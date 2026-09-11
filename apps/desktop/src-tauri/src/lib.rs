use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager};

mod formulas;
mod images;
mod python_macros;
mod session;
use session::projects;

fn rename_document_path(path: &Path, new_name: &str) -> Result<PathBuf, String> {
    if new_name.is_empty()
        || matches!(new_name, "." | "..")
        || new_name.contains(&['/', '\\', '\0'][..])
    {
        return Err("enter a valid file name without folders".to_string());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "the document does not have a parent folder".to_string())?;
    let destination = parent.join(new_name);
    if destination == path {
        return Ok(destination);
    }
    if destination.exists() {
        return Err(format!("a file named '{new_name}' already exists"));
    }

    fs::rename(path, &destination).map_err(|error| error.to_string())?;
    Ok(destination)
}

#[derive(Default)]
struct ExitPermission(AtomicBool);

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    python_macros::calculation_worker::shutdown();
    app.state::<ExitPermission>()
        .0
        .store(true, Ordering::Release);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ExitPermission::default())
        .manage(session::WorkspaceState::default())
        .manage(python_macros::PythonRuntimeState::default())
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            // macOS's predefined Quit sends terminate: directly. Route our own
            // Quit item through the same save/discard flow as window closing.
            #[cfg(target_os = "macos")]
            if let Some(tauri::menu::MenuItemKind::Submenu(application)) = menu.items()?.first() {
                if let Some(index) = application.items()?.len().checked_sub(1) {
                    application.remove_at(index)?;
                }
                application.append(&tauri::menu::MenuItem::with_id(
                    app,
                    "tablune-quit",
                    "Quit Tablune Sheets",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "tablune-quit" {
                let _ = app.emit("tablune-request-exit", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            exit_application,
            images::image_import,
            images::image_read,
            images::image_clipboard_copy,
            images::image_clipboard_paste,
            session::sheets::sheet_cell,
            session::sheets::clipboard_generation,
            session::sheets::clipboard_read_text,
            session::sheets::clipboard_write_text,
            session::sheets::sheet_shift_formula,
            session::sheets::sheet_shift_formulas,
            session::calculation::project_enable_calculation,
            session::calculation::project_recalculate,
            session::calculation::project_apply_functions,
            session::calculation::project_cancel_calculation,
            projects::project_new,
            projects::project_open,
            projects::project_save,
            projects::project_action,
            projects::project_close,
            projects::project_export_table,
            projects::recent_files,
            projects::recent_remove,
            python_macros::project_python_preview,
            python_macros::project_python_result,
            session::workspace_summary,
            session::workspace_reorder,
            session::session_summary,
            session::session_new,
            session::session_open,
            session::session_close,
            session::session_save,
            session::session_duplicate,
            session::session_rename,
            session::session_grid_window,
            session::session_apply_edit,
            session::session_undo,
            session::session_redo,
            session::session_set_view,
            session::session_set_header,
            session::session_set_column_type,
            session::session_search,
            session::session_replace,
            session::session_column_profile,
            session::session_facets,
            session::session_export_view,
            session::workspace_write_recovery,
            session::workspace_recovery_available,
            session::workspace_restore_recovery,
            session::workspace_discard_recovery,
            python_macros::python_status,
            python_macros::python_set_interpreter,
            python_macros::python_macro_folder,
            python_macros::python_set_macro_folder,
            python_macros::macro_read_script,
            python_macros::macro_write_script,
            python_macros::python_preview_macro,
            python_macros::python_cancel_macro,
            python_macros::python_apply_preview
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tablune Sheets")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && !app.state::<ExitPermission>().0.load(Ordering::Acquire)
            {
                api.prevent_exit();
                let _ = app.emit("tablune-request-exit", ());
            }
        });
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::rename_document_path;

    #[test]
    fn renames_a_document_without_overwriting_an_existing_file() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("tablune-rename-{unique}"));
        fs::create_dir_all(&directory).expect("temporary directory should be created");
        let source = directory.join("before.csv");
        fs::write(&source, "a,b\n1,2\n").expect("source fixture should be written");

        let destination =
            rename_document_path(&source, "after.csv").expect("document should be renamed");
        assert!(!source.exists());
        assert_eq!(destination, directory.join("after.csv"));
        assert_eq!(fs::read_to_string(&destination).unwrap(), "a,b\n1,2\n");

        fs::write(&source, "replacement").expect("second fixture should be written");
        let error = rename_document_path(&source, "after.csv")
            .expect_err("an existing destination must not be overwritten");
        assert!(error.contains("already exists"));

        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn rejects_paths_instead_of_file_names() {
        let source = Path::new("/tmp/source.csv");
        assert!(rename_document_path(source, "folder/other.csv").is_err());
        assert!(rename_document_path(source, "..").is_err());
    }

    #[test]
    fn production_configuration_enables_a_restrictive_csp() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("production CSP should be configured");
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("connect-src ipc: http://ipc.localhost"));
        assert!(!csp.contains("https:"));
        assert!(!csp.contains("'unsafe-eval'"));
    }
}
