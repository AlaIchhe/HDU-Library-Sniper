"""Check GitHub Releases for a newer desktop application version."""

from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.request import Request, urlopen

from hdu_sniper import __version__


DEFAULT_UPDATE_API_URL = "https://api.github.com/repos/AlaIchhe/HDU-Library-Sniper/releases/latest"
UPDATE_TIMEOUT_SECONDS = 8
_VERSION_PATTERN = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+]([0-9A-Za-z.-]+))?$")


@dataclass(frozen=True)
class UpdateInfo:
    """Information needed to notify a user and open the matching download."""

    version: str
    tag_name: str
    release_url: str
    download_url: str | None
    notes: str | None = None
    published_at: str | None = None


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


def _select_download_url(assets: Sequence[Any]) -> str | None:
    """Choose an installer suitable for the current platform."""
    candidates: list[tuple[str, str]] = []
    for asset in assets:
        if not isinstance(asset, Mapping):
            continue
        name = asset.get("name")
        url = asset.get("browser_download_url")
        if isinstance(name, str) and isinstance(url, str):
            candidates.append((name, url))

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

    return (preferred or candidates)[0][1] if preferred or candidates else None


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

    body = release.get("body")
    published_at = release.get("published_at")
    return UpdateInfo(
        version=normalize_version(tag_name),
        tag_name=tag_name,
        release_url=release_url,
        download_url=_select_download_url(assets),
        notes=body if isinstance(body, str) and body.strip() else None,
        published_at=published_at if isinstance(published_at, str) else None,
    )
