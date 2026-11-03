//! Independent, session-local script jobs. Calculation retains its own runtime/queue.
use super::*;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

const CONCURRENCY: usize = 2;
const MAX_JOBS: usize = 32;
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: u64,
    pub project_id: Option<u64>,
    pub document_id: u64,
    pub script_id: Option<String>,
    pub script_name: String,
    pub input_name: String,
    pub input_revision: u64,
    pub script_revision: Option<u64>,
    pub interpreter: String,
    pub timeout_seconds: Option<u64>,
    pub state: String,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub error: Option<String>,
    pub result_available: bool,
}
impl JobSummary {
    fn active(&self) -> bool {
        matches!(self.state.as_str(), "queued" | "running" | "cancelling")
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    summary: JobSummary,
    stdout: String,
    stderr: String,
    preview: Option<MacroPreview>,
}
struct Execution {
    interpreter: InterpreterInfo,
    runner: PathBuf,
    snapshot: MacroDocumentSnapshot,
    code: String,
    source_path: Option<String>,
}
struct Job {
    summary: JobSummary,
    runtime: Arc<Mutex<RuntimeInner>>,
    execution: Option<Execution>,
    input: MacroDocumentSnapshot,
    preview: Option<MacroPreview>,
}
#[derive(Default)]
struct JobRegistry {
    next_id: u64,
    stopping: bool,
    jobs: BTreeMap<u64, Job>,
}
#[derive(Clone, Default)]
pub struct PythonJobs(Arc<Mutex<JobRegistry>>);
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl PythonJobs {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, JobRegistry>, String> {
        self.0.lock().map_err(|_| "Python jobs unavailable".into())
    }
    fn submit(
        &self,
        execution: Execution,
        project_id: Option<u64>,
        script_id: Option<String>,
        script_name: String,
        script_revision: Option<u64>,
        timeout_seconds: Option<u64>,
    ) -> Result<JobSummary, String> {
        if execution.code.len() > CODE_LIMIT {
            return Err("Macro code cannot exceed 1 MiB".into());
        }
        if timeout_seconds == Some(0) {
            return Err("Choose a positive time limit or no limit".into());
        }
        let mut registry = self.lock()?;
        if registry.stopping {
            return Err("Python jobs are shutting down".into());
        }
        if registry.jobs.len() >= MAX_JOBS {
            return Err(
                "There are 32 retained jobs. Discard finished jobs before starting another.".into(),
            );
        }
        registry.next_id += 1;
        let id = registry.next_id;
        let summary = JobSummary {
            id,
            project_id,
            script_id,
            script_name,
            script_revision,
            document_id: execution.snapshot.document_id,
            input_name: execution.snapshot.display_name.clone(),
            input_revision: execution.snapshot.revision,
            interpreter: execution.interpreter.path.clone(),
            timeout_seconds,
            state: "queued".into(),
            created_at: now(),
            started_at: None,
            finished_at: None,
            error: None,
            result_available: false,
        };
        // Retain only input metadata after execution; queued input is owned by Execution.
        let source = &execution.snapshot;
        let input = MacroDocumentSnapshot {
            document_id: source.document_id,
            identity: source.identity,
            revision: source.revision,
            calculation_revision: source.calculation_revision,
            rows: vec![],
            header_enabled: source.header_enabled,
            display_name: source.display_name.clone(),
            delimiter: source.delimiter.clone(),
            line_ending: source.line_ending,
        };
        registry.jobs.insert(
            id,
            Job {
                summary: summary.clone(),
                runtime: Arc::new(Mutex::new(RuntimeInner {
                    background: true,
                    timeout_seconds,
                    ..Default::default()
                })),
                execution: Some(execution),
                input,
                preview: None,
            },
        );
        drop(registry);
        self.schedule();
        Ok(summary)
    }
    fn schedule(&self) {
        let Ok(mut registry) = self.lock() else {
            return;
        };
        if registry.stopping {
            return;
        }
        let active = registry
            .jobs
            .values()
            .filter(|j| matches!(j.summary.state.as_str(), "running" | "cancelling"))
            .count();
        for _ in active..CONCURRENCY {
            let Some(job) = registry
                .jobs
                .values_mut()
                .find(|j| j.summary.state == "queued")
            else {
                break;
            };
            let Some(execution) = job.execution.take() else {
                continue;
            };
            job.summary.state = "running".into();
            job.summary.started_at = Some(now());
            let id = job.summary.id;
            let project = job.summary.project_id.is_some();
            let runtime = job.runtime.clone();
            let manager = self.clone();
            thread::spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let output = run_macro(
                        runtime.clone(),
                        execution.interpreter,
                        execution.runner,
                        execution.snapshot.clone(),
                        execution.code,
                        execution.source_path,
                    )?;
                    let mut preview = build_preview(&runtime, &execution.snapshot, output)?;
                    // Logs live only in the bounded runtime buffers, not every list/preview response.
                    preview.stdout.clear();
                    preview.stderr.clear();
                    if project {
                        preview.can_apply = true;
                        preview.blocked_reason = None;
                    }
                    Ok::<_, String>(preview)
                }))
                .unwrap_or_else(|_| Err("Python job stopped unexpectedly".into()));
                if let Ok(mut rt) = runtime.lock() {
                    rt.child = None;
                }
                if let Ok(mut registry) = manager.lock() {
                    if let Some(job) = registry.jobs.get_mut(&id) {
                        let cancelled = lock_runtime(&runtime)
                            .map(|r| r.cancel_requested)
                            .unwrap_or(true);
                        job.summary.finished_at = Some(now());
                        match outcome {
                            _ if cancelled => {
                                job.summary.state = "cancelled".into();
                                if let Ok(mut rt) = runtime.lock() {
                                    rt.pending = None;
                                }
                            }
                            Ok(preview) => {
                                job.summary.state = "succeeded".into();
                                job.summary.result_available = true;
                                job.preview = Some(preview);
                            }
                            Err(error) => {
                                job.summary.state = "failed".into();
                                job.summary.error = Some(error);
                            }
                        }
                    }
                }
                manager.schedule();
            });
        }
    }
    pub(crate) fn has_active(
        &self,
        project: Option<u64>,
        document: Option<u64>,
    ) -> Result<bool, String> {
        Ok(self.lock()?.jobs.values().any(|j| {
            j.summary.active()
                && project.is_none_or(|p| j.summary.project_id == Some(p))
                && document.is_none_or(|d| j.summary.document_id == d)
        }))
    }
    fn cancel(&self, id: u64) -> Result<(), String> {
        let mut registry = self.lock()?;
        let job = registry.jobs.get_mut(&id).ok_or("Job not found")?;
        if !job.summary.active() {
            return Ok(());
        }
        let mut rt = lock_runtime(&job.runtime)?;
        rt.cancel_requested = true;
        if job.summary.state == "queued" {
            job.execution = None;
            job.summary.state = "cancelled".into();
            job.summary.finished_at = Some(now());
        } else {
            job.summary.state = "cancelling".into();
            if let Some(child) = &rt.child {
                terminate_process_tree(&mut *child.lock().map_err(|_| "Python unavailable")?);
            }
        }
        Ok(())
    }
    pub(crate) fn shutdown(&self) {
        let ids = if let Ok(mut registry) = self.lock() {
            registry.stopping = true;
            registry.jobs.keys().copied().collect::<Vec<_>>()
        } else {
            vec![]
        };
        for id in ids {
            let _ = self.cancel(id);
        }
    }
}

#[tauri::command]
pub async fn python_start_project_job(
    app: AppHandle,
    project_id: u64,
    script_id: String,
    timeout_seconds: Option<u64>,
) -> Result<JobSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let interpreter = resolve_interpreter(&app)?;
        let runner = runner_path(&app)?;
        let workspace = app.state::<WorkspaceState>();
        let handle = session::projects::handle(&workspace, project_id)?;
        let project = session::projects::lock_project(&handle)?;
        let (script, input) = project.script_input(&script_id)?;
        let document = session::lock_document(&input)?;
        document.ensure_transformable()?;
        app.state::<PythonJobs>().submit(
            Execution {
                interpreter,
                runner,
                snapshot: document.macro_snapshot(),
                code: script.code,
                source_path: None,
            },
            Some(project_id),
            Some(script_id),
            script.name,
            Some(script.revision),
            timeout_seconds,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn python_start_job(
    app: AppHandle,
    document_id: u64,
    code: String,
    source_path: Option<String>,
    expected_revision: u64,
    timeout_seconds: Option<u64>,
) -> Result<JobSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let interpreter = resolve_interpreter(&app)?;
        let runner = runner_path(&app)?;
        let workspace = app.state::<WorkspaceState>();
        let _operation = session::SessionFileOperation::acquire(document_id)?;
        let handle = session::document_handle(&workspace, document_id)?;
        let document = session::lock_document(&handle)?;
        if document.summary().project_id.is_some() {
            return Err("Use the project script editor".into());
        }
        let snapshot = document.macro_snapshot();
        if snapshot.revision != expected_revision {
            return Err("The input changed; start the job again".into());
        }
        let name = source_path
            .as_deref()
            .and_then(|s| Path::new(s).file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or("Untitled macro.py".into());
        app.state::<PythonJobs>().submit(
            Execution {
                interpreter,
                runner,
                snapshot,
                code,
                source_path,
            },
            None,
            None,
            name,
            None,
            timeout_seconds,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn python_jobs(jobs: State<'_, PythonJobs>) -> Result<Vec<JobSummary>, String> {
    Ok(jobs
        .lock()?
        .jobs
        .values()
        .rev()
        .map(|j| j.summary.clone())
        .collect())
}
#[tauri::command]
pub fn python_job_detail(jobs: State<'_, PythonJobs>, job_id: u64) -> Result<JobDetail, String> {
    let registry = jobs.lock()?;
    let job = registry.jobs.get(&job_id).ok_or("Job not found")?;
    let (stdout, stderr) = runtime_logs(&job.runtime)?;
    Ok(JobDetail {
        summary: job.summary.clone(),
        stdout,
        stderr,
        preview: job.preview.clone(),
    })
}
#[tauri::command]
pub fn python_cancel_job(jobs: State<'_, PythonJobs>, job_id: u64) -> Result<(), String> {
    jobs.cancel(job_id)
}
#[tauri::command]
pub fn python_discard_job(jobs: State<'_, PythonJobs>, job_id: u64) -> Result<(), String> {
    let mut registry = jobs.lock()?;
    if registry
        .jobs
        .get(&job_id)
        .is_some_and(|j| j.summary.active())
    {
        return Err("Cancel the job before discarding it".into());
    }
    registry.jobs.remove(&job_id);
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    project: Option<session::projects::ProjectSummary>,
    document: Option<DocumentSummary>,
}
#[tauri::command]
pub fn python_accept_job(
    workspace: State<'_, WorkspaceState>,
    jobs: State<'_, PythonJobs>,
    job_id: u64,
) -> Result<JobResult, String> {
    // Never lock a project/document while holding the registry: submission uses the opposite order.
    let (project_id, document_id) = {
        let registry = jobs.lock()?;
        let job = registry.jobs.get(&job_id).ok_or("Job not found")?;
        (job.summary.project_id, job.summary.document_id)
    };
    if let Some(project_id) = project_id {
        let handle = session::projects::handle(&workspace, project_id)?;
        let mut project = session::projects::lock_project(&handle)?;
        let mut registry = jobs.lock()?;
        let job = registry.jobs.get_mut(&job_id).ok_or("Job not found")?;
        if !job.summary.result_available {
            return Err("Result is no longer available".into());
        }
        let mut rt = lock_runtime(&job.runtime)?;
        let pending = rt.pending.as_ref().ok_or("Result is no longer available")?;
        project.add_result(pending.rows.clone(), &job.input, &job.summary.script_name)?;
        session::projects::update_directory(&handle, &project)?;
        job.summary.result_available = false;
        rt.pending = None;
        Ok(JobResult {
            project: Some(project.summary()?),
            document: None,
        })
    } else {
        let handle = session::document_handle(&workspace, document_id)?;
        let mut document = session::lock_document(&handle)?;
        let mut registry = jobs.lock()?;
        let job = registry.jobs.get_mut(&job_id).ok_or("Job not found")?;
        if !job.summary.result_available {
            return Err("Result is no longer available".into());
        }
        let mut rt = lock_runtime(&job.runtime)?;
        let pending = rt.pending.as_ref().ok_or("Result is no longer available")?;
        if !document.matches_macro_snapshot(
            job.input.identity,
            job.input.revision,
            job.input.header_enabled,
        ) {
            return Err(
                "The input table changed. This result cannot overwrite newer edits.".into(),
            );
        }
        document.apply_macro_rows(pending.rows.clone(), job.input.identity, job.input.revision)?;
        job.summary.result_available = false;
        rt.pending = None;
        Ok(JobResult {
            project: None,
            document: Some(document.summary()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn execution(code: String) -> Execution {
        Execution {
            interpreter: inspect_interpreter("python3")
                .expect("Python 3.10+ required for job integration tests"),
            runner: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/tablune_runner.py"),
            snapshot: MacroDocumentSnapshot {
                document_id: 7,
                identity: 7,
                revision: 4,
                calculation_revision: 2,
                rows: vec![vec!["captured input".into()]],
                header_enabled: false,
                display_name: "Input.csv".into(),
                delimiter: ",".into(),
                line_ending: tablune_csv::LineEnding::Lf,
            },
            code,
            source_path: None,
        }
    }
    fn submit(manager: &PythonJobs, code: String, timeout: Option<u64>) -> u64 {
        manager
            .submit(
                execution(code),
                Some(1),
                Some("script".into()),
                "Script.py".into(),
                Some(3),
                timeout,
            )
            .unwrap()
            .id
    }
    fn wait_until(mut condition: impl FnMut() -> bool) {
        let started = Instant::now();
        while !condition() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "job condition timed out"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn state(manager: &PythonJobs, id: u64) -> String {
        manager.lock().unwrap().jobs[&id].summary.state.clone()
    }
    fn stdout(manager: &PythonJobs, id: u64) -> String {
        runtime_logs(&manager.lock().unwrap().jobs[&id].runtime)
            .unwrap()
            .0
    }
    struct Shutdown(PythonJobs);
    impl Drop for Shutdown {
        fn drop(&mut self) {
            self.0.shutdown();
        }
    }

    #[test]
    fn two_jobs_stream_before_finishing_queue_a_third_and_cancel_independently() {
        let manager = PythonJobs::default();
        let _cleanup = Shutdown(manager.clone());
        let directory = TemporaryDirectory::create().unwrap();
        let release = directory.0.join("release");
        let literal = serde_json::to_string(release.to_str().unwrap()).unwrap();
        let code = format!(
            "import time\nfrom pathlib import Path\ndef run(rows, context):\n    print('ready 雪')\n    while not Path({literal}).exists():\n        time.sleep(0.02)\n    return [[rows[0][0] + ' done']]\n"
        );
        let one = submit(&manager, code.clone(), None);
        let two = submit(&manager, code, None);
        wait_until(|| {
            stdout(&manager, one).contains("ready 雪") && stdout(&manager, two).contains("ready 雪")
        });
        assert_eq!(state(&manager, one), "running");
        assert_eq!(state(&manager, two), "running");
        let three = submit(
            &manager,
            "def run(rows, context):\n    return [['third']]\n".into(),
            None,
        );
        assert_eq!(state(&manager, three), "queued");
        let four = submit(
            &manager,
            "raise Exception('must never execute')".into(),
            None,
        );
        manager.cancel(four).unwrap();
        assert_eq!(state(&manager, four), "cancelled");
        assert!(manager.lock().unwrap().jobs[&four].execution.is_none());
        manager.cancel(one).unwrap();
        wait_until(|| state(&manager, one) == "cancelled" && state(&manager, three) == "succeeded");
        assert_eq!(state(&manager, two), "running");
        assert!(manager.has_active(Some(1), None).unwrap());
        assert!(!manager.has_active(Some(2), None).unwrap());
        // Formula worker is independently usable while the second script is still running.
        let result = calculation_worker::test_request(
            serde_json::json!({"protocolVersion":1,"code":"def double(x): return x*2", "validateOnly":true}),
        );
        assert_eq!(result["functions"][0], "double");
        fs::write(release, "done").unwrap();
        wait_until(|| state(&manager, two) == "succeeded");
        let registry = manager.lock().unwrap();
        let rows = |id| {
            lock_runtime(&registry.jobs[&id].runtime)
                .unwrap()
                .pending
                .as_ref()
                .unwrap()
                .rows
                .clone()
        };
        assert_eq!(rows(two), vec![vec!["captured input done"]]);
        assert_eq!(rows(three), vec![vec!["third"]]);
        assert!(registry.jobs[&two].input.rows.is_empty());
        assert_eq!(registry.jobs[&two].summary.input_revision, 4);
        assert!(registry.jobs[&two].summary.result_available);
    }

    #[test]
    fn failure_retains_live_logs_and_bounds_each_stream() {
        let manager = PythonJobs::default();
        let _cleanup = Shutdown(manager.clone());
        let id = submit(&manager, "import sys\ndef run(rows, context):\n    print('x' * 2000000)\n    print('before failure', file=sys.stderr)\n    raise ValueError('job failure')\n".into(), Some(10));
        wait_until(|| state(&manager, id) == "failed");
        let registry = manager.lock().unwrap();
        let job = &registry.jobs[&id];
        let (out, err) = runtime_logs(&job.runtime).unwrap();
        assert!(out.len() <= LOG_LIMIT + 100);
        assert!(out.ends_with("[output truncated]"));
        assert!(err.contains("before failure") && err.contains("job failure"));
        assert!(!job.summary.result_available);
        assert!(job.summary.error.as_ref().unwrap().contains("job failure"));
    }

    #[test]
    fn timeout_releases_slot_and_shutdown_cancels_active_and_queued_work() {
        let manager = PythonJobs::default();
        let _cleanup = Shutdown(manager.clone());
        let id = submit(
            &manager,
            "import time\ndef run(rows, context):\n    print('started')\n    time.sleep(30)\n"
                .into(),
            Some(1),
        );
        wait_until(|| state(&manager, id) == "failed");
        assert!(
            manager.lock().unwrap().jobs[&id]
                .summary
                .error
                .as_ref()
                .unwrap()
                .contains("time limit")
        );
        let long =
            "import time\ndef run(rows, context):\n    print('started')\n    time.sleep(30)\n";
        let a = submit(&manager, long.into(), None);
        let b = submit(&manager, long.into(), None);
        let c = submit(&manager, long.into(), None);
        manager.shutdown();
        wait_until(|| {
            [a, b, c]
                .into_iter()
                .all(|id| state(&manager, id) == "cancelled")
        });
        assert!(!manager.has_active(None, None).unwrap());
        assert!(
            manager
                .submit(
                    execution(long.into()),
                    None,
                    None,
                    "x.py".into(),
                    None,
                    None
                )
                .is_err()
        );
    }
}
