//! Validated, content-addressed project images. Lock order: document -> assets.
use crate::session::{self, WorkspaceState};
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    io::{Cursor, Read},
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
pub type Assets = BTreeMap<String, ImageAsset>;
pub type SharedAssets = Arc<Mutex<Assets>>;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellImage {
    pub asset_id: String,
    pub name: String,
    pub alt: String,
}
impl CellImage {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.asset_id)
            || self.name.trim().is_empty()
            || self.name.len() > 1024
            || self.name.contains(['/', '\\', '\0', '\n', '\r'])
            || self.alt.len() > 8192
        {
            return Err("Invalid image reference or name".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAsset {
    pub format: String,
    pub width: u32,
    pub height: u32,
    #[serde(skip)]
    pub bytes: Arc<Vec<u8>>,
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn decode(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("Image exceeds 20 MiB".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "Invalid image")?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg) {
        return Err("Only PNG and JPEG images are supported".into());
    }
    let (w, h) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|e| e.to_string())?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 25_000_000 {
        return Err("Image exceeds 25 megapixels or has invalid dimensions".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|e| e.to_string())
}
pub fn from_bytes(bytes: Vec<u8>) -> Result<(String, ImageAsset), String> {
    let decoded = decode(&bytes)?;
    let format = if image::guess_format(&bytes).map_err(|e| e.to_string())? == ImageFormat::Png {
        "png"
    } else {
        "jpeg"
    };
    Ok((
        format!("{:x}", Sha256::digest(&bytes)),
        ImageAsset {
            format: format.into(),
            width: decoded.width(),
            height: decoded.height(),
            bytes: Arc::new(bytes),
        },
    ))
}
pub fn validate_asset(id: &str, asset: &ImageAsset) -> Result<(), String> {
    let (actual, checked) = from_bytes(asset.bytes.as_ref().clone())?;
    if actual != id
        || asset.width != checked.width
        || asset.height != checked.height
        || asset.format != checked.format
    {
        return Err("Corrupt image resource".into());
    }
    Ok(())
}
pub fn retain_referenced(data: &mut session::projects::ProjectData) {
    let ids: HashSet<_> = data
        .tables
        .iter()
        .flat_map(|t| t.sheet.cells.values())
        .filter_map(|m| m.image.as_ref().map(|i| i.asset_id.clone()))
        .collect();
    data.assets.retain(|id, _| ids.contains(id));
}
fn store(state: &WorkspaceState, document_id: u64) -> Result<SharedAssets, String> {
    let handle = session::document_handle(state, document_id)?;
    let doc = session::lock_document(&handle)?;
    if doc.project_id.is_none() {
        return Err("Images require a .tablune project".into());
    }
    Ok(doc.image_assets.clone())
}
#[tauri::command]
pub async fn image_import(
    app: tauri::AppHandle,
    document_id: u64,
    path: String,
) -> Result<CellImage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let assets = store(&app.state::<WorkspaceState>(), document_id)?;
        let path = Path::new(&path);
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() > MAX_IMAGE_BYTES {
            return Err("Image exceeds 20 MiB".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let (id, asset) = from_bytes(bytes)?;
        let reference = CellImage {
            asset_id: id.clone(),
            name: path
                .file_name()
                .ok_or("Missing file name")?
                .to_string_lossy()
                .into_owned(),
            alt: String::new(),
        };
        reference.validate()?;
        assets
            .lock()
            .map_err(|_| "Image store unavailable")?
            .entry(id)
            .or_insert(asset);
        Ok(reference)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn image_read(
    app: tauri::AppHandle,
    document_id: u64,
    asset_id: String,
    thumbnail: bool,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let assets = store(&app.state::<WorkspaceState>(), document_id)?;
        let asset = assets
            .lock()
            .map_err(|_| "Image store unavailable")?
            .get(&asset_id)
            .cloned()
            .ok_or("Image resource is missing")?;
        let bytes = if thumbnail {
            let mut output = Cursor::new(Vec::new());
            decode(&asset.bytes)?
                .thumbnail(256, 256)
                .write_to(&mut output, ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            output.into_inner()
        } else {
            asset.bytes.as_ref().clone()
        };
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}
// Only the current internal clipboard pins assets; replacing it releases the old set.
static CLIPBOARD: Mutex<Assets> = Mutex::new(BTreeMap::new());
#[tauri::command]
pub fn image_clipboard_copy(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    asset_ids: Vec<String>,
) -> Result<(), String> {
    let mut next = Assets::new();
    if !asset_ids.is_empty() {
        let assets = store(&state, document_id)?;
        let assets = assets.lock().map_err(|_| "Image store unavailable")?;
        for id in asset_ids {
            next.insert(
                id.clone(),
                assets
                    .get(&id)
                    .cloned()
                    .ok_or("Image resource is missing")?,
            );
        }
    }
    *CLIPBOARD
        .lock()
        .map_err(|_| "Image clipboard unavailable")? = next;
    Ok(())
}
#[tauri::command]
pub fn image_clipboard_paste(
    state: State<'_, WorkspaceState>,
    document_id: u64,
    asset_ids: Vec<String>,
) -> Result<(), String> {
    let next: Assets = {
        let clipboard = CLIPBOARD
            .lock()
            .map_err(|_| "Image clipboard unavailable")?;
        asset_ids
            .into_iter()
            .map(|id| {
                Ok((
                    id.clone(),
                    clipboard
                        .get(&id)
                        .cloned()
                        .ok_or("Image clipboard has changed; copy again")?,
                ))
            })
            .collect::<Result<_, String>>()?
    };
    let assets = store(&state, document_id)?;
    assets
        .lock()
        .map_err(|_| "Image store unavailable")?
        .extend(next);
    Ok(())
}

#[cfg(test)]
pub(crate) fn fixture() -> (CellImage, ImageAsset) {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(12, 8)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    let (asset_id, asset) = from_bytes(bytes.into_inner()).unwrap();
    (
        CellImage {
            asset_id,
            name: "photo.png".into(),
            alt: "Product photograph".into(),
        },
        asset,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_formats_hashes_dimensions_and_corruption() {
        let (reference, asset) = fixture();
        reference.validate().unwrap();
        validate_asset(&reference.asset_id, &asset).unwrap();
        assert_eq!((asset.width, asset.height), (12, 8));
        assert_eq!(
            from_bytes(asset.bytes.as_ref().clone()).unwrap().0,
            reference.asset_id
        );
        assert!(validate_asset(&"0".repeat(64), &asset).is_err());
        assert!(from_bytes(b"not a PNG".to_vec()).is_err());
        assert!(from_bytes(vec![0; MAX_IMAGE_BYTES as usize + 1]).is_err());
        let mut jpeg = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 2)
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        assert_eq!(from_bytes(jpeg.into_inner()).unwrap().1.format, "jpeg");
        let mut oversized = Cursor::new(Vec::new());
        image::DynamicImage::new_luma8(5001, 5000)
            .write_to(&mut oversized, ImageFormat::Png)
            .unwrap();
        assert!(
            from_bytes(oversized.into_inner())
                .unwrap_err()
                .contains("megapixels")
        );
    }
}
