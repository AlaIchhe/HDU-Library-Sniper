"""应用组合根：集中装配运行时依赖。"""

from __future__ import annotations

from functools import lru_cache

from hdu_sniper.app import SniperApp
from hdu_sniper.booking.plans import BookingPlans
from hdu_sniper.booking.runner import BookingRunner
from hdu_sniper.config import load_settings
from hdu_sniper.library.client import LibraryClient
from hdu_sniper.library.login import LibraryLogin
from hdu_sniper.library.rooms import LibraryRooms
from hdu_sniper.notifier import Notifier
from hdu_sniper.scheduler import SchedulerService


def create_app() -> SniperApp:
    """加载配置并创建一个完整、相互一致的应用实例。"""
    settings = load_settings()
    client = LibraryClient()
    rooms = LibraryRooms(client)
    plans = BookingPlans(settings.paths.plans_file, client, rooms)
    login = LibraryLogin(client, settings)
    notifier = Notifier(settings.paths.booking_log, settings.wechat_webhook)
    booking = BookingRunner(
        settings,
        client,
        plans,
        notifier,
        rooms=rooms,
        login=login,
    )
    scheduler = SchedulerService(settings.paths)
    return SniperApp(
        settings,
        client,
        plans,
        notifier,
        login=login,
        booking=booking,
        scheduler=scheduler,
    )


@lru_cache(maxsize=1)
def get_app() -> SniperApp:
    """返回当前进程共享的应用实例。"""
    return create_app()
