"""组合根：装配 settings / client / plans / notifier。"""

from __future__ import annotations

from config.setting import Settings, load_settings
from core.client import LibraryClient
from core.sniper import PlanRepository
from utils.notifier import Notifier


def build_runtime() -> tuple[Settings, LibraryClient, PlanRepository, Notifier]:
    """加载配置并构造运行时四件套，供交互式应用与非交互入口共用。"""
    settings = load_settings()
    client = LibraryClient()
    plans = PlanRepository(settings.plans_file)
    notifier = Notifier(settings.log_file, settings.wechat_webhook)
    return settings, client, plans, notifier
