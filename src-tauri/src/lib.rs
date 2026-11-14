#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hdu_sniper_auth::AuthService;
use hdu_sniper_server::{build_router, BookingExecutor, Scheduler};
use hdu_sniper_store::Store;
use tauri::{Emitter, Manager, WindowEvent};

const LOCAL_API_HOST: &str = "127.0.0.1";
const LOCAL_API_PORT: u16 = 8000;
const LOCAL_API_ADDR: &str = "127.0.0.1:8000";

/// 本地 API 的启动状态。前端启动页在超时后通过 `local_api_status` 读取它，
/// 这样“后端没起来”不再是黑盒：端口被占用、数据库打不开都会带着原文展示。
#[derive(Default)]
struct ApiStatus {
    running: AtomicBool,
    error: Mutex<Option<String>>,
}

#[derive(serde::Serialize)]
struct ApiStatusView {
    running: bool,
    error: Option<String>,
}

#[tauri::command]
fn local_api_status(status: tauri::State<'_, ApiStatus>) -> ApiStatusView {
    ApiStatusView {
        running: status.running.load(Ordering::SeqCst),
        error: status.error.lock().map(|slot| slot.clone()).unwrap_or(None),
    }
}

/// 记下启动失败原因：启动日志（startup.log）、GUI 日志、前端状态各一份。
fn record_api_failure(app: &tauri::AppHandle, message: String) {
    if let Some(status) = app.try_state::<ApiStatus>() {
        status.running.store(false, Ordering::SeqCst);
        if let Ok(mut slot) = status.error.lock() {
            *slot = Some(message.clone());
        }
    }
    log::error!("{message}");
    log_startup_line(&message);
}

/// 让本地 API 的请求绕过系统代理。
///
/// `tauri-plugin-http` 默认启用 reqwest 的 `system-proxy`，Windows 上会读 WinINET。
/// `ProxyOverride` 里的 `<local>` 这类写法 hyper-util 不认，于是 `127.0.0.1:8000`
/// 也会被送进代理：后端明明起来了，前端却报“无法连接本地后台服务”。
/// 把回环地址并进 NO_PROXY 即可；其它域名仍按系统代理走。
fn ensure_loopback_bypass() {
    const LOOPBACK: &str = "127.0.0.1,localhost,::1";
    let current = env::var("NO_PROXY")
        .or_else(|_| env::var("no_proxy"))
        .unwrap_or_default();
    let merged = if current.trim().is_empty() {
        LOOPBACK.to_string()
    } else {
        format!("{current},{LOOPBACK}")
    };
    // Windows 的环境变量大小写不敏感，两个写法会落到同一个变量上；
    // Unix 上两个都写，保证 reqwest/hyper-util 读到。
    env::set_var("NO_PROXY", &merged);
    env::set_var("no_proxy", merged);
}

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

fn start_api(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app_home_dir().join("data");
    fs::create_dir_all(&data_dir)?;
    let store = Arc::new(Store::open(data_dir.join("hdu-sniper.sqlite"))?);
    let auth = Arc::new(AuthService::new(store.clone())?);
    let booking = Arc::new(BookingExecutor::new(store.clone()));
    let scheduler = Arc::new(Scheduler::new(store.clone(), auth.clone(), booking));
    let router = build_router(store, auth, scheduler.clone());
    tauri::async_runtime::spawn(scheduler.clone().run());
    let handle = app.clone();
    let data_dir = data_dir.display().to_string();
    let version = env!("CARGO_PKG_VERSION").to_string();
    tauri::async_runtime::spawn(async move {
        // 上一次退出的进程可能还没放开端口（Windows 上尤其常见）：
        // 短暂重试，而不是一次 bind 失败就永久没有后端。
        let mut last_error = None;
        for attempt in 1..=5 {
            match tokio::net::TcpListener::bind((LOCAL_API_HOST, LOCAL_API_PORT)).await {
                Ok(listener) => {
                    if let Some(status) = handle.try_state::<ApiStatus>() {
                        status.running.store(true, Ordering::SeqCst);
                        if let Ok(mut slot) = status.error.lock() {
                            *slot = None;
                        }
                    }
                    let message = format!(
                        "local API listening on http://{LOCAL_API_ADDR} (v{version}, data dir {data_dir})"
                    );
                    log::info!("{message}");
                    log_startup_line(&message);
                    if let Err(error) = axum::serve(listener, router).await {
                        record_api_failure(&handle, format!("local API stopped: {error}"));
                    }
                    return;
                }
                Err(error) => {
                    last_error = Some(error);
                    if attempt < 5 {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                    }
                }
            }
        }
        let message = format!(
            "cannot bind local API on {LOCAL_API_ADDR} after 5 attempts: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unknown error".into())
        );
        record_api_failure(&handle, message);
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        log_startup_line(&format!("panic: {info}"));
    }));
    // 必须在任何 reqwest client 构建之前设置（plugin-http 每个请求都会新建 client）。
    ensure_loopback_bypass();
    let mut builder = tauri::Builder::default()
        .manage(ApiStatus::default())
        .invoke_handler(tauri::generate_handler![local_api_status]);

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

    #[cfg(target_os = "macos")]
    {
        // LaunchAgent 的 ProgramArguments 里带上 --background，登录后直接进托盘。
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ));
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

            if let Err(error) = start_api(app.handle()) {
                record_api_failure(app.handle(), format!("startup API error: {error}"));
            }

            // Windows 的自启动由 NSIS 钩子写进 HKCU\...\Run；macOS 没有安装器，
            // 首次运行时把 LaunchAgent 装好，之后交给系统管理。
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_autostart::ManagerExt as _;
                let autolaunch = app.autolaunch();
                match autolaunch.is_enabled() {
                    Ok(true) => {}
                    Ok(false) => {
                        if let Err(error) = autolaunch.enable() {
                            log_startup_line(&format!("autostart enable failed: {error}"));
                        }
                    }
                    Err(error) => {
                        log_startup_line(&format!("autostart state unavailable: {error}"))
                    }
                }
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
