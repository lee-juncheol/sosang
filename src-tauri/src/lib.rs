mod camera;
mod files;
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(camera::CameraLock::default())
        .invoke_handler(tauri::generate_handler![
            camera::camera_status,
            camera::camera_list_luts,
            camera::camera_register_lut,
            camera::camera_register_luts,
            camera::camera_delete_luts,
            camera::camera_list_backups,
            camera::camera_restore_backup,
            files::save_file,
            files::open_external,
            update::app_check_update,
            update::app_install_update
        ])
        .setup(|_app| {
            lumix_ptp::start_discovery();
            #[cfg(debug_assertions)]
            if std::env::var_os("SOSANG_CAMERA_SELFCHECK").is_some() {
                camera::self_check(_app.handle().clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the sosang app");
}
