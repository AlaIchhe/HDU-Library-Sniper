"""应用运行目录解析。

桌面端默认使用操作系统标准用户目录；容器和服务器可通过
``HDU_SNIPER_HOME`` 将所有可变文件收拢到一个显式根目录。
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from platformdirs import PlatformDirs


APP_NAME = "HDU-Library-Sniper"
APP_HOME_ENV = "HDU_SNIPER_HOME"


@dataclass(frozen=True)
class AppPaths:
    """应用配置、数据和状态文件的绝对路径集合。"""

    config_dir: Path
    data_dir: Path
    state_dir: Path
    log_dir: Path

    def __post_init__(self) -> None:
        for field_name in ("config_dir", "data_dir", "state_dir", "log_dir"):
            path = getattr(self, field_name)
            if not path.is_absolute():
                raise ValueError(f"{field_name} 必须是绝对路径: {path}")

    @property
    def settings_file(self) -> Path:
        return self.config_dir / "settings.yaml"

    @property
    def plans_file(self) -> Path:
        return self.config_dir / "plans.yaml"

    @property
    def credentials_file(self) -> Path:
        return self.data_dir / "credentials.yaml"

    @property
    def session_cache(self) -> Path:
        return self.data_dir / "session.cache"

    @property
    def booking_log(self) -> Path:
        return self.log_dir / "booking.log"

    @property
    def task_log(self) -> Path:
        return self.log_dir / "task.log"


def resolve_app_paths(env: Mapping[str, str] | None = None) -> AppPaths:
    """解析当前进程应使用的应用目录，不创建任何文件或目录。"""
    environ = os.environ if env is None else env
    home_value = environ.get(APP_HOME_ENV, "").strip()

    if home_value:
        home = Path(home_value).expanduser()
        if not home.is_absolute():
            raise ValueError(f"{APP_HOME_ENV} 必须是绝对路径: {home}")
        home = home.resolve()
        state_dir = home / "state"
        return AppPaths(
            config_dir=home / "config",
            data_dir=home / "data",
            state_dir=state_dir,
            log_dir=state_dir / "logs",
        )

    dirs = PlatformDirs(APP_NAME, appauthor=False, roaming=False)
    return AppPaths(
        config_dir=Path(dirs.user_config_dir).resolve(),
        data_dir=Path(dirs.user_data_dir).resolve(),
        state_dir=Path(dirs.user_state_dir).resolve(),
        log_dir=Path(dirs.user_log_dir).resolve(),
    )
