#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request},
    Router,
};
use hdu_sniper_auth::AuthService;
use hdu_sniper_server::{build_router, BookingExecutor, Scheduler};
use hdu_sniper_store::Store;
use tauri::{Emitter, Manager, WindowEvent};
use tower::ServiceExt;

const MAX_IPC_BODY_BYTES: usize = 16 * 1024 * 1024;

/// 桌面端托管的内存路由器状态。启动阶段同步初始化完成后即直接可用，
/// 不再经由本地 TCP 端口与环回 HTTP 通信。
#[derive(Default)]
struct LocalApi {
    router: Mutex<Option<Router>>,
    error: Mutex<Option<String>>,
}

#[derive(serde::Serialize)]
struct ApiStatusView {
    running: bool,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct ApiRequest {
    method: String,
    path: String,
    body: Option<String>,
}

#[derive(serde::Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
}

#[tauri::command]
fn local_api_status(api: tauri::State<'_, LocalApi>) -> ApiStatusView {
    let running = api
        .router
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false);
    let error = api.error.lock().map(|slot| slot.clone()).unwrap_or(None);
    ApiStatusView { running, error }
}

/// 桌面端统一 API 入口：把前端请求在进程内直接交给同一个 Axum `Router` 执行。
#[tauri::command]
async fn api_request(
    api: tauri::State<'_, LocalApi>,
    request: ApiRequest,
) -> Result<ApiResponse, String> {
    let router = api
        .router
        .lock()
        .map_err(|_| "local API state poisoned".to_string())?
        .clone();
    let Some(router) = router else {
        let detail = api
            .error
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .unwrap_or_else(|| "本地后台服务未就绪".into());
        return Err(detail);
    };
    dispatch_request(router, request).await
}

async fn dispatch_request(router: Router, request: ApiRequest) -> Result<ApiResponse, String> {
    if !request.path.starts_with("/api/") {
        return Err(format!("unsupported IPC path: {}", request.path));
    }
    let method = Method::from_bytes(request.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|error| format!("invalid HTTP method: {error}"))?;
    let mut builder = Request::builder()
        .method(method)
        .uri(&request.path)
        .header(header::HOST, "localhost");
    let body = match request.body {
        Some(text) if !text.is_empty() => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(text)
        }
        _ => Body::empty(),
    };
    let req = builder
        .body(body)
        .map_err(|error| format!("failed to build API request: {error}"))?;
    let response = router
        .oneshot(req)
        .await
        .map_err(|error| format!("API router error: {error}"))?;
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), MAX_IPC_BODY_BYTES)
        .await
        .map_err(|error| format!("failed to read API response body: {error}"))?;
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|error| format!("invalid UTF-8 API response body: {error}"))?;
    Ok(ApiResponse { status, body })
}

/// 记下启动失败原因：启动日志（startup.log）、GUI 日志、前端状态各一份。
fn record_api_failure(app: &tauri::AppHandle, message: String) {
    if let Some(api) = app.try_state::<LocalApi>() {
        if let Ok(mut slot) = api.router.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = api.error.lock() {
            *slot = Some(message.clone());
        }
    }
    log::error!("{message}");
    log_startup_line(&message);
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

fn init_api(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app_home_dir().join("data");
    fs::create_dir_all(&data_dir)?;
    let store = Arc::new(Store::open(data_dir.join("hdu-sniper.sqlite"))?);
    let auth = Arc::new(AuthService::new(store.clone())?);
    let booking = Arc::new(BookingExecutor::new(store.clone()));
    let scheduler = Arc::new(Scheduler::new(store.clone(), auth.clone(), booking));
    let router = build_router(store, auth, scheduler.clone());
    if let Some(api) = app.try_state::<LocalApi>() {
        if let Ok(mut slot) = api.router.lock() {
            *slot = Some(router);
        }
        if let Ok(mut slot) = api.error.lock() {
            *slot = None;
        }
    }
    tauri::async_runtime::spawn(scheduler.run());
    let version = env!("CARGO_PKG_VERSION");
    let message = format!(
        "local API ready via IPC (v{version}, data dir {})",
        data_dir.display()
    );
    log::info!("{message}");
    log_startup_line(&message);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        log_startup_line(&format!("panic: {info}"));
    }));
    let mut builder = tauri::Builder::default()
        .manage(LocalApi::default())
        .invoke_handler(tauri::generate_handler![local_api_status, api_request]);

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

            if let Err(error) = init_api(app.handle()) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_router() -> Router {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = Arc::new(AuthService::new(store.clone()).unwrap());
        let booking = Arc::new(BookingExecutor::new(store.clone()));
        let scheduler = Arc::new(Scheduler::new(store.clone(), auth.clone(), booking));
        build_router(store, auth, scheduler)
    }

    #[tokio::test]
    async fn dispatches_get_health_in_memory() {
        let response = dispatch_request(
            test_router(),
            ApiRequest {
                method: "GET".into(),
                path: "/api/health".into(),
                body: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        let parsed: serde_json::Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(parsed["status"], "ok");
    }

    #[tokio::test]
    async fn forwards_post_json_and_preserves_http_status() {
        let response = dispatch_request(
            test_router(),
            ApiRequest {
                method: "POST".into(),
                path: "/api/session/login".into(),
                body: Some(r#"{"studentId":"","password":""}"#.into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        let parsed: serde_json::Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(parsed["success"], false);
    }

    #[tokio::test]
    async fn rejects_non_api_paths_over_ipc() {
        let err = dispatch_request(
            test_router(),
            ApiRequest {
                method: "GET".into(),
                path: "/index.html".into(),
                body: None,
            },
        )
        .await
        .err()
        .unwrap();
        assert!(err.contains("unsupported IPC path"));
    }
}
