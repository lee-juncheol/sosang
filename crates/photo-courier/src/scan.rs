//! Finding photos in a folder, optionally with all of its subfolders.

use crate::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoEntry {
    pub path: String,
    pub name: String,
    /// Folder path below the listed folder with "/" separators, empty at the top level.
    pub subfolder: String,
    /// Modification time in milliseconds since 1970, when known.
    pub modified: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    /// Photos this app can send (JPG / JPEG).
    Sendable,
    /// Anything that looks like a photo, for the destination list.
    AnyPhoto,
}

pub fn is_jpeg(path: &Path) -> bool {
    matches!(ext(path).as_deref(), Some("jpg" | "jpeg"))
}

fn ext(path: &Path) -> Option<String> {
    path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase)
}

fn wanted(path: &Path, kind: Kind) -> bool {
    match kind {
        Kind::Sendable => is_jpeg(path),
        Kind::AnyPhoto => matches!(ext(path).as_deref(), Some("jpg" | "jpeg" | "webp" | "png" | "hif" | "heic" | "heif")),
    }
}

/// Folders that are really documents on macOS (apps, photo libraries) are not walked into.
const PACKAGES: &[&str] = &["app", "bundle", "framework", "photoslibrary", "photolibrary", "aplibrary", "lrdata", "lrlibrary", "fcpbundle", "imovielibrary", "pkg", "plugin", "kext"];

fn hidden(path: &Path, meta: &fs::Metadata) -> bool {
    let dot = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.') || n.starts_with('$'));
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    let _ = meta;
    dot
}

fn same(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// List photos. `recursive` walks visible subfolders; `exclude` skips one folder tree (the
/// destination, when it sits inside the source). An unreadable subfolder is skipped, but an
/// unreadable top folder is an error.
pub fn list(folder: &Path, kind: Kind, recursive: bool, exclude: Option<&Path>) -> Result<Vec<PhotoEntry>, Error> {
    let exclude = exclude.filter(|e| !same(e, folder)).and_then(|e| fs::canonicalize(e).ok());
    let mut out = Vec::new();
    let mut pending: Vec<(PathBuf, String)> = vec![(folder.to_path_buf(), String::new())];
    let mut first = true;
    while let Some((dir, sub)) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if first => return Err(Error::Read(e.to_string())),
            Err(_) => continue,
        };
        first = false;
        for entry in entries.flatten() {
            let path = entry.path();
            // file_type does not follow symlinks, so linked folders are never walked into.
            let Ok(file_type) = entry.file_type() else { continue };
            let Ok(meta) = entry.metadata() else { continue };
            if hidden(&path, &meta) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() {
                if !recursive || ext(&path).is_some_and(|e| PACKAGES.contains(&e.as_str())) {
                    continue;
                }
                if exclude.as_ref().is_some_and(|ex| fs::canonicalize(&path).is_ok_and(|p| &p == ex)) {
                    continue;
                }
                let child = if sub.is_empty() { name } else { format!("{sub}/{name}") };
                pending.push((path, child));
            } else if file_type.is_file() && wanted(&path, kind) {
                let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64);
                out.push(PhotoEntry { path: path.to_string_lossy().into_owned(), name, subfolder: sub.clone(), modified });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_subfolders_but_skips_hidden_packages_and_the_destination() {
        let root = std::env::temp_dir().join(format!("photo-courier-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for dir in ["DCIM/100_PANA", ".hidden", "Lib.photoslibrary", "sent", "DCIM/101_PANA"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in ["A.JPG", "notes.txt", "DCIM/100_PANA/P1.jpg", "DCIM/100_PANA/P2.HIF", "DCIM/101_PANA/P3.JPEG", ".hidden/x.jpg", "Lib.photoslibrary/y.jpg", "sent/P1.jpg", "._A.JPG"] {
            fs::write(root.join(file), b"x").unwrap();
        }
        let mut found: Vec<String> = list(&root, Kind::Sendable, true, Some(&root.join("sent")))
            .unwrap()
            .into_iter()
            .map(|e| if e.subfolder.is_empty() { e.name } else { format!("{}/{}", e.subfolder, e.name) })
            .collect();
        found.sort();
        assert_eq!(found, ["A.JPG", "DCIM/100_PANA/P1.jpg", "DCIM/101_PANA/P3.JPEG"]);

        let flat = list(&root, Kind::Sendable, false, None).unwrap();
        assert_eq!(flat.len(), 1);
        assert!(flat[0].modified.is_some());
        let any = list(&root.join("DCIM/100_PANA"), Kind::AnyPhoto, false, None).unwrap();
        assert_eq!(any.len(), 2);
        assert!(list(&root.join("missing"), Kind::Sendable, true, None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
