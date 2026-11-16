//! Photo sending (from PhotoCourier): commands behind the app's "사진 보내기" view.
//! The work itself lives in the `photo-courier` crate; these run it off the UI thread.

use crate::camera::CommandError;
use photo_courier::{image, scan, Error, Format, Job, Kind, PhotoEntry};
use std::path::PathBuf;
use tauri::ipc::Response;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

impl From<Error> for CommandError {
    fn from(e: Error) -> Self {
        let code = match e {
            Error::Unreadable => "courier_unreadable",
            Error::Unsupported => "courier_unsupported",
            Error::Encode => "courier_encode",
            Error::Read(_) => "courier_read",
            Error::Write(_) => "courier_write",
        };
        CommandError::new(code, e.to_string())
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, CommandError> + Send + 'static) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| CommandError::new("internal", e.to_string()))?
}

fn read(path: &str) -> Result<Vec<u8>, CommandError> {
    if !scan::is_jpeg(PathBuf::from(path).as_path()) {
        return Err(Error::Unsupported.into());
    }
    std::fs::read(path).map_err(|e| Error::Read(e.to_string()).into())
}

/// Folder picker; null when cancelled.
#[tauri::command]
pub async fn courier_pick_folder(app: AppHandle) -> Result<Option<String>, CommandError> {
    blocking(move || {
        let Some(folder) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
        let path = folder.into_path().map_err(|e| CommandError::new("internal", e.to_string()))?;
        Ok(Some(path.display().to_string()))
    })
    .await
}

/// JPG photos in `folder` (and its subfolders when `recursive`), skipping the `exclude` tree.
#[tauri::command]
pub async fn courier_list(folder: String, recursive: bool, exclude: Option<String>) -> Result<Vec<PhotoEntry>, CommandError> {
    blocking(move || Ok(scan::list(folder.as_ref(), Kind::Sendable, recursive, exclude.as_deref().map(AsRef::as_ref))?)).await
}

/// Photos already in the destination folder (top level only).
#[tauri::command]
pub async fn courier_list_saved(folder: String) -> Result<Vec<PhotoEntry>, CommandError> {
    blocking(move || Ok(scan::list(folder.as_ref(), Kind::AnyPhoto, false, None)?)).await
}

/// Small upright JPEG for the list.
#[tauri::command]
pub async fn courier_thumbnail(path: String) -> Result<Response, CommandError> {
    blocking(move || Ok(Response::new(image::thumbnail(&read(&path)?, 160)?))).await
}

/// Upright preview whose longer edge is at most `edge`. Body: 4-byte little-endian length of a
/// JSON header ({width, height, info}: full upright size and capture details), the header, then
/// the JPEG.
#[tauri::command]
pub async fn courier_preview(path: String, edge: u32) -> Result<Response, CommandError> {
    blocking(move || {
        let preview = image::preview(&read(&path)?, edge.clamp(256, 4096))?;
        let header = serde_json::json!({ "width": preview.width, "height": preview.height, "info": preview.info });
        let header = serde_json::to_vec(&header).map_err(|e| CommandError::new("internal", e.to_string()))?;
        let mut body = Vec::with_capacity(4 + header.len() + preview.jpeg.len());
        body.extend_from_slice(&(header.len() as u32).to_le_bytes());
        body.extend_from_slice(&header);
        body.extend_from_slice(&preview.jpeg);
        Ok(Response::new(body))
    })
    .await
}

/// Send one photo; returns the saved path. `webp` = WebP quality, null keeps the JPG format.
#[tauri::command]
pub async fn courier_export(source: String, destination: String, level: f64, webp: Option<u8>) -> Result<String, CommandError> {
    blocking(move || {
        if !scan::is_jpeg(source.as_ref()) {
            return Err(Error::Unsupported.into());
        }
        let job = Job {
            source: source.into(),
            destination: destination.into(),
            level: if level.is_finite() { level } else { 0.0 },
            format: webp.map_or(Format::Original, Format::WebP),
        };
        Ok(photo_courier::export(&job)?.display().to_string())
    })
    .await
}
