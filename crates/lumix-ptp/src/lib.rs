//! PTP transport for registering LUTs in a LUMIX camera's LUT Library over USB.
//!
//! Only three operations are ever sent: `GetDeviceInfo` (0x1001), the Panasonic settings read
//! (0x9421 with property 0x080000A2) and the settings write (0x9422, same property). The write
//! only accepts a [`lumix_lut::SettingsBlob`], so its bytes have passed format, model and
//! checksum validation, and [`register_lut`] adds a backup, a scope guard and a read-back check.
//!
//! On macOS the camera is reached through ImageCaptureCore, which coexists with `ptpcamerad`
//! (raw USB access is blocked by it). ImageCaptureCore delivers callbacks on the main run
//! loop, so every call here must come from a thread other than the main thread, and the main
//! thread must be running its run loop (a Tauri app does; the `probe` example shows a CLI).

use lumix_lut::{BaseStyle, Lut33, NewLut, SettingsBlob, SETTINGS_PROP};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(target_os = "macos")]
mod mac;

const OP_GET_DEVICE_INFO: u16 = 0x1001;
const OP_READ_SETTINGS: u16 = 0x9421;
const OP_WRITE_SETTINGS: u16 = 0x9422;
const RESP_OK: u16 = 0x2001;

/// Bodies and firmware whose LUT Library writes were verified on real hardware.
pub const VERIFIED_FOR_WRITE: &[(&str, &str)] = &[("DC-S1M2", "1.5")];

#[derive(Debug)]
pub enum PtpError {
    NoCamera,
    Timeout(&'static str),
    Session(String),
    /// The camera answered with a PTP response code other than OK.
    Response { op: u16, code: u16 },
    Transport(String),
    Settings(lumix_lut::Error),
    NotVerified { model: String, version: String },
    Verify(String),
    /// The read-back check failed and the settings read before the write were written back.
    RolledBack(String),
    Io(std::io::Error),
    Unsupported,
}

impl std::fmt::Display for PtpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PtpError::NoCamera => write!(f, "no LUMIX camera found over USB"),
            PtpError::Timeout(what) => write!(f, "timed out waiting for {what}"),
            PtpError::Session(m) => write!(f, "could not open a session with the camera: {m}"),
            PtpError::Response { op, code } => write!(f, "camera rejected operation {op:#06x} with response {code:#06x}"),
            PtpError::Transport(m) => write!(f, "USB transfer failed: {m}"),
            PtpError::Settings(e) => write!(f, "{e}"),
            PtpError::NotVerified { model, version } => write!(f, "writing to {model} firmware {version} has not been verified"),
            PtpError::Verify(m) => write!(f, "read-back check failed: {m}"),
            PtpError::RolledBack(m) => write!(f, "read-back check failed ({m}); the settings from before the write were written back"),
            PtpError::Io(e) => write!(f, "{e}"),
            PtpError::Unsupported => write!(f, "camera access is only implemented on macOS so far"),
        }
    }
}
impl std::error::Error for PtpError {}
impl From<lumix_lut::Error> for PtpError {
    fn from(e: lumix_lut::Error) -> Self {
        PtpError::Settings(e)
    }
}
impl From<std::io::Error> for PtpError {
    fn from(e: std::io::Error) -> Self {
        PtpError::Io(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub manufacturer: String,
    pub model: String,
    pub version: String,
    pub serial: String,
}

impl DeviceInfo {
    pub fn write_verified(&self) -> bool {
        VERIFIED_FOR_WRITE.iter().any(|(m, v)| *m == self.model && *v == self.version)
    }

    /// A Panasonic body; writes to one that is not verified need [`Camera::allow_unverified_writes`].
    pub fn is_panasonic(&self) -> bool {
        self.manufacturer.to_ascii_lowercase().contains("panasonic")
    }
}

/// Start USB camera discovery in the background (call once at app start; safe to call again).
/// A freshly started browser can take a while to report a camera that is already connected.
pub fn start_discovery() {
    #[cfg(target_os = "macos")]
    mac::start_discovery();
}

/// An open PTP session with one camera.
pub struct Camera {
    #[cfg(target_os = "macos")]
    inner: mac::Session,
    info: DeviceInfo,
    /// The user accepted writing to a model/firmware that is not on [`VERIFIED_FOR_WRITE`].
    unverified_ok: std::cell::Cell<bool>,
}

impl Camera {
    /// Find the first USB camera whose name contains `name_hint` and open a session.
    pub fn open(name_hint: &str, timeout: Duration) -> Result<Camera, PtpError> {
        #[cfg(target_os = "macos")]
        {
            let inner = mac::Session::open(name_hint, timeout)?;
            let (code, data) = inner.transaction(OP_GET_DEVICE_INFO, &[], None, Duration::from_secs(10))?;
            check(OP_GET_DEVICE_INFO, code)?;
            let info = parse_device_info(&data).ok_or_else(|| PtpError::Transport("malformed DeviceInfo".into()))?;
            Ok(Camera { inner, info, unverified_ok: std::cell::Cell::new(false) })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (name_hint, timeout);
            Err(PtpError::Unsupported)
        }
    }

    pub fn info(&self) -> &DeviceInfo {
        &self.info
    }

    /// Allow LUT writes to this Panasonic body although its model and firmware are not on
    /// [`VERIFIED_FOR_WRITE`] (experimental; the user must agree first). Every write still
    /// backs up, passes the scope guard and is read back, and a failed read-back is undone.
    pub fn allow_unverified_writes(&self) {
        self.unverified_ok.set(true);
    }

    /// LUT writes are allowed: a verified body, or a Panasonic body the user accepted.
    pub fn may_write(&self) -> bool {
        self.info.write_verified() || (self.unverified_ok.get() && self.info.is_panasonic())
    }

    fn not_verified(&self) -> PtpError {
        PtpError::NotVerified { model: self.info.model.clone(), version: self.info.version.clone() }
    }

    /// Read the whole settings file (about 9 MB on DC-S1M2; takes a few seconds).
    pub fn read_settings(&self) -> Result<SettingsBlob, PtpError> {
        #[cfg(target_os = "macos")]
        {
            let (code, data) = self.inner.transaction(OP_READ_SETTINGS, &[SETTINGS_PROP], None, Duration::from_secs(60))?;
            check(OP_READ_SETTINGS, code)?;
            Ok(SettingsBlob::parse(data)?)
        }
        #[cfg(not(target_os = "macos"))]
        Err(PtpError::Unsupported)
    }

    /// Write a validated settings file back (about 11 s on DC-S1M2).
    pub fn write_settings(&self, blob: &SettingsBlob) -> Result<(), PtpError> {
        if !self.may_write() {
            return Err(self.not_verified());
        }
        self.write_camera_settings(blob)
    }

    /// Write settings of this camera's model without the write-permission check: used to put
    /// back settings the camera itself produced (a backup or the state before a failed write).
    fn write_camera_settings(&self, blob: &SettingsBlob) -> Result<(), PtpError> {
        if blob.model() != self.info.model {
            return Err(PtpError::Verify(format!("settings are for {}, the camera is {}", blob.model(), self.info.model)));
        }
        #[cfg(target_os = "macos")]
        {
            let (code, _) = self.inner.transaction(OP_WRITE_SETTINGS, &[SETTINGS_PROP], Some(blob.as_bytes().to_vec()), Duration::from_secs(120))?;
            check(OP_WRITE_SETTINGS, code)
        }
        #[cfg(not(target_os = "macos"))]
        Err(PtpError::Unsupported)
    }
}

fn check(op: u16, code: u16) -> Result<(), PtpError> {
    if code == RESP_OK {
        Ok(())
    } else {
        Err(PtpError::Response { op, code })
    }
}

/// What [`register_lut`] did.
#[derive(Debug, Clone)]
pub struct RegisterReport {
    pub index: usize,
    pub name: String,
    pub backup: PathBuf,
    /// Bytes outside the target slot that differ after the camera re-saved its settings.
    /// The camera updates a few state bytes itself, so a small number is expected.
    pub other_changes: usize,
}

/// Store `lut` in Library entry `index`, with a backup and a read-back check.
///
/// 1. read the current settings and save them to `backup_dir`;
/// 2. patch only the chosen entry (`SettingsBlob::with_lut` enforces the scope);
/// 3. write; 4. read again and confirm the entry and its LUT match what was sent.
pub fn register_lut(
    camera: &Camera,
    index: usize,
    name: &str,
    style: BaseStyle,
    lut: &Lut33,
    allow_overwrite: bool,
    backup_dir: &Path,
    progress: impl FnMut(&str),
) -> Result<RegisterReport, PtpError> {
    let r = register_luts(camera, &[NewLut { index, name, style, lut }], allow_overwrite, &[], backup_dir, progress)?;
    Ok(RegisterReport { index, name: name.to_string(), backup: r.backup, other_changes: r.other_changes })
}

/// What [`register_luts`] did.
#[derive(Debug, Clone)]
pub struct RegisterManyReport {
    /// Stored entries and their names, in the order given.
    pub registered: Vec<(usize, String)>,
    pub backup: PathBuf,
    /// Bytes outside the target slots that differ after the camera re-saved its settings.
    pub other_changes: usize,
}

/// What the caller last saw in a Library entry: `None` = empty, `Some(name)` = in use.
/// Writes stop when the camera no longer matches (see [`SettingsBlob::check_expected`]).
pub type Expected = (usize, Option<String>);

fn check_expected(blob: &SettingsBlob, expected: &[Expected]) -> Result<(), PtpError> {
    let list: Vec<(usize, Option<&str>)> = expected.iter().map(|(i, n)| (*i, n.as_deref())).collect();
    Ok(blob.check_expected(&list)?)
}

/// Store several LUTs in a single write, with a backup and a read-back check of every entry.
/// If any one is refused, or an entry no longer matches `expected`, nothing is written.
pub fn register_luts(
    camera: &Camera,
    luts: &[NewLut<'_>],
    allow_overwrite: bool,
    expected: &[Expected],
    backup_dir: &Path,
    mut progress: impl FnMut(&str),
) -> Result<RegisterManyReport, PtpError> {
    if !camera.may_write() {
        return Err(camera.not_verified());
    }
    progress("reading");
    let current = camera.read_settings()?;
    check_expected(&current, expected)?;
    let patched = current.with_luts(luts, allow_overwrite)?;
    let names: Vec<String> = luts.iter().map(|l| format!("{} {}", l.index, l.name)).collect();
    let backup = save_backup(camera, &current, backup_dir, &format!("before adding {}", names.join(", ")))?;

    progress("writing");
    camera.write_settings(&patched)?;

    progress("verifying");
    let after = camera.read_settings()?;
    let entries = after.entries();
    let mismatch = luts.iter().find_map(|l| {
        let entry = entries.get(l.index)?;
        if !entry.in_use || entry.name != l.name {
            Some(format!("entry {} reads back as {:?}", l.index, entry.name))
        } else if after.lut(l.index).as_ref() != Some(l.lut) {
            Some(format!("LUT data in entry {} differs from what was sent", l.index))
        } else {
            None
        }
    });
    let mismatch = mismatch.or_else(|| (entries.len() != current.entries().len()).then(|| "the Library size changed".to_string()));
    if let Some(m) = mismatch {
        return Err(roll_back(camera, &current, m, &mut progress));
    }
    let other_changes = after.as_bytes().iter().zip(patched.as_bytes()).filter(|(a, b)| a != b).count();
    progress("done");
    Ok(RegisterManyReport { registered: luts.iter().map(|l| (l.index, l.name.to_string())).collect(), backup, other_changes })
}

/// After a failed read-back, write the settings read before the write (`original`, which the
/// camera itself produced) back and check the Library matches it again.
fn roll_back(camera: &Camera, original: &SettingsBlob, why: String, progress: &mut impl FnMut(&str)) -> PtpError {
    progress("restoring");
    let restored = camera.write_camera_settings(original).and_then(|_| camera.read_settings());
    match restored {
        Ok(now) if now.entries() == original.entries() => PtpError::RolledBack(why),
        Ok(_) => PtpError::Verify(format!("{why}; writing the earlier settings back did not restore the Library, restore the backup")),
        Err(e) => PtpError::Verify(format!("{why}; writing the earlier settings back failed ({e}), restore the backup")),
    }
}

/// Save `blob` as `{model}-settings-{millis}.bin` with a `.json` beside it that records the
/// camera (model, firmware, serial), the time and why the backup was taken. Restoring checks
/// the camera against that record.
fn save_backup(camera: &Camera, blob: &SettingsBlob, backup_dir: &Path, action: &str) -> Result<PathBuf, PtpError> {
    std::fs::create_dir_all(backup_dir)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let backup = backup_dir.join(format!("{}-settings-{stamp}.bin", camera.info.model));
    std::fs::write(&backup, blob.as_bytes())?;
    write_backup_info(&camera.info, &backup, stamp, action)?;
    Ok(backup)
}

/// Write the `.json` record beside a settings backup (see [`save_backup`]). Public so a backup
/// taken before records existed can be described for the camera it came from.
pub fn write_backup_info(i: &DeviceInfo, backup: &Path, created_millis: u128, action: &str) -> Result<(), PtpError> {
    let stamp = created_millis;
    let info = format!(
        "{{\"model\":{},\"firmware\":{},\"serial\":{},\"created\":{stamp},\"action\":{}}}\n",
        json_string(&i.model),
        json_string(&i.version),
        json_string(&i.serial),
        json_string(action)
    );
    std::fs::write(backup.with_extension("json"), info)?;
    Ok(())
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// What [`restore_settings`] did.
#[derive(Debug, Clone)]
pub struct RestoreReport {
    /// Backup of the settings as they were just before the restore.
    pub backup: PathBuf,
}

/// Write a saved settings file back to the camera, after backing up the current one, and
/// check that the camera then reads back exactly that file. The caller checks that the file
/// came from this camera (serial, model, firmware) before calling.
///
/// No write permission is needed: the file is settings this camera produced.
pub fn restore_settings(camera: &Camera, saved: &SettingsBlob, backup_dir: &Path, mut progress: impl FnMut(&str)) -> Result<RestoreReport, PtpError> {
    progress("reading");
    let current = camera.read_settings()?;
    if current.as_bytes().len() != saved.as_bytes().len() {
        return Err(PtpError::Verify("the saved settings do not have this camera's layout".into()));
    }
    let backup = save_backup(camera, &current, backup_dir, "before restoring a backup")?;

    progress("writing");
    camera.write_camera_settings(saved)?;

    progress("verifying");
    let after = camera.read_settings()?;
    if after.as_bytes() != saved.as_bytes() {
        let n = after.as_bytes().iter().zip(saved.as_bytes()).filter(|(a, b)| a != b).count();
        return Err(PtpError::Verify(format!("{n} bytes differ from the restored file")));
    }
    progress("done");
    Ok(RestoreReport { backup })
}

/// What [`delete_luts`] did.
#[derive(Debug, Clone)]
pub struct DeleteReport {
    /// Emptied entries and the names they had, in index order.
    pub deleted: Vec<(usize, String)>,
    pub backup: PathBuf,
}

/// Empty one or more Library entries in a single write, with a backup and a read-back check.
/// Only their title entries change, as in the camera's own delete; the entry selected in the
/// camera is refused, and if any entry is refused nothing is written.
pub fn delete_luts(camera: &Camera, indices: &[usize], expected: &[Expected], backup_dir: &Path, mut progress: impl FnMut(&str)) -> Result<DeleteReport, PtpError> {
    if !camera.may_write() {
        return Err(camera.not_verified());
    }
    progress("reading");
    let current = camera.read_settings()?;
    check_expected(&current, expected)?;
    let patched = current.without_luts(indices)?;
    let entries = current.entries();
    let mut deleted: Vec<(usize, String)> = indices.iter().map(|&i| (i, entries[i].name.clone())).collect();
    deleted.sort_by_key(|(i, _)| *i);
    let names: Vec<String> = deleted.iter().map(|(i, n)| format!("{i} {n}")).collect();
    let backup = save_backup(camera, &current, backup_dir, &format!("before deleting {}", names.join(", ")))?;

    progress("writing");
    camera.write_settings(&patched)?;

    progress("verifying");
    let after = camera.read_settings()?.entries();
    if let Some((i, _)) = deleted.iter().find(|(i, _)| after.get(*i).map_or(true, |e| e.in_use)) {
        let m = format!("entry {i} still holds {:?}", after.get(*i).map(|e| e.name.as_str()).unwrap_or("?"));
        return Err(roll_back(camera, &current, m, &mut progress));
    }
    progress("done");
    Ok(DeleteReport { deleted, backup })
}

/// Parse a PTP DeviceInfo dataset (data phase only).
pub fn parse_device_info(d: &[u8]) -> Option<DeviceInfo> {
    let mut p = 0usize;
    let u16v = |p: &mut usize| -> Option<u16> {
        let v = u16::from_le_bytes(d.get(*p..*p + 2)?.try_into().ok()?);
        *p += 2;
        Some(v)
    };
    let u32v = |p: &mut usize| -> Option<u32> {
        let v = u32::from_le_bytes(d.get(*p..*p + 4)?.try_into().ok()?);
        *p += 4;
        Some(v)
    };
    let s = |p: &mut usize| -> Option<String> {
        let n = *d.get(*p)? as usize;
        *p += 1;
        let units: Vec<u16> = (0..n).map(|i| u16::from_le_bytes([d[*p + 2 * i], d[*p + 2 * i + 1]])).collect();
        *p += 2 * n;
        Some(String::from_utf16_lossy(&units).trim_end_matches('\0').to_string())
    };
    let arr = |p: &mut usize| -> Option<()> {
        let n = u32::from_le_bytes(d.get(*p..*p + 4)?.try_into().ok()?) as usize;
        *p += 4 + 2 * n;
        Some(())
    };
    u16v(&mut p)?; // standard version
    u32v(&mut p)?; // vendor extension id
    u16v(&mut p)?; // vendor extension version
    s(&mut p)?; // vendor extension description
    u16v(&mut p)?; // functional mode
    for _ in 0..5 {
        arr(&mut p)?;
    }
    Some(DeviceInfo { manufacturer: s(&mut p)?, model: s(&mut p)?, version: s(&mut p)?, serial: s(&mut p)? })
}

#[cfg(test)]
mod tests {
    #[test]
    fn backup_info_strings_are_valid_json() {
        assert_eq!(super::json_string("plain"), "\"plain\"");
        assert_eq!(super::json_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\u000a\"");
    }

    #[test]
    fn device_info_from_s1m2() {
        // DeviceInfo returned by a DC-S1M2 on firmware 1.5 (serial replaced).
        let mut d = vec![0x64, 0, 0x1c, 0, 0, 0, 0x64, 0, 0, 0, 0];
        for n in [1u32, 0, 0, 0, 0] {
            d.extend(n.to_le_bytes());
            if n == 1 {
                d.extend(0x1001u16.to_le_bytes());
            }
        }
        for t in ["Panasonic", "DC-S1M2", "1.5", "00000TEST0000"] {
            let u: Vec<u16> = t.encode_utf16().chain([0]).collect();
            d.push(u.len() as u8);
            for x in u {
                d.extend(x.to_le_bytes());
            }
        }
        let info = super::parse_device_info(&d).unwrap();
        assert_eq!((info.model.as_str(), info.version.as_str()), ("DC-S1M2", "1.5"));
        assert!(info.write_verified());
    }
}
