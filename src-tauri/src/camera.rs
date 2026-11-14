//! Tauri commands over `lumix-ptp`. Every call opens its own session, runs on a blocking worker
//! thread (ImageCaptureCore needs the main thread free), and holds one lock so two calls never
//! talk to the camera at the same time.

use lumix_lut::parse_cube;
use lumix_ptp::{delete_luts, register_lut, register_luts, Camera, DeviceInfo, PtpError};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Empty hint: take the first USB camera; writes are still limited to verified models.
const NAME_HINT: &str = "";
const FIND_TIMEOUT: Duration = Duration::from_secs(5);
/// Entries 0 (built-in Vlog_709) and 1 (ARRI 709) came with the camera; the app never changes them.
const FIRST_USER_ENTRY: usize = 2;

#[derive(Default)]
pub struct CameraLock(Mutex<()>);

/// Error sent to the UI: a stable `code` to branch on and an English `message` for logs.
#[derive(Debug, Serialize)]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        CommandError { code, message: message.into() }
    }
}

impl From<PtpError> for CommandError {
    fn from(e: PtpError) -> Self {
        let code = match &e {
            PtpError::NoCamera | PtpError::Timeout("the camera to appear") => "no_camera",
            PtpError::Timeout(_) => "timeout",
            PtpError::Session(_) => "session",
            PtpError::NotVerified { .. } => "not_verified",
            PtpError::Settings(lumix_lut::Error::UnsupportedModel(_)) => "unsupported_model",
            PtpError::Settings(lumix_lut::Error::Cube(_) | lumix_lut::Error::UnsupportedPhotoStyle(_)) => "bad_cube",
            PtpError::Settings(lumix_lut::Error::InvalidName(_)) => "bad_name",
            PtpError::Settings(lumix_lut::Error::Slot(_)) => "bad_slot",
            PtpError::Verify(_) => "verify_failed",
            PtpError::Unsupported => "unsupported_platform",
            _ => "camera_error",
        };
        CommandError::new(code, e.to_string())
    }
}

impl From<lumix_lut::Error> for CommandError {
    fn from(e: lumix_lut::Error) -> Self {
        PtpError::Settings(e).into()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraStatus {
    manufacturer: String,
    model: String,
    firmware: String,
    /// Model and firmware are on the verified list, so registering is allowed.
    write_supported: bool,
}

impl From<&DeviceInfo> for CameraStatus {
    fn from(i: &DeviceInfo) -> Self {
        // The serial number stays in Rust; the UI has no use for it.
        CameraStatus { manufacturer: i.manufacturer.clone(), model: i.model.clone(), firmware: i.version.clone(), write_supported: i.write_verified() }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    index: usize,
    name: String,
    /// 0 = STD, 49 = V-Log, 37 = ARRI 709, 10 = Vlog_709 (built-in entry 0).
    style_code: u16,
    in_use: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    camera: CameraStatus,
    entries: Vec<LibraryEntry>,
    free_slots: Vec<usize>,
    /// Entry chosen in the camera menu, when it can be read (DC-S1M2 firmware 1.5).
    selected: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResult {
    index: usize,
    name: String,
    backup: String,
    other_changes: usize,
}

/// Run `f` with an open camera on a worker thread, one caller at a time.
async fn with_camera<T: Send + 'static>(app: AppHandle, f: impl FnOnce(&AppHandle, &Camera) -> Result<T, CommandError> + Send + 'static) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let lock = app.state::<CameraLock>();
        let _guard = lock.0.try_lock().map_err(|_| CommandError::new("busy", "another camera operation is running"))?;
        let camera = Camera::open(NAME_HINT, FIND_TIMEOUT)?;
        f(&app, &camera)
    })
    .await
    .map_err(|e| CommandError::new("internal", e.to_string()))?
}

pub(crate) fn backup_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app.path().app_data_dir().map_err(|e| CommandError::new("internal", e.to_string()))?;
    Ok(dir.join("camera-backups"))
}

/// Find the camera and report model, firmware and whether registering is allowed. About 1 s.
#[tauri::command]
pub async fn camera_status(app: AppHandle) -> Result<CameraStatus, CommandError> {
    with_camera(app, |_, camera| Ok(camera.info().into())).await
}

/// Read the LUT Library. Reads the whole settings file, about 6 s on DC-S1M2.
#[tauri::command]
pub async fn camera_list_luts(app: AppHandle) -> Result<Library, CommandError> {
    with_camera(app, |_, camera| {
        let blob = camera.read_settings()?;
        let entries = blob
            .entries()
            .into_iter()
            .map(|e| LibraryEntry { index: e.index, name: e.name, style_code: e.style_code, in_use: e.in_use })
            .collect();
        Ok(Library { camera: camera.info().into(), entries, free_slots: blob.free_slots(), selected: blob.selected_entry() })
    })
    .await
}

/// Register a .cube file in one Library slot: read, back up, write, read back. About 25 s.
/// Emits `camera-progress` with "reading", "writing", "verifying", "done".
#[tauri::command]
pub async fn camera_register_lut(app: AppHandle, cube: String, slot: usize, name: String, overwrite: bool) -> Result<RegisterResult, CommandError> {
    if slot < FIRST_USER_ENTRY {
        return Err(CommandError::new("bad_slot", format!("entry {slot} came with the camera")));
    }
    // Check the file before touching the camera.
    let cube = parse_cube(&cube)?;
    let style = cube.base_style()?;
    lumix_lut::validate_name(&name)?;
    with_camera(app, move |app, camera| {
        let backups = backup_dir(app)?;
        let report = register_lut(camera, slot, &name, style, &cube.lut, overwrite, &backups, |step| {
            let _ = app.emit("camera-progress", step);
        })?;
        Ok(RegisterResult { index: report.index, name: report.name, backup: report.backup.display().to_string(), other_changes: report.other_changes })
    })
    .await
}

/// One file for `camera_register_luts`.
#[derive(Debug, serde::Deserialize)]
pub struct NewLutRequest {
    cube: String,
    slot: usize,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterManyResult {
    registered: Vec<EntryName>,
    backup: String,
    other_changes: usize,
}

/// Register several .cube files in one write: read, back up, write, read back. About 25 s.
/// Every file and slot is checked before the camera is touched; if one is refused, nothing
/// is written. Emits `camera-progress` like `camera_register_lut`.
#[tauri::command]
pub async fn camera_register_luts(app: AppHandle, items: Vec<NewLutRequest>, overwrite: bool) -> Result<RegisterManyResult, CommandError> {
    let mut parsed = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        if item.slot < FIRST_USER_ENTRY {
            return Err(CommandError::new("bad_slot", format!("file {}: entry {} came with the camera", i + 1, item.slot)));
        }
        let at = |e: lumix_lut::Error| {
            let mut err = CommandError::from(e);
            err.message = format!("file {} ({}): {}", i + 1, item.name, err.message);
            err
        };
        let cube = parse_cube(&item.cube).map_err(at)?;
        let style = cube.base_style().map_err(at)?;
        lumix_lut::validate_name(&item.name).map_err(at)?;
        parsed.push((item.slot, item.name.clone(), style, cube.lut));
    }
    with_camera(app, move |app, camera| {
        let backups = backup_dir(app)?;
        let luts: Vec<lumix_lut::NewLut> = parsed.iter().map(|(index, name, style, lut)| lumix_lut::NewLut { index: *index, name, style: *style, lut }).collect();
        let report = register_luts(camera, &luts, overwrite, &backups, |step| {
            let _ = app.emit("camera-progress", step);
        })?;
        Ok(RegisterManyResult {
            registered: report.registered.into_iter().map(|(index, name)| EntryName { index, name }).collect(),
            backup: report.backup.display().to_string(),
            other_changes: report.other_changes,
        })
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryName {
    index: usize,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    deleted: Vec<EntryName>,
    backup: String,
}

/// Empty one or more Library slots in one write: read, back up, write, read back. About 25 s.
/// Emits `camera-progress` like `camera_register_lut`.
#[tauri::command]
pub async fn camera_delete_luts(app: AppHandle, slots: Vec<usize>) -> Result<DeleteResult, CommandError> {
    if let Some(slot) = slots.iter().find(|&&s| s < FIRST_USER_ENTRY) {
        return Err(CommandError::new("bad_slot", format!("entry {slot} came with the camera")));
    }
    with_camera(app, move |app, camera| {
        let backups = backup_dir(app)?;
        let report = delete_luts(camera, &slots, &backups, |step| {
            let _ = app.emit("camera-progress", step);
        })?;
        Ok(DeleteResult {
            deleted: report.deleted.into_iter().map(|(index, name)| EntryName { index, name }).collect(),
            backup: report.backup.display().to_string(),
        })
    })
    .await
}

/// Debug builds only: `SOSANG_CAMERA_SELFCHECK=1` runs status and Library read at startup and
/// prints the result, so the commands can be checked inside the real app process without a UI.
#[cfg(debug_assertions)]
pub(crate) fn self_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let t = std::time::Instant::now();
        match camera_status(app.clone()).await {
            Ok(s) => println!("[selfcheck] status {:?} ({:.1}s)", s, t.elapsed().as_secs_f32()),
            Err(e) => println!("[selfcheck] status error {e:?}"),
        }
        let t = std::time::Instant::now();
        match camera_list_luts(app.clone()).await {
            Ok(l) => {
                let used: Vec<String> = l.entries.iter().filter(|e| e.in_use).map(|e| format!("{}:{}", e.index, e.name)).collect();
                println!("[selfcheck] library {} in use, free {:?} ({:.1}s)", used.len(), l.free_slots, t.elapsed().as_secs_f32());
                println!("[selfcheck] entries {}", used.join(", "));
            }
            Err(e) => println!("[selfcheck] library error {e:?}"),
        }
        match backup_dir(&app) {
            Ok(d) => println!("[selfcheck] backups would go to {}", d.display()),
            Err(e) => println!("[selfcheck] backup dir error {e:?}"),
        }
    });
}
