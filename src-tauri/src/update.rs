//! App updates through tauri-plugin-updater. The endpoint and public key are in
//! tauri.conf.json (`plugins.updater`); every download is checked against that key, and the
//! signature must name the version the endpoint announced (`requireSignedVersion`).

use crate::camera::{CameraLock, CommandError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn update_error(e: tauri_plugin_updater::Error) -> CommandError {
    CommandError::new("update_failed", e.to_string())
}

/// Ask the update endpoint whether a newer version exists. `null` = up to date.
#[tauri::command]
pub async fn app_check_update(app: AppHandle) -> Result<Option<UpdateInfo>, CommandError> {
    let update = app.updater().map_err(update_error)?.check().await.map_err(update_error)?;
    Ok(update.map(|u| UpdateInfo { version: u.version, current_version: u.current_version, notes: u.body }))
}

/// Download, verify and install the newer version, then restart. Refused while a camera
/// operation is running, and the camera stays locked until the restart. Emits
/// `update-progress` with the bytes downloaded so far.
#[tauri::command]
pub async fn app_install_update(app: AppHandle) -> Result<(), CommandError> {
    let lock = app.state::<CameraLock>();
    let _camera = lock.try_lock()?;
    let update = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?
        .ok_or_else(|| CommandError::new("no_update", "no newer version is available"))?;
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit("update-progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(update_error)?;
    app.restart();
}
