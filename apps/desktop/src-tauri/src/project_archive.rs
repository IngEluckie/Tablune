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
    if !matches!(data.version, 1..=9) {
        return Err(format!("Unsupported .tablune version {}", data.version));
    }
    if data.standalone_canvas
        && (data.canvases.len() != 1
            || !data.tables.is_empty()
            || !data.scripts.is_empty()
            || !data.markdown.is_empty()
            || !data.organization.folders.is_empty()
            || !data.organization.item_folders.is_empty()
            || !data.functions.draft.is_empty()
            || !data.functions.applied.is_empty())
    {
        return Err("Invalid standalone canvas document".into());
    }
    if data.functions.draft.len() > 1024 * 1024 || data.functions.applied.len() > 1024 * 1024 {
        return Err("Functions code exceeds 1 MiB".into());
    }
    if data.tables.len() != data.rows.len() {
        return Err("Missing table data".into());
    }
    super::name(&data.name)?;
    if data.version < 5 && data.organization != super::ProjectOrganization::default() {
        return Err("Folder organization requires project format 5".into());
    }
    super::tree::validate(&data.organization, data)?;
    let mut ids = HashSet::new();
    for id in std::iter::once(&data.id)
        .chain(data.tables.iter().map(|t| &t.id))
        .chain(data.scripts.iter().map(|s| &s.id))
        .chain(data.canvases.iter().map(|c| &c.id))
        .chain(data.markdown.iter().map(|d| &d.id))
    {
        if id.is_empty()
            || id.len() > 120
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || !ids.insert(id)
        {
            return Err("Invalid or duplicate project identifier".into());
        }
    }
    for (id, asset) in &data.assets {
        if data.version < 3 || !crate::images::valid_id(id) {
            return Err("Invalid image asset version or identifier".into());
        }
        crate::images::validate_asset(id, asset)?;
    }
    for doc in &data.markdown {
        if data.version < 4 || doc.path.is_some() {
            return Err("Invalid project Markdown metadata".into());
        }
        super::markdown::validate(doc, &data.assets)?;
    }
    for canvas in &data.canvases {
        if data.version < 7 {
            return Err("Canvases require format 7".into());
        }
        super::name(&canvas.name)?;
        super::canvas::validate(&canvas.content, &data.assets)?;
    }
    let mut names = HashSet::new();
    for t in &data.tables {
        if !t.sheet.merges.is_empty()
            && (data.version < 8 || !t.view.sorts.is_empty() || !t.view.filters.is_empty())
        {
            return Err(
                "Las combinaciones requieren formato 8 y una hoja sin filtros ni ordenación".into(),
            );
        }
        super::merges::validate(&t.sheet.merges)?;
        if data.version < 6 && !t.sheet.styles.is_empty() {
            return Err("Cell styles require project format 6".into());
        }
        for (key, style) in &t.sheet.styles {
            let (row, col) = crate::formulas::position(key).ok_or("Invalid styled cell address")?;
            if row > 9_999_999 || col >= 100_000 {
                return Err("Styled cell exceeds sheet limits".into());
            }
            if data.version < 9 && style.wrap_text {
                return Err("El ajuste de texto requiere formato 9".into());
            }
            style.validate()?;
        }
        super::name(&t.name)?;
        for (key, meta) in &t.sheet.cells {
            if let Some(image) = &meta.image {
                image.validate()?;
                if meta.formula
                    || meta.source != image.name
                    || !data.assets.contains_key(&image.asset_id)
                {
                    return Err("Invalid or missing cell image".into());
                }
            }
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
        for m in &table.sheet.merges {
            for row in m.start_row..=m.end_row {
                for col in m.start_column..=m.end_column {
                    if row == m.start_row && col == m.start_column {
                        continue;
                    }
                    let meta = table.sheet.cells.get(&crate::formulas::key((row, col)));
                    if rows
                        .get(row)
                        .and_then(|r| r.get(col))
                        .is_some_and(|v| !v.is_empty())
                        || meta.is_some_and(|v| v.formula || v.image.is_some())
                    {
                        return Err("Combinación con contenido oculto".into());
                    }
                }
            }
        }
        for (key, meta) in &table.sheet.cells {
            if meta.formula || meta.image.is_some() {
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
    if !matches!(data.version, 1..=9) {
        return Err(format!("Unsupported .tablune version {}", data.version));
    }
    for canvas in &mut data.canvases {
        canvas.content = serde_json::from_slice(&entry(
            &mut zip,
            &format!("canvases/{}.json", canvas.id),
            16 * 1024 * 1024,
        )?)
        .map_err(|e| e.to_string())?;
    }
    for doc in &mut data.markdown {
        doc.content = String::from_utf8(entry(
            &mut zip,
            &format!("documents/{}.md", doc.id),
            super::markdown::MAX_TEXT,
        )?)
        .map_err(|e| e.to_string())?;
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
    if data.version >= 2 {
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
    for (id, asset) in &mut data.assets {
        if !crate::images::valid_id(id) {
            return Err("Invalid image identifier".into());
        }
        asset.bytes = std::sync::Arc::new(entry(
            &mut zip,
            &format!("assets/{id}"),
            crate::images::MAX_IMAGE_BYTES,
        )?);
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
            standalone_canvas: data.standalone_canvas,
            canvases: data.canvases.clone(),
            organization: data.organization.clone(),
            markdown: data.markdown.clone(),
            assets: data.assets.clone(),
            functions: data.functions.clone(),
            version: 9,
            id: data.id.clone(),
            name: data.name.clone(),
            tables: data.tables.clone(),
            scripts: data.scripts.clone(),
            rows: Vec::new(),
        };
        for canvas in &mut manifest.canvases {
            canvas.content = super::canvas::empty();
        }
        for doc in &mut manifest.markdown {
            doc.content.clear();
        }
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
        for (id, asset) in &data.assets {
            zip.start_file(format!("assets/{id}"), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(&asset.bytes).map_err(|e| e.to_string())?;
        }
        for canvas in &data.canvases {
            zip.start_file(format!("canvases/{}.json", canvas.id), options)
                .map_err(|e| e.to_string())?;
            serde_json::to_writer(&mut zip, &canvas.content).map_err(|e| e.to_string())?;
        }
        for doc in &data.markdown {
            zip.start_file(format!("documents/{}.md", doc.id), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(doc.content.as_bytes())
                .map_err(|e| e.to_string())?;
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
