use serde::{Deserialize, Serialize};
use tablune_core::TableDocument;
use tablune_csv::{CsvDialect, LineEnding};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_csv_document, write_csv_document])
        .run(tauri::generate_context!())
        .expect("error while running Tablune Sheets");
}
