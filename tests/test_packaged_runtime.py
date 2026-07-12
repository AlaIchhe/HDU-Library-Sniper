"""Frozen desktop runtime resource tests."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from hdu_sniper import diagnostics
from hdu_sniper.library.login import configure_packaged_browser
from hdu_sniper.paths import AppPaths
from hdu_sniper.scheduler import SchedulerService


def _paths(tmp_path: Path) -> AppPaths:
    return AppPaths(
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        state_dir=tmp_path / "state",
        log_dir=tmp_path / "state" / "logs",
    )


def test_packaged_browser_is_resolved_from_bundle(
    monkeypatch,
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "bundle"
    browsers = bundle / "playwright-browsers"
    browsers.mkdir(parents=True)
    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "HDU-Library-Sniper.exe"))

    assert configure_packaged_browser() == browsers
    assert os.environ["PLAYWRIGHT_BROWSERS_PATH"] == str(browsers)


def test_existing_browser_configuration_has_precedence(
    monkeypatch,
    tmp_path: Path,
) -> None:
    configured = tmp_path / "custom-browsers"
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(configured))

    assert configure_packaged_browser() == configured


def test_frozen_scheduler_separates_install_and_resource_roots(
    monkeypatch,
    tmp_path: Path,
) -> None:
    executable = tmp_path / "app" / "HDU-Library-Sniper.exe"
    resources = tmp_path / "app" / "_internal"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(resources), raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))

    scheduler = SchedulerService(_paths(tmp_path))

    assert scheduler.install_root == executable.parent
    assert scheduler.resource_root == resources
    assert scheduler._launcher_command() == [str(executable)]


def test_self_check_rejects_frozen_app_without_browser(monkeypatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(diagnostics, "configure_packaged_browser", lambda: None)

    assert diagnostics.desktop_self_check() == 10
