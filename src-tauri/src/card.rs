//! LUTs through the camera's own settings file on a memory card, for bodies without a USB
//! tether connection (LUMIX L10). The camera saves its settings with [Save/Restore Camera
//! Setting] → [Save] to `AD_LUMIX/CAMSET/<NAME>.DAT`; the app adds LUTs to that file, and the
//! camera takes them with [Load]. The file holds the same data as a USB settings read.

use crate::camera::{backup_dir, CommandError, EntryName, LibraryEntry};
use lumix_lut::{parse_cube, SettingsBlob};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Card settings files are about 9 MB; anything far larger is not one.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const FIRST_USER_ENTRY: usize = 2;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFile {
    path: String,
    /// Card name as the computer shows it ("LUMIX", "E:").
    volume: String,
    /// File name on the card ("CAMSET01.DAT").
    file: String,
    /// Empty when the file can't be read (`error` says why).
    model: String,
    used: usize,
    /// Last change, milliseconds since 1970.
    modified: u64,
    error: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardLibrary {
    path: String,
    file: String,
    model: String,
    entries: Vec<LibraryEntry>,
    free_slots: Vec<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRegisterResult {
    registered: Vec<EntryName>,
    backup: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct CardLutRequest {
    cube: String,
    slot: usize,
    name: String,
}

fn io(e: std::io::Error) -> CommandError {
    CommandError::new("card_io", e.to_string())
}

/// Folders where memory cards appear.
fn card_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::fs::read_dir("/Volumes").map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default()
    }
    #[cfg(windows)]
    {
        (b'A'..=b'Z').map(|c| PathBuf::from(format!("{}:\\", c as char))).filter(|p| p.exists()).collect()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Vec::new()
    }
}

/// `<card>/AD_LUMIX/CAMSET`, matched without regard to case (FAT shows names either way).
fn camset_dir(root: &Path) -> Option<PathBuf> {
    let find = |dir: &Path, name: &str| -> Option<PathBuf> {
        std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name)))
    };
    find(&find(root, "AD_LUMIX")?, "CAMSET")
}

fn is_settings_file(p: &Path) -> bool {
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    !name.starts_with('.') && name.to_ascii_uppercase().ends_with(".DAT") && p.is_file()
}

/// Only a `.DAT` file inside a card's `AD_LUMIX/CAMSET` folder is read or written.
fn checked_path(path: &str) -> Result<PathBuf, CommandError> {
    let p = PathBuf::from(path);
    let ok = is_settings_file(&p)
        && p.parent().is_some_and(|d| d.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("CAMSET")))
        && p.parent().and_then(Path::parent).is_some_and(|d| d.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("AD_LUMIX")));
    if !ok {
        return Err(CommandError::new("card_file", format!("{path} is not a camera settings file on a card")));
    }
    Ok(p)
}

fn read_blob(p: &Path) -> Result<(Vec<u8>, SettingsBlob), CommandError> {
    let len = std::fs::metadata(p).map_err(io)?.len();
    if len > MAX_FILE_BYTES {
        return Err(CommandError::new("unknown_layout", "file too large for a settings file"));
    }
    let bytes = std::fs::read(p).map_err(io)?;
    let blob = SettingsBlob::from_card_file(&bytes)?;
    Ok((bytes, blob))
}

fn library(p: &Path, blob: &SettingsBlob) -> CardLibrary {
    // Any body whose file parses: the layout is the one the S1II and L10 share, and nothing
    // outside the chosen entries changes (the L10 loaded such a file back).
    let model = blob.model().to_string();
    CardLibrary {
        path: p.display().to_string(),
        file: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        model,
        entries: blob.entries().into_iter().map(|e| LibraryEntry::new(e.index, e.name, e.style_code, e.in_use)).collect(),
        free_slots: blob.free_slots().into_iter().filter(|&s| s >= FIRST_USER_ENTRY).collect(),
    }
}

/// Camera settings files on every card the computer shows, newest first.
#[tauri::command]
pub async fn card_find_settings() -> Result<Vec<CardFile>, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut found = Vec::new();
        for root in card_roots() {
            let Some(dir) = camset_dir(&root) else { continue };
            let volume = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.display().to_string());
            for p in std::fs::read_dir(&dir).map(|d| d.flatten().map(|e| e.path()).collect::<Vec<_>>()).unwrap_or_default() {
                if !is_settings_file(&p) {
                    continue;
                }
                let modified = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                let (model, used, error) = match read_blob(&p) {
                    Ok((_, blob)) => (blob.model().to_string(), blob.entries().iter().filter(|e| e.in_use).count(), None),
                    Err(e) => (String::new(), 0, Some(e.code())),
                };
                found.push(CardFile { path: p.display().to_string(), volume: volume.clone(), file: p.file_name().unwrap().to_string_lossy().to_string(), model, used, modified, error });
            }
        }
        found.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(found)
    })
    .await
    .map_err(|e| CommandError::new("internal", e.to_string()))?
}

/// The LUT Library in one card settings file.
#[tauri::command]
pub async fn card_list_luts(path: String) -> Result<CardLibrary, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = checked_path(&path)?;
        let (_, blob) = read_blob(&p)?;
        Ok(library(&p, &blob))
    })
    .await
    .map_err(|e| CommandError::new("internal", e.to_string()))?
}

/// Add LUTs to user entries of a card settings file (empty or not): check every file first, keep a copy of
/// the original, write, read back and compare. If the file on the card does not match what was
/// written, the original goes back.
#[tauri::command]
pub async fn card_register_luts(app: tauri::AppHandle, path: String, items: Vec<CardLutRequest>) -> Result<CardRegisterResult, CommandError> {
    let mut parsed = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        if item.slot < FIRST_USER_ENTRY {
            return Err(CommandError::new("bad_slot", format!("file {}: entry {} came with the camera", i + 1, item.slot)));
        }
        let at = |e: lumix_lut::Error| CommandError::from(e).context(&format!("file {} ({})", i + 1, item.name));
        let cube = parse_cube(&item.cube).map_err(at)?;
        let style = cube.base_style().map_err(at)?;
        lumix_lut::validate_name(&item.name).map_err(at)?;
        parsed.push((item.slot, item.name.clone(), style, cube.lut));
    }
    let backups = backup_dir(&app)?.join("card");
    tauri::async_runtime::spawn_blocking(move || register_in_file(&path, &parsed, &backups))
    .await
    .map_err(|e| CommandError::new("internal", e.to_string()))?
}

type ParsedLut = (usize, String, lumix_lut::BaseStyle, lumix_lut::Lut33);

fn register_in_file(path: &str, parsed: &[ParsedLut], backups: &Path) -> Result<CardRegisterResult, CommandError> {
    let p = checked_path(&path)?;
    let (original, blob) = read_blob(&p)?;
    let luts: Vec<lumix_lut::NewLut> = parsed.iter().map(|(index, name, style, lut)| lumix_lut::NewLut { index: *index, name, style: *style, lut }).collect();
    let patched = blob.with_luts(&luts, true)?;
    let out = patched.card_file_bytes().to_vec();

    std::fs::create_dir_all(backups).map_err(io)?;
    let stamp = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let stem = p.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let backup = backups.join(format!("{}-{stem}-{stamp}.DAT", blob.model()));
    std::fs::write(&backup, &original).map_err(io)?;

    let tmp = p.with_file_name(format!("{stem}.TMP"));
    std::fs::write(&tmp, &out).map_err(io)?;
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })?;
    let back = std::fs::read(&p).map_err(io)?;
    if back != out {
        let _ = std::fs::write(&p, &original);
        return Err(CommandError::new("verify_failed", "the file on the card differs from what was written; the original was put back"));
    }
    // macOS may leave an AppleDouble file ("._NAME.DAT") next to it; the camera has no use for it.
    if let Some(name) = p.file_name() {
        let _ = std::fs::remove_file(p.with_file_name(format!("._{}", name.to_string_lossy())));
    }
    Ok(CardRegisterResult {
        registered: parsed.iter().map(|(index, name, ..)| EntryName::new(*index, name.clone())).collect(),
        backup: backup.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grey() -> lumix_lut::Lut33 {
        let v = (0..lumix_lut::LUT_ENTRIES).map(|i| { let y = (i % 33 * 2047) as u16; [y, y, y] }).collect();
        lumix_lut::Lut33::from_u16(v).unwrap()
    }

    #[test]
    fn only_dat_files_in_a_cards_camset_folder_are_accepted() {
        let dir = std::env::temp_dir().join(format!("sosang-card-path-{}", std::process::id()));
        let camset = dir.join("AD_LUMIX").join("CAMSET");
        std::fs::create_dir_all(&camset).unwrap();
        std::fs::write(camset.join("CAMSET01.DAT"), b"x").unwrap();
        std::fs::write(dir.join("CAMSET01.DAT"), b"x").unwrap();
        std::fs::write(camset.join("NOTES.TXT"), b"x").unwrap();
        assert!(checked_path(&camset.join("CAMSET01.DAT").display().to_string()).is_ok());
        assert_eq!(checked_path(&dir.join("CAMSET01.DAT").display().to_string()).unwrap_err().code(), "card_file");
        assert_eq!(checked_path(&camset.join("NOTES.TXT").display().to_string()).unwrap_err().code(), "card_file");
        assert_eq!(camset_dir(&dir), Some(camset));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Against the L10 card file kept out of git (skipped when absent).
    #[test]
    fn a_lut_goes_into_an_l10_card_file_with_a_backup_of_the_original() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../crates/lumix-lut/tests/fixtures/local/l10_camset_original.dat");
        let Ok(original) = std::fs::read(&fixture) else { return eprintln!("skipping: {} not present", fixture.display()) };
        let dir = std::env::temp_dir().join(format!("sosang-card-write-{}", std::process::id()));
        let camset = dir.join("AD_LUMIX").join("CAMSET");
        std::fs::create_dir_all(&camset).unwrap();
        let file = camset.join("CAMSET01.DAT");
        std::fs::write(&file, &original).unwrap();
        let path = file.display().to_string();
        let lut = grey();

        let r = register_in_file(&path, &[(5, "GREY".to_string(), lumix_lut::BaseStyle::Standard, lut.clone()), (2, "OVER".to_string(), lumix_lut::BaseStyle::Standard, lut.clone())], &dir.join("backups")).unwrap();
        assert!(std::fs::read(&r.backup).unwrap() == original);
        let after = std::fs::read(&file).unwrap();
        assert_eq!(after.len(), original.len());
        let blob = SettingsBlob::from_card_file(&after).unwrap();
        assert_eq!(blob.entries()[5].name, "GREY");
        assert_eq!(blob.lut(5), Some(lut));
        assert_eq!(blob.shown(5), Some(true));
        // Entry 2 held "Sample LUT1": overwritten.
        assert_eq!((blob.entries()[2].name.as_str(), blob.lut(2)), ("OVER", Some(grey())));
        assert_eq!(blob.entries()[3].name, "Sample LUT2");
        assert!(!camset.join("CAMSET01.TMP").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
