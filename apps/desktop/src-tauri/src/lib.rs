use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tablune_core::TableDocument;
use tablune_csv::{CsvDialect, LineEnding};

mod session;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CsvPayload {
    rows: Vec<Vec<String>>,
    delimiter: String,
    line_ending: LineEnding,
}

#[tauri::command]
fn read_csv_document(path: String) -> Result<CsvPayload, String> {
    let file = tablune_csv::read_path(path).map_err(|error| error.to_string())?;
    Ok(CsvPayload {
        rows: file.document.into_rows(),
        delimiter: char::from(file.dialect.delimiter).to_string(),
        line_ending: file.dialect.line_ending,
    })
}

#[tauri::command]
fn write_csv_document(path: String, payload: CsvPayload) -> Result<(), String> {
    let delimiter = payload
        .delimiter
        .as_bytes()
        .first()
        .copied()
        .ok_or_else(|| "delimiter cannot be empty".to_string())?;
    if payload.delimiter.len() != 1 {
        return Err("delimiter must be one ASCII character".to_string());
    }

    let document = TableDocument::from_rows(payload.rows);
    tablune_csv::write_path(
        path,
        &document,
        CsvDialect {
            delimiter,
            line_ending: payload.line_ending,
        },
    )
    .map_err(|error| error.to_string())
}

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

#[tauri::command]
fn rename_csv_document(path: String, new_name: String) -> Result<String, String> {
    let destination = rename_document_path(Path::new(&path), new_name.trim())?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(session::SessionState::default())
        .invoke_handler(tauri::generate_handler![
            read_csv_document,
            write_csv_document,
            rename_csv_document,
            exit_application,
            session::session_summary,
            session::session_new,
            session::session_open,
            session::session_save,
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
            session::session_write_recovery,
            session::session_recovery_available,
            session::session_restore_recovery,
            session::session_discard_recovery
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tablune Sheets");
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
}
