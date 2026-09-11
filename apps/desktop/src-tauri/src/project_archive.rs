//! Self-contained archive codec. Entries are read directly; never extract paths.
use super::ProjectData;
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Write},
    path::Path,
};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};
#[derive(serde::Deserialize)]
struct StoredTable {
    rows: Vec<Vec<String>>,
    sheet: crate::formulas::SheetData,
}
#[derive(serde::Serialize)]
struct StoredTableRef<'a> {
    rows: &'a [Vec<String>],
    sheet: &'a crate::formulas::SheetData,
}
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(super) fn validate(data: &ProjectData) -> Result<(), String> {
    if !matches!(data.version, 1 | 2) {
        return Err(format!("Unsupported .tablune version {}", data.version));
    }
    if data.functions.draft.len() > 1024 * 1024 || data.functions.applied.len() > 1024 * 1024 {
        return Err("Functions code exceeds 1 MiB".into());
    }
    if data.tables.len() != data.rows.len() {
        return Err("Missing table data".into());
    }
    super::name(&data.name)?;
    let mut ids = HashSet::new();
    for id in std::iter::once(&data.id)
        .chain(data.tables.iter().map(|t| &t.id))
        .chain(data.scripts.iter().map(|s| &s.id))
    {
        if id.is_empty()
            || id.len() > 120
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || !ids.insert(id)
        {
            return Err("Invalid or duplicate project identifier".into());
        }
    }
    let mut names = HashSet::new();
    for t in &data.tables {
        super::name(&t.name)?;
        for (key, meta) in &t.sheet.cells {
            if let Some(result) = &meta.cached {
                crate::formulas::validate_result(result)?;
            }
            let (row, column) =
                crate::formulas::position(key).ok_or("Invalid cell metadata address")?;
            if row > 9_999_999
                || column >= 100_000
                || (meta.formula
                    && (!meta.source.starts_with('=')
                        || meta.source.len() > crate::formulas::FORMULA_LIMIT))
            {
                return Err("Invalid sheet metadata".into());
            }
        }
        if !names.insert(&t.name) {
            return Err("Duplicate table name".into());
        }
        if matches!(t.dialect.delimiter, 0 | b'\n' | b'\r' | b'"')
            || !t.dialect.delimiter.is_ascii()
        {
            return Err("Invalid delimiter".into());
        }
    }
    for (table, rows) in data.tables.iter().zip(&data.rows) {
        for (key, meta) in &table.sheet.cells {
            if meta.formula {
                let (r, c) = crate::formulas::position(key).ok_or("Invalid cell address")?;
                if rows.get(r).and_then(|row| row.get(c)) != Some(&meta.source) {
                    return Err("Formula source does not match table content".into());
                }
            }
        }
    }
    names.clear();
    for s in &data.scripts {
        super::name(&s.name)?;
        if !names.insert(&s.name) || s.code.len() > 1024 * 1024 {
            return Err("Invalid script".into());
        }
        if s.input_table_id
            .as_ref()
            .is_some_and(|id| !data.tables.iter().any(|t| &t.id == id))
        {
            return Err("Script refers to a missing table".into());
        }
    }
    Ok(())
}
pub(super) fn read(path: &Path) -> Result<ProjectData, String> {
    let mut zip =
        ZipArchive::new(File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut total = 0u64;
    let mut names = HashSet::new();
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        total = total.saturating_add(f.size());
        if total > MAX_ARCHIVE_BYTES || !names.insert(f.name().to_owned()) {
            return Err("Oversized archive or duplicate entry".into());
        }
    }
    let mut data: ProjectData =
        serde_json::from_slice(&entry(&mut zip, "manifest.json", 16 * 1024 * 1024)?)
            .map_err(|e| e.to_string())?;
    if !matches!(data.version, 1 | 2) {
        return Err(format!("Unsupported .tablune version {}", data.version));
    }
    for t in &mut data.tables {
        let bytes = entry(
            &mut zip,
            &format!("tables/{}.json", t.id),
            MAX_ARCHIVE_BYTES,
        )?;
        if data.version == 1 {
            data.rows
                .push(serde_json::from_slice(&bytes).map_err(|e| e.to_string())?);
        } else {
            let table: StoredTable = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            t.sheet = table.sheet;
            data.rows.push(table.rows);
        }
    }
    if data.version == 2 {
        data.functions.draft =
            String::from_utf8(entry(&mut zip, "functions/draft.py", 1024 * 1024)?)
                .map_err(|e| e.to_string())?;
        data.functions.applied =
            String::from_utf8(entry(&mut zip, "functions/applied.py", 1024 * 1024)?)
                .map_err(|e| e.to_string())?;
    }
    for s in &mut data.scripts {
        s.code = String::from_utf8(entry(
            &mut zip,
            &format!("scripts/{}.py", s.id),
            1024 * 1024,
        )?)
        .map_err(|e| e.to_string())?;
    }
    validate(&data)?;
    Ok(data)
}
fn entry(zip: &mut ZipArchive<File>, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    let f = zip.by_name(name).map_err(|e| e.to_string())?;
    if f.size() > limit {
        return Err("Project entry exceeds size limit".into());
    }
    let mut bytes = Vec::new();
    f.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Project entry exceeds size limit".into());
    }
    Ok(bytes)
}
pub(super) fn write(path: &Path, data: &ProjectData) -> Result<(), String> {
    validate(data)?;
    let parent = path.parent().unwrap_or(Path::new("."));
    let temp = parent.join(format!(".tablune-{}.tmp", super::persistent_id()));
    let result = (|| -> Result<(), String> {
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(1));
        zip.start_file("manifest.json", options)
            .map_err(|e| e.to_string())?;
        let mut manifest = ProjectData {
            functions: data.functions.clone(),
            version: 2,
            id: data.id.clone(),
            name: data.name.clone(),
            tables: data.tables.clone(),
            scripts: data.scripts.clone(),
            rows: Vec::new(),
        };
        for s in &mut manifest.scripts {
            s.code.clear();
        }
        for table in &mut manifest.tables {
            table.sheet = crate::formulas::SheetData::default();
        }
        manifest.functions.draft.clear();
        manifest.functions.applied.clear();
        let manifest_bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        if manifest_bytes.len() > 16 * 1024 * 1024 {
            return Err("Project manifest exceeds 16 MiB".into());
        }
        zip.write_all(&manifest_bytes).map_err(|e| e.to_string())?;
        for (name, code) in [
            ("functions/draft.py", &data.functions.draft),
            ("functions/applied.py", &data.functions.applied),
        ] {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            zip.write_all(code.as_bytes()).map_err(|e| e.to_string())?;
        }
        for (t, rows) in data.tables.iter().zip(&data.rows) {
            zip.start_file(format!("tables/{}.json", t.id), options)
                .map_err(|e| e.to_string())?;
            // JSON emits many tiny writes; buffer them before compression.
            let mut buffer = std::io::BufWriter::with_capacity(64 * 1024, &mut zip);
            serde_json::to_writer(
                &mut buffer,
                &StoredTableRef {
                    rows,
                    sheet: &t.sheet,
                },
            )
            .map_err(|e| e.to_string())?;
            buffer.flush().map_err(|e| e.to_string())?;
        }
        for s in &data.scripts {
            zip.start_file(format!("scripts/{}.py", s.id), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(s.code.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        zip.finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        let mut completed = ZipArchive::new(File::open(&temp).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let mut size = 0u64;
        for index in 0..completed.len() {
            size =
                size.saturating_add(completed.by_index(index).map_err(|e| e.to_string())?.size());
        }
        if size > MAX_ARCHIVE_BYTES {
            return Err("Project exceeds the 2 GiB uncompressed archive limit".into());
        }
        drop(completed);
        tablune_csv::replace_file_atomic(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
