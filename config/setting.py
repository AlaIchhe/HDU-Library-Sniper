"""配置加载：读取 config/config.yaml，缺失字段使用默认值。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

_DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"


@dataclass
class Settings:
    """抢座工具运行配置。"""

    max_trials: int = 5
    retry_delay: float = 1.0
    dry_run: bool = False
    # 预约窗口尚未开放（服务器返回"超出可预约座位时间范围"）时的等待策略：
    # 不占用 max_trials 指数退避预算，按固定短间隔轮询，直到窗口开放或超时。
    # 场景：定时任务在开放时刻（如 20:00:00）发起请求，但服务器实际开闸略晚几秒。
    window_wait_seconds: float = 30.0
    window_poll_interval: float = 1.0
    session_cache: str = "data/session.cache"
    plans_file: str = "data/plans.yaml"
    log_file: str = "logs/booking.log"
    wechat_webhook: str = ""


def load_settings(path: str | Path = _DEFAULT_CONFIG_PATH) -> Settings:
    """从 config.yaml 加载配置；文件不存在或字段缺失时回退到默认值。"""
    path = Path(path)
    data: dict = {}
    if path.exists() and path.read_text(encoding="utf-8").strip():
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    booking = data.get("booking") or {}
    paths = data.get("paths") or {}
    notification = data.get("notification") or {}

    return Settings(
        max_trials=int(booking.get("max_trials", 5)),
        retry_delay=float(booking.get("retry_delay", 1.0)),
        dry_run=bool(booking.get("dry_run", False)),
        window_wait_seconds=float(booking.get("window_wait_seconds", 30.0)),
        window_poll_interval=float(booking.get("window_poll_interval", 1.0)),
        session_cache=str(paths.get("session_cache", "data/session.cache")),
        plans_file=str(paths.get("plans_file", "data/plans.yaml")),
        log_file=str(paths.get("log_file", "logs/booking.log")),
        wechat_webhook=str(notification.get("wechat_webhook", "")),
    )
