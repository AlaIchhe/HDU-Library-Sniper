"""配置加载：读取 config/config.yaml，缺失字段使用默认值。"""

from __future__ import annotations

import contextlib
import os
from dataclasses import dataclass
from pathlib import Path

import yaml


_DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"


@dataclass
class Settings:
    """抢座工具运行配置。"""

    project_root: Path | None = None
    max_trials: int = 5
    retry_delay: float = 1.0
    dry_run: bool = False
    # 预约窗口尚未开放（服务器返回"超出可预约座位时间范围"）时的等待策略：
    # 不占用 max_trials 指数退避预算，按固定短间隔轮询，直到窗口开放或超时。
    # 场景：定时任务在开放时刻（如 20:00:00）发起请求，但服务器实际开闸略晚几秒。
    window_wait_seconds: float = 30.0
    window_poll_interval: float = 1.0
    session_cache: str = "data/session.cache"
    # 学号 + 密码凭据（headless 登录用）；已 .gitignore，绝不提交。
    credentials_file: str = "data/credentials.yaml"
    plans_file: str = "config/plans.yaml"
    log_file: str = "logs/booking.log"
    wechat_webhook: str = ""


@dataclass
class Credentials:
    """杭电统一身份认证凭据（学号 + 数字杭电密码）。"""

    student_id: str
    password: str


def load_settings(path: str | Path = _DEFAULT_CONFIG_PATH) -> Settings:
    """从 config.yaml 加载配置；文件不存在或字段缺失时回退到默认值。"""
    path = Path(path)
    data: dict = {}
    if path.exists() and path.read_text(encoding="utf-8").strip():
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    booking = data.get("booking") or {}
    paths = data.get("paths") or {}
    notification = data.get("notification") or {}

    # 项目根目录：config.yaml 所在目录的上一级
    project_root = path.resolve().parent.parent

    return Settings(
        project_root=project_root,
        max_trials=int(booking.get("max_trials", 5)),
        retry_delay=float(booking.get("retry_delay", 1.0)),
        dry_run=bool(booking.get("dry_run", False)),
        window_wait_seconds=float(booking.get("window_wait_seconds", 30.0)),
        window_poll_interval=float(booking.get("window_poll_interval", 1.0)),
        session_cache=str(paths.get("session_cache", "data/session.cache")),
        credentials_file=str(paths.get("credentials_file", "data/credentials.yaml")),
        plans_file=str(paths.get("plans_file", "config/plans.yaml")),
        log_file=str(paths.get("log_file", "logs/booking.log")),
        wechat_webhook=str(notification.get("wechat_webhook", "")),
    )


def load_credentials(path: str | Path) -> Credentials | None:
    """加载登录凭据：优先环境变量 ``HDU_STUDENT_ID`` / ``HDU_PASSWORD``（CI 用），
    其次读取 ``path`` 指向的 YAML 文件（本地用）。两者都缺则返回 ``None``。

    YAML 格式::

        student_id: "学号"
        password: "数字杭电密码"
    """
    sid = os.environ.get("HDU_STUDENT_ID", "").strip()
    pwd = os.environ.get("HDU_PASSWORD", "").strip()
    if sid and pwd:
        return Credentials(student_id=sid, password=pwd)

    p = Path(path).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    if not p.exists():
        return None
    try:
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except (yaml.YAMLError, OSError):
        return None
    sid = str(data.get("student_id", "")).strip()
    pwd = str(data.get("password", "")).strip()
    if sid and pwd:
        return Credentials(student_id=sid, password=pwd)
    return None


def save_credentials(path: str | Path, creds: Credentials) -> None:
    """把凭据写入 YAML 文件（本地复用 + 供非交互 --run-now 自愈登录）。

    POSIX 下尝试 ``chmod 600``；写入失败抛 ``OSError`` 由调用方决定是否阻断。
    文件已加入 ``.gitignore``，绝不应提交。
    """
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        yaml.safe_dump(
            {"student_id": creds.student_id, "password": creds.password},
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    with contextlib.suppress(OSError):
        p.chmod(0o600)  # Windows 无 POSIX 权限模型，忽略
