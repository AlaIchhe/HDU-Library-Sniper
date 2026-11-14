use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hdu_sniper_server::{IdleTaskKind, Scheduler};
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::broadcast::error::RecvError;

const AUTO_CHECK_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const SAFE_UPDATE_WINDOW: Duration = Duration::from_secs(20 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const STAGED_RETRY_INTERVAL: Duration = Duration::from_secs(60);
const SILENT_RESTART_MARKER: &str = ".silent-restart";
const SILENT_RESTART_TTL_SECS: u64 = 120;

struct PendingUpdate {
    update: Update,
    bytes: Vec<u8>,
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default()
}

pub(crate) fn should_run_auto_check(
    last_attempt: Option<Instant>,
    now: Instant,
    cooldown: Duration,
) -> bool {
    match last_attempt {
        Some(prev) => now.saturating_duration_since(prev) >= cooldown,
        None => true,
    }
}

pub(crate) fn write_silent_restart_marker(data_dir: &Path, now_secs: u64) -> std::io::Result<()> {
    fs::create_dir_all(data_dir)?;
    fs::write(data_dir.join(SILENT_RESTART_MARKER), now_secs.to_string())
}

pub(crate) fn consume_silent_restart_marker(data_dir: &Path) -> bool {
    consume_silent_restart_marker_at(data_dir, unix_now_secs())
}

pub(crate) fn consume_silent_restart_marker_at(data_dir: &Path, now_secs: u64) -> bool {
    let path = data_dir.join(SILENT_RESTART_MARKER);
    let Ok(raw) = fs::read_to_string(&path) else {
        return false;
    };
    let _ = fs::remove_file(&path);
    let Ok(recorded) = raw.trim().parse::<u64>() else {
        return false;
    };
    now_secs.saturating_sub(recorded) <= SILENT_RESTART_TTL_SECS
}

pub(crate) fn spawn_auto_updater(app: tauri::AppHandle, scheduler: Arc<Scheduler>) {
    if cfg!(debug_assertions) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let mut rx = scheduler.subscribe_idle();
        let mut staged: Option<PendingUpdate> = None;
        let mut last_check_at: Option<Instant> = None;
        let mut retry_tick = tokio::time::interval(STAGED_RETRY_INTERVAL);
        retry_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                recv = rx.recv() => {
                    match recv {
                        Ok(kind) => {
                            let label = match kind {
                                IdleTaskKind::Booking => "booking settled",
                                IdleTaskKind::CheckIn => "check-in succeeded",
                            };
                            handle_idle_trigger(
                                &app,
                                &scheduler,
                                &mut staged,
                                &mut last_check_at,
                                label,
                            ).await;
                        }
                        Err(RecvError::Lagged(_)) => {
                            handle_idle_trigger(
                                &app,
                                &scheduler,
                                &mut staged,
                                &mut last_check_at,
                                "idle queue lagged",
                            ).await;
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
                _ = retry_tick.tick(), if staged.is_some() => {
                    try_install_staged(&app, &scheduler, &mut staged);
                }
            }
        }
    });
}

async fn handle_idle_trigger(
    app: &tauri::AppHandle,
    scheduler: &Scheduler,
    staged: &mut Option<PendingUpdate>,
    last_check_at: &mut Option<Instant>,
    reason: &str,
) {
    if staged.is_some() {
        try_install_staged(app, scheduler, staged);
        return;
    }

    if !scheduler.is_safe_update_window_now(SAFE_UPDATE_WINDOW) {
        log::info!("skipping auto-update check ({reason}): unsafe task window");
        return;
    }

    let now = Instant::now();
    if !should_run_auto_check(*last_check_at, now, AUTO_CHECK_COOLDOWN) {
        return;
    }
    *last_check_at = Some(now);

    match check_and_download(app).await {
        Ok(Some(pending)) => {
            *staged = Some(pending);
            try_install_staged(app, scheduler, staged);
        }
        Ok(None) => {}
        Err(err) => {
            let message = format!("background auto-update check/download failed ({reason}): {err}");
            log::warn!("{message}");
            crate::log_startup_line(&message);
        }
    }
}

async fn check_and_download(app: &tauri::AppHandle) -> Result<Option<PendingUpdate>, String> {
    let updater = app
        .updater_builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())?;

    let update = tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| "update manifest request timed out".to_string())?
        .map_err(|err| err.to_string())?;

    let Some(update) = update else {
        return Ok(None);
    };

    let version = update.version.clone();
    log::info!("background update available: v{version}; downloading installer");

    let bytes = tokio::time::timeout(DOWNLOAD_TIMEOUT, update.download(|_, _| {}, || {}))
        .await
        .map_err(|_| format!("downloading update v{version} timed out"))?
        .map_err(|err| err.to_string())?;

    log::info!("downloaded update v{version} ({} bytes)", bytes.len());
    Ok(Some(PendingUpdate { update, bytes }))
}

fn try_install_staged(
    app: &tauri::AppHandle,
    scheduler: &Scheduler,
    staged: &mut Option<PendingUpdate>,
) {
    let Some(pending) = staged.as_ref() else {
        return;
    };
    let version = pending.update.version.clone();

    if !scheduler.is_safe_update_window_now(SAFE_UPDATE_WINDOW) {
        log::info!(
            "update v{version} staged in memory; deferring install until next 20m safe idle window"
        );
        return;
    }

    let pending = staged.take().expect("checked staged update above");
    let data_dir = crate::app_home_dir().join("data");
    let hidden_in_tray = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .is_some_and(|visible| !visible);

    if hidden_in_tray {
        if let Err(err) = write_silent_restart_marker(&data_dir, unix_now_secs()) {
            log::warn!("failed to write silent restart marker: {err}");
        }
    }

    let start_msg = format!(
        "installing background update v{version} silently (hidden_in_tray={hidden_in_tray})"
    );
    log::info!("{start_msg}");
    crate::log_startup_line(&start_msg);

    match pending.update.install(&pending.bytes) {
        Ok(()) => {
            log::info!("update v{version} installed; restarting application");
            app.restart();
        }
        Err(err) => {
            if hidden_in_tray {
                let _ = fs::remove_file(data_dir.join(SILENT_RESTART_MARKER));
            }
            let fail_msg = format!("silent update install failed for v{version}: {err}");
            log::error!("{fail_msg}");
            crate::log_startup_line(&fail_msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_blocks_rapid_rechecks_and_allows_after_interval() {
        let start = Instant::now();
        let cooldown = Duration::from_secs(600);
        assert!(should_run_auto_check(None, start, cooldown));
        assert!(!should_run_auto_check(
            Some(start),
            start + Duration::from_secs(599),
            cooldown
        ));
        assert!(should_run_auto_check(
            Some(start),
            start + cooldown,
            cooldown
        ));
    }

    #[test]
    fn silent_restart_marker_respects_ttl_and_consumes_once() {
        let dir =
            std::env::temp_dir().join(format!("hdu-sniper-updater-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(!consume_silent_restart_marker_at(&dir, 1000));

        write_silent_restart_marker(&dir, 1000).unwrap();
        assert!(consume_silent_restart_marker_at(&dir, 1050));
        assert!(!consume_silent_restart_marker_at(&dir, 1051));

        write_silent_restart_marker(&dir, 1000).unwrap();
        assert!(!consume_silent_restart_marker_at(&dir, 1200));
        let _ = fs::remove_dir_all(&dir);
    }
}
