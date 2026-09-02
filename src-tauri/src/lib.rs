#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

struct Backend(Mutex<Option<Child>>);

const STARTUP_TASK: &str = "HDU-Library-Sniper";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize)]
struct StartupStatus {
    enabled: bool,
    task_name: String,
}

#[cfg(windows)]
fn run_reg(args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    Command::new("reg.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn spawn_backend(executable: &std::path::Path) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    Command::new(executable)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

#[cfg(not(windows))]
fn spawn_backend(executable: &std::path::Path) -> std::io::Result<Child> {
    Command::new(executable).spawn()
}

#[cfg(windows)]
// NOTE: reg.exe requires the root hive prefix (HKCU\). Without it the command
// fails with "Invalid key name", so autostart would never be persisted.
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn startup_enabled() -> bool {
    run_reg(&["query", RUN_KEY, "/v", STARTUP_TASK])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn set_startup_task(exe: &std::path::Path, enabled: bool) -> Result<(), String> {
    if enabled {
        // HKCU Run is per-user and does not require elevation, unlike schtasks /SC ONLOGON.
        let action = format!("\"{}\" --background", exe.display());
        let output = run_reg(&[
            "add",
            RUN_KEY,
            "/v",
            STARTUP_TASK,
            "/t",
            "REG_SZ",
            "/d",
            &action,
            "/f",
        ])?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    } else {
        let output = run_reg(&["delete", RUN_KEY, "/v", STARTUP_TASK, "/f"])?;
        if !output.status.success() && startup_enabled() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn startup_status() -> StartupStatus {
    #[cfg(windows)]
    let enabled = startup_enabled();
    #[cfg(not(windows))]
    let enabled = false;
    StartupStatus {
        enabled,
        task_name: STARTUP_TASK.to_string(),
    }
}

#[tauri::command]
fn enable_startup(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        return set_startup_task(&std::env::current_exe().map_err(|e| e.to_string())?, true);
    }
    #[cfg(not(windows))]
    {
        let _ = _app;
        Ok(())
    }
}

#[tauri::command]
fn disable_startup(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        return set_startup_task(&std::env::current_exe().map_err(|e| e.to_string())?, false);
    }
    #[cfg(not(windows))]
    {
        let _ = _app;
        Ok(())
    }
}

fn backend_executable(resource_dir: &std::path::Path) -> std::path::PathBuf {
    let direct = resource_dir.join("hdu-sniper-server.exe");
    if direct.exists() {
        return direct;
    }
    // Tauri rewrites `..` in resource paths to `_up_/dist`, so older MSI layouts
    // shipped the backend nested there. Keep resolving it for compatibility.
    resource_dir
        .join("_up_")
        .join("dist")
        .join("hdu-sniper-server.exe")
}

#[tauri::command]
fn start_backend(app: tauri::AppHandle, state: tauri::State<Backend>) -> Result<(), String> {
    let resource = backend_executable(&app.path().resource_dir().map_err(|e| e.to_string())?);
    let child = spawn_backend(&resource).map_err(|e| e.to_string())?;
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
        if args
            .iter()
            .any(|arg| arg == "--install-startup" || arg == "--uninstall-startup")
        {
            let enabled = args.iter().any(|arg| arg == "--install-startup");
            let result = std::env::current_exe()
                .map_err(|e| e.to_string())
                .and_then(|exe| set_startup_task(&exe, enabled));
            if let Err(error) = result {
                eprintln!("startup task configuration failed: {error}");
                std::process::exit(1);
            }
            return;
        }
    }

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // The Single Instance plugin must be registered first so it can
        // de-duplicate launcher attempts before any other plugin runs.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder = builder
        .manage(Backend(Mutex::new(None)))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("hdu-library-sniper".to_string()),
                    }),
                ])
                .max_file_size(500_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            start_backend,
            stop_backend,
            startup_status,
            enable_startup,
            disable_startup
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                let _ = app
                    .handle()
                    .plugin(tauri_plugin_window_state::Builder::default().build());
            }

            let handle = app.handle().clone();
            let background = std::env::args().any(|arg| arg == "--background");
            if background {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            if let Ok(resource_dir) = app.path().resource_dir() {
                let executable = backend_executable(&resource_dir);
                if executable.exists() {
                    if let Ok(child) = spawn_backend(&executable) {
                        if let Ok(mut backend) = app.state::<Backend>().0.lock() {
                            *backend = Some(child);
                        }
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
                    "show" => {
                        if let Some(window) = tray_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        if let Ok(mut backend) = tray_handle.state::<Backend>().0.lock() {
                            if let Some(mut child) = backend.take() {
                                let _ = child.kill();
                            }
                        }
                        tray_handle.exit(0);
                    }
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
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
