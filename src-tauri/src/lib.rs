#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, WindowEvent};

struct Backend(Mutex<Option<Child>>);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The backend inherits the GUI's hidden console, so its stdout/stderr would be
/// discarded on Windows. Persist both streams next to the server data in
/// `%USERPROFILE%\.hdu-library-sniper\logs\server.log`; `HDU_SNIPER_HOME`
/// overrides the location exactly like the server's own data dir.
fn app_home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HDU_SNIPER_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".hdu-library-sniper"))
}

fn backend_log_file() -> Option<File> {
    let dir = app_home_dir()?.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("server.log");
    // 5 MiB per segment with a single rotated segment: backend output is low
    // volume, this only matters when one error repeats for a long time.
    if let Ok(metadata) = std::fs::metadata(&path) {
        if metadata.len() > 5 * 1024 * 1024 {
            let previous = dir.join("server.log.1");
            let _ = std::fs::remove_file(&previous);
            let _ = std::fs::rename(&path, &previous);
        }
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path).ok()?;
    let started = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let _ = writeln!(file);
    let _ = writeln!(file, "=== hdu-sniper-server start (unix {started}) ===");
    let _ = file.flush();
    Some(file)
}

fn spawn_backend(executable: &Path) -> std::io::Result<Child> {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(file) = backend_log_file() {
        match file.try_clone() {
            Ok(stderr) => {
                command.stdout(Stdio::from(file));
                command.stderr(Stdio::from(stderr));
            }
            Err(error) => log::warn!("cannot duplicate the backend log handle: {error}"),
        }
    }
    command.spawn()
}

// 自启项由 MSI 安装阶段的 startup.wxs RegistryValue 组件直接维护。

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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .invoke_handler(tauri::generate_handler![start_backend, stop_backend])
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
