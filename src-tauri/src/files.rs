//! Saving downloads and opening links, which a WebView does not do on its own.

use crate::camera::CommandError;
use tauri::ipc::{InvokeBody, Request};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Keep only a plain file name: no folders, no control characters.
fn safe_file_name(raw: &str) -> String {
    let name: String = raw.rsplit(['/', '\\']).next().unwrap_or("").chars().filter(|c| !c.is_control()).collect();
    let name = name.trim().trim_start_matches('.').to_string();
    if name.is_empty() { "download".into() } else { name }
}

/// Body: the file bytes. Header `x-filename`: the suggested name, percent-encoded.
/// Shows a save dialog; returns the saved path, or null when cancelled.
#[tauri::command]
pub async fn save_file(app: AppHandle, request: Request<'_>) -> Result<Option<String>, CommandError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new("internal", "expected raw file bytes"));
    };
    let bytes = bytes.clone();
    let name = request.headers().get("x-filename").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let name = safe_file_name(&name);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app.dialog().file().set_file_name(&name).blocking_save_file() else { return Ok(None) };
        let path = path.into_path().map_err(|e| CommandError::new("internal", e.to_string()))?;
        std::fs::write(&path, bytes).map_err(|e| CommandError::new("internal", e.to_string()))?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|e| CommandError::new("internal", e.to_string()))?
}

/// Open an https link in the default browser.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), CommandError> {
    if !url.starts_with("https://") {
        return Err(CommandError::new("internal", "only https links are opened"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| CommandError::new("internal", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_decoded_and_stripped_of_folders() {
        assert_eq!(safe_file_name(&percent_decode("Portra%20400%20STD.cube")), "Portra 400 STD.cube");
        assert_eq!(safe_file_name(&percent_decode("..%2F..%2Fetc%2Fpasswd")), "passwd");
        assert_eq!(safe_file_name(&percent_decode("%ED%95%84%EB%A6%84.cube")), "필름.cube");
        assert_eq!(safe_file_name(""), "download");
        assert_eq!(safe_file_name(".hidden"), "hidden");
    }
}
