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

use lumix_lut::{BaseStyle, Lut33, SettingsBlob, SETTINGS_PROP};
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
            Ok(Camera { inner, info })
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
        if !self.info.write_verified() || blob.model() != self.info.model {
            return Err(PtpError::NotVerified { model: self.info.model.clone(), version: self.info.version.clone() });
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
    mut progress: impl FnMut(&str),
) -> Result<RegisterReport, PtpError> {
    if !camera.info.write_verified() {
        return Err(PtpError::NotVerified { model: camera.info.model.clone(), version: camera.info.version.clone() });
    }
    progress("reading");
    let current = camera.read_settings()?;
    let patched = current.with_lut(index, name, style, lut, allow_overwrite)?;

    let backup = save_backup(camera, &current, backup_dir)?;

    progress("writing");
    camera.write_settings(&patched)?;

    progress("verifying");
    let after = camera.read_settings()?;
    let entry = &after.entries()[index];
    if !entry.in_use || entry.name != name {
        return Err(PtpError::Verify(format!("entry {index} reads back as {:?}", entry.name)));
    }
    if after.lut(index).as_ref() != Some(lut) {
        return Err(PtpError::Verify(format!("LUT data in entry {index} differs from what was sent")));
    }
    let other_changes = after.as_bytes().iter().zip(patched.as_bytes()).filter(|(a, b)| a != b).count();
    progress("done");
    Ok(RegisterReport { index, name: name.to_string(), backup, other_changes })
}

fn save_backup(camera: &Camera, blob: &SettingsBlob, backup_dir: &Path) -> Result<PathBuf, PtpError> {
    std::fs::create_dir_all(backup_dir)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let backup = backup_dir.join(format!("{}-settings-{stamp}.bin", camera.info.model));
    std::fs::write(&backup, blob.as_bytes())?;
    Ok(backup)
}

/// What [`delete_lut`] did.
#[derive(Debug, Clone)]
pub struct DeleteReport {
    pub index: usize,
    /// Name the entry had before it was emptied.
    pub name: String,
    pub backup: PathBuf,
}

/// Empty Library entry `index`, with a backup and a read-back check. Only the title entry
/// changes, as in the camera's own delete; the entry selected in the camera is refused.
pub fn delete_lut(camera: &Camera, index: usize, backup_dir: &Path, mut progress: impl FnMut(&str)) -> Result<DeleteReport, PtpError> {
    if !camera.info.write_verified() {
        return Err(PtpError::NotVerified { model: camera.info.model.clone(), version: camera.info.version.clone() });
    }
    progress("reading");
    let current = camera.read_settings()?;
    let name = current.entries().get(index).map(|e| e.name.clone()).unwrap_or_default();
    let patched = current.without_lut(index)?;
    let backup = save_backup(camera, &current, backup_dir)?;

    progress("writing");
    camera.write_settings(&patched)?;

    progress("verifying");
    let after = camera.read_settings()?;
    if after.entries()[index].in_use {
        return Err(PtpError::Verify(format!("entry {index} still holds {:?}", after.entries()[index].name)));
    }
    progress("done");
    Ok(DeleteReport { index, name, backup })
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
