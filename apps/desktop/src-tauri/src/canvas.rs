//! Versioned project canvases. Geometry and resource references are validated before commit.
use super::*;
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocument {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub content: Value,
}
pub fn empty() -> Value {
    json!({"nodes": [], "edges": []})
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("Invalid canvas {key}"))
}
fn number(v: &Value, key: &str, min: f64, max: f64) -> Result<(), String> {
    if !v[key]
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= min && n <= max)
    {
        return Err(format!("Invalid canvas {key}"));
    }
    Ok(())
}
fn color(v: &Value, key: &str) -> Result<(), String> {
    let c = string(v, key)?;
    if c != "transparent"
        && !(c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("Invalid canvas color".into());
    }
    Ok(())
}
pub fn validate(content: &Value, assets: &crate::images::Assets) -> Result<(), String> {
    if serde_json::to_vec(content)
        .map_err(|e| e.to_string())?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("Canvas exceeds 16 MiB".into());
    }
    let nodes = content["nodes"].as_array().ok_or("Missing canvas nodes")?;
    let edges = content["edges"].as_array().ok_or("Missing canvas edges")?;
    if nodes.len() + edges.len() > 10_000 {
        return Err("Canvas exceeds 10 000 elements".into());
    }
    let mut ids = HashSet::new();
    for item in nodes.iter().chain(edges) {
        let id = string(item, "id")?;
        if id.is_empty()
            || id.len() > 120
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !ids.insert(id)
        {
            return Err("Invalid or duplicate canvas identifier".into());
        }
        if string(item, "text")?.len() > 64 * 1024 {
            return Err("Canvas text exceeds 64 KiB".into());
        }
        color(item, "stroke")?;
        number(item, "strokeWidth", 0., 12.)?;
    }
    let node_ids: HashSet<_> = nodes.iter().filter_map(|n| n["id"].as_str()).collect();
    for n in nodes {
        if !matches!(
            string(n, "kind")?,
            "rect"
                | "rounded"
                | "ellipse"
                | "diamond"
                | "text"
                | "note"
                | "image"
                | "card"
                | "freehand"
        ) {
            return Err("Unknown canvas shape".into());
        }
        for key in ["x", "y"] {
            number(n, key, -1_000_000., 1_000_000.)?;
        }
        for key in ["width", "height"] {
            number(n, key, 16., 10_000.)?;
        }
        number(n, "fontSize", 8., 96.)?;
        for key in ["fill", "color"] {
            color(n, key)?;
        }
        if !matches!(string(n, "align")?, "left" | "center" | "right") {
            return Err("Invalid text alignment".into());
        }
        if !n["group"].is_null() && string(n, "group")?.len() > 120 {
            return Err("Invalid group".into());
        }
        if n["kind"] == "freehand" {
            let points = n["points"].as_array().ok_or("Missing stroke points")?;
            if points.is_empty() || points.len() > 4096 {
                return Err("Invalid stroke point count".into());
            }
            for point in points {
                number(point, "x", 0., 1.)?;
                number(point, "y", 0., 1.)?;
            }
        }
        if n["kind"] == "image" && !assets.contains_key(string(n, "assetId")?) {
            return Err("Missing canvas image".into());
        }
        if n["kind"] == "card"
            && (string(&n["link"], "id")?.len() > 120
                || string(&n["link"], "name")?.len() > 1024
                || !matches!(string(&n["link"], "kind")?, "table" | "markdown" | "script"))
        {
            return Err("Invalid document link".into());
        }
    }
    for e in edges {
        for key in ["from", "to"] {
            let endpoint = &e[key];
            if !node_ids.contains(string(endpoint, "nodeId")?)
                || !matches!(
                    string(endpoint, "side")?,
                    "top" | "right" | "bottom" | "left"
                )
            {
                return Err("Invalid connector endpoint".into());
            }
        }
        if !matches!(string(e, "route")?, "straight" | "elbow") {
            return Err("Invalid connector route".into());
        }
        number(e, "offset", -1_000_000., 1_000_000.)?;
        if !e["startArrow"].is_boolean() || !e["endArrow"].is_boolean() {
            return Err("Invalid connector arrows".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn canvas_image_import(
    app: AppHandle,
    project_id: u64,
    path: Option<String>,
    bytes: Option<Vec<u8>>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let bytes = if let Some(path) = path {
            let mut b = Vec::new();
            fs::File::open(path)
                .map_err(|e| e.to_string())?
                .take(crate::images::MAX_IMAGE_BYTES + 1)
                .read_to_end(&mut b)
                .map_err(|e| e.to_string())?;
            b
        } else {
            bytes.ok_or("Missing image")?
        };
        let (id, asset) = crate::images::from_bytes(bytes)?;
        let h = handle(&app.state::<WorkspaceState>(), project_id)?;
        let p = lock_project(&h)?;
        let mut assets = p.image_assets.lock().map_err(|e| e.to_string())?;
        let total: usize = assets.values().map(|a| a.bytes.len()).sum();
        if !assets.contains_key(&id) && total + asset.bytes.len() > 256 * 1024 * 1024 {
            return Err("Image resources exceed 256 MiB".into());
        }
        assets.insert(id.clone(), asset);
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn canvas_image_read(
    app: AppHandle,
    project_id: u64,
    asset_id: String,
) -> Result<tauri::ipc::Response, String> {
    let h = handle(&app.state::<WorkspaceState>(), project_id)?;
    let p = lock_project(&h)?;
    let assets = p.image_assets.lock().map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(
        assets
            .get(&asset_id)
            .ok_or("Missing image")?
            .bytes
            .as_ref()
            .clone(),
    ))
}
#[tauri::command]
pub async fn canvas_export(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        if bytes.len() > 128 * 1024 * 1024
            || !path
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("png") || s.eq_ignore_ascii_case("svg"))
        {
            return Err("Invalid canvas export".into());
        }
        let _reservation = FilePathOperation::acquire(path)?;
        write_bytes_atomic(path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn canvas_new(app: AppHandle) -> Result<ProjectSummary, String> {
    let state = app.state::<WorkspaceState>();
    let created = project_new_internal(&state, "Untitled canvas".into(), None)?;
    apply_action(
        &state,
        created.project_id,
        ProjectAction::NewCanvas {
            name: "Untitled canvas".into(),
            folder_id: None,
        },
    )?;
    let h = handle(&state, created.project_id)?;
    let mut p = lock_project(&h)?;
    p.data.standalone_canvas = true;
    p.summary()
}
