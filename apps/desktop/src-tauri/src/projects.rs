//! Project ownership and lifecycle. Lock order: registry -> project -> table.
use super::*;
#[path = "project_archive.rs"]
mod archive;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSummary {
    pub id: String,
    pub name: String,
    pub code: String,
    pub revision: u64,
    pub input_table_id: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FunctionsData {
    pub draft: String,
    pub applied: String,
    pub revision: u64,
    pub draft_revision: u64,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculationSummary {
    pub enabled: bool,
    pub running: bool,
    pub paused: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMetadata {
    #[serde(default)]
    pub sheet: SheetData,
    pub id: String,
    pub name: String,
    pub dialect: CsvDialect,
    pub header_enabled: bool,
    pub column_types: HashMap<usize, ColumnType>,
    pub view: ViewState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectData {
    #[serde(default)]
    pub functions: FunctionsData,
    pub version: u8,
    pub id: String,
    pub name: String,
    pub tables: Vec<TableMetadata>,
    pub scripts: Vec<ScriptSummary>,
    #[serde(skip)]
    pub rows: Vec<Vec<Vec<String>>>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTableSummary {
    pub id: String,
    pub document: DocumentSummary,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub functions: FunctionsData,
    pub calculation: CalculationSummary,
    pub project_id: u64,
    pub persistent_id: String,
    pub name: String,
    pub path: Option<String>,
    pub dirty: bool,
    pub revision: String,
    pub tables: Vec<ProjectTableSummary>,
    pub scripts: Vec<ScriptSummary>,
}
pub struct ProjectHandle {
    id: u64,
    session: Mutex<ProjectSession>,
    documents: Mutex<HashMap<u64, DocumentHandle>>,
    closed: std::sync::atomic::AtomicBool,
}
impl ProjectHandle {
    fn new(project: ProjectSession) -> Self {
        let documents = project
            .tables
            .iter()
            .map(|h| (h.lock().expect("new table lock").identity, h.clone()))
            .collect();
        Self {
            id: project.runtime_id,
            session: Mutex::new(project),
            documents: Mutex::new(documents),
            closed: std::sync::atomic::AtomicBool::new(false),
        }
    }
}
pub(crate) fn update_directory(
    handle: &Arc<ProjectHandle>,
    project: &ProjectSession,
) -> Result<(), String> {
    let documents = project
        .tables
        .iter()
        .map(|h| Ok((lock_document(h)?.identity, h.clone())))
        .collect::<Result<HashMap<_, _>, String>>()?;
    *handle
        .documents
        .lock()
        .map_err(|_| "Table directory unavailable")? = documents;
    Ok(())
}
pub struct ProjectSession {
    pub(crate) runtime_id: u64,
    pub(super) data: ProjectData,
    path: Option<PathBuf>,
    pub(super) tables: Vec<DocumentHandle>,
    pub(super) calculation: CalculationSummary,
    pub(super) calculation_generation: u64,
    saved_signature: String,
}
static PROJECT_PATH_OPERATIONS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));
struct ProjectPathReservation(String);
impl ProjectPathReservation {
    fn acquire(path: &Path) -> Result<Self, String> {
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("tablune"))
        {
            return Err("Project files must use the .tablune extension".into());
        }
        let key = canonical_key(path);
        if !PROJECT_PATH_OPERATIONS
            .lock()
            .map_err(|_| "Project path registry unavailable")?
            .insert(key.clone())
        {
            return Err(
                "This project file is being opened or saved; try again when it finishes".into(),
            );
        }
        Ok(Self(key))
    }
}
impl Drop for ProjectPathReservation {
    fn drop(&mut self) {
        if let Ok(mut paths) = PROJECT_PATH_OPERATIONS.lock() {
            paths.remove(&self.0);
        }
    }
}
fn persistent_id() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        next_session_identity()
    )
}
fn name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 240 || value.chars().any(char::is_control) {
        return Err("Enter a name between 1 and 240 bytes without control characters".into());
    }
    Ok(value.into())
}
fn unique_name(base: &str, existing: impl Iterator<Item = String>) -> String {
    let names: HashSet<_> = existing.collect();
    if !names.contains(base) {
        return base.into();
    }
    for i in 2.. {
        let candidate = format!("{base} ({i})");
        if !names.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}
fn registry(
    state: &WorkspaceState,
) -> Result<std::sync::MutexGuard<'_, Vec<Arc<ProjectHandle>>>, String> {
    state
        .projects
        .lock()
        .map_err(|_| "Project registry unavailable".into())
}
pub(crate) fn handle(state: &WorkspaceState, id: u64) -> Result<Arc<ProjectHandle>, String> {
    for item in registry(state)?.iter() {
        if item.id == id {
            return Ok(item.clone());
        }
    }
    Err("Project is no longer open".into())
}
pub(crate) fn lock_project(
    handle: &Arc<ProjectHandle>,
) -> Result<std::sync::MutexGuard<'_, ProjectSession>, String> {
    let project = handle.session.lock().map_err(|_| "Project unavailable")?;
    if handle.closed.load(AtomicOrdering::Acquire) {
        return Err("Project is no longer open".into());
    }
    Ok(project)
}
pub(super) fn find_document(state: &WorkspaceState, id: u64) -> Result<DocumentHandle, String> {
    let projects = registry(state)?.clone();
    for project in projects {
        if let Some(document) = project
            .documents
            .lock()
            .map_err(|_| "Table directory unavailable")?
            .get(&id)
        {
            return Ok(document.clone());
        }
    }
    Err(format!("document {id} is not open"))
}
impl ProjectSession {
    fn from_data(
        mut data: ProjectData,
        path: Option<PathBuf>,
        dirty: bool,
    ) -> Result<Self, String> {
        archive::validate(&data)?;
        let runtime_id = next_session_identity();
        let mut tables = Vec::new();
        for (meta, rows) in data.tables.iter().zip(std::mem::take(&mut data.rows)) {
            let mut session = session_from_recovery(RecoveryPayload {
                rows,
                path: None,
                dialect: meta.dialect,
                header_enabled: meta.header_enabled,
                column_types: meta.column_types.clone(),
            });
            session.sheet = meta.sheet.clone();
            session.sheet.invalidate_all();
            session.sync_sheet();
            session.project_id = Some(runtime_id);
            session.title = Some(meta.name.clone());
            session.view = meta.view.clone();
            session.saved_state = session.current_state;
            session.rebuild_view();
            tables.push(Arc::new(Mutex::new(session)));
        }
        let mut project = Self {
            runtime_id,
            data,
            path,
            tables,
            saved_signature: String::new(),
            calculation: CalculationSummary::default(),
            calculation_generation: 0,
        };
        project.data.version = 2;
        project.data.rows.clear();
        if !dirty {
            project.saved_signature = project.signature()?;
        }
        Ok(project)
    }
    fn save_to(&mut self, destination: PathBuf) -> Result<ProjectSummary, String> {
        let handles = self.tables.clone();
        let mut sessions = handles
            .iter()
            .map(lock_document)
            .collect::<Result<Vec<_>, _>>()?;
        let data = self.snapshot_with(&sessions);
        archive::write(&destination, &data)?;
        for session in &mut sessions {
            session.saved_state = session.current_state;
        }
        self.path = Some(destination);
        self.saved_signature = self.signature_with(&sessions)?;
        drop(sessions);
        self.summary()
    }
    fn signature_with(
        &self,
        sessions: &[std::sync::MutexGuard<'_, DocumentSession>],
    ) -> Result<String, String> {
        let states: Vec<_> = sessions
            .iter()
            .map(|s| (s.identity, s.revision, s.current_state))
            .collect();
        serde_json::to_string(&(&self.data, states)).map_err(|e| e.to_string())
    }
    fn signature(&self) -> Result<String, String> {
        let sessions = self
            .tables
            .iter()
            .map(lock_document)
            .collect::<Result<Vec<_>, _>>()?;
        self.signature_with(&sessions)
    }
    pub(crate) fn summary(&self) -> Result<ProjectSummary, String> {
        let sessions = self
            .tables
            .iter()
            .map(lock_document)
            .collect::<Result<Vec<_>, _>>()?;
        let revision = self.signature_with(&sessions)?;
        // Compact UI fingerprint; the full signature remains internal for equality.
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        revision.hash(&mut hash);
        for s in &sessions {
            s.calculation_revision.hash(&mut hash);
        }
        Ok(ProjectSummary {
            functions: self.data.functions.clone(),
            calculation: CalculationSummary {
                enabled: self.calculation.enabled,
                running: self.calculation.running,
                paused: self.calculation.paused,
                error: self.calculation.error.clone(),
            },
            project_id: self.runtime_id,
            persistent_id: self.data.id.clone(),
            name: self.data.name.clone(),
            path: self.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            dirty: revision != self.saved_signature,
            revision: format!("{:x}", hash.finish()),
            tables: self
                .data
                .tables
                .iter()
                .zip(&sessions)
                .map(|(m, s)| ProjectTableSummary {
                    id: m.id.clone(),
                    document: s.summary(),
                })
                .collect(),
            scripts: self.data.scripts.clone(),
        })
    }
    fn snapshot_with(
        &self,
        sessions: &[std::sync::MutexGuard<'_, DocumentSession>],
    ) -> ProjectData {
        let mut data = self.data.clone();
        for (meta, session) in data.tables.iter_mut().zip(sessions) {
            meta.sheet = session.sheet.clone();
            meta.dialect = session.dialect;
            meta.header_enabled = session.header_enabled;
            meta.column_types = session.column_types.clone();
            meta.view = session.view.clone();
        }
        data.rows = sessions
            .iter()
            .map(|s| s.document.rows().to_vec())
            .collect();
        data
    }
    fn add_table(&mut self, mut session: DocumentSession, title: &str) -> Result<u64, String> {
        let title = unique_name(
            &name(title)?,
            self.data.tables.iter().map(|m| m.name.clone()),
        );
        session.path = None;
        session.project_id = Some(self.runtime_id);
        session.title = Some(title.clone());
        session.sync_sheet();
        session.rebuild_view();
        self.data.tables.push(TableMetadata {
            sheet: session.sheet.clone(),
            id: persistent_id(),
            name: title,
            dialect: session.dialect,
            header_enabled: session.header_enabled,
            column_types: session.column_types.clone(),
            view: session.view.clone(),
        });
        let id = session.identity;
        self.tables.push(Arc::new(Mutex::new(session)));
        Ok(id)
    }
    pub(crate) fn script_input(
        &self,
        script_id: &str,
    ) -> Result<(ScriptSummary, DocumentHandle), String> {
        let script = self
            .data
            .scripts
            .iter()
            .find(|s| s.id == script_id)
            .ok_or("Script is no longer available")?
            .clone();
        let index = self
            .data
            .tables
            .iter()
            .position(|t| Some(&t.id) == script.input_table_id.as_ref())
            .ok_or("Choose an input table")?;
        Ok((script, self.tables[index].clone()))
    }
    pub(crate) fn add_result(
        &mut self,
        rows: Vec<Vec<String>>,
        input: &MacroDocumentSnapshot,
        script_name: &str,
    ) -> Result<(), String> {
        let mut session = session_from_recovery(RecoveryPayload {
            rows,
            path: None,
            dialect: CsvDialect {
                delimiter: input.delimiter.as_bytes()[0],
                line_ending: input.line_ending,
            },
            header_enabled: input.header_enabled,
            column_types: HashMap::new(),
        });
        session.view = ViewState::default();
        session.rebuild_view();
        self.add_table(
            session,
            &format!("{} result", script_name.trim_end_matches(".py")),
        )?;
        Ok(())
    }
}
pub(super) fn summaries(state: &WorkspaceState) -> Result<Vec<ProjectSummary>, String> {
    let handles = registry(state)?.clone();
    handles.iter().map(|p| lock_project(p)?.summary()).collect()
}
pub(super) fn ensure_not_project_path(state: &WorkspaceState, path: &Path) -> Result<(), String> {
    let handles = registry(state)?.clone();
    for project in &handles {
        if lock_project(project)?
            .path
            .as_deref()
            .is_some_and(|p| canonical_key(p) == canonical_key(path))
        {
            return Err("An open project already uses this path".into());
        }
    }
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("tablune"))
    {
        return Err("Use project open/save for .tablune files".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn project_new(
    app: AppHandle,
    name: String,
    source_document_id: Option<u64>,
) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_new_internal(&app.state::<WorkspaceState>(), name, source_document_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn project_new_internal(
    state: &WorkspaceState,
    name: String,
    source_document_id: Option<u64>,
) -> Result<ProjectSummary, String> {
    let source = source_document_id
        .map(|id| document_handle(state, id))
        .transpose()?;
    let mut project = ProjectSession::from_data(
        ProjectData {
            functions: FunctionsData::default(),
            version: 1,
            id: persistent_id(),
            name: self::name(&name)?,
            tables: Vec::new(),
            scripts: Vec::new(),
            rows: Vec::new(),
        },
        None,
        true,
    )?;
    if let Some(source) = source {
        let source = lock_document(&source)?;
        let mut table = source.duplicate_to(PathBuf::new());
        table.view = source.view.clone();
        table.rebuild_view();
        project.add_table(table, &source.summary().display_name)?;
    }
    let summary = project.summary()?;
    registry(state)?.push(Arc::new(ProjectHandle::new(project)));
    Ok(summary)
}
#[tauri::command]
pub async fn project_open(app: AppHandle, path: String) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_open_internal(&app, &app.state::<WorkspaceState>(), path)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn project_open_internal(
    app: &AppHandle,
    state: &WorkspaceState,
    path: String,
) -> Result<ProjectSummary, String> {
    let _reservation = ProjectPathReservation::acquire(Path::new(&path))?;
    let key = canonical_key(Path::new(&path));
    {
        let items = registry(state)?.clone();
        for p in items {
            let p = lock_project(&p)?;
            if p.path.as_deref().is_some_and(|p| canonical_key(p) == key) {
                remember(app, &path, "project");
                return p.summary();
            }
        }
    }
    let data = archive::read(Path::new(&path))?;
    let project = ProjectSession::from_data(data, Some(PathBuf::from(&path)), false)?;
    let mut registry = registry(state)?;
    for p in registry.iter() {
        let p = lock_project(p)?;
        if p.path.as_deref().is_some_and(|p| canonical_key(p) == key) {
            remember(app, &path, "project");
            return p.summary();
        }
    }
    // Standalone CSV commands reject .tablune, but also protect unusual extensions.
    if find_document_by_path(state, Path::new(&path), None)?.is_some() {
        return Err("An open CSV already uses this path".into());
    }
    let summary = project.summary()?;
    registry.push(Arc::new(ProjectHandle::new(project)));
    drop(registry);
    remember(app, &path, "project");
    Ok(summary)
}
#[tauri::command]
pub async fn project_save(
    app: AppHandle,
    project_id: u64,
    path: String,
) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_save_internal(&app, &app.state::<WorkspaceState>(), project_id, path)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn project_save_internal(
    app: &AppHandle,
    state: &WorkspaceState,
    project_id: u64,
    path: String,
) -> Result<ProjectSummary, String> {
    let destination = PathBuf::from(&path);
    let _reservation = ProjectPathReservation::acquire(&destination)?;
    let registry = registry(state)?.clone();
    for p in registry.iter() {
        let p = lock_project(p)?;
        if p.runtime_id != project_id
            && p.path
                .as_deref()
                .is_some_and(|p| canonical_key(p) == canonical_key(&destination))
        {
            return Err("Another project already uses this path".into());
        }
    }
    if find_document_by_path(state, &destination, None)?.is_some() {
        return Err("An open CSV already uses this path".into());
    }
    let handle = registry
        .iter()
        .find(|p| p.id == project_id)
        .cloned()
        .ok_or("Project is no longer open")?;
    let mut project = lock_project(&handle)?;
    drop(registry);
    let summary = project.save_to(destination)?;
    drop(project);
    remember(app, &path, "project");
    if let Err(e) = write_recovery(app, state) {
        report_nonfatal("project recovery after save", &e);
    }
    Ok(summary)
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectAction {
    NewTable,
    ImportTable {
        path: String,
    },
    RenameTable {
        table_id: String,
        name: String,
    },
    DuplicateTable {
        table_id: String,
    },
    DeleteTable {
        table_id: String,
    },
    NewScript,
    UpdateFunctions {
        code: String,
        expected_revision: u64,
    },
    ImportScript {
        name: String,
        code: String,
    },
    UpdateScript {
        script_id: String,
        name: String,
        code: String,
        input_table_id: Option<String>,
        expected_revision: u64,
    },
    DeleteScript {
        script_id: String,
    },
}
#[tauri::command]
pub async fn project_action(
    app: AppHandle,
    project_id: u64,
    action: ProjectAction,
) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_action(&app.state::<WorkspaceState>(), project_id, action)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn apply_action(
    state: &WorkspaceState,
    project_id: u64,
    action: ProjectAction,
) -> Result<ProjectSummary, String> {
    let handle = handle(state, project_id)?;
    let mut p = lock_project(&handle)?;
    match action {
        ProjectAction::UpdateFunctions {
            code,
            expected_revision,
        } => {
            if code.len() > 1024 * 1024 {
                return Err("Functions code exceeds 1 MiB".into());
            }
            if p.data.functions.draft_revision != expected_revision {
                return Err("Functions draft changed; refresh before editing".into());
            }
            if p.data.functions.draft != code {
                p.data.functions.draft = code;
                p.data.functions.draft_revision += 1;
            }
        }
        ProjectAction::NewTable => {
            p.add_table(DocumentSession::default(), "Table")?;
        }
        ProjectAction::ImportTable { path } => {
            let file = tablune_csv::read_path(&path).map_err(|e| e.to_string())?;
            let header = suggest_header(file.document.rows());
            let session = DocumentSession::from_file(
                PathBuf::from(&path),
                file,
                FilePreferences {
                    header_enabled: Some(header),
                    ..FilePreferences::default()
                },
            );
            p.add_table(
                session,
                Path::new(&path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Table"),
            )?;
        }
        ProjectAction::RenameTable {
            table_id,
            name: title,
        } => {
            let title = name(&title)?;
            let index = p
                .data
                .tables
                .iter()
                .position(|t| t.id == table_id)
                .ok_or("Table not found")?;
            if p.data
                .tables
                .iter()
                .any(|t| t.id != table_id && t.name == title)
            {
                return Err("A table already has that name".into());
            }
            p.data.tables[index].name = title.clone();
            lock_document(&p.tables[index])?.title = Some(title);
        }
        ProjectAction::DuplicateTable { table_id } => {
            let i = p
                .data
                .tables
                .iter()
                .position(|t| t.id == table_id)
                .ok_or("Table not found")?;
            let mut session = {
                let s = lock_document(&p.tables[i])?;
                let mut copy = s.duplicate_to(PathBuf::new());
                copy.view = s.view.clone();
                copy
            };
            session.rebuild_view();
            let title = p.data.tables[i].name.clone();
            p.add_table(session, &title)?;
        }
        ProjectAction::DeleteTable { table_id } => {
            let i = p
                .data
                .tables
                .iter()
                .position(|t| t.id == table_id)
                .ok_or("Table not found")?;
            p.data.tables.remove(i);
            p.tables.remove(i);
            for s in &mut p.data.scripts {
                if s.input_table_id.as_ref() == Some(&table_id) {
                    s.input_table_id = None;
                    s.revision += 1;
                }
            }
        }
        ProjectAction::NewScript => {
            let title = unique_name(
                "Transform.py",
                p.data.scripts.iter().map(|s| s.name.clone()),
            );
            let input = p.data.tables.first().map(|t| t.id.clone());
            p.data.scripts.push(ScriptSummary {
                id: persistent_id(),
                name: title,
                code: "def transform(rows, context):\n    return rows\n".into(),
                revision: 0,
                input_table_id: input,
            });
        }
        ProjectAction::ImportScript { name: title, code } => {
            if code.len() > 1024 * 1024 {
                return Err("Script exceeds 1 MiB".into());
            }
            let title = unique_name(
                &name(&title)?,
                p.data.scripts.iter().map(|s| s.name.clone()),
            );
            let input = p.data.tables.first().map(|t| t.id.clone());
            p.data.scripts.push(ScriptSummary {
                id: persistent_id(),
                name: title,
                code,
                revision: 0,
                input_table_id: input,
            });
        }
        ProjectAction::UpdateScript {
            script_id,
            name: title,
            code,
            input_table_id,
            expected_revision,
        } => {
            let title = name(&title)?;
            if code.len() > 1024 * 1024 {
                return Err("Script exceeds 1 MiB".into());
            }
            if input_table_id
                .as_ref()
                .is_some_and(|id| !p.data.tables.iter().any(|t| &t.id == id))
            {
                return Err("Input table is not in this project".into());
            }
            if p.data
                .scripts
                .iter()
                .any(|s| s.id != script_id && s.name == title)
            {
                return Err("A script already has that name".into());
            }
            let script = p
                .data
                .scripts
                .iter_mut()
                .find(|s| s.id == script_id)
                .ok_or("Script not found")?;
            if script.revision != expected_revision {
                return Err("Script changed; reload it before editing".into());
            }
            script.name = title;
            script.code = code;
            script.input_table_id = input_table_id;
            script.revision += 1;
        }
        ProjectAction::DeleteScript { script_id } => {
            let i = p
                .data
                .scripts
                .iter()
                .position(|s| s.id == script_id)
                .ok_or("Script not found")?;
            p.data.scripts.remove(i);
        }
    }
    update_directory(&handle, &p)?;
    p.summary()
}
#[tauri::command]
pub fn project_close(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    runtime: State<'_, crate::python_macros::PythonRuntimeState>,
    project_id: u64,
    discard_unsaved: bool,
) -> Result<(), String> {
    if crate::python_macros::project_running(&runtime, project_id)? {
        return Err("Cancel this project's Python execution before closing".into());
    }
    let mut registry = registry(&state)?;
    let i = registry
        .iter()
        .position(|p| p.id == project_id)
        .ok_or("Project not found")?;
    if lock_project(&registry[i])?.summary()?.dirty && !discard_unsaved {
        return Err("Save or discard this project before closing".into());
    }
    let closing = lock_project(&registry[i])?;
    if closing.calculation.running {
        return Err("Cancel this project’s calculation before closing".into());
    }
    registry[i].closed.store(true, AtomicOrdering::Release);
    drop(closing);
    let removed = registry.remove(i);
    drop(registry);
    if let Err(error) = write_recovery(&app, &state) {
        removed.closed.store(false, AtomicOrdering::Release);
        let mut items = self::registry(&state)?;
        let index = i.min(items.len());
        items.insert(index, removed);
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub fn project_export_table(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    path: String,
) -> Result<(), String> {
    ensure_path_available(&state, Path::new(&path), 0)?;
    let handle = document_handle(&state, document_id)?;
    let s = lock_document(&handle)?;
    s.ensure_calculated()?;
    tablune_csv::write_path(
        path,
        &TableDocument::from_rows(s.materialized_rows()),
        s.dialect,
    )
    .map_err(|e| e.to_string())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub kind: String,
}
fn recent_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recents.json"))
}
static RECENTS_LOCK: Mutex<()> = Mutex::new(());
pub(super) fn remember(app: &AppHandle, path: &str, kind: &str) {
    let result = (|| -> Result<(), String> {
        let _lock = RECENTS_LOCK.lock().map_err(|e| e.to_string())?;
        let file = recent_path(app)?;
        let mut items: Vec<RecentFile> = if file.exists() {
            read_json(&file)?
        } else {
            Vec::new()
        };
        let key = canonical_key(Path::new(path));
        items.retain(|r| r.path != key);
        items.insert(
            0,
            RecentFile {
                path: key,
                kind: kind.into(),
            },
        );
        items.truncate(20);
        write_bytes_atomic(
            &file,
            &serde_json::to_vec(&items).map_err(|e| e.to_string())?,
        )
    })();
    if let Err(e) = result {
        report_nonfatal("recent files", &e);
    }
}
#[tauri::command]
pub fn recent_files(app: AppHandle) -> Result<Vec<RecentFile>, String> {
    let _lock = RECENTS_LOCK.lock().map_err(|e| e.to_string())?;
    let path = recent_path(&app)?;
    if path.exists() {
        read_json(&path)
    } else {
        Ok(Vec::new())
    }
}
#[tauri::command]
pub fn recent_remove(app: AppHandle, path: String) -> Result<(), String> {
    let _lock = RECENTS_LOCK.lock().map_err(|e| e.to_string())?;
    let file = recent_path(&app)?;
    let mut items: Vec<RecentFile> = if file.exists() {
        read_json(&file)?
    } else {
        Vec::new()
    };
    items.retain(|r| r.path != path);
    write_bytes_atomic(
        &file,
        &serde_json::to_vec(&items).map_err(|e| e.to_string())?,
    )
}
#[derive(Serialize, Deserialize)]
pub(super) struct RecoveryProject {
    data: ProjectData,
    rows: Vec<Vec<Vec<String>>>,
    path: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
struct RecoveryProjects {
    version: u8,
    projects: Vec<RecoveryProject>,
}
pub(super) fn recovery_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects-recovery.json"))
}
static RECOVERY_LOCK: Mutex<()> = Mutex::new(());
pub(super) fn write_recovery(app: &AppHandle, state: &WorkspaceState) -> Result<(), String> {
    let _lock = RECOVERY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut projects = Vec::new();
    let handles = registry(state)?.clone();
    for handle in &handles {
        let p = lock_project(handle)?;
        let sessions = p
            .tables
            .iter()
            .map(lock_document)
            .collect::<Result<Vec<_>, _>>()?;
        if p.signature_with(&sessions)? == p.saved_signature {
            continue;
        }
        let mut data = p.snapshot_with(&sessions);
        let rows = std::mem::take(&mut data.rows);
        projects.push(RecoveryProject {
            data,
            rows,
            path: p.path.clone(),
        });
    }
    let path = recovery_path(app)?;
    if projects.is_empty() {
        remove_if_exists(&path).map_err(|e| e.to_string())
    } else {
        write_bytes_atomic(
            &path,
            &serde_json::to_vec(&RecoveryProjects {
                version: 2,
                projects,
            })
            .map_err(|e| e.to_string())?,
        )
    }
}
pub(super) fn discard_recovery(app: &AppHandle) -> Result<(), String> {
    let _lock = RECOVERY_LOCK
        .lock()
        .map_err(|_| "Recovery writer unavailable")?;
    remove_if_exists(&recovery_path(app)?).map_err(|e| e.to_string())
}
pub(super) fn read_recovery(app: &AppHandle) -> Result<Vec<RecoveryProject>, String> {
    let path = recovery_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut payload: RecoveryProjects = read_json(&path)?;
    if !matches!(payload.version, 1 | 2) {
        return Err("Unsupported project recovery version".into());
    }
    for p in &mut payload.projects {
        p.data.rows = std::mem::take(&mut p.rows);
        archive::validate(&p.data)?;
    }
    Ok(payload.projects)
}
pub(super) fn restore_projects(
    state: &WorkspaceState,
    projects: Vec<RecoveryProject>,
) -> Result<(), String> {
    let restored = projects
        .into_iter()
        .map(|p| {
            ProjectSession::from_data(p.data, p.path, true).map(|p| Arc::new(ProjectHandle::new(p)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    *registry(state)? = restored;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> ProjectData {
        ProjectData {
            functions: FunctionsData::default(),
            version: 1,
            id: "project-fixture".into(),
            name: "Ventas México".into(),
            tables: vec![TableMetadata {
                sheet: SheetData::default(),
                id: "table-fixture".into(),
                name: "Ventas".into(),
                dialect: CsvDialect {
                    delimiter: b';',
                    line_ending: LineEnding::CrLf,
                },
                header_enabled: true,
                column_types: HashMap::from([(1, ColumnType::Number)]),
                view: ViewState {
                    sorts: vec![SortSpec {
                        column: 1,
                        direction: SortDirection::Descending,
                        column_type: ColumnType::Number,
                    }],
                    filters: Vec::new(),
                },
            }],
            scripts: vec![ScriptSummary {
                id: "script-fixture".into(),
                name: "Limpiar.py".into(),
                code: "def transform(rows, context):\n    return rows\n".into(),
                revision: 3,
                input_table_id: Some("table-fixture".into()),
            }],
            rows: vec![vec![
                vec!["nombre".into(), "importe".into()],
                vec!["José\n二".into(), "0012.30".into()],
                vec![],
                vec!["".into()],
                vec!["a;\"b".into(), "".into()],
            ]],
        }
    }
    fn temporary_path() -> PathBuf {
        let dir = std::env::temp_dir().join(persistent_id());
        fs::create_dir(&dir).unwrap();
        dir.join("test.tablune")
    }
    fn add_project(state: &WorkspaceState, data: ProjectData) -> u64 {
        let p = ProjectSession::from_data(data, None, false).unwrap();
        let id = p.runtime_id;
        registry(state)
            .unwrap()
            .push(Arc::new(ProjectHandle::new(p)));
        id
    }
    #[test]
    fn archive_round_trip_preserves_text_shapes_scripts_and_metadata() {
        let path = temporary_path();
        let data = fixture();
        archive::write(&path, &data).unwrap();
        let loaded = archive::read(&path).unwrap();
        assert_eq!(loaded.rows, data.rows);
        assert_eq!(loaded.scripts[0].code, data.scripts[0].code);
        assert_eq!(loaded.tables[0].dialect.delimiter, b';');
        assert_eq!(loaded.tables[0].dialect.line_ending, LineEnding::CrLf);
        assert_eq!(
            loaded.tables[0].column_types.get(&1),
            Some(&ColumnType::Number)
        );
        assert_eq!(loaded.tables[0].view.sorts.len(), 1);
        let p = ProjectSession::from_data(loaded, Some(path.clone()), false).unwrap();
        let summary = p.summary().unwrap();
        assert!(!summary.dirty);
        assert_eq!(summary.tables[0].document.project_id, Some(p.runtime_id));
        assert_eq!(summary.tables[0].document.path, None);
        assert!(!summary.tables[0].document.can_undo);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn archives_reject_bad_versions_identifiers_and_missing_references() {
        let mut data = fixture();
        data.version = 99;
        assert!(archive::validate(&data).is_err());
        data.version = 1;
        data.tables[0].id = "../escape".into();
        assert!(archive::validate(&data).is_err());
        let mut data = fixture();
        data.scripts[0].input_table_id = Some("missing".into());
        assert!(archive::validate(&data).is_err());
        let path = temporary_path();
        fs::write(&path, b"not a zip").unwrap();
        assert!(archive::read(&path).is_err());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn failed_write_preserves_existing_archive() {
        let path = temporary_path();
        let data = fixture();
        archive::write(&path, &data).unwrap();
        let bytes = fs::read(&path).unwrap();
        let mut invalid = data.clone();
        invalid.rows.clear();
        assert!(archive::write(&path, &invalid).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let bad = path.join("no-parent.tablune");
        assert!(archive::write(&bad, &data).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn two_copies_have_independent_sessions_and_script_revisions() {
        let state = WorkspaceState::default();
        assert!(
            workspace_summary_value(&state)
                .unwrap()
                .documents
                .is_empty()
        );
        let a = add_project(&state, fixture());
        let b = add_project(&state, fixture());
        let ah = handle(&state, a).unwrap();
        let bh = handle(&state, b).unwrap();
        let aid = lock_project(&ah).unwrap().summary().unwrap().tables[0]
            .document
            .document_id;
        let bid = lock_project(&bh).unwrap().summary().unwrap().tables[0]
            .document
            .document_id;
        assert_ne!(aid, bid);
        let doc = document_handle(&state, aid).unwrap();
        let revision = lock_document(&doc).unwrap().revision;
        lock_document(&doc)
            .unwrap()
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 1,
                        column: 0,
                        value: "Modified".into(),
                    }],
                },
                revision,
            )
            .unwrap();
        assert!(lock_project(&ah).unwrap().summary().unwrap().dirty);
        assert!(!lock_project(&bh).unwrap().summary().unwrap().dirty);
        let script = fixture().scripts.remove(0);
        let result = apply_action(
            &state,
            b,
            ProjectAction::UpdateScript {
                script_id: script.id.clone(),
                name: script.name.clone(),
                code: "# only code changed".into(),
                input_table_id: script.input_table_id.clone(),
                expected_revision: 3,
            },
        )
        .unwrap();
        assert!(result.dirty);
        assert_eq!(result.scripts[0].revision, 4);
        assert!(
            apply_action(
                &state,
                b,
                ProjectAction::UpdateScript {
                    script_id: script.id,
                    name: script.name,
                    code: String::new(),
                    input_table_id: script.input_table_id,
                    expected_revision: 3
                }
            )
            .is_err()
        );
    }
    #[test]
    fn deleting_input_clears_script_binding_and_duplicate_preserves_view() {
        let state = WorkspaceState::default();
        let id = add_project(&state, fixture());
        let result = apply_action(
            &state,
            id,
            ProjectAction::DuplicateTable {
                table_id: "table-fixture".into(),
            },
        )
        .unwrap();
        assert_eq!(result.tables.len(), 2);
        assert_eq!(result.tables[1].document.view.sorts.len(), 1);
        assert_eq!(result.tables[1].document.display_name, "Ventas (2)");
        let result = apply_action(
            &state,
            id,
            ProjectAction::DeleteTable {
                table_id: "table-fixture".into(),
            },
        )
        .unwrap();
        assert_eq!(result.scripts[0].input_table_id, None);
        assert_eq!(result.scripts[0].revision, 4);
    }
    #[test]
    fn script_only_recovery_restores_unsaved_work_and_new_runtime_ids() {
        let state = WorkspaceState::default();
        let id = add_project(&state, fixture());
        apply_action(
            &state,
            id,
            ProjectAction::UpdateScript {
                script_id: "script-fixture".into(),
                name: "Limpiar.py".into(),
                code: "# unsaved script".into(),
                input_table_id: Some("table-fixture".into()),
                expected_revision: 3,
            },
        )
        .unwrap();
        let h = handle(&state, id).unwrap();
        let p = lock_project(&h).unwrap();
        let sessions = p
            .tables
            .iter()
            .map(lock_document)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut data = p.snapshot_with(&sessions);
        let rows = std::mem::take(&mut data.rows);
        let encoded = serde_json::to_vec(&RecoveryProjects {
            version: 1,
            projects: vec![RecoveryProject {
                data,
                rows,
                path: None,
            }],
        })
        .unwrap();
        let mut payload: RecoveryProjects = serde_json::from_slice(&encoded).unwrap();
        let mut entry = payload.projects.remove(0);
        entry.data.rows = entry.rows;
        let restored = ProjectSession::from_data(entry.data, None, true).unwrap();
        let summary = restored.summary().unwrap();
        assert!(summary.dirty);
        assert_eq!(summary.scripts[0].code, "# unsaved script");
        assert_ne!(summary.project_id, id);
    }
    #[test]
    fn each_python_result_is_an_independent_editable_table() {
        let mut p = ProjectSession::from_data(fixture(), None, false).unwrap();
        let snapshot = lock_document(&p.tables[0]).unwrap().macro_snapshot();
        p.add_result(snapshot.rows.clone(), &snapshot, "Clean.py")
            .unwrap();
        p.add_result(snapshot.rows.clone(), &snapshot, "Clean.py")
            .unwrap();
        assert_eq!(p.tables.len(), 3);
        assert_eq!(
            p.summary().unwrap().tables[2].document.display_name,
            "Clean result (2)"
        );
        let mut result = lock_document(&p.tables[1]).unwrap();
        let rev = result.revision;
        result
            .apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 1,
                        column: 0,
                        value: "Edited result".into(),
                    }],
                },
                rev,
            )
            .unwrap();
        drop(result);
        assert_eq!(
            lock_document(&p.tables[0]).unwrap().document.rows(),
            snapshot.rows
        );
        assert_eq!(
            lock_document(&p.tables[2]).unwrap().document.rows(),
            snapshot.rows
        );
    }
    #[test]
    fn project_save_commits_table_dirty_state_and_keeps_failed_saves_dirty() {
        let mut p = ProjectSession::from_data(fixture(), None, true).unwrap();
        {
            let mut table = lock_document(&p.tables[0]).unwrap();
            let revision = table.revision;
            table
                .apply_edit(
                    EditCommand::SetCells {
                        cells: vec![CellInput {
                            row: 1,
                            column: 0,
                            value: "changed".into(),
                        }],
                    },
                    revision,
                )
                .unwrap();
        }
        let path = temporary_path();
        assert!(p.save_to(path.join("missing")).is_err());
        assert!(p.summary().unwrap().dirty);
        let summary = p.save_to(path.clone()).unwrap();
        assert!(!summary.dirty);
        assert!(!summary.tables[0].document.dirty);
        assert_eq!(archive::read(&path).unwrap().rows[0][1][0], "changed");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn csv_conversion_copies_unsaved_data_without_changing_source() {
        let state = WorkspaceState::default();
        let source = Arc::new(Mutex::new(DocumentSession::default()));
        let id = {
            let mut s = lock_document(&source).unwrap();
            s.apply_edit(
                EditCommand::SetCells {
                    cells: vec![CellInput {
                        row: 0,
                        column: 0,
                        value: "001.00".into(),
                    }],
                },
                0,
            )
            .unwrap();
            s.identity
        };
        lock_workspace(&state).unwrap().push(source.clone());
        let p = project_new_internal(&state, "Converted".into(), Some(id)).unwrap();
        assert!(lock_document(&source).unwrap().summary().dirty);
        assert_eq!(workspace_summary_value(&state).unwrap().documents.len(), 1);
        assert_eq!(
            lock_document(&document_handle(&state, p.tables[0].document.document_id).unwrap())
                .unwrap()
                .document
                .rows()[0][0],
            "001.00"
        );
    }
    #[test]
    fn another_projects_table_lookup_does_not_wait_for_a_save_lock() {
        let state = Arc::new(WorkspaceState::default());
        let a = add_project(&state, fixture());
        let b = add_project(&state, fixture());
        let target = lock_project(&handle(&state, b).unwrap())
            .unwrap()
            .summary()
            .unwrap()
            .tables[0]
            .document
            .document_id;
        let a_handle = handle(&state, a).unwrap();
        let saving = lock_project(&a_handle).unwrap();
        let (send, recv) = std::sync::mpsc::channel();
        let reader = state.clone();
        let worker = std::thread::spawn(move || {
            let result =
                document_handle(&reader, target).and_then(|h| Ok(lock_document(&h)?.identity));
            send.send(result).unwrap();
        });
        let result = recv.recv_timeout(std::time::Duration::from_secs(1));
        drop(saving);
        worker.join().unwrap();
        assert_eq!(result.unwrap().unwrap(), target);
    }
    #[test]
    fn canonical_path_reservations_prevent_concurrent_save_as_collisions() {
        let path = temporary_path();
        let first = ProjectPathReservation::acquire(&path).unwrap();
        assert!(ProjectPathReservation::acquire(&path).is_err());
        drop(first);
        assert!(ProjectPathReservation::acquire(&path).is_ok());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    #[ignore = "100k x 50 project save/open benchmark"]
    fn project_100k_by_50_round_trip() {
        let mut data = fixture();
        data.rows = vec![
            (0..100_000)
                .map(|r| (0..50).map(|c| format!("{}", (r + c) % 10_000)).collect())
                .collect(),
        ];
        let path = temporary_path();
        let start = std::time::Instant::now();
        archive::write(&path, &data).unwrap();
        let saved = start.elapsed();
        drop(data);
        let start = std::time::Instant::now();
        let data = archive::read(&path).unwrap();
        let opened = start.elapsed();
        let start = std::time::Instant::now();
        let p = ProjectSession::from_data(data, Some(path.clone()), false).unwrap();
        eprintln!(
            "project 100k x 50: save={saved:?}, read={opened:?}, session={:?}, bytes={}",
            start.elapsed(),
            fs::metadata(&path).unwrap().len()
        );
        assert_eq!(p.summary().unwrap().tables[0].document.row_count, 100_000);
        #[cfg(target_os = "macos")]
        {
            let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
            // getrusage initializes the complete output on success.
            if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0 {
                let usage = unsafe { usage.assume_init() };
                eprintln!("project benchmark peak RSS: {} bytes", usage.ru_maxrss);
            }
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn format_two_preserves_formulas_functions_drafts_and_cached_values_without_execution() {
        let mut p = ProjectSession::from_data(fixture(), None, true).unwrap();
        p.data.functions = FunctionsData {
            draft: "def f(x):\n    return x*3\n".into(),
            applied: "def f(x):\n    return x*2\n".into(),
            revision: 4,
            draft_revision: 5,
        };
        {
            let mut s = lock_document(&p.tables[0]).unwrap();
            let revision = s.revision;
            s.apply_edit(
                EditCommand::SetSheetCells {
                    cells: vec![sheets::SheetCellInput {
                        row: 1,
                        column: 2,
                        value: "=f(21)".into(),
                        literal: false,
                        cell_type: None,
                    }],
                },
                revision,
            )
            .unwrap();
            calculation::calculate_for_test(&mut s, &p.data.functions.applied);
            assert_eq!(s.cell_value(1, 2), "42");
        }
        let path = temporary_path();
        p.save_to(path.clone()).unwrap();
        let data = archive::read(&path).unwrap();
        assert_eq!(data.version, 2);
        assert_eq!(data.functions.draft, p.data.functions.draft);
        assert_eq!(data.functions.applied, p.data.functions.applied);
        let restored = ProjectSession::from_data(data, Some(path.clone()), false).unwrap();
        assert!(!restored.calculation.enabled);
        let table = lock_document(&restored.tables[0]).unwrap();
        assert_eq!(table.raw_cell(1, 2), "=f(21)");
        assert_eq!(table.cell_value(1, 2), "42");
        assert!(table.sheet.cells["1,2"].pending);
        assert!(table.ensure_calculated().is_err());
        assert!(!restored.calculation.running);
        drop(table);
        assert!(!restored.summary().unwrap().dirty);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn legacy_archive_import_does_not_activate_text_that_looks_like_a_formula() {
        use std::io::Write;
        let path = temporary_path();
        let mut data = fixture();
        data.rows[0][1][0] = "=danger()".into();
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&data).unwrap()).unwrap();
        for (t, rows) in data.tables.iter().zip(&data.rows) {
            zip.start_file(format!("tables/{}.json", t.id), options)
                .unwrap();
            zip.write_all(&serde_json::to_vec(rows).unwrap()).unwrap();
        }
        for s in &data.scripts {
            zip.start_file(format!("scripts/{}.py", s.id), options)
                .unwrap();
            zip.write_all(s.code.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let p = ProjectSession::from_data(archive::read(&path).unwrap(), Some(path.clone()), false)
            .unwrap();
        assert_eq!(p.data.version, 2);
        let s = lock_document(&p.tables[0]).unwrap();
        assert!(!s.cell_info(1, 0).formula);
        assert_eq!(s.cell_value(1, 0), "=danger()");
        drop(s);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn recovery_keeps_unapplied_functions_and_formula_metadata() {
        let mut p = ProjectSession::from_data(fixture(), None, true).unwrap();
        p.data.functions.draft = "def unsaved(): return 7".into();
        let mut table = lock_document(&p.tables[0]).unwrap();
        table
            .edit_sheet_cells(vec![sheets::SheetCellInput {
                row: 1,
                column: 2,
                value: "=unsaved()".into(),
                literal: false,
                cell_type: Some(formulas::CellType::Auto),
            }])
            .unwrap();
        drop(table);
        let sessions = p
            .tables
            .iter()
            .map(lock_document)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut data = p.snapshot_with(&sessions);
        drop(sessions);
        let rows = std::mem::take(&mut data.rows);
        let encoded = serde_json::to_vec(&RecoveryProject {
            data,
            rows,
            path: None,
        })
        .unwrap();
        let mut recovered: RecoveryProject = serde_json::from_slice(&encoded).unwrap();
        recovered.data.rows = recovered.rows;
        let restored = ProjectSession::from_data(recovered.data, None, true).unwrap();
        assert_eq!(restored.data.functions.draft, "def unsaved(): return 7");
        assert!(restored.data.functions.applied.is_empty());
        assert!(
            lock_document(&restored.tables[0])
                .unwrap()
                .cell_info(1, 2)
                .formula
        );
        assert!(restored.summary().unwrap().dirty);
        assert!(!restored.calculation.enabled);
    }
}
