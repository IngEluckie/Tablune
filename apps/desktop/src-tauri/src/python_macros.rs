#[path = "calculation_worker.rs"]
pub(crate) mod calculation_worker;
pub(crate) static PYTHON_QUEUE: tauri::async_runtime::Mutex<()> =
    tauri::async_runtime::Mutex::const_new(());
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, path::BaseDirectory};

use crate::session::{
    self, DocumentSummary, MAX_HISTORY_BYTES, MacroDocumentSnapshot, WorkspaceState,
    estimate_macro_history,
};

const PROTOCOL_VERSION: u8 = 1;
const MIN_PYTHON_MAJOR: u64 = 3;
const MIN_PYTHON_MINOR: u64 = 10;
const CODE_LIMIT: usize = 1024 * 1024;
const LOG_LIMIT: usize = 1024 * 1024;
const OUTPUT_LIMIT: u64 = 512 * 1024 * 1024;
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(120);
const SAMPLE_LIMIT: usize = 100;
static NEXT_TEMP_DIRECTORY: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonStatus {
    path: Option<String>,
    version: Option<String>,
    available: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroChangeSample {
    row: usize,
    column: usize,
    before: Option<String>,
    after: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroPreview {
    id: String,
    base_revision: u64,
    base_calculation_revision: u64,
    rows_before: usize,
    rows_after: usize,
    columns_before: usize,
    columns_after: usize,
    changed_cells: usize,
    header_changed: bool,
    estimated_undo_bytes: usize,
    can_apply: bool,
    blocked_reason: Option<String>,
    stdout: String,
    stderr: String,
    samples: Vec<MacroChangeSample>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MacroInput<'a> {
    protocol_version: u8,
    rows: &'a [Vec<String>],
    context: MacroContext,
}

#[derive(Debug, Serialize)]
struct MacroContext {
    headers: Option<Vec<String>>,
    header_enabled: bool,
    header_present: bool,
    document_name: String,
    delimiter: String,
    line_ending: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MacroOutput {
    protocol_version: u8,
    rows: Vec<Vec<String>>,
    headers: Option<Vec<String>>,
}

#[derive(Debug)]
struct PendingPreview {
    calculation_revision: u64,
    project: Option<(u64, String, u64)>,
    id: String,
    document_id: u64,
    identity: u64,
    revision: u64,
    header_enabled: bool,
    rows: Vec<Vec<String>>,
    estimated_bytes: usize,
}

#[derive(Default)]
struct RuntimeInner {
    active: bool,
    active_project: Option<u64>,
    cancel_requested: bool,
    child: Option<Arc<Mutex<Child>>>,
    pending: Option<PendingPreview>,
    next_preview: u64,
}

#[derive(Clone, Default)]
pub struct PythonRuntimeState {
    inner: Arc<Mutex<RuntimeInner>>,
}

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn create() -> Result<Self, String> {
        let id = NEXT_TEMP_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("tablune-macro-{}-{id}", std::process::id()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|error| error.to_string())?;
        Ok(Self(path))
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug)]
struct InterpreterInfo {
    path: String,
    version: String,
}

#[derive(Debug, Deserialize)]
struct InterpreterProbe {
    path: String,
    version: String,
    major: u64,
    minor: u64,
}

#[derive(Debug)]
struct RunOutput {
    rows: Vec<Vec<String>>,
    stdout: String,
    stderr: String,
}

fn lock_runtime(
    inner: &Arc<Mutex<RuntimeInner>>,
) -> Result<std::sync::MutexGuard<'_, RuntimeInner>, String> {
    inner
        .lock()
        .map_err(|_| "the Python runtime is unavailable".to_string())
}

fn inspect_interpreter(candidate: &str) -> Result<InterpreterInfo, String> {
    let script = concat!(
        "import json,sys; ",
        "print(json.dumps({'path':sys.executable,'version':'.'.join(map(str,sys.version_info[:3])),",
        "'major':sys.version_info[0],'minor':sys.version_info[1]}))"
    );
    let directory = TemporaryDirectory::create()?;
    let stdout_path = directory.0.join("probe-stdout.log");
    let stderr_path = directory.0.join("probe-stderr.log");
    let stdout_file = fs::File::create(&stdout_path).map_err(|error| error.to_string())?;
    let stderr_file = fs::File::create(&stderr_path).map_err(|error| error.to_string())?;
    let mut child = Command::new(candidate)
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|error| format!("{candidate}: {error}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{candidate}: interpreter check timed out"));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = read_limited(&stdout_path, 64 * 1024);
    let stderr = read_limited(&stderr_path, 64 * 1024);
    if !status.success() {
        return Err(format!("{candidate}: {}", stderr.trim()));
    }
    let probe: InterpreterProbe = serde_json::from_str(&stdout)
        .map_err(|_| format!("{candidate} did not report a valid Python version"))?;
    if (probe.major, probe.minor) < (MIN_PYTHON_MAJOR, MIN_PYTHON_MINOR) {
        return Err(format!(
            "Python {} is unsupported; Tablune requires Python 3.10 or later",
            probe.version
        ));
    }
    Ok(InterpreterInfo {
        path: probe.path,
        version: probe.version,
    })
}

fn resolve_interpreter(app: &AppHandle) -> Result<InterpreterInfo, String> {
    let configured = session::load_python_interpreter(app)?;
    let mut candidates = Vec::new();
    if let Some(path) = configured {
        candidates.push(path);
    }
    candidates.extend([
        "/opt/homebrew/bin/python3".to_string(),
        "/usr/local/bin/python3".to_string(),
        "/usr/bin/python3".to_string(),
        "python3".to_string(),
        "python".to_string(),
    ]);
    let mut seen = HashSet::new();
    let mut errors = Vec::new();
    for candidate in candidates {
        if seen.insert(candidate.clone()) {
            match inspect_interpreter(&candidate) {
                Ok(info) => return Ok(info),
                Err(error) => errors.push(error),
            }
        }
    }
    Err(errors
        .last()
        .cloned()
        .unwrap_or_else(|| "Python 3.10 or later was not found".to_string()))
}

#[tauri::command]
pub fn python_status(app: AppHandle) -> PythonStatus {
    match resolve_interpreter(&app) {
        Ok(info) => PythonStatus {
            path: Some(info.path),
            version: Some(info.version),
            available: true,
            error: None,
        },
        Err(error) => PythonStatus {
            path: None,
            version: None,
            available: false,
            error: Some(error),
        },
    }
}

#[tauri::command]
pub async fn python_set_interpreter(app: AppHandle, path: String) -> Result<PythonStatus, String> {
    let _lease = PYTHON_QUEUE.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let info = inspect_interpreter(path.trim())?;
        let previous = session::load_python_interpreter(&app)?;
        session::save_python_interpreter(&app, info.path.clone())?;
        if previous.as_deref() != Some(&info.path) {
            session::calculation::interpreter_changed(&app)?;
        }
        Ok(PythonStatus {
            path: Some(info.path),
            version: Some(info.version),
            available: true,
            error: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn validated_macro_folder(path: &str) -> Result<String, String> {
    let path = Path::new(path.trim());
    if path.as_os_str().is_empty() {
        return Err("the macros folder path cannot be empty".to_string());
    }
    let metadata =
        fs::metadata(path).map_err(|error| format!("the macros folder is unavailable: {error}"))?;
    if !metadata.is_dir() {
        return Err("the macros folder path is not a directory".to_string());
    }
    path.canonicalize()
        .map_err(|error| format!("the macros folder is unavailable: {error}"))
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn python_macro_folder(app: AppHandle) -> Result<Option<String>, String> {
    let Some(path) = session::load_python_macro_folder(&app)? else {
        return Ok(None);
    };
    Ok(validated_macro_folder(&path).ok())
}

#[tauri::command]
pub fn python_set_macro_folder(app: AppHandle, path: String) -> Result<String, String> {
    let path = validated_macro_folder(&path)?;
    session::save_python_macro_folder(&app, path.clone())?;
    Ok(path)
}

fn validated_macro_script_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty()
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("py"))
    {
        return Err("macro files must use the .py extension".to_string());
    }
    Ok(path)
}

#[tauri::command]
pub fn macro_read_script(path: String) -> Result<String, String> {
    let path = validated_macro_script_path(&path)?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("the macro path is not a file".to_string());
    }
    if metadata.len() > CODE_LIMIT as u64 {
        return Err("macro files cannot exceed 1 MiB".to_string());
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn macro_write_script(path: String, code: String) -> Result<(), String> {
    if code.len() > CODE_LIMIT {
        return Err("macro code cannot exceed 1 MiB".to_string());
    }
    let path = validated_macro_script_path(&path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "the macro path does not have a parent folder".to_string())?;
    if !parent.is_dir() {
        return Err("the macro parent folder is unavailable".to_string());
    }
    fs::write(path, code).map_err(|error| error.to_string())
}

fn runner_path(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resolve("python/tablune_runner.py", BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    if bundled.exists() {
        return Ok(bundled);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("python")
        .join("tablune_runner.py");
    development
        .exists()
        .then_some(development)
        .ok_or_else(|| "the Tablune Python runner is missing".to_string())
}

fn read_limited(path: &Path, limit: usize) -> String {
    let truncated = fs::metadata(path)
        .map(|metadata| metadata.len() > limit as u64)
        .unwrap_or(false);
    let Ok(file) = fs::File::open(path) else {
        return String::new();
    };
    let mut bytes = Vec::new();
    let _ = file.take(limit as u64).read_to_end(&mut bytes);
    let mut output = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        output.push_str("\n[output truncated]");
    }
    output
}

fn validate_rows(rows: &[Vec<String>]) -> Result<(), String> {
    let cells = rows
        .iter()
        .map(Vec::len)
        .fold(0usize, usize::saturating_add);
    if cells > 50_000_000 {
        return Err("the macro returned too many cells".to_string());
    }
    Ok(())
}

fn configure_macro_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn terminate_process_tree(process: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = -(process.id() as i32);
        // The macro is launched as the leader of its own process group.
        let _ = unsafe { libc::kill(process_group, libc::SIGKILL) };
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let process_id = process.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &process_id, "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = process.kill();
}

fn run_macro(
    inner: Arc<Mutex<RuntimeInner>>,
    interpreter: InterpreterInfo,
    runner: PathBuf,
    snapshot: MacroDocumentSnapshot,
    code: String,
    source_path: Option<String>,
) -> Result<RunOutput, String> {
    let directory = TemporaryDirectory::create()?;
    let input_path = directory.0.join("input.json");
    let macro_path = directory.0.join("macro.py");
    let output_path = directory.0.join("output.json");
    let stdout_path = directory.0.join("stdout.log");
    let stderr_path = directory.0.join("stderr.log");
    let header_present = snapshot.header_enabled && !snapshot.rows.is_empty();
    let headers = snapshot
        .header_enabled
        .then(|| snapshot.rows.first().cloned().unwrap_or_default());
    let data_start = usize::from(header_present);
    let line_ending = match snapshot.line_ending {
        tablune_csv::LineEnding::Lf => "lf",
        tablune_csv::LineEnding::CrLf => "crlf",
    };
    let input = MacroInput {
        protocol_version: PROTOCOL_VERSION,
        rows: &snapshot.rows[data_start..],
        context: MacroContext {
            headers,
            header_enabled: snapshot.header_enabled,
            header_present,
            document_name: snapshot.display_name,
            delimiter: snapshot.delimiter,
            line_ending: line_ending.to_string(),
        },
    };
    let encoded = serde_json::to_vec(&input).map_err(|error| error.to_string())?;
    fs::write(&input_path, encoded).map_err(|error| error.to_string())?;
    fs::write(&macro_path, code).map_err(|error| error.to_string())?;
    let stdout_file = fs::File::create(&stdout_path).map_err(|error| error.to_string())?;
    let stderr_file = fs::File::create(&stderr_path).map_err(|error| error.to_string())?;
    let working_directory = source_path
        .as_deref()
        .and_then(|path| Path::new(path).parent())
        .unwrap_or(&directory.0)
        .to_path_buf();
    let mut command = Command::new(&interpreter.path);
    command
        .arg(runner)
        .arg(&input_path)
        .arg(&macro_path)
        .arg(&output_path)
        .current_dir(&working_directory)
        .env("TABLUNE_MACRO_DIR", &working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
    configure_macro_process(&mut command);
    let child = Arc::new(Mutex::new(
        command
            .spawn()
            .map_err(|error| format!("failed to start Python: {error}"))?,
    ));
    {
        let mut runtime = lock_runtime(&inner)?;
        runtime.child = Some(child.clone());
        if runtime.cancel_requested {
            if let Ok(mut process) = child.lock() {
                terminate_process_tree(&mut process);
            }
        }
    }

    let started = Instant::now();
    let mut cancelled = false;
    let exit_status = loop {
        let cancel_requested = lock_runtime(&inner)?.cancel_requested;
        let mut process = child
            .lock()
            .map_err(|_| "the Python process is unavailable".to_string())?;
        if cancel_requested {
            terminate_process_tree(&mut process);
            cancelled = true;
        } else if started.elapsed() >= EXECUTION_TIMEOUT {
            terminate_process_tree(&mut process);
        }
        match process.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None => {
                drop(process);
                thread::sleep(Duration::from_millis(25));
            }
        }
    };
    let stdout = read_limited(&stdout_path, LOG_LIMIT);
    let stderr = read_limited(&stderr_path, LOG_LIMIT);
    if cancelled {
        return Err("Python macro cancelled".to_string());
    }
    if started.elapsed() >= EXECUTION_TIMEOUT {
        return Err(format!(
            "Python macro exceeded the two minute limit\n{stderr}"
        ));
    }
    if !exit_status.success() {
        return Err(format!("Python macro failed\n{stderr}"));
    }
    let metadata =
        fs::metadata(&output_path).map_err(|_| "the macro did not produce a result".to_string())?;
    if metadata.len() > OUTPUT_LIMIT {
        return Err("the macro result exceeds 512 MiB".to_string());
    }
    let output: MacroOutput =
        serde_json::from_slice(&fs::read(&output_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("the macro result is invalid: {error}"))?;
    if output.protocol_version != PROTOCOL_VERSION {
        return Err("the macro returned an unsupported protocol version".to_string());
    }
    validate_rows(&output.rows)?;
    let mut rows = output.rows;
    if snapshot.header_enabled {
        let headers = output
            .headers
            .ok_or_else(|| "the macro result is missing headers".to_string())?;
        if header_present || !headers.is_empty() || !rows.is_empty() {
            rows.insert(0, headers);
        }
    } else if output.headers.is_some() {
        return Err("a macro cannot enable document headers".to_string());
    }
    Ok(RunOutput {
        rows,
        stdout,
        stderr,
    })
}

fn column_count(rows: &[Vec<String>]) -> usize {
    rows.iter().map(Vec::len).max().unwrap_or(0)
}

fn build_preview(
    inner: &Arc<Mutex<RuntimeInner>>,
    snapshot: &MacroDocumentSnapshot,
    output: RunOutput,
) -> Result<MacroPreview, String> {
    let estimated_undo_bytes = estimate_macro_history(&snapshot.rows, &output.rows);
    let max_rows = snapshot.rows.len().max(output.rows.len());
    let max_columns = column_count(&snapshot.rows).max(column_count(&output.rows));
    let mut changed_cells = 0usize;
    let mut samples = Vec::new();
    for row in 0..max_rows {
        for column in 0..max_columns {
            let before = snapshot.rows.get(row).and_then(|values| values.get(column));
            let after = output.rows.get(row).and_then(|values| values.get(column));
            if before != after {
                changed_cells = changed_cells.saturating_add(1);
                if samples.len() < SAMPLE_LIMIT {
                    samples.push(MacroChangeSample {
                        row,
                        column,
                        before: before.cloned(),
                        after: after.cloned(),
                    });
                }
            }
        }
    }
    let header_changed = snapshot.header_enabled
        && snapshot.rows.first().map(Vec::as_slice) != output.rows.first().map(Vec::as_slice);
    let blocked_reason = preview_blocked_reason(changed_cells, estimated_undo_bytes);
    let mut runtime = lock_runtime(inner)?;
    runtime.next_preview = runtime.next_preview.wrapping_add(1);
    let id = format!("macro-preview-{}", runtime.next_preview);
    runtime.pending = Some(PendingPreview {
        calculation_revision: snapshot.calculation_revision,
        project: None,
        id: id.clone(),
        document_id: snapshot.document_id,
        identity: snapshot.identity,
        revision: snapshot.revision,
        header_enabled: snapshot.header_enabled,
        rows: output.rows,
        estimated_bytes: estimated_undo_bytes,
    });
    Ok(MacroPreview {
        id,
        base_revision: snapshot.revision,
        base_calculation_revision: snapshot.calculation_revision,
        rows_before: snapshot.rows.len(),
        rows_after: runtime
            .pending
            .as_ref()
            .map_or(0, |preview| preview.rows.len()),
        columns_before: column_count(&snapshot.rows),
        columns_after: runtime
            .pending
            .as_ref()
            .map_or(0, |preview| column_count(&preview.rows)),
        changed_cells,
        header_changed,
        estimated_undo_bytes,
        can_apply: blocked_reason.is_none(),
        blocked_reason,
        stdout: output.stdout,
        stderr: output.stderr,
        samples,
    })
}

fn preview_blocked_reason(changed_cells: usize, estimated_undo_bytes: usize) -> Option<String> {
    if changed_cells == 0 {
        Some("The macro did not change the document.".to_string())
    } else if estimated_undo_bytes > MAX_HISTORY_BYTES {
        Some("The result exceeds the 64 MiB Undo limit.".to_string())
    } else {
        None
    }
}

#[tauri::command]
pub async fn python_preview_macro(
    app: AppHandle,
    workspace_state: State<'_, WorkspaceState>,
    runtime_state: State<'_, PythonRuntimeState>,
    document_id: u64,
    code: String,
    source_path: Option<String>,
    expected_revision: u64,
) -> Result<MacroPreview, String> {
    if code.len() > CODE_LIMIT {
        return Err("macro code cannot exceed 1 MiB".to_string());
    }
    let handle = session::document_handle(&workspace_state, document_id)?;
    let snapshot = session::lock_document(&handle)?.macro_snapshot();
    if snapshot.revision != expected_revision {
        return Err("the document changed; run the macro preview again".to_string());
    }
    if session::lock_document(&handle)?
        .summary()
        .project_id
        .is_some()
    {
        return Err("Use the project script editor for this table".into());
    }
    run_preview(
        &app,
        &workspace_state,
        &runtime_state,
        snapshot,
        code,
        source_path,
        None,
    )
    .await
}

async fn run_preview(
    app: &AppHandle,
    workspace: &WorkspaceState,
    runtime_state: &PythonRuntimeState,
    snapshot: MacroDocumentSnapshot,
    code: String,
    source_path: Option<String>,
    project: Option<(u64, String, u64)>,
) -> Result<MacroPreview, String> {
    if code.len() > CODE_LIMIT {
        return Err("macro code cannot exceed 1 MiB".into());
    }
    let _execution_lease = PYTHON_QUEUE.lock().await;
    let interpreter = resolve_interpreter(app)?;
    let runner = runner_path(app)?;
    let inner = runtime_state.inner.clone();
    {
        let mut runtime = lock_runtime(&inner)?;
        if runtime.active {
            return Err("another Python macro is already running".into());
        }
        runtime.active = true;
        runtime.active_project = project.as_ref().map(|p| p.0);
        runtime.cancel_requested = false;
        runtime.child = None;
        runtime.pending = None;
    }
    let execution_inner = inner.clone();
    let execution_snapshot = snapshot.clone();
    let task_result = tauri::async_runtime::spawn_blocking(move || {
        run_macro(
            execution_inner,
            interpreter,
            runner,
            execution_snapshot,
            code,
            source_path,
        )
    })
    .await;
    // Reserve the runtime through preview publication, including validation.
    let result = (|| {
        let output = task_result.map_err(|e| e.to_string())??;
        let handle = session::document_handle(workspace, snapshot.document_id)?;
        if !session::lock_document(&handle)?.matches_macro_snapshot(
            snapshot.identity,
            snapshot.revision,
            snapshot.header_enabled,
        ) {
            return Err("the document changed while the macro was running".into());
        }
        if let Some((project_id, script_id, revision)) = &project {
            let handle = session::projects::handle(workspace, *project_id)?;
            let p = session::projects::lock_project(&handle)?;
            let (script, input) = p.script_input(script_id)?;
            if script.revision != *revision
                || session::lock_document(&input)?.summary().document_id != snapshot.document_id
            {
                return Err("Script or input changed; run preview again".into());
            }
        }
        {
            let current = session::lock_document(&handle)?;
            current.ensure_transformable()?;
            if current.summary().calculation_revision != snapshot.calculation_revision {
                return Err("Calculated input changed; run preview again".into());
            }
        }
        let mut preview = build_preview(&inner, &snapshot, output)?;
        if project.is_some() {
            preview.can_apply = true;
            preview.blocked_reason = None;
            if let Some(pending) = &mut lock_runtime(&inner)?.pending {
                pending.project = project;
            }
        }
        Ok(preview)
    })();
    let mut runtime = lock_runtime(&inner)?;
    runtime.active = false;
    runtime.active_project = None;
    runtime.cancel_requested = false;
    runtime.child = None;
    result
}

#[tauri::command]
pub async fn project_python_preview(
    app: AppHandle,
    workspace: State<'_, WorkspaceState>,
    runtime: State<'_, PythonRuntimeState>,
    project_id: u64,
    script_id: String,
) -> Result<MacroPreview, String> {
    let (script, snapshot) = {
        let handle = session::projects::handle(&workspace, project_id)?;
        let p = session::projects::lock_project(&handle)?;
        let (script, input) = p.script_input(&script_id)?;
        session::lock_document(&input)?.ensure_transformable()?;
        let snapshot = session::lock_document(&input)?.macro_snapshot();
        (script, snapshot)
    };
    run_preview(
        &app,
        &workspace,
        &runtime,
        snapshot,
        script.code,
        None,
        Some((project_id, script_id, script.revision)),
    )
    .await
}

pub(crate) fn project_running(
    runtime: &PythonRuntimeState,
    project_id: u64,
) -> Result<bool, String> {
    Ok(lock_runtime(&runtime.inner)?.active_project == Some(project_id))
}

fn validate_project_preview(
    pending: &PendingPreview,
    project_id: u64,
    script: &session::projects::ScriptSummary,
    snapshot: &MacroDocumentSnapshot,
    preview_id: &str,
) -> Result<(), String> {
    if pending.id != preview_id
        || pending.project != Some((project_id, script.id.clone(), script.revision))
        || pending.document_id != snapshot.document_id
        || pending.calculation_revision != snapshot.calculation_revision
        || pending.identity != snapshot.identity
        || pending.revision != snapshot.revision
        || pending.header_enabled != snapshot.header_enabled
    {
        return Err("Script or input changed; run preview again".into());
    }
    Ok(())
}

#[tauri::command]
pub fn project_python_result(
    workspace: State<'_, WorkspaceState>,
    runtime: State<'_, PythonRuntimeState>,
    project_id: u64,
    script_id: String,
    preview_id: String,
) -> Result<session::projects::ProjectSummary, String> {
    let handle = session::projects::handle(&workspace, project_id)?;
    let mut p = session::projects::lock_project(&handle)?;
    let (script, input) = p.script_input(&script_id)?;
    let input = session::lock_document(&input)?;
    input.ensure_transformable()?;
    let snapshot = input.macro_snapshot();
    let pending = {
        let mut rt = lock_runtime(&runtime.inner)?;
        let pending = rt
            .pending
            .as_ref()
            .ok_or("Preview is no longer available")?;
        validate_project_preview(pending, project_id, &script, &snapshot, &preview_id)?;
        rt.pending.take().ok_or("Preview is no longer available")?
    };
    p.add_result(pending.rows, &snapshot, &script.name)?;
    drop(input);
    session::projects::update_directory(&handle, &p)?;
    p.summary()
}

#[tauri::command]
pub fn python_cancel_macro(runtime_state: State<'_, PythonRuntimeState>) -> Result<bool, String> {
    let mut runtime = lock_runtime(&runtime_state.inner)?;
    if !runtime.active {
        return Ok(false);
    }
    runtime.cancel_requested = true;
    if let Some(child) = &runtime.child {
        let mut process = child
            .lock()
            .map_err(|_| "the Python process is unavailable".to_string())?;
        terminate_process_tree(&mut process);
    }
    Ok(true)
}

#[tauri::command]
pub fn python_apply_preview(
    workspace_state: State<'_, WorkspaceState>,
    runtime_state: State<'_, PythonRuntimeState>,
    document_id: u64,
    preview_id: String,
    expected_revision: u64,
) -> Result<DocumentSummary, String> {
    let pending = {
        let mut runtime = lock_runtime(&runtime_state.inner)?;
        let pending = runtime
            .pending
            .take()
            .ok_or_else(|| "the macro preview is no longer available".to_string())?;
        if pending.id != preview_id || pending.document_id != document_id {
            runtime.pending = Some(pending);
            return Err("the macro preview is no longer available".to_string());
        }
        pending
    };
    if pending.project.is_some() {
        return Err("Use create result table for project previews".into());
    }
    if pending.estimated_bytes > MAX_HISTORY_BYTES {
        return Err("this macro result is too large to keep an undo entry".to_string());
    }
    let handle = session::document_handle(&workspace_state, document_id)?;
    let mut session = session::lock_document(&handle)?;
    if !session.matches_macro_snapshot(pending.identity, expected_revision, pending.header_enabled)
    {
        return Err("the document changed; run the macro preview again".to_string());
    }
    session.apply_macro_rows(pending.rows, pending.identity, pending.revision)?;
    Ok(session.summary())
}

pub(crate) fn request_calculation_cancel(runtime: &PythonRuntimeState) -> Result<(), String> {
    lock_runtime(&runtime.inner)?.cancel_requested = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_preview_rejects_changed_code_input_revision_and_project() {
        let script = session::projects::ScriptSummary {
            id: "s".into(),
            name: "Code.py".into(),
            code: "pass".into(),
            revision: 3,
            input_table_id: Some("t".into()),
        };
        let snapshot = MacroDocumentSnapshot {
            calculation_revision: 0,
            document_id: 9,
            identity: 9,
            revision: 4,
            rows: vec![],
            header_enabled: true,
            display_name: "Table".into(),
            delimiter: ",".into(),
            line_ending: tablune_csv::LineEnding::Lf,
        };
        let pending = PendingPreview {
            calculation_revision: snapshot.calculation_revision,
            project: Some((1, "s".into(), 3)),
            id: "preview".into(),
            document_id: 9,
            identity: 9,
            revision: 4,
            header_enabled: true,
            rows: vec![],
            estimated_bytes: MAX_HISTORY_BYTES + 1,
        };
        assert!(validate_project_preview(&pending, 1, &script, &snapshot, "preview").is_ok());
        assert!(validate_project_preview(&pending, 2, &script, &snapshot, "preview").is_err());
        assert!(
            validate_project_preview(&pending, 1, &script, &snapshot, "other-preview").is_err()
        );
        let mut changed = script.clone();
        changed.revision += 1;
        assert!(validate_project_preview(&pending, 1, &changed, &snapshot, "preview").is_err());
        let mut changed = snapshot.clone();
        changed.document_id += 1;
        assert!(validate_project_preview(&pending, 1, &script, &changed, "preview").is_err());
        let mut changed = snapshot.clone();
        changed.revision += 1;
        assert!(validate_project_preview(&pending, 1, &script, &changed, "preview").is_err());
        let mut changed = snapshot.clone();
        changed.header_enabled = false;
        assert!(validate_project_preview(&pending, 1, &script, &changed, "preview").is_err());
    }

    #[test]
    fn validates_supported_python_versions() {
        assert!(inspect_interpreter("tablune-python-does-not-exist").is_err());
        let status = inspect_interpreter("python3");
        if let Ok(info) = status {
            assert!(!info.path.is_empty());
            assert!(!info.version.is_empty());
        }
    }

    #[test]
    fn validates_macro_folders() {
        let directory = TemporaryDirectory::create().unwrap();
        let canonical = validated_macro_folder(directory.0.to_str().unwrap()).unwrap();
        assert_eq!(
            PathBuf::from(canonical),
            directory.0.canonicalize().unwrap()
        );

        let file = directory.0.join("macro.py");
        fs::write(&file, "def run(rows, context):\n    pass\n").unwrap();
        assert!(
            validated_macro_folder(file.to_str().unwrap())
                .unwrap_err()
                .contains("not a directory")
        );
        assert!(validated_macro_folder("").is_err());
    }

    #[test]
    fn macro_file_commands_only_accept_python_scripts() {
        assert!(validated_macro_script_path("macro.py").is_ok());
        assert!(validated_macro_script_path("MACRO.PY").is_ok());
        assert!(validated_macro_script_path("notes.txt").is_err());
        assert!(validated_macro_script_path("").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn temporary_macro_directories_are_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TemporaryDirectory::create().unwrap();
        let mode = fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn preview_samples_ragged_changes() {
        let inner = PythonRuntimeState::default().inner;
        let snapshot = MacroDocumentSnapshot {
            calculation_revision: 0,
            document_id: 1,
            identity: 1,
            revision: 2,
            rows: vec![vec!["a".into()], vec!["b".into(), "c".into()]],
            header_enabled: false,
            display_name: "test.csv".into(),
            delimiter: ",".into(),
            line_ending: tablune_csv::LineEnding::Lf,
        };
        let preview = build_preview(
            &inner,
            &snapshot,
            RunOutput {
                rows: vec![vec!["a".into(), "x".into()]],
                stdout: String::new(),
                stderr: String::new(),
            },
        )
        .unwrap();
        assert_eq!(preview.changed_cells, 3);
        assert!(preview.can_apply);
        assert_eq!(
            inner.lock().unwrap().pending.as_ref().unwrap().document_id,
            1
        );
    }

    #[test]
    fn runner_prefers_run_and_supports_mutation_without_a_return_value() {
        let Ok(interpreter) = inspect_interpreter("python3") else {
            return;
        };
        let inner = PythonRuntimeState::default().inner;
        let snapshot = MacroDocumentSnapshot {
            calculation_revision: 0,
            document_id: 1,
            identity: 1,
            revision: 0,
            rows: vec![
                vec!["name".into(), "note".into()],
                vec!["Ada".into(), "línea\n,dos".into()],
                vec![String::new()],
            ],
            header_enabled: true,
            display_name: "test.csv".into(),
            delimiter: ",".into(),
            line_ending: tablune_csv::LineEnding::Lf,
        };
        let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("tablune_runner.py");
        let result = run_macro(
            inner,
            interpreter,
            runner,
            snapshot,
            "def transform(rows, context):\n    return [['wrong']]\n\ndef run(rows, context):\n    rows.append(['雪'])\n    context['headers'][:] = ['person', 'note']\n".into(),
            None,
        )
        .unwrap();
        assert_eq!(result.rows[0], vec!["person", "note"]);
        assert_eq!(result.rows[1][1], "línea\n,dos");
        assert_eq!(result.rows[2], vec![""]);
        assert_eq!(result.rows[3], vec!["雪"]);
    }

    #[test]
    fn runner_allows_calculation_only_run() {
        let Ok(interpreter) = inspect_interpreter("python3") else {
            return;
        };
        let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("tablune_runner.py");
        let snapshot = MacroDocumentSnapshot {
            calculation_revision: 0,
            document_id: 1,
            identity: 1,
            revision: 0,
            rows: vec![vec!["4".into()], vec!["5".into()]],
            header_enabled: false,
            display_name: "test.csv".into(),
            delimiter: ",".into(),
            line_ending: tablune_csv::LineEnding::Lf,
        };
        let result = run_macro(
            PythonRuntimeState::default().inner,
            interpreter,
            runner,
            snapshot,
            "def run(rows, context):\n    print(sum(int(row[0]) for row in rows))\n".into(),
            None,
        )
        .unwrap();
        assert_eq!(result.rows, vec![vec!["4"], vec!["5"]]);
        assert_eq!(result.stdout.trim(), "9");
    }

    #[test]
    fn runner_keeps_transform_as_a_legacy_entrypoint() {
        let Ok(interpreter) = inspect_interpreter("python3") else {
            return;
        };
        let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("tablune_runner.py");
        let snapshot = MacroDocumentSnapshot {
            calculation_revision: 0,
            document_id: 1,
            identity: 1,
            revision: 0,
            rows: vec![vec!["before".into()]],
            header_enabled: false,
            display_name: "test.csv".into(),
            delimiter: ",".into(),
            line_ending: tablune_csv::LineEnding::Lf,
        };
        let result = run_macro(
            PythonRuntimeState::default().inner,
            interpreter,
            runner,
            snapshot,
            "def transform(rows, context):\n    return [['after']]\n".into(),
            None,
        )
        .unwrap();
        assert_eq!(result.rows, vec![vec!["after"]]);
    }

    #[test]
    fn invalid_macro_results_are_rejected() {
        let Ok(interpreter) = inspect_interpreter("python3") else {
            return;
        };
        let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("tablune_runner.py");
        let snapshot = MacroDocumentSnapshot {
            calculation_revision: 0,
            document_id: 1,
            identity: 1,
            revision: 0,
            rows: vec![vec!["value".into()]],
            header_enabled: false,
            display_name: "test.csv".into(),
            delimiter: ",".into(),
            line_ending: tablune_csv::LineEnding::Lf,
        };
        let error = run_macro(
            PythonRuntimeState::default().inner,
            interpreter,
            runner,
            snapshot,
            "def transform(rows, context):\n    return [[42]]\n".into(),
            None,
        )
        .unwrap_err();
        assert!(error.contains("not a string"));
    }

    #[test]
    fn running_macro_can_be_cancelled() {
        let Some(interpreter) = [
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "python3",
            "python",
        ]
        .into_iter()
        .find_map(|candidate| inspect_interpreter(candidate).ok()) else {
            return;
        };
        let runtime = PythonRuntimeState::default();
        let marker_directory = TemporaryDirectory::create().unwrap();
        let marker = marker_directory.0.join("child-survived.txt");
        let marker_literal = serde_json::to_string(marker.to_str().unwrap()).unwrap();
        let child_code = format!(
            "import time; from pathlib import Path; time.sleep(1); Path({marker_literal}).write_text('alive')"
        );
        let child_code_literal = serde_json::to_string(&child_code).unwrap();
        let macro_code = format!(
            "import subprocess, sys, time\ndef transform(rows, context):\n    subprocess.Popen([sys.executable, '-c', {child_code_literal}])\n    time.sleep(30)\n    return rows\n"
        );
        runtime.inner.lock().unwrap().active = true;
        let inner = runtime.inner.clone();
        let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("tablune_runner.py");
        let snapshot = MacroDocumentSnapshot {
            calculation_revision: 0,
            document_id: 1,
            identity: 1,
            revision: 0,
            rows: vec![vec!["value".into()]],
            header_enabled: false,
            display_name: "test.csv".into(),
            delimiter: ",".into(),
            line_ending: tablune_csv::LineEnding::Lf,
        };
        let execution_inner = inner.clone();
        let handle = thread::spawn(move || {
            run_macro(
                execution_inner,
                interpreter,
                runner,
                snapshot,
                macro_code,
                None,
            )
        });
        for _ in 0..100 {
            if inner.lock().unwrap().child.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(300));
        {
            let mut state = inner.lock().unwrap();
            state.cancel_requested = true;
            if let Some(child) = &state.child {
                terminate_process_tree(&mut child.lock().unwrap());
            }
        }
        assert!(handle.join().unwrap().unwrap_err().contains("cancelled"));
        thread::sleep(Duration::from_millis(1_300));
        assert!(
            !marker.exists(),
            "a child process survived macro cancellation"
        );
    }

    #[test]
    fn undo_budget_blocks_apply_without_allocating_the_result() {
        assert!(preview_blocked_reason(1, MAX_HISTORY_BYTES).is_none());
        assert!(
            preview_blocked_reason(1, MAX_HISTORY_BYTES + 1)
                .unwrap()
                .contains("64 MiB")
        );
    }
}
