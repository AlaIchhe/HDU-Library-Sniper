#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use serde::Serialize;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

struct Backend(Mutex<Option<Child>>);

const STARTUP_TASK: &str = "HDU-Library-Sniper";

#[derive(Debug, Serialize)]
struct StartupStatus { enabled: bool, task_name: String }

#[cfg(windows)]
fn schtasks(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("schtasks.exe").args(args).output().map_err(|e| e.to_string())
}

#[cfg(windows)]
fn startup_enabled() -> bool {
    schtasks(&["/Query", "/TN", STARTUP_TASK]).map(|output| output.status.success()).unwrap_or(false)
}

#[cfg(windows)]
fn set_startup_task(exe: &std::path::Path, enabled: bool) -> Result<(), String> {
    if enabled {
        let action = format!("\"{}\" --background", exe.display());
        let output = schtasks(&["/Create", "/TN", STARTUP_TASK, "/TR", &action, "/SC", "ONLOGON", "/F"])?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    } else {
        let output = schtasks(&["/Delete", "/TN", STARTUP_TASK, "/F"])?;
        if !output.status.success() && startup_enabled() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    }
    Ok(())
}

#[tauri::command]
fn startup_status() -> StartupStatus {
    #[cfg(windows)]
    let enabled = startup_enabled();
    #[cfg(not(windows))]
    let enabled = false;
    StartupStatus { enabled, task_name: STARTUP_TASK.to_string() }
}

#[tauri::command]
fn enable_startup(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        return set_startup_task(&std::env::current_exe().map_err(|e| e.to_string())?, true);
    }
    #[cfg(not(windows))]
    { let _ = _app; Ok(()) }
}

#[tauri::command]
fn disable_startup(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        return set_startup_task(&std::env::current_exe().map_err(|e| e.to_string())?, false);
    }
    #[cfg(not(windows))]
    { let _ = _app; Ok(()) }
}

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
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.iter().any(|arg| arg == "--install-startup" || arg == "--uninstall-startup") {
            let enabled = args.iter().any(|arg| arg == "--install-startup");
            let result = std::env::current_exe().map_err(|e| e.to_string()).and_then(|exe| set_startup_task(&exe, enabled));
            if let Err(error) = result { eprintln!("startup task configuration failed: {error}"); std::process::exit(1); }
            return;
        }
    }
    tauri::Builder::default()
        .manage(Backend(Mutex::new(None)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![start_backend, stop_backend, startup_status, enable_startup, disable_startup])
        .setup(|app| {
            let handle = app.handle().clone();
            let background = std::env::args().any(|arg| arg == "--background");
            if background { if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); } }
            if let Ok(resource_dir) = app.path().resource_dir() {
                let executable = resource_dir.join("hdu-sniper-server.exe");
                if executable.exists() {
                    if let Ok(child) = Command::new(executable).spawn() {
                        if let Ok(mut backend) = app.state::<Backend>().0.lock() { *backend = Some(child); }
                    }
                }
            }
            if let Some(tray) = app.tray_by_id("main") {
                use tauri::menu::{Menu, MenuItem};
                let show = MenuItem::with_id(&handle, "show", "显示窗口", true, None::<&str>)?;
                let quit = MenuItem::with_id(&handle, "quit", "退出", true, None::<&str>)?;
                tray.set_menu(Some(Menu::with_items(&handle, &[&show, &quit])?))?;
                let tray_handle = handle.clone();
                tray.on_menu_event(move |_app, event| match event.id.as_ref() {
                    "show" => { if let Some(window) = tray_handle.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); } },
                    "quit" => {
                        if let Ok(mut backend) = tray_handle.state::<Backend>().0.lock() {
                            if let Some(mut child) = backend.take() { let _ = child.kill(); }
                        }
                        tray_handle.exit(0);
                    },
                    _ => {}
                });
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
