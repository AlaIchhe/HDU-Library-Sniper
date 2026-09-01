#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

struct Backend(Mutex<Option<Child>>);

#[tauri::command]
fn start_backend(app: tauri::AppHandle, state: tauri::State<Backend>) -> Result<(), String> {
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?.join("hdu-sniper-server.exe");
    let child = Command::new(resource).spawn().map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|_| "backend lock poisoned")? = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_backend(state: tauri::State<Backend>) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().map_err(|_| "backend lock poisoned")?.take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Backend(Mutex::new(None)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![])))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![start_backend, stop_backend])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_menu(tauri::menu::Menu::with_items(&handle, &[])?);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
