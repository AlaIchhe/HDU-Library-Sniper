"""Check GitHub Releases for a newer desktop application version."""

from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from platformdirs import user_downloads_dir

from hdu_sniper import __version__
from hdu_sniper.dto import (
    DownloadProgress,
    UpdateCancelled,
    UpdateChecksumError,
    UpdateInfo,
)


DEFAULT_UPDATE_API_URL = "https://api.github.com/repos/AlaIchhe/HDU-Library-Sniper/releases/latest"
UPDATE_TIMEOUT_SECONDS = 8
DOWNLOAD_TIMEOUT_SECONDS = 120
DOWNLOAD_CHUNK_SIZE = 64 * 1024
_VERSION_PATTERN = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+]([0-9A-Za-z.-]+))?$")


def normalize_version(value: str) -> str:
    """Normalize a release tag or version string for display/comparison."""
    return value.strip().lstrip("vV")


def _version_key(value: str) -> tuple[tuple[int, int, int], tuple[int, ...], str] | None:
    match = _VERSION_PATTERN.fullmatch(value.strip())
    if not match:
        return None

    core = tuple(int(part or 0) for part in match.group(1, 2, 3))
    prerelease = match.group(4)
    if prerelease is None:
        return core, (1,), ""

    # Stable releases sort after prereleases. For prerelease identifiers,
    # numeric parts sort before textual parts and then lexicographically.
    parts: list[int] = [0]
    for part in prerelease.split("."):
        if part.isdigit():
            parts.extend((0, int(part)))
        else:
            parts.extend((1, sum(ord(char) for char in part)))
    return core, tuple(parts), prerelease


def is_newer_version(current: str, candidate: str) -> bool:
    """Return whether candidate is a valid version newer than current."""
    current_key = _version_key(normalize_version(current))
    candidate_key = _version_key(normalize_version(candidate))
    return bool(current_key and candidate_key and candidate_key > current_key)


def _select_asset(assets: Sequence[Any]) -> Mapping[str, Any] | None:
    """Choose an installer asset suitable for the current platform."""
    candidates: list[tuple[str, str, Mapping[str, Any]]] = []
    for asset in assets:
        if not isinstance(asset, Mapping):
            continue
        name = asset.get("name")
        url = asset.get("browser_download_url")
        if isinstance(name, str) and isinstance(url, str):
            candidates.append((name, url, asset))

    if sys.platform == "win32":
        preferred = [
            item for item in candidates if "setup" in item[0].lower() and item[0].endswith(".exe")
        ]
    elif sys.platform == "darwin":
        preferred = [item for item in candidates if item[0].lower().endswith(".dmg")]
    else:
        preferred = [
            item
            for item in candidates
            if item[0].lower().endswith((".appimage", ".deb", ".rpm", ".tar.gz", ".zip"))
        ]

    return (preferred or candidates)[0][2] if preferred or candidates else None


def _fetch_latest_release(api_url: str, timeout: int) -> Mapping[str, Any]:
    request = Request(
        api_url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "HDU-Library-Sniper-Updater",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    if not isinstance(payload, Mapping):
        raise ValueError("GitHub release response is not an object")
    return payload


def check_for_update(
    current_version: str | None = None,
    *,
    api_url: str | None = None,
    timeout: int = UPDATE_TIMEOUT_SECONDS,
) -> UpdateInfo | None:
    """Return update metadata, or ``None`` when the app is already current."""
    release = _fetch_latest_release(
        api_url or os.environ.get("HDU_UPDATE_API_URL", DEFAULT_UPDATE_API_URL),
        timeout,
    )
    tag_name = release.get("tag_name")
    if not isinstance(tag_name, str) or not is_newer_version(
        current_version or __version__, tag_name
    ):
        return None

    release_url = release.get("html_url")
    if not isinstance(release_url, str) or not release_url:
        release_url = "https://github.com/AlaIchhe/HDU-Library-Sniper/releases"

    assets = release.get("assets", [])
    if not isinstance(assets, Sequence) or isinstance(assets, (str, bytes)):
        assets = []

    asset = _select_asset(assets)
    download_url = asset["browser_download_url"] if asset else None
    digest = asset.get("digest") if asset else None
    sha256_value = None
    if isinstance(digest, str) and digest.lower().startswith("sha256:"):
        candidate = digest[7:]
        if re.fullmatch(r"[0-9a-fA-F]{64}", candidate):
            sha256_value = candidate.lower()

    body = release.get("body")
    published_at = release.get("published_at")
    return UpdateInfo(
        version=normalize_version(tag_name),
        tag_name=tag_name,
        release_url=release_url,
        download_url=download_url,
        sha256=sha256_value,
        notes=body if isinstance(body, str) and body.strip() else None,
        published_at=published_at if isinstance(published_at, str) else None,
    )


def default_download_dir() -> Path:
    """Return the user's Downloads folder, falling back to a temp directory."""
    try:
        downloads = user_downloads_dir()
        if downloads:
            return Path(downloads)
    except Exception:
        pass
    return Path(tempfile.gettempdir()) / "HDU-Library-Sniper-Updates"


def download_update(
    update: UpdateInfo,
    destination_dir: Path,
    *,
    progress: Callable[[DownloadProgress], None] | None = None,
    cancel: Callable[[], bool] | None = None,
    timeout: int = DOWNLOAD_TIMEOUT_SECONDS,
) -> Path:
    """Download and verify an installer, returning the saved file path."""
    if not update.download_url:
        raise ValueError("Update has no installer download URL")

    destination_dir.mkdir(parents=True, exist_ok=True)
    url_name = Path(urlparse(update.download_url).path).name
    file_name = re.sub(r'[\\/:*?"<>|]', "_", url_name).strip()
    if not file_name:
        file_name = f"HDU-Library-Sniper-Setup-{update.version}.exe"
    target = destination_dir / file_name
    partial = destination_dir / f".{file_name}.part"

    request = Request(
        update.download_url,
        headers={"User-Agent": "HDU-Library-Sniper-Updater"},
    )
    try:
        with urlopen(request, timeout=timeout) as response, partial.open("wb") as output:
            content_length = response.headers.get("Content-Length")
            total = int(content_length) if content_length and content_length.isdigit() else None
            downloaded = 0
            while True:
                if cancel is not None and cancel():
                    raise UpdateCancelled("Update download cancelled")
                chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                output.write(chunk)
                downloaded += len(chunk)
                if progress is not None:
                    progress(DownloadProgress(downloaded=downloaded, total=total))

        if total is not None and downloaded != total:
            raise UpdateChecksumError(
                f"Download incomplete: expected {total} bytes, got {downloaded}"
            )

        if update.sha256:
            digest = sha256()
            with partial.open("rb") as handle:
                for block in iter(lambda: handle.read(DOWNLOAD_CHUNK_SIZE), b""):
                    digest.update(block)
            if digest.hexdigest() != update.sha256.lower():
                raise UpdateChecksumError(
                    f"SHA-256 mismatch: expected {update.sha256}, got {digest.hexdigest()}"
                )

        partial.replace(target)
    except Exception:
        with contextlib.suppress(OSError):
            partial.unlink()
        raise
    return target


def launch_installer(installer: Path) -> None:
    """Launch an installer detached from this process so the app can close."""
    if sys.platform == "win32":
        subprocess.Popen(
            [str(installer), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
            cwd=str(installer.parent),
            # CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
            creationflags=0x00000200 | 0x00000008,
        )
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(installer)], start_new_session=True)
        return
    subprocess.Popen(["xdg-open", str(installer)], start_new_session=True)


class UpdateService:
    """应用层更新服务：封装检查、下载、安装与平台能力判断。"""

    def __init__(self, *, allow_installer_download: bool | None = None) -> None:
        self._allow_installer_download = (
            sys.platform == "win32"
            if allow_installer_download is None
            else allow_installer_download
        )

    def check_for_update(self) -> UpdateInfo | None:
        """检查 GitHub Releases 是否有更新。"""
        return check_for_update()

    def install_supported(self, update: UpdateInfo) -> bool:
        """判断当前环境是否支持应用内下载并启动安装包。"""
        return (
            self._allow_installer_download
            and bool(update.download_url)
            and update.download_url.lower().endswith(".exe")
        )

    def download(
        self,
        update: UpdateInfo,
        *,
        progress: Callable[[DownloadProgress], None] | None = None,
        cancel: Callable[[], bool] | None = None,
    ) -> Path:
        """下载到默认目录并校验安装包。"""
        return download_update(
            update,
            default_download_dir(),
            progress=progress,
            cancel=cancel,
        )

    def launch(self, installer: Path) -> None:
        """启动已下载的安装程序。"""
        launch_installer(installer)
