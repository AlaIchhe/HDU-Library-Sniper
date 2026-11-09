use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use hdu_sniper_server::build_router;
use hdu_sniper_store::Store;
use tokio::net::TcpListener;

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
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "hdu_sniper_server=info".into()),
        )
        .init();

    let data_dir = app_home().join("data");
    fs::create_dir_all(&data_dir).context("create data directory")?;
    let store = Arc::new(Store::open(data_dir.join("hdu-sniper.sqlite")).context("open database")?);

    let port: u16 = env::var("HDU_WEB_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8000);
    let host = env::var("HDU_WEB_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let listener = TcpListener::bind((host.as_str(), port))
        .await
        .context("bind local API")?;
    tracing::info!(%host, port, "HDU Library Sniper Rust API listening");
    axum::serve(listener, build_router(store))
        .await
        .context("serve local API")?;
    Ok(())
}
