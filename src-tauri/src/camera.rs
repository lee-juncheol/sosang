//! Tauri commands over `lumix-ptp`. Every call opens its own session, runs on a blocking worker
//! thread (ImageCaptureCore needs the main thread free), and holds one lock so two calls never
//! talk to the camera at the same time.

use lumix_lut::parse_cube;
use lumix_ptp::{delete_luts, register_luts, restore_settings, Camera, DeviceInfo, PtpError};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Empty hint: take the first USB camera. Writes need a verified model and firmware, or the
/// user's consent to an experimental write (`experimental`) on another Panasonic body.
const NAME_HINT: &str = "";
const FIND_TIMEOUT: Duration = Duration::from_secs(5);
/// Entries 0 (built-in Vlog_709) and 1 (ARRI 709) came with the camera; the app never changes them.
const FIRST_USER_ENTRY: usize = 2;

/// One camera operation at a time. An async-aware mutex so an app update can hold it across
/// its download and keep camera writes out until the restart.
#[derive(Default)]
pub struct CameraLock(tauri::async_runtime::Mutex<()>);

impl CameraLock {
    pub(crate) fn try_lock(&self) -> Result<impl Send + '_, CommandError> {
        self.0.try_lock().map_err(|_| CommandError::new("busy", "another camera operation is running"))
    }
}

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
            PtpError::Settings(lumix_lut::Error::Format(_)) => "unknown_layout",
            PtpError::Settings(lumix_lut::Error::Cube(_) | lumix_lut::Error::UnsupportedPhotoStyle(_)) => "bad_cube",
            PtpError::Settings(lumix_lut::Error::InvalidName(_)) => "bad_name",
            PtpError::Settings(lumix_lut::Error::Slot(_)) => "bad_slot",
            PtpError::Settings(lumix_lut::Error::Changed(_)) => "slot_changed",
            PtpError::Verify(_) => "verify_failed",
            PtpError::RolledBack(_) => "rolled_back",
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
    /// Not verified, but a Panasonic body: writing is allowed as an experiment after consent.
    write_experimental: bool,
}

impl From<&DeviceInfo> for CameraStatus {
    fn from(i: &DeviceInfo) -> Self {
        // The serial number stays in Rust; the UI has no use for it.
        let write_supported = i.write_verified();
        CameraStatus {
            manufacturer: i.manufacturer.clone(),
            model: i.model.clone(),
            firmware: i.version.clone(),
            write_supported,
            write_experimental: !write_supported && i.is_panasonic(),
        }
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
    /// Entry chosen in the camera menu, when it can be read (deleting needs it).
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
        let _guard = lock.try_lock()?;
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

/// The user agreed to write to a body that is not verified.
fn consent(camera: &Camera, experimental: bool) {
    if experimental {
        camera.allow_unverified_writes();
    }
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
///
/// `expected` is what the caller last saw in the slot (`null` = empty); the write stops if
/// the camera no longer matches.
pub async fn camera_register_lut(app: AppHandle, cube: String, slot: usize, name: String, overwrite: bool, expected: Option<String>, experimental: bool) -> Result<RegisterResult, CommandError> {
    if slot < FIRST_USER_ENTRY {
        return Err(CommandError::new("bad_slot", format!("entry {slot} came with the camera")));
    }
    // Check the file before touching the camera.
    let cube = parse_cube(&cube)?;
    let style = cube.base_style()?;
    lumix_lut::validate_name(&name)?;
    with_camera(app, move |app, camera| {
        let backups = backup_dir(app)?;
        consent(camera, experimental);
        let lut = lumix_lut::NewLut { index: slot, name: &name, style, lut: &cube.lut };
        let report = register_luts(camera, &[lut], overwrite, &[(slot, expected)], &backups, |step| {
            let _ = app.emit("camera-progress", step);
        })?;
        Ok(RegisterResult { index: slot, name: name.clone(), backup: report.backup.display().to_string(), other_changes: report.other_changes })
    })
    .await
}

/// One file for `camera_register_luts`.
#[derive(Debug, serde::Deserialize)]
pub struct NewLutRequest {
    cube: String,
    slot: usize,
    name: String,
    /// What the caller last saw in the slot (`null` = empty).
    expected: Option<String>,
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
pub async fn camera_register_luts(app: AppHandle, items: Vec<NewLutRequest>, overwrite: bool, experimental: bool) -> Result<RegisterManyResult, CommandError> {
    let mut parsed = Vec::with_capacity(items.len());
    let mut expected = Vec::with_capacity(items.len());
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
        expected.push((item.slot, item.expected.clone()));
    }
    with_camera(app, move |app, camera| {
        let backups = backup_dir(app)?;
        consent(camera, experimental);
        let luts: Vec<lumix_lut::NewLut> = parsed.iter().map(|(index, name, style, lut)| lumix_lut::NewLut { index: *index, name, style: *style, lut }).collect();
        let report = register_luts(camera, &luts, overwrite, &expected, &backups, |step| {
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
///
/// `names` are the names the caller saw in those slots, in the same order; the write stops if
/// the camera no longer matches.
pub async fn camera_delete_luts(app: AppHandle, slots: Vec<usize>, names: Vec<String>, experimental: bool) -> Result<DeleteResult, CommandError> {
    if let Some(slot) = slots.iter().find(|&&s| s < FIRST_USER_ENTRY) {
        return Err(CommandError::new("bad_slot", format!("entry {slot} came with the camera")));
    }
    if names.len() != slots.len() {
        return Err(CommandError::new("internal", "one name per slot is needed"));
    }
    let expected: Vec<lumix_ptp::Expected> = slots.iter().copied().zip(names.into_iter().map(Some)).collect();
    with_camera(app, move |app, camera| {
        consent(camera, experimental);
        let backups = backup_dir(app)?;
        let report = delete_luts(camera, &slots, &expected, &backups, |step| {
            let _ = app.emit("camera-progress", step);
        })?;
        Ok(DeleteResult {
            deleted: report.deleted.into_iter().map(|(index, name)| EntryName { index, name }).collect(),
            backup: report.backup.display().to_string(),
        })
    })
    .await
}

/// The `.json` written beside each backup by lumix-ptp.
#[derive(Debug, serde::Deserialize)]
struct BackupInfo {
    model: String,
    firmware: String,
    serial: String,
    created: u64,
    action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    /// File name without extension; pass it back to `camera_restore_backup`.
    id: String,
    model: String,
    firmware: String,
    /// Milliseconds since 1970.
    created: u64,
    action: String,
}

fn read_backup_info(dir: &std::path::Path, id: &str) -> Option<BackupInfo> {
    let text = std::fs::read_to_string(dir.join(format!("{id}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

/// Backups that can be restored (those with an info file), newest first. No camera needed.
#[tauri::command]
pub async fn camera_list_backups(app: AppHandle) -> Result<Vec<BackupEntry>, CommandError> {
    let dir = backup_dir(&app)?;
    let Ok(read) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut list: Vec<BackupEntry> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name.strip_suffix(".bin")?.to_string();
            let info = read_backup_info(&dir, &id)?;
            Some(BackupEntry { id, model: info.model, firmware: info.firmware, created: info.created, action: info.action })
        })
        .collect();
    list.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(list)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    backup: String,
}

/// Write a backup back to the camera: only to the same camera (serial), model and firmware it
/// came from. The current settings are backed up first; the camera must read back the file
/// exactly. About 25 s. Emits `camera-progress`.
#[tauri::command]
pub async fn camera_restore_backup(app: AppHandle, id: String) -> Result<RestoreResult, CommandError> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(CommandError::new("bad_backup", "invalid backup id"));
    }
    let dir = backup_dir(&app)?;
    let info = read_backup_info(&dir, &id).ok_or_else(|| CommandError::new("bad_backup", "backup info file is missing"))?;
    let bytes = std::fs::read(dir.join(format!("{id}.bin"))).map_err(|e| CommandError::new("bad_backup", e.to_string()))?;
    let saved = lumix_lut::SettingsBlob::parse(bytes).map_err(|e| CommandError::new("bad_backup", e.to_string()))?;
    with_camera(app, move |app, camera| {
        let now = camera.info();
        if now.serial != info.serial || now.model != info.model || now.version != info.firmware || saved.model() != now.model {
            return Err(CommandError::new("other_camera", format!("backup is from {} firmware {}, a different camera or firmware", info.model, info.firmware)));
        }
        let report = restore_settings(camera, &saved, &backup_dir(app)?, |step| {
            let _ = app.emit("camera-progress", step);
        })?;
        Ok(RestoreResult { backup: report.backup.display().to_string() })
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
