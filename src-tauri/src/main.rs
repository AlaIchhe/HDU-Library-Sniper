#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// WebView2 caches the app's embedded UI (served from http://tauri.localhost)
/// under %LOCALAPPDATA%\{identifier}\EBWebView. After an in-place MSI upgrade
/// this cache can keep serving the previous release's JS bundle, so the user
/// keeps seeing the old UI (e.g. the v2.0.0 login page without the QR code).
/// Clear the cache whenever the installed app version changes.
#[cfg(windows)]
fn reset_webview_cache_on_version_change() {
    use std::path::PathBuf;

    const IDENTIFIER: &str = "io.github.alaichhe.hdu-library-sniper";
    const MARKER: &str = ".webview-cache-version";

    let Ok(local_app_data) = std::env::var("LOCALAPPDATA") else { return };
    let root = PathBuf::from(local_app_data).join(IDENTIFIER);
    let version = env!("CARGO_PKG_VERSION");
    let cache_dir = root.join("EBWebView");
    let marker_path = root.join(MARKER);

    let version_changed = std::fs::read_to_string(&marker_path)
        .map(|s| s.trim() != version)
        .unwrap_or(true);

    if version_changed {
        // Only remember the new version once the stale cache is actually gone,
        // otherwise a locked cache would never be retried on the next launch.
        let cleared = if cache_dir.exists() {
            std::fs::remove_dir_all(&cache_dir).is_ok()
        } else {
            true
        };
        if cleared && std::fs::create_dir_all(&root).is_ok() {
            let _ = std::fs::write(&marker_path, version);
        }
    }
}

fn main() {
    #[cfg(windows)]
    reset_webview_cache_on_version_change();
    hdu_library_sniper_lib::run();
}
