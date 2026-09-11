//! Calculation lifecycle. Snapshots are immutable; publication checks every source revision.
use super::*;
use crate::{
    formulas::{self, CellResult},
    python_macros,
};
use serde_json::{Value, json};
use tauri::Emitter;

fn snapshot_sheet(s: &DocumentSession) -> Result<Option<Value>, String> {
    let (order, blocked) = s.graph.order(&s.sheet);
    if order.is_empty() && blocked.is_empty() {
        return Ok(None);
    }
    let mut values = std::collections::BTreeMap::new();
    let mut formulas = Vec::new();
    let mut errors = std::collections::BTreeMap::new();
    for k in blocked {
        errors.insert(
            k,
            CellResult::error(
                "#CYCLE!",
                "This formula is in, or depends on, a circular reference",
            ),
        );
    }
    for k in order {
        match s.graph.parsed.get(&k) {
            Some(Ok(parsed)) => {
                for r in &parsed.references {
                    let first = r.start.row.min(r.end.row);
                    let last = r
                        .start
                        .row
                        .max(r.end.row)
                        .min(s.document.row_count().saturating_sub(1));
                    let first_col = r.start.column.min(r.end.column);
                    let last_col = r.start.column.max(r.end.column);
                    if (r.start.row.abs_diff(r.end.row) + 1)
                        .saturating_mul(r.start.column.abs_diff(r.end.column) + 1)
                        > 50_000_000
                    {
                        return Err("Formula range exceeds 50 million cells".into());
                    }
                    if s.document.row_count() > 0 && first <= last {
                        for row in first..=last {
                            let width = s.document.rows()[row].len();
                            if width == 0 {
                                continue;
                            }
                            for column in first_col..=last_col.min(width - 1) {
                                values
                                    .entry(formulas::key((row, column)))
                                    .or_insert_with(|| s.scalar_at((row, column)));
                            }
                        }
                    }
                }
                formulas.push(json!({"key":k,"tree":parsed.tree}));
            }
            Some(Err(error)) => {
                errors.insert(k, CellResult::error("#SYNTAX!", error));
            }
            None => {
                errors.insert(
                    k,
                    CellResult::error("#SYNTAX!", "Formula parser state unavailable"),
                );
            }
        }
    }
    Ok(Some(
        json!({"documentId":s.identity,"revision":s.revision,"values":values,"formulas":formulas,"errors":errors}),
    ))
}
fn emit_project(app: &AppHandle, p: &projects::ProjectSession) {
    if let Ok(summary) = p.summary() {
        let _ = app.emit("tablune-calculation", summary);
    }
}
/// Check cancellation and reserve the worker under the same project lock.
pub(crate) fn reserve_calculation(
    app: &AppHandle,
    project_id: u64,
    generation: u64,
) -> Result<(), String> {
    let state = app.state::<WorkspaceState>();
    let handle = projects::handle(&state, project_id)?;
    let p = projects::lock_project(&handle)?;
    if p.calculation_generation != generation {
        return Err("Calculation cancelled".into());
    }
    python_macros::calculation_worker::reserve_runtime(app, project_id)
}
pub(crate) fn interpreter_changed(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<WorkspaceState>();
    let handles = state
        .projects
        .lock()
        .map_err(|_| "Project workspace unavailable")?
        .clone();
    for handle in handles {
        let mut p = projects::lock_project(&handle)?;
        for table in &p.tables {
            let mut s = lock_document(table)?;
            s.sheet.invalidate_all();
            s.calculation_revision += 1;
        }
        p.calculation.error = None;
        emit_project(app, &p);
    }
    Ok(())
}
#[tauri::command]
pub fn project_enable_calculation(
    app: AppHandle,
    project_id: u64,
) -> Result<projects::ProjectSummary, String> {
    let state = app.state::<WorkspaceState>();
    let handle = projects::handle(&state, project_id)?;
    let mut p = projects::lock_project(&handle)?;
    p.calculation.enabled = true;
    p.calculation.paused = false;
    p.calculation.error = None;
    p.summary()
}
#[tauri::command]
pub async fn project_recalculate(
    app: AppHandle,
    project_id: u64,
    force: bool,
) -> Result<projects::ProjectSummary, String> {
    let generation = {
        let state = app.state::<WorkspaceState>();
        let handle = projects::handle(&state, project_id)?;
        let mut p = projects::lock_project(&handle)?;
        if !p.calculation.enabled {
            return Err("Enable Python calculation for this project first".into());
        }
        if p.calculation.running {
            return p.summary();
        }
        if force {
            for table in &p.tables {
                lock_document(table)?.sheet.invalidate_all();
            }
            p.calculation.paused = false;
        }
        if p.calculation.paused {
            return p.summary();
        }
        p.calculation.running = true;
        p.calculation.error = None;
        p.calculation_generation += 1;
        emit_project(&app, &p);
        p.calculation_generation
    };
    let _lease = python_macros::PYTHON_QUEUE.lock().await;
    tauri::async_runtime::spawn_blocking(move || calculate_locked(&app, project_id, generation))
        .await
        .map_err(|e| e.to_string())?
}
fn calculate_locked(
    app: &AppHandle,
    project_id: u64,
    generation: u64,
) -> Result<projects::ProjectSummary, String> {
    let state = app.state::<WorkspaceState>();
    let handle = projects::handle(&state, project_id)?;
    let prepared = (|| {
        let p = projects::lock_project(&handle)?;
        if p.calculation_generation != generation || p.calculation.paused {
            return Ok(None);
        }
        let sheets = p
            .tables
            .iter()
            .map(|t| snapshot_sheet(&*lock_document(t)?))
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        Ok(Some((
            p.data.functions.revision,
            json!({"protocolVersion":1,"code":p.data.functions.applied,"sheets":sheets}),
        )))
    })();
    let result = match prepared {
        Ok(Some((revision, payload))) => {
            let output = if payload["sheets"].as_array().is_some_and(Vec::is_empty) {
                Ok(json!({"results":[]}))
            } else {
                python_macros::calculation_worker::request(
                    app,
                    project_id,
                    generation,
                    payload.clone(),
                )
            };
            output.map(|output| (revision, payload, output))
        }
        Ok(None) => {
            let mut p = projects::lock_project(&handle)?;
            p.calculation.running = false;
            emit_project(app, &p);
            return p.summary();
        }
        Err(e) => Err(e),
    };
    let mut p = projects::lock_project(&handle)?;
    p.calculation.running = false;
    if p.calculation_generation != generation {
        emit_project(app, &p);
        return p.summary();
    }
    match result {
        Ok((functions_revision, payload, output))
            if p.data.functions.revision == functions_revision =>
        {
            let publication = (|| -> Result<(), String> {
                let outputs = output["results"]
                    .as_array()
                    .ok_or("Invalid calculation results")?;
                for result in outputs {
                    let id = result["documentId"]
                        .as_u64()
                        .ok_or("Invalid calculation document")?;
                    let request = payload["sheets"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|s| s["documentId"] == id)
                        .ok_or("Unexpected calculation document")?;
                    let Some(table) = p
                        .tables
                        .iter()
                        .find(|t| t.lock().is_ok_and(|s| s.identity == id))
                    else {
                        continue;
                    };
                    let mut s = lock_document(table)?;
                    publish_sheet(&mut s, request, result, functions_revision)?;
                }
                Ok(())
            })();
            if let Err(error) = publication {
                p.calculation.paused = true;
                p.calculation.error = Some(error);
            }
        }
        Ok(_) => {}
        Err(error) => {
            p.calculation.paused = true;
            p.calculation.error = Some(error);
        }
    }
    emit_project(app, &p);
    p.summary()
}
fn publish_sheet(
    s: &mut DocumentSession,
    request: &Value,
    result: &Value,
    functions_revision: u64,
) -> Result<bool, String> {
    if request["documentId"] != s.identity
        || result["documentId"] != s.identity
        || result["revision"] != s.revision
        || request["revision"] != s.revision
    {
        return Ok(false);
    }
    let results: std::collections::BTreeMap<String, CellResult> =
        serde_json::from_value(result["results"].clone()).map_err(|e| e.to_string())?;
    let expected: HashSet<_> = request["formulas"]
        .as_array()
        .ok_or("Invalid formula request")?
        .iter()
        .map(|f| f["key"].as_str().unwrap_or("").to_string())
        .chain(
            request["errors"]
                .as_object()
                .ok_or("Invalid error request")?
                .keys()
                .cloned(),
        )
        .collect();
    if results.keys().cloned().collect::<HashSet<_>>() != expected {
        return Err("Incomplete calculation response".into());
    }
    for result in results.values() {
        crate::formulas::validate_result(result)?;
    }
    for (key, result) in results {
        if let Some(m) = s.sheet.cells.get_mut(&key).filter(|m| m.formula) {
            m.cached = Some(result);
            m.pending = false;
        }
    }
    s.sheet.functions_revision = functions_revision;
    s.calculation_revision += 1;
    s.rebuild_view();
    Ok(true)
}

#[tauri::command]
pub async fn project_apply_functions(
    app: AppHandle,
    project_id: u64,
    expected_revision: u64,
) -> Result<projects::ProjectSummary, String> {
    let (code, generation) = {
        let state = app.state::<WorkspaceState>();
        let handle = projects::handle(&state, project_id)?;
        let mut p = projects::lock_project(&handle)?;
        if !p.calculation.enabled {
            return Err("Enable Python calculation before applying functions".into());
        }
        if p.calculation.running {
            return Err("Wait for calculation or cancel it before applying functions".into());
        }
        if p.data.functions.draft_revision != expected_revision {
            return Err("Functions draft changed".into());
        }
        p.calculation_generation += 1;
        p.calculation.running = true;
        p.calculation.error = None;
        emit_project(&app, &p);
        (p.data.functions.draft.clone(), p.calculation_generation)
    };
    let _lease = python_macros::PYTHON_QUEUE.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceState>();
        let handle = projects::handle(&state, project_id)?;
        {
            let mut p = projects::lock_project(&handle)?;
            if p.calculation_generation != generation {
                p.calculation.running = false;
                emit_project(&app, &p);
                return p.summary();
            }
        }
        let result = python_macros::calculation_worker::request(
            &app,
            project_id,
            generation,
            json!({"protocolVersion":1,"code":code,"validateOnly":true}),
        );
        let mut p = projects::lock_project(&handle)?;
        p.calculation.running = false;
        if p.calculation_generation == generation {
            match result {
                Ok(_) if p.data.functions.draft_revision == expected_revision => {
                    p.data.functions.applied = code;
                    p.data.functions.revision += 1;
                    p.calculation.paused = false;
                    p.calculation.error = None;
                    for table in &p.tables {
                        let mut s = lock_document(table)?;
                        s.sheet.invalidate_all();
                        s.calculation_revision += 1;
                    }
                }
                Ok(_) => {
                    p.calculation.error =
                        Some("Functions draft changed during validation; apply it again".into());
                }
                Err(error) => {
                    p.calculation.error = Some(error);
                }
            }
        }
        emit_project(&app, &p);
        p.summary()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn project_cancel_calculation(
    app: AppHandle,
    project_id: u64,
) -> Result<projects::ProjectSummary, String> {
    let state = app.state::<WorkspaceState>();
    let handle = projects::handle(&state, project_id)?;
    let mut p = projects::lock_project(&handle)?;
    p.calculation_generation += 1;
    p.calculation.paused = true;
    p.calculation.error = Some("Calculation cancelled. Recalculate when ready.".into());
    let runtime = app.state::<python_macros::PythonRuntimeState>();
    if python_macros::project_running(&runtime, project_id)? {
        python_macros::request_calculation_cancel(&runtime)?;
    }
    emit_project(&app, &p);
    p.summary()
}

#[cfg(test)]
pub(super) fn calculate_for_test(s: &mut DocumentSession, code: &str) {
    calculate_with_test_worker(
        s,
        code,
        &mut crate::python_macros::calculation_worker::test_worker(),
    );
}
#[cfg(test)]
pub(super) fn calculate_with_test_worker(
    s: &mut DocumentSession,
    code: &str,
    worker: &mut impl FnMut(Value) -> Value,
) {
    let Some(snapshot) = snapshot_sheet(s).unwrap() else {
        return;
    };
    let output = worker(json!({"protocolVersion":1,"code":code,"sheets":[snapshot.clone()]}));
    publish_sheet(s, &snapshot, &output["results"][0], 0).unwrap();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_results_cannot_overwrite_new_edits_or_another_sheet() {
        let mut s = DocumentSession {
            project_id: Some(1),
            ..DocumentSession::default()
        };
        s.edit_sheet_cells(vec![sheets::SheetCellInput {
            image: None,
            row: 0,
            column: 0,
            value: "=1+2".into(),
            literal: false,
            cell_type: None,
        }])
        .unwrap();
        let request = snapshot_sheet(&s).unwrap().unwrap();
        let output = crate::python_macros::calculation_worker::test_request(
            json!({"protocolVersion":1,"code":"","sheets":[request.clone()]}),
        );
        let other = DocumentSession {
            project_id: Some(2),
            ..DocumentSession::default()
        };
        assert_ne!(other.identity, s.identity);
        s.edit_sheet_cells(vec![sheets::SheetCellInput {
            image: None,
            row: 0,
            column: 0,
            value: "=4+5".into(),
            literal: false,
            cell_type: None,
        }])
        .unwrap();
        assert!(!publish_sheet(&mut s, &request, &output["results"][0], 0).unwrap());
        assert!(s.sheet.cells["0,0"].pending);
        assert_eq!(s.raw_cell(0, 0), "=4+5");
        let mut other = other;
        assert!(!publish_sheet(&mut other, &request, &output["results"][0], 0).unwrap());
    }
}
