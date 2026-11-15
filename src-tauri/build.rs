fn main() {
    // Listing the app's commands makes them deny-by-default: a window can call one only when a
    // capability grants it (see capabilities/default.json).
    let commands = &["camera_status", "camera_list_luts", "camera_register_lut", "camera_register_luts", "camera_delete_luts", "camera_list_backups", "camera_restore_backup", "save_file", "open_external", "app_check_update", "app_install_update"];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run tauri-build");
}
