"""Tests for the best-effort desktop release checker."""

from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

import pytest

from hdu_sniper.updater import (
    UpdateCancelled,
    UpdateChecksumError,
    UpdateInfo,
    check_for_update,
    download_update,
    is_newer_version,
    launch_installer,
)


class FakeResponse:
    def __init__(self, body: bytes, content_length: int | None = None) -> None:
        self.body = body
        expected_length = len(body) if content_length is None else content_length
        self.headers = {"Content-Length": str(expected_length)}
        self._offset = 0

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            chunk = self.body[self._offset :]
            self._offset = len(self.body)
        else:
            chunk = self.body[self._offset : self._offset + size]
            self._offset += len(chunk)
        return chunk

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> None:
        return None


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


def test_check_for_update_captures_asset_sha256(monkeypatch) -> None:
    monkeypatch.setattr("hdu_sniper.updater.sys.platform", "win32")
    monkeypatch.setattr(
        "hdu_sniper.updater._fetch_latest_release",
        lambda _url, _timeout: {
            "tag_name": "v1.3.0",
            "html_url": "https://example.test/releases/tag/v1.3.0",
            "assets": [
                {
                    "name": "HDU-Library-Sniper-Setup-1.3.0.exe",
                    "browser_download_url": "https://example.test/setup.exe",
                    "digest": "sha256:" + "ABCDEF0123456789" * 4,
                }
            ],
        },
    )

    result = check_for_update("1.2.0", api_url="https://example.test/releases/latest")

    assert result is not None
    assert result.sha256 == "abcdef0123456789" * 4


def test_download_update_writes_file_and_reports_progress(tmp_path: Path) -> None:
    body = b"installer-bytes"
    update = UpdateInfo(
        version="1.3.0",
        tag_name="v1.3.0",
        release_url="https://example.test/releases/tag/v1.3.0",
        download_url="https://example.test/setup.exe",
        sha256=sha256(body).hexdigest(),
    )
    progress = []

    with patch("hdu_sniper.updater.urlopen", return_value=FakeResponse(body)):
        target = download_update(update, tmp_path, progress=progress.append)

    assert target == tmp_path / "setup.exe"
    assert target.read_bytes() == body
    assert progress[-1].downloaded == len(body)
    assert progress[-1].total == len(body)


def test_download_update_rejects_checksum_mismatch(tmp_path: Path) -> None:
    body = b"installer-bytes"
    update = UpdateInfo(
        version="1.3.0",
        tag_name="v1.3.0",
        release_url="https://example.test/releases/tag/v1.3.0",
        download_url="https://example.test/setup.exe",
        sha256=sha256(b"different").hexdigest(),
    )

    with patch("hdu_sniper.updater.urlopen", return_value=FakeResponse(body)):
        with pytest.raises(UpdateChecksumError):
            download_update(update, tmp_path)

    assert not (tmp_path / "setup.exe").exists()
    assert not (tmp_path / ".setup.exe.part").exists()


def test_download_update_honors_cancel(tmp_path: Path) -> None:
    update = UpdateInfo(
        version="1.3.0",
        tag_name="v1.3.0",
        release_url="https://example.test/releases/tag/v1.3.0",
        download_url="https://example.test/setup.exe",
    )
    calls = 0

    def cancel() -> bool:
        nonlocal calls
        calls += 1
        return calls > 1

    with patch("hdu_sniper.updater.urlopen", return_value=FakeResponse(b"installer-bytes")):
        with pytest.raises(UpdateCancelled):
            download_update(update, tmp_path, cancel=cancel)

    assert not (tmp_path / ".setup.exe.part").exists()


def test_download_update_rejects_short_body(tmp_path: Path) -> None:
    update = UpdateInfo(
        version="1.3.0",
        tag_name="v1.3.0",
        release_url="https://example.test/releases/tag/v1.3.0",
        download_url="https://example.test/setup.exe",
    )

    with patch(
        "hdu_sniper.updater.urlopen",
        return_value=FakeResponse(b"short", content_length=100),
    ):
        with pytest.raises(UpdateChecksumError):
            download_update(update, tmp_path)

    assert not (tmp_path / ".setup.exe.part").exists()


def test_launch_installer_runs_silent_setup_on_windows(monkeypatch) -> None:
    monkeypatch.setattr("hdu_sniper.updater.sys.platform", "win32")

    with patch("hdu_sniper.updater.subprocess.Popen") as popen:
        launch_installer(Path("C:/Downloads/setup.exe"))

    popen.assert_called_once()
    args, kwargs = popen.call_args
    assert Path(args[0][0]).name == "setup.exe"
    assert args[0][1:] == [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
    ]
    assert kwargs["creationflags"] == 0x00000200 | 0x00000008
