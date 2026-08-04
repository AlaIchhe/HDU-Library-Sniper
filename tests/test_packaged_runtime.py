"""Frozen desktop runtime resource tests."""

from __future__ import annotations

import sys
from pathlib import Path

from hdu_sniper.paths import AppPaths
from hdu_sniper.scheduler import SchedulerService


def _paths(tmp_path: Path) -> AppPaths:
    return AppPaths(
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        state_dir=tmp_path / "state",
        log_dir=tmp_path / "state" / "logs",
    )


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
