mod camera;
mod card;
mod courier;
mod files;
mod update;

use tauri::{Manager, RunEvent, WindowEvent};
#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    AppHandle,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu).on_menu_event(|app, event| {
        if event.id() == QUIT_MENU_ID {
            app.exit(0);
        }
    });
    builder
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
            camera::camera_rearrange_luts,
            camera::camera_list_backups,
            camera::camera_restore_backup,
            card::card_find_settings,
            card::card_list_luts,
            card::card_register_luts,
            courier::courier_pick_folder,
            courier::courier_list,
            courier::courier_list_saved,
            courier::courier_thumbnail,
            courier::courier_preview,
            courier::courier_export,
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
        // Closing the window or quitting during a camera operation waits for it to finish.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if camera::exit_when_idle(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the sosang app")
        .run(|app, event| {
            if let RunEvent::ExitRequested { code, api, .. } = event {
                // An update restart already holds the camera lock and needs no wait.
                if code != Some(tauri::RESTART_EXIT_CODE) && camera::exit_when_idle(app) {
                    api.prevent_exit();
                }
            }
        });
}

/// The default macOS menu, except Quit: the built-in item terminates the process at once,
/// which no exit handler can hold. This one asks the app to exit, so a camera operation can
/// finish first.
#[cfg(target_os = "macos")]
fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        if let Some(quit) = app_menu.items()?.pop() {
            app_menu.remove(&quit)?;
        }
        let name = &app.package_info().name;
        app_menu.append(&MenuItem::with_id(app, QUIT_MENU_ID, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?)?;
    }
    Ok(menu)
}

#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "sosang-quit";
