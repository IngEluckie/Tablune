//! Markdown sessions and portable image resources. No HTML or scripts are executed.
use super::*;
use crate::images::{self, Assets};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::{collections::BTreeMap, io::Read, ops::Range};

pub const MAX_TEXT: u64 = 16 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDocument {
    pub id: String,
    pub name: String,
    pub content: String,
    pub revision: u64,
    pub path: Option<String>,
    pub dirty: bool,
    #[serde(default)]
    pub images: BTreeMap<String, String>,
}
#[derive(Clone)]
pub struct MarkdownSession {
    pub document: MarkdownDocument,
    pub assets: Assets,
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MarkdownAction {
    New {
        name: String,
    },
    Open {
        path: String,
    },
    Update {
        content: String,
        expected_revision: u64,
    },
    Rename {
        name: String,
    },
    Save {
        path: String,
    },
    Delete {
        discard: bool,
    },
    CopyToProject {
        target_project_id: u64,
    },
}
fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("File exceeds size limit".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("File exceeds size limit".into());
    }
    Ok(bytes)
}
fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.len() > 240 || name.chars().any(char::is_control) {
        return Err("Enter a document name between 1 and 240 bytes".into());
    }
    Ok(())
}
pub fn validate(doc: &MarkdownDocument, assets: &Assets) -> Result<(), String> {
    validate_name(&doc.name)?;
    if doc.content.len() as u64 > MAX_TEXT {
        return Err("Markdown exceeds 16 MiB".into());
    }
    for id in doc.images.values() {
        if !assets.contains_key(id) {
            return Err("Missing Markdown image resource".into());
        }
    }
    Ok(())
}
struct ImageReference {
    range: Range<usize>,
    url: String,
    alt: String,
    title: String,
}
fn references(content: &str) -> Vec<ImageReference> {
    let mut out = Vec::new();
    let mut active: Option<ImageReference> = None;
    for (event, range) in Parser::new_ext(
        content,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    )
    .into_offset_iter()
    {
        match event {
            Event::Start(Tag::Image {
                dest_url, title, ..
            }) => {
                active = Some(ImageReference {
                    range,
                    url: dest_url.into_string(),
                    alt: String::new(),
                    title: title.into_string(),
                })
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some(image) = &mut active {
                    image.alt.push_str(&text);
                }
            }
            Event::End(TagEnd::Image) => {
                if let Some(mut image) = active.take() {
                    image.range.end = range.end;
                    out.push(image);
                }
            }
            _ => {}
        }
    }
    out
}
fn local_image(base: &Path, url: &str) -> Option<PathBuf> {
    if url.contains(':') || url.starts_with('/') || url.starts_with('\\') {
        return None;
    }
    // Decode percent escapes in file references, without interpreting URL schemes.
    let mut bytes = Vec::new();
    let source = url.as_bytes();
    let mut i = 0;
    while i < source.len() {
        if source[i] == b'%' && i + 2 < source.len() {
            if let Ok(hex) = std::str::from_utf8(&source[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    bytes.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        bytes.push(source[i]);
        i += 1;
    }
    let relative = String::from_utf8(bytes).ok()?;
    let root = base.canonicalize().ok()?;
    let path = root.join(relative).canonicalize().ok()?;
    // Imported text cannot request images outside its directory tree.
    path.starts_with(&root).then_some(path)
}
fn collect_images(
    doc: &mut MarkdownDocument,
    assets: &mut Assets,
    base: &Path,
) -> Result<(), String> {
    let mut total: usize = assets.values().map(|a| a.bytes.len()).sum();
    for image in references(&doc.content) {
        if doc.images.contains_key(&image.url) {
            continue;
        }
        if let Some(path) = local_image(base, &image.url) {
            let Ok(bytes) = read_limited(&path, images::MAX_IMAGE_BYTES) else {
                continue;
            };
            let Ok((id, asset)) = images::from_bytes(bytes) else {
                continue;
            };
            if !assets.contains_key(&id) {
                total += asset.bytes.len();
            }
            if total > 256 * 1024 * 1024 {
                return Err("Document images exceed 256 MiB".into());
            }
            doc.images.insert(image.url, id.clone());
            assets.insert(id, asset);
        }
    }
    Ok(())
}
pub(super) fn new_document(name: String) -> Result<MarkdownDocument, String> {
    validate_name(&name)?;
    Ok(MarkdownDocument {
        id: format!(
            "md-{:x}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            next_session_identity()
        ),
        name,
        content: String::new(),
        revision: 0,
        path: None,
        dirty: true,
        images: BTreeMap::new(),
    })
}
pub(super) fn open_document(path: &str) -> Result<MarkdownSession, String> {
    ensure_extension(path)?;
    let mut doc = new_document(
        Path::new(path)
            .file_name()
            .ok_or("Missing file name")?
            .to_string_lossy()
            .into_owned(),
    )?;
    doc.content = String::from_utf8(read_limited(Path::new(path), MAX_TEXT)?)
        .map_err(|_| "Markdown must be UTF-8")?;
    doc.path = Some(path.into());
    doc.dirty = false;
    let mut assets = Assets::new();
    collect_images(
        &mut doc,
        &mut assets,
        Path::new(path).parent().unwrap_or(Path::new(".")),
    )?;
    Ok(MarkdownSession {
        document: doc,
        assets,
    })
}
fn ensure_extension(path: &str) -> Result<(), String> {
    if !Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
    {
        return Err("Use a .md or .markdown file".into());
    }
    Ok(())
}
fn export_document(doc: &MarkdownDocument, assets: &Assets, path: &str) -> Result<(), String> {
    ensure_extension(path)?;
    let path = Path::new(path);
    let directory_name = format!(
        "{}.assets",
        path.file_stem()
            .ok_or("Missing file name")?
            .to_string_lossy()
    );
    let directory = path.with_file_name(&directory_name);
    let mut content = doc.content.clone();
    for image in references(&doc.content).into_iter().rev() {
        if let Some(id) = doc.images.get(&image.url) {
            let asset = assets.get(id).ok_or("Missing image resource")?;
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let filename = format!("{id}.{}", asset.format);
            write_bytes_atomic(&directory.join(&filename), &asset.bytes)?;
            let target: String = format!("{directory_name}/{filename}")
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect();
            let alt = image
                .alt
                .replace('\\', "\\\\")
                .replace('[', "\\[")
                .replace(']', "\\]");
            let title = if image.title.is_empty() {
                String::new()
            } else {
                format!(
                    " \"{}\"",
                    image.title.replace('\\', "\\\\").replace('"', "\\\"")
                )
            };
            content.replace_range(image.range, &format!("![{alt}](<{target}>{title})"));
        }
    }
    // Publish text last; a failed image write leaves the previous document intact.
    write_bytes_atomic(path, content.as_bytes())
}
pub fn ensure_unclaimed(state: &WorkspaceState, path: &Path) -> Result<(), String> {
    if summaries(state)?.iter().any(|d| {
        d.path
            .as_ref()
            .is_some_and(|p| canonical_key(Path::new(p)) == canonical_key(path))
    }) {
        return Err("An open Markdown document owns this path".into());
    }
    Ok(())
}
pub fn summaries(state: &WorkspaceState) -> Result<Vec<MarkdownDocument>, String> {
    Ok(state
        .markdown
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.document.clone())
        .collect())
}
fn with_document<T>(
    state: &WorkspaceState,
    project_id: Option<u64>,
    id: &str,
    run: impl FnOnce(&mut MarkdownDocument, &mut Assets) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(project_id) = project_id {
        let handle = projects::handle(state, project_id)?;
        let mut project = projects::lock_project(&handle)?;
        let shared = project.image_assets.clone();
        let mut assets = shared.lock().map_err(|e| e.to_string())?;
        let doc = project
            .data
            .markdown
            .iter_mut()
            .find(|d| d.id == id)
            .ok_or("Document is no longer open")?;
        run(doc, &mut assets)
    } else {
        let mut docs = state.markdown.lock().map_err(|e| e.to_string())?;
        let s = docs
            .iter_mut()
            .find(|s| s.document.id == id)
            .ok_or("Document is no longer open")?;
        run(&mut s.document, &mut s.assets)
    }
}
#[tauri::command]
pub async fn markdown_action(
    app: AppHandle,
    project_id: Option<u64>,
    document_id: Option<String>,
    action: MarkdownAction,
) -> Result<MarkdownDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        action_internal(&app, project_id, document_id, action)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn action_internal(
    app: &AppHandle,
    project_id: Option<u64>,
    document_id: Option<String>,
    action: MarkdownAction,
) -> Result<MarkdownDocument, String> {
    static ACTIONS: Mutex<()> = Mutex::new(());
    let _operation = ACTIONS.lock().map_err(|e| e.to_string())?;
    let state = app.state::<WorkspaceState>();
    match action {
        MarkdownAction::New { name } => add(
            &state,
            project_id,
            MarkdownSession {
                document: new_document(name)?,
                assets: Assets::new(),
            },
        ),
        MarkdownAction::Open { path } => {
            if project_id.is_none()
                && find_document_by_path(&state, Path::new(&path), None)?.is_some()
            {
                return Err("An open table owns this path".into());
            }
            if project_id.is_none() {
                if let Some(doc) = summaries(&state)?.into_iter().find(|d| {
                    d.path.as_ref().is_some_and(|p| {
                        canonical_key(Path::new(p)) == canonical_key(Path::new(&path))
                    })
                }) {
                    return Ok(doc);
                }
            }
            let doc = add(&state, project_id, open_document(&path)?)?;
            if project_id.is_none() {
                projects::remember(app, &path, "markdown");
            }
            Ok(doc)
        }
        MarkdownAction::CopyToProject { target_project_id } => {
            let session = with_document(
                &state,
                project_id,
                document_id.as_deref().ok_or("Missing document ID")?,
                |doc, assets| {
                    Ok(MarkdownSession {
                        document: doc.clone(),
                        assets: assets.clone(),
                    })
                },
            )?;
            add(&state, Some(target_project_id), session)
        }
        MarkdownAction::Delete { discard } => {
            let id = document_id.ok_or("Missing document ID")?;
            if let Some(pid) = project_id {
                let handle = projects::handle(&state, pid)?;
                let mut p = projects::lock_project(&handle)?;
                let index = p
                    .data
                    .markdown
                    .iter()
                    .position(|d| d.id == id)
                    .ok_or("Unknown document")?;
                p.data.organization.item_folders.remove(&id);
                Ok(p.data.markdown.remove(index))
            } else {
                let mut docs = state.markdown.lock().map_err(|e| e.to_string())?;
                let index = docs
                    .iter()
                    .position(|s| s.document.id == id)
                    .ok_or("Unknown document")?;
                if docs[index].document.dirty && !discard {
                    return Err("Save or explicitly discard changes before closing".into());
                }
                Ok(docs.remove(index).document)
            }
        }
        other => {
            let id = document_id.ok_or("Missing document ID")?;
            if let MarkdownAction::Save { path } = &other {
                ensure_extension(path)?;
                if summaries(&state)?.iter().any(|d| {
                    (project_id.is_some() || d.id != id)
                        && d.path.as_ref().is_some_and(|p| {
                            canonical_key(Path::new(p)) == canonical_key(Path::new(path))
                        })
                }) {
                    return Err("Another open Markdown document owns this path".into());
                }
                if find_document_by_path(&state, Path::new(path), None)?.is_some() {
                    return Err("An open table owns this path".into());
                }
            }
            let result = with_document(&state, project_id, &id, |doc, assets| {
                match &other {
                    MarkdownAction::Update {
                        content,
                        expected_revision,
                    } => {
                        if doc.revision != *expected_revision {
                            return Err("Document changed; retry with the latest revision".into());
                        }
                        if content.len() as u64 > MAX_TEXT {
                            return Err("Markdown exceeds 16 MiB".into());
                        }
                        if doc.content != *content {
                            let mut next = doc.clone();
                            next.content = content.clone();
                            if let Some(path) = &doc.path {
                                collect_images(
                                    &mut next,
                                    assets,
                                    Path::new(path).parent().unwrap_or(Path::new(".")),
                                )?;
                            }
                            next.revision += 1;
                            next.dirty = true;
                            *doc = next;
                        }
                    }
                    MarkdownAction::Rename { name } => {
                        validate_name(name)?;
                        doc.name = name.clone();
                        doc.revision += 1;
                        doc.dirty = true;
                    }
                    MarkdownAction::Save { path } => {
                        export_document(doc, assets, path)?;
                        if project_id.is_none() {
                            doc.path = Some(path.clone());
                            doc.name = Path::new(path)
                                .file_name()
                                .unwrap()
                                .to_string_lossy()
                                .into_owned();
                            doc.dirty = false;
                        }
                    }
                    _ => unreachable!(),
                }
                Ok(doc.clone())
            })?;
            if let MarkdownAction::Save { path } = other {
                if project_id.is_none() {
                    projects::remember(app, &path, "markdown");
                }
            }
            Ok(result)
        }
    }
}
fn add(
    state: &WorkspaceState,
    project_id: Option<u64>,
    mut s: MarkdownSession,
) -> Result<MarkdownDocument, String> {
    if let Some(pid) = project_id {
        let handle = projects::handle(state, pid)?;
        let mut p = projects::lock_project(&handle)?;
        s.document.id = new_document(s.document.name.clone())?.id;
        s.document.path = None;
        s.document.dirty = true;
        p.image_assets
            .lock()
            .map_err(|e| e.to_string())?
            .extend(s.assets);
        p.data.markdown.push(s.document.clone());
    } else {
        let mut docs = state.markdown.lock().map_err(|e| e.to_string())?;
        if let Some(path) = &s.document.path {
            if let Some(existing) = docs.iter().find(|d| {
                d.document
                    .path
                    .as_ref()
                    .is_some_and(|p| canonical_key(Path::new(p)) == canonical_key(Path::new(path)))
            }) {
                return Ok(existing.document.clone());
            }
        }
        docs.push(s.clone());
    }
    Ok(s.document)
}
#[tauri::command]
pub async fn markdown_image_import(
    app: AppHandle,
    project_id: Option<u64>,
    document_id: String,
    path: Option<String>,
    bytes: Option<Vec<u8>>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = match path {
            Some(path) => read_limited(Path::new(&path), images::MAX_IMAGE_BYTES)?,
            None => bytes.ok_or("Missing image")?,
        };
        let (id, asset) = images::from_bytes(bytes)?;
        with_document(
            &app.state::<WorkspaceState>(),
            project_id,
            &document_id,
            |doc, assets| {
                let total: usize = assets.values().map(|a| a.bytes.len()).sum();
                if !assets.contains_key(&id) && total + asset.bytes.len() > 256 * 1024 * 1024 {
                    return Err("Image resources exceed 256 MiB".into());
                }
                let url = format!("tablune-asset:{id}");
                assets.insert(id.clone(), asset);
                doc.images.insert(url.clone(), id);
                Ok(url)
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn markdown_image_read(
    app: AppHandle,
    project_id: Option<u64>,
    document_id: String,
    url: String,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_document(
            &app.state::<WorkspaceState>(),
            project_id,
            &document_id,
            |doc, assets| {
                let id = doc
                    .images
                    .get(&url)
                    .ok_or("Image unavailable; import a local PNG or JPEG")?;
                Ok(tauri::ipc::Response::new(
                    assets
                        .get(id)
                        .ok_or("Missing image")?
                        .bytes
                        .as_ref()
                        .clone(),
                ))
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Serialize, Deserialize)]
struct Recovery {
    version: u8,
    documents: Vec<MarkdownDocument>,
    assets: BTreeMap<String, Vec<u8>>,
}
pub fn recovery_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("markdown-recovery.json"))
}
static RECOVERY_IO: Mutex<()> = Mutex::new(());
pub fn discard_recovery(app: &AppHandle) -> Result<(), String> {
    let _io = RECOVERY_IO.lock().map_err(|e| e.to_string())?;
    remove_if_exists(&recovery_path(app)?).map_err(|e| e.to_string())
}
pub fn write_recovery(app: &AppHandle, state: &WorkspaceState) -> Result<(), String> {
    let _io = RECOVERY_IO.lock().map_err(|e| e.to_string())?;
    let docs = state.markdown.lock().map_err(|e| e.to_string())?;
    let mut recovery = Recovery {
        version: 1,
        documents: Vec::new(),
        assets: BTreeMap::new(),
    };
    for s in docs.iter().filter(|s| s.document.dirty) {
        recovery.documents.push(s.document.clone());
        for id in s.document.images.values() {
            if let Some(a) = s.assets.get(id) {
                recovery.assets.insert(id.clone(), a.bytes.as_ref().clone());
            }
        }
    }
    let path = recovery_path(app)?;
    if recovery.documents.is_empty() {
        remove_if_exists(&path).map_err(|e| e.to_string())
    } else {
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        write_json_atomic(&path, &recovery)
    }
}
pub fn restore_recovery(app: &AppHandle, state: &WorkspaceState) -> Result<(), String> {
    let _io = RECOVERY_IO.lock().map_err(|e| e.to_string())?;
    let path = recovery_path(app)?;
    if !path.exists() {
        return Ok(());
    }
    let recovery: Recovery = read_json(&path)?;
    *state.markdown.lock().map_err(|e| e.to_string())? = restore_sessions(recovery)?;
    Ok(())
}
fn restore_sessions(recovery: Recovery) -> Result<Vec<MarkdownSession>, String> {
    if recovery.version != 1 {
        return Err("Unsupported Markdown recovery version".into());
    }
    let mut assets = Assets::new();
    for (id, bytes) in recovery.assets {
        let (actual, asset) = images::from_bytes(bytes)?;
        if actual != id {
            return Err("Corrupt recovery image".into());
        }
        assets.insert(id, asset);
    }
    let mut sessions = Vec::new();
    for mut doc in recovery.documents {
        validate(&doc, &assets)?;
        doc.id = new_document(doc.name.clone())?.id;
        doc.dirty = true;
        sessions.push(MarkdownSession {
            document: doc,
            assets: assets.clone(),
        });
    }
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        let p = std::env::temp_dir().join(new_document("test".into()).unwrap().id);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn png() -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }
    #[test]
    fn exports_reference_images_without_rewriting_code_and_reopens_portably() {
        let dir = directory();
        fs::write(dir.join("source.png"), png()).unwrap();
        let original = "# México\n\n![Descripción][pic]\n\n[pic]: source.png \"Título\"\n\n```md\n![literal](source.png)\n```\n";
        fs::write(dir.join("input.md"), original).unwrap();
        let session = open_document(dir.join("input.md").to_str().unwrap()).unwrap();
        assert_eq!(session.document.content, original);
        assert!(!session.document.dirty);
        assert_eq!(session.assets.len(), 1);
        assert_eq!(references(original).len(), 1);
        export_document(
            &session.document,
            &session.assets,
            dir.join("Output file.md").to_str().unwrap(),
        )
        .unwrap();
        fs::remove_file(dir.join("source.png")).unwrap();
        let reopened = open_document(dir.join("Output file.md").to_str().unwrap()).unwrap();
        assert!(
            reopened
                .document
                .content
                .contains("```md\n![literal](source.png)\n```")
        );
        assert!(reopened.document.content.contains("Output%20file.assets/"));
        assert_eq!(reopened.assets.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn project_copy_keeps_images_independent_of_the_source_and_tracks_dirty_state() {
        let state = WorkspaceState::default();
        let p = projects::project_new_internal(&state, "Project".into(), None).unwrap();
        let mut document = new_document("Notes.md".into()).unwrap();
        let (id, asset) = images::from_bytes(png()).unwrap();
        let url = format!("tablune-asset:{id}");
        document.content = format!("![image]({url})");
        document.images.insert(url, id.clone());
        let copy = add(
            &state,
            Some(p.project_id),
            MarkdownSession {
                document,
                assets: Assets::from([(id, asset)]),
            },
        )
        .unwrap();
        assert!(copy.path.is_none());
        with_document(&state, Some(p.project_id), &copy.id, |doc, assets| {
            validate(doc, assets)
        })
        .unwrap();
    }
    #[test]
    fn confines_file_images_and_leaves_missing_or_remote_references_intact() {
        let dir = directory();
        fs::write(dir.join("image.png"), png()).unwrap();
        assert!(local_image(&dir, "image.png").is_some());
        assert!(local_image(&dir, "https://example.com/image.png").is_none());
        assert!(local_image(&dir, "../image.png").is_none());
        let mut doc = new_document("Notes.md".into()).unwrap();
        doc.content = "![missing](missing.png)\n![remote](https://example.com/a.png)".into();
        collect_images(&mut doc, &mut Assets::new(), &dir).unwrap();
        assert!(doc.images.is_empty());
        export_document(&doc, &Assets::new(), dir.join("out.md").to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(dir.join("out.md")).unwrap(), doc.content);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_export_does_not_replace_existing_text() {
        let dir = directory();
        let target = dir.join("out.md");
        fs::write(&target, "keep me").unwrap();
        let mut doc = new_document("out.md".into()).unwrap();
        doc.content = "![a](tablune-asset:missing)".into();
        doc.images
            .insert("tablune-asset:missing".into(), "missing".into());
        assert!(export_document(&doc, &Assets::new(), target.to_str().unwrap()).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "keep me");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn standalone_recovery_restores_source_and_images_with_fresh_session_ids() {
        let mut document = new_document("Recovered.md".into()).unwrap();
        let (id, asset) = images::from_bytes(png()).unwrap();
        document.content = "# Unsaved café\n".into();
        document.images.insert("image.png".into(), id.clone());
        let original_id = document.id.clone();
        let recovery = Recovery {
            version: 1,
            documents: vec![document],
            assets: BTreeMap::from([(id, asset.bytes.as_ref().clone())]),
        };
        let bytes = serde_json::to_vec(&recovery).unwrap();
        let restored = restore_sessions(serde_json::from_slice(&bytes).unwrap()).unwrap();
        assert_eq!(restored[0].document.content, "# Unsaved café\n");
        assert_ne!(restored[0].document.id, original_id);
        assert!(restored[0].document.dirty);
        assert_eq!(restored[0].assets.len(), 1);
        let mut corrupt: Recovery = serde_json::from_slice(&bytes).unwrap();
        corrupt.assets.values_mut().next().unwrap()[0] ^= 1;
        assert!(restore_sessions(corrupt).is_err());
    }
}
