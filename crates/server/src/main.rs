use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use hdu_sniper_auth::AuthService;
use hdu_sniper_server::{build_router, BookingExecutor, Scheduler};
use hdu_sniper_store::Store;
use tokio::net::TcpListener;

fn configured_port() -> u16 {
    env::var("HDU_WEB_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8000)
}

fn check_health(port: u16) -> anyhow::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let timeout = Duration::from_secs(3);
    let mut stream =
        TcpStream::connect_timeout(&addr, timeout).context("connect health endpoint")?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
    let mut buf = [0_u8; 256];
    let n = stream.read(&mut buf).context("read health response")?;
    let head = std::str::from_utf8(&buf[..n]).unwrap_or("");
    let status_line = head.lines().next().unwrap_or("");
    if !status_line.starts_with("HTTP/1.1 200") && !status_line.starts_with("HTTP/1.0 200") {
        bail!("unexpected health status: {status_line}");
    }
    Ok(())
}

fn app_home() -> PathBuf {
    if let Ok(home) = env::var("HDU_SNIPER_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    if let Ok(home) = env::var("USERPROFILE").or_else(|_| env::var("HOME")) {
        return PathBuf::from(home).join(".hdu-library-sniper");
    }
    PathBuf::from(".hdu-library-sniper")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if env::args().any(|arg| arg == "--healthcheck") {
        return check_health(configured_port());
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "hdu_sniper_server=info".into()),
        )
        .init();

    let data_dir = app_home().join("data");
    fs::create_dir_all(&data_dir).context("create data directory")?;
    let store = Arc::new(Store::open(data_dir.join("hdu-sniper.sqlite")).context("open database")?);
    let auth = Arc::new(AuthService::new(store.clone()).context("open auth service")?);
    let booking = Arc::new(BookingExecutor::new(store.clone()));
    let scheduler = Arc::new(Scheduler::new(store.clone(), auth.clone(), booking));
    tokio::spawn(scheduler.clone().run());

    let port = configured_port();
    let host = env::var("HDU_WEB_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let listener = TcpListener::bind((host.as_str(), port))
        .await
        .context("bind local API")?;
    tracing::info!(%host, port, "HDU Library Sniper Rust API listening");
    axum::serve(listener, build_router(store, auth, scheduler))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve local API")?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::check_health;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn healthcheck_accepts_200_and_rejects_503() {
        let ok_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let ok_port = ok_listener.local_addr().unwrap().port();
        let ok_handle = thread::spawn(move || {
            let (mut conn, _) = ok_listener.accept().unwrap();
            let mut req = [0_u8; 256];
            let _ = conn.read(&mut req);
            let _ = conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        });
        assert!(check_health(ok_port).is_ok());
        ok_handle.join().unwrap();

        let err_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let err_port = err_listener.local_addr().unwrap().port();
        let err_handle = thread::spawn(move || {
            let (mut conn, _) = err_listener.accept().unwrap();
            let mut req = [0_u8; 256];
            let _ = conn.read(&mut req);
            let _ =
                conn.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
        });
        assert!(check_health(err_port).is_err());
        err_handle.join().unwrap();
    }
}
