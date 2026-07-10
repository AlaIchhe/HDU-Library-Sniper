"""抢座编排服务：统一立即 / 定时 / 非交互三种入口的 Sniper 构造与进度回调。"""

from __future__ import annotations

from datetime import datetime
from typing import Callable

from config.setting import Settings
from core.client import LibraryClient
from core.room_browser import RoomBrowser
from core.sniper import BookingPlan, BookingResult, PlanRepository, Sniper
from services.auth import AuthService
from utils.notifier import Notifier


class ExitCode:
    """非交互模式 (--run-now) 退出码。"""

    SUCCESS = 0
    ALL_FAILED = 1
    AUTH_FAILED = 2
    NO_PLANS = 3


class BookingService:
    """统一封装 Sniper 的构造与三种调用入口，消除三处重复的编排样板。"""

    def __init__(
        self,
        settings: Settings,
        client: LibraryClient,
        plans: PlanRepository,
        notifier: Notifier,
    ) -> None:
        self.settings = settings
        self.client = client
        self.plans = plans
        self.notifier = notifier
        self.room_browser = RoomBrowser(self.client)

    def _build_sniper(self, **overrides) -> Sniper:
        """用 settings 默认值构造 Sniper；定时预约的临时参数通过 overrides 覆盖。"""
        kwargs = dict(
            max_trials=self.settings.max_trials,
            retry_delay=self.settings.retry_delay,
            dry_run=self.settings.dry_run,
            window_wait_seconds=self.settings.window_wait_seconds,
            window_poll_interval=self.settings.window_poll_interval,
        )
        kwargs.update(overrides)
        return Sniper(self.client, self.notifier, self.room_browser, **kwargs)

    @staticmethod
    def _progress_line(result: BookingResult, indent: str = "  ") -> str:
        icon = "OK" if result.success else "X"
        return f"{indent}[{icon}] [{result.plan.to_plan_code()}] {result.message}"

    def book_now(
        self,
        plans: list[BookingPlan],
        on_progress: Callable[[BookingResult], None] | None = None,
    ) -> list[BookingResult]:
        """立即抢座：依次尝试方案，任一成功即停止。"""
        sniper = self._build_sniper()
        return sniper.book_all(plans, on_progress=on_progress)

    def book_scheduled(
        self,
        plans: list[BookingPlan],
        execute_at: datetime,
        on_countdown: Callable[[int], None] | None = None,
        on_progress: Callable[[BookingResult], None] | None = None,
        **sniper_overrides,
    ) -> list[BookingResult]:
        """定时抢座：等待至 execute_at 后执行。Ctrl+C 中断时标记 cancelled 并向上抛出。"""
        sniper = self._build_sniper(**sniper_overrides)
        try:
            return sniper.book_at(plans, execute_at, on_countdown=on_countdown, on_progress=on_progress)
        except KeyboardInterrupt:
            sniper.cancelled = True
            raise

    def run_once(self) -> int:
        """非交互模式：缓存认证 + 立即抢座一次，返回退出码。

        专为外部调度器（Windows 任务计划程序 / cron / GitHub Actions）设计：
        全程无需键盘输入，跑完即退出。日志 / 结果通过 Notifier 写入
        config.yaml 的 log_file，stdout 供 task.log 捕获。
        """
        auth = AuthService(self.client, self.settings)
        if not auth.try_cache():
            self.notifier.send(
                "抢座任务无法启动",
                f"Cookie 缓存缺失或已过期（{self.settings.session_cache}），"
                f"请先用交互模式重新登录一次以刷新缓存。",
                success=False,
            )
            return ExitCode.AUTH_FAILED

        plans = self.plans.list_enabled()
        if not plans:
            self.notifier.send("抢座任务无可用方案", "没有启用的预约方案，任务跳过。", success=False)
            return ExitCode.NO_PLANS

        sniper = self._build_sniper()

        def on_progress(result: BookingResult) -> None:
            print(self._progress_line(result, indent=""))

        results = sniper.book_all(plans, on_progress=on_progress)
        return ExitCode.SUCCESS if any(r.success for r in results) else ExitCode.ALL_FAILED
