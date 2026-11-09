#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use hdu_sniper_auth::AuthService;
use hdu_sniper_server::{build_router, BookingExecutor, Scheduler};
use hdu_sniper_store::Store;
use tauri::{Emitter, Manager, WindowEvent};

fn app_home_dir() -> PathBuf {
    if let Some(home) = env::var_os("HDU_SNIPER_HOME").filter(|value| !value.is_empty()) {
        return PathBuf::from(home);
    }
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hdu-library-sniper")
}

fn log_startup_line(message: &str) {
    let dir = app_home_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("startup.log"))
    {
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
    eprintln!("{message}");
}

fn start_api() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app_home_dir().join("data");
    fs::create_dir_all(&data_dir)?;
    let store = Arc::new(Store::open(data_dir.join("hdu-sniper.sqlite"))?);
    let auth = Arc::new(AuthService::new(store.clone())?);
    let booking = Arc::new(BookingExecutor::new(store.clone()));
    let scheduler = Arc::new(Scheduler::new(store.clone(), auth.clone(), booking));
    let router = build_router(store, auth, scheduler.clone());
    tauri::async_runtime::spawn(scheduler.clone().run());
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::bind(("127.0.0.1", 8000)).await {
            Ok(listener) => {
                if let Err(error) = axum::serve(listener, router).await {
                    log_startup_line(&format!("local API stopped: {error}"));
                }
            }
            Err(error) => {
                log_startup_line(&format!("cannot bind local API on 127.0.0.1:8000: {error}"))
            }
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        log_startup_line(&format!("panic: {info}"));
    }));
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("tray-window-shown", ());
            }
        }));
    }

    builder = builder
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
        .setup(|app| {
            #[cfg(desktop)]
            {
                let _ = app
                    .handle()
                    .plugin(tauri_plugin_window_state::Builder::default().build());
            }

            if let Err(error) = start_api() {
                log_startup_line(&format!("startup API error: {error}"));
            }

            let handle = app.handle().clone();
            let background = std::env::args().any(|arg| arg == "--background");
            if background {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
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
                            let _ = window.emit("tray-window-shown", ());
                        }
                    }
                    "quit" => {
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
