//! A reusable Python child, serialized with the macro execution queue.
use super::*;
use serde_json::{Value, json};
use std::io::Write;
use std::process::ChildStdin;
static WORKER: Mutex<Option<Worker>> = Mutex::new(None);
struct Worker {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    directory: TemporaryDirectory,
    interpreter: PathBuf,
    sequence: u64,
}
impl Drop for Worker {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            terminate_process_tree(&mut child);
            let _ = child.wait();
        }
    }
}
impl Worker {
    fn start(app: &AppHandle, path: &Path) -> Result<Self, String> {
        let runner = app
            .path()
            .resolve("python/tablune_calculator.py", BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        let runner = if runner.exists() {
            runner
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/tablune_calculator.py")
        };
        Self::start_at(runner, path)
    }
    fn start_at(runner: PathBuf, path: &Path) -> Result<Self, String> {
        let directory = TemporaryDirectory::create()?;
        let mut command = Command::new(path);
        command
            .arg("-u")
            .arg(runner)
            .current_dir(&directory.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_macro_process(&mut command);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to start Python: {e}"))?;
        let stdin = child.stdin.take().ok_or("Python stdin unavailable")?;
        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            stdin,
            directory,
            interpreter: path.into(),
            sequence: 0,
        })
    }
    fn request(&mut self, runtime: &PythonRuntimeState, payload: &Value) -> Result<Value, String> {
        self.request_with_timeout(runtime, payload, EXECUTION_TIMEOUT)
    }
    fn request_with_timeout(
        &mut self,
        runtime: &PythonRuntimeState,
        payload: &Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.sequence += 1;
        let input = self
            .directory
            .0
            .join(format!("input-{}.json", self.sequence));
        let output = self
            .directory
            .0
            .join(format!("output-{}.json", self.sequence));
        let encoded = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
        if encoded.len() > OUTPUT_LIMIT as usize {
            return Err("Calculation input exceeds 512 MiB".into());
        }
        fs::write(&input, encoded).map_err(|e| e.to_string())?;
        {
            let mut state = lock_runtime(&runtime.inner)?;
            if state.cancel_requested {
                return Err("Calculation cancelled".into());
            }
            state.child = Some(self.child.clone());
        }
        writeln!(self.stdin, "{}", json!({"input":input,"output":output}))
            .map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let started = Instant::now();
        let result = (|| {
            loop {
                if lock_runtime(&runtime.inner)?.cancel_requested {
                    return Err("Calculation cancelled".into());
                }
                if started.elapsed() >= timeout {
                    return Err("Calculation exceeded the two minute limit".into());
                }
                if let Ok(metadata) = fs::metadata(&output) {
                    if metadata.len() > OUTPUT_LIMIT {
                        return Err("Calculation output exceeds 512 MiB".into());
                    }
                    let result: Value =
                        serde_json::from_slice(&fs::read(&output).map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())?;
                    if result["protocolVersion"] != 1 {
                        return Err("Unsupported calculation response".into());
                    }
                    if let Some(error) = result["error"].as_str() {
                        return Err(error.into());
                    }
                    return Ok(result);
                }
                if self
                    .child
                    .lock()
                    .map_err(|_| "Python unavailable")?
                    .try_wait()
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    return Err("Python calculation process stopped".into());
                }
                thread::sleep(Duration::from_millis(20));
            }
        })();
        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
        result
    }
}
pub(crate) fn reserve_runtime(app: &AppHandle, project_id: u64) -> Result<(), String> {
    let runtime = app.state::<PythonRuntimeState>();
    let mut state = lock_runtime(&runtime.inner)?;
    state.active = true;
    state.active_project = Some(project_id);
    state.cancel_requested = false;
    state.child = None;
    Ok(())
}
pub(crate) fn request(
    app: &AppHandle,
    project_id: u64,
    generation: u64,
    payload: Value,
) -> Result<Value, String> {
    let runtime = app.state::<PythonRuntimeState>();
    session::calculation::reserve_calculation(app, project_id, generation)?;
    let result = (|| {
        let interpreter = resolve_interpreter(app)?;
        if lock_runtime(&runtime.inner)?.cancel_requested {
            return Err("Calculation cancelled".into());
        }
        let mut worker = WORKER.lock().map_err(|_| "Calculator unavailable")?;
        let path = PathBuf::from(&interpreter.path);
        if worker.as_ref().is_none_or(|w| w.interpreter != path) {
            *worker = Some(Worker::start(app, &path)?);
        }
        let result = worker.as_mut().unwrap().request(&runtime, &payload);
        if result.is_err() {
            *worker = None;
        }
        result
    })();
    {
        let mut state = lock_runtime(&runtime.inner)?;
        state.active = false;
        state.active_project = None;
        state.child = None;
        state.cancel_requested = false;
    }
    result
}
pub(crate) fn shutdown() {
    if let Ok(mut worker) = WORKER.lock() {
        *worker = None;
    }
}

#[cfg(test)]
pub(crate) fn test_request(payload: Value) -> Value {
    let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/tablune_calculator.py");
    let mut worker = Worker::start_at(runner, Path::new("python3")).unwrap();
    worker
        .request(&PythonRuntimeState::default(), &payload)
        .unwrap()
}
#[cfg(test)]
pub(crate) fn test_worker() -> impl FnMut(Value) -> Value {
    let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/tablune_calculator.py");
    let mut worker = Worker::start_at(runner, Path::new("python3")).unwrap();
    move |payload| {
        worker
            .request(&PythonRuntimeState::default(), &payload)
            .unwrap()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reuses_process_with_fresh_function_namespaces_and_bounded_errors() {
        let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/tablune_calculator.py");
        let mut worker = Worker::start_at(runner, Path::new("python3")).unwrap();
        let id = worker.child.lock().unwrap().id();
        let runtime = PythonRuntimeState::default();
        let tree = crate::formulas::parse("=counter() + 10").unwrap().tree;
        let payload = json!({"protocolVersion":1,"code":"count = 0\ndef counter():\n    global count\n    count += 1\n    return count\n","sheets":[{"documentId":1,"revision":2,"values":{},"errors":{},"formulas":[{"key":"0,0","tree":tree}]}]});
        for _ in 0..2 {
            let result = worker.request(&runtime, &payload).unwrap();
            assert_eq!(result["results"][0]["results"]["0,0"]["display"], "11");
            assert_eq!(worker.child.lock().unwrap().id(), id);
        }
        assert!(
            worker
                .request(
                    &runtime,
                    &json!({"protocolVersion":1,"code":"def broken(:","validateOnly":true})
                )
                .is_err()
        );
        assert!(
            worker
                .request(
                    &runtime,
                    &json!({"protocolVersion":1,"code":"def sum(x): return x","validateOnly":true})
                )
                .is_err()
        );
        assert!(worker.request(&runtime,&json!({"protocolVersion":1,"code":"import tablune_missing_package_005","validateOnly":true})).is_err());
        assert!(Worker::start_at(PathBuf::new(), Path::new("tablune-python-missing")).is_err());
    }
    #[test]
    fn calculation_can_be_cancelled() {
        let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/tablune_calculator.py");
        let mut worker = Worker::start_at(runner, Path::new("python3")).unwrap();
        let runtime = PythonRuntimeState::default();
        let clone = runtime.clone();
        let task = thread::spawn(move || {
            worker.request(&clone,&json!({"protocolVersion":1,"code":"import time\ntime.sleep(30)","validateOnly":true}))
        });
        thread::sleep(Duration::from_millis(150));
        lock_runtime(&runtime.inner).unwrap().cancel_requested = true;
        assert!(task.join().unwrap().unwrap_err().contains("cancelled"));
    }
    #[test]
    fn timeout_stops_a_calculation_and_logs_are_bounded() {
        let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/tablune_calculator.py");
        let mut worker = Worker::start_at(runner, Path::new("python3")).unwrap();
        let runtime = PythonRuntimeState::default();
        let result = worker
            .request(
                &runtime,
                &json!({"protocolVersion":1,"code":"print('x'*2000000)","validateOnly":true}),
            )
            .unwrap();
        assert!(result["stdout"].as_str().unwrap().len() < LOG_LIMIT + 100);
        let result = worker.request_with_timeout(
            &runtime,
            &json!({"protocolVersion":1,"code":"import time\ntime.sleep(30)","validateOnly":true}),
            Duration::from_millis(100),
        );
        assert!(result.unwrap_err().contains("two minute limit"));
    }
}
