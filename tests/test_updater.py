"""Tests for the best-effort desktop release checker."""

from __future__ import annotations

from hdu_sniper.updater import check_for_update, is_newer_version


def test_version_comparison_ignores_v_prefix() -> None:
    assert is_newer_version("1.2.0", "v1.2.1")
    assert not is_newer_version("1.2.1", "v1.2.1")
    assert not is_newer_version("1.2.1", "v1.1.9")


def test_stable_release_is_newer_than_prerelease() -> None:
    assert is_newer_version("1.3.0-rc.1", "v1.3.0")
    assert not is_newer_version("1.3.0", "v1.3.0-rc.2")


def test_check_for_update_selects_windows_installer(monkeypatch) -> None:
    monkeypatch.setattr("hdu_sniper.updater.sys.platform", "win32")
    monkeypatch.setattr(
        "hdu_sniper.updater._fetch_latest_release",
        lambda _url, _timeout: {
            "tag_name": "v1.3.0",
            "html_url": "https://github.com/AlaIchhe/HDU-Library-Sniper/releases/tag/v1.3.0",
            "body": "Bug fixes",
            "assets": [
                {
                    "name": "HDU-Library-Sniper-1.3.0-windows-x64-portable.zip",
                    "browser_download_url": "https://example.test/portable.zip",
                },
                {
                    "name": "HDU-Library-Sniper-Setup-1.3.0.exe",
                    "browser_download_url": "https://example.test/setup.exe",
                },
            ],
        },
    )

    result = check_for_update("1.2.0", api_url="https://example.test/releases/latest")

    assert result is not None
    assert result.version == "1.3.0"
    assert result.download_url == "https://example.test/setup.exe"


def test_check_for_update_returns_none_for_current_release(monkeypatch) -> None:
    monkeypatch.setattr(
        "hdu_sniper.updater._fetch_latest_release",
        lambda _url, _timeout: {"tag_name": "v1.2.0", "assets": []},
    )

    assert check_for_update("1.2.0", api_url="https://example.test/releases/latest") is None
