"""抢座编排服务：统一立即 / 定时 / 非交互三种入口的 Sniper 构造与进度回调。"""

from __future__ import annotations

from datetime import datetime
from threading import Lock
from typing import Callable

from config.settings import Settings, load_credentials
from core.client import LibraryClient
from core.room_browser import RoomBrowser
from core.sniper import BookingPlan, BookingResult, PlanRepository, Sniper
from services.auth import AuthService
from services.browser_auth import BrowserAuthService
from utils.notifier import Notifier


class ExitCode:
    """非交互模式 (--run-now) 退出码。"""

    SUCCESS = 0
    ALL_FAILED = 1
    AUTH_FAILED = 2
    NO_PLANS = 3


class BookingService:
    """统一封装 Sniper 的构造与三种调用入口，消除三处重复的编排样板。

    抢座是同步阻塞调用（重试循环 / 倒计时 sleep 可长达数十秒），GUI 必须把它
    丢到 worker 线程跑。活动 Sniper 登记在 ``self._active_sniper``，供
    :meth:`cancel_active` 从 GUI 线程置位 ``Sniper.cancelled``——Sniper 的循环
    已在每个 tick / 每次尝试前轮询该标志，置位后即协作式退出。详见各方法文档。
    """

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
        self.browser_auth = BrowserAuthService(self.client, self.settings)
        # 当前活动 Sniper（抢座进行中时非空）；GUI 线程据此取消，见 cancel_active。
        # 使用线程锁保护访问，防止竞态条件。
        self._sniper_lock = Lock()
        self._active_sniper: Sniper | None = None

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
        """立即抢座：依次尝试方案，任一成功即停止。

        阻塞调用——GUI 须在 worker 线程执行。运行期间可用 :meth:`cancel_active`
        协作式取消（Sniper 在每次尝试前轮询 ``cancelled``）。
        """
        sniper = self._build_sniper()
        with self._sniper_lock:
            self._active_sniper = sniper
        try:
            return sniper.book_all(plans, on_progress=on_progress)
        finally:
            with self._sniper_lock:
                self._active_sniper = None

    def book_scheduled(
        self,
        plans: list[BookingPlan],
        execute_at: datetime,
        on_countdown: Callable[[int], None] | None = None,
        on_progress: Callable[[BookingResult], None] | None = None,
        **sniper_overrides,
    ) -> list[BookingResult]:
        """定时抢座：等待至 execute_at 后执行。Ctrl+C 中断时标记 cancelled 并向上抛出。

        阻塞调用——GUI 须在 worker 线程执行，倒计时与重试期间均可由
        :meth:`cancel_active` 协作式取消（倒计时每秒轮询一次 ``cancelled``）。
        """
        sniper = self._build_sniper(**sniper_overrides)
        with self._sniper_lock:
            self._active_sniper = sniper
        try:
            return sniper.book_at(plans, execute_at, on_countdown=on_countdown, on_progress=on_progress)
        except KeyboardInterrupt:
            sniper.cancelled = True
            raise
        finally:
            with self._sniper_lock:
                self._active_sniper = None

    # ------------------------------------------------------------------
    # 取消 / 状态查询 —— 供 GUI（或任何外部线程）对活动抢座做协作式控制
    # ------------------------------------------------------------------
    def cancel_active(self) -> bool:
        """请求取消正在进行的抢座（GUI / 外部线程调用）。

        把当前活动 Sniper 的 ``cancelled`` 置 True——Sniper 的重试循环与倒计时
        循环已在每个 tick / 每次尝试前轮询该标志，置位后会在 ~1 秒内（倒计时
        ``sleep`` 期间）或当前请求返回后退出，并返回已积累的部分结果。

        线程安全：使用 Lock 保护 _active_sniper 的访问。返回 True 表示存在活动
        任务并已置位；False 表示当前没有正在进行的抢座。

        注意：取消是协作式的，无法硬中断一个进行中的 ``requests`` 网络调用——
        最坏情况需等当前请求返回。调用方应向用户提示"取消中，可能需数秒"。
        同一时间只应有一个活动抢座；UI 层须在活动期间禁用启动按钮（见 is_active）。
        """
        with self._sniper_lock:
            sniper = self._active_sniper
            if sniper is None:
                return False
            sniper.cancelled = True
            return True

    @property
    def is_active(self) -> bool:
        """是否有抢座任务正在进行（供 UI 据此启用/禁用启动与取消按钮）。"""
        with self._sniper_lock:
            return self._active_sniper is not None

    def _relogin_with_credentials(self) -> bool:
        """缓存失效时，用已存凭据（环境变量或 data/credentials.yaml）headless 自愈登录。

        供非交互 ``--run-now`` 在 cookie 过期时自动续登，免去人工刷新。成功返回 True。
        """
        creds = load_credentials(self.settings.credentials_file)
        if not creds:
            return False
        ok, msg = self.browser_auth.login_with_credentials(creds.student_id, creds.password)
        if not ok:
            self.notifier.send("自动登录失败", msg, success=False)
        return ok

    def run_once(self) -> int:
        """非交互模式：缓存认证 + 立即抢座一次，返回退出码。

        专为外部调度器（Windows 任务计划程序 / cron / GitHub Actions）设计：
        全程无需键盘输入，跑完即退出。日志 / 结果通过 Notifier 写入
        config.yaml 的 log_file，stdout 供 task.log 捕获。

        认证顺序：先复用 session.cache；过期则用已存学号+密码 headless 自愈登录；
        两者都不可用才返回 AUTH_FAILED。
        """
        auth = AuthService(self.client, self.settings)
        if not auth.try_cache() and not self._relogin_with_credentials():
            self.notifier.send(
                "抢座任务无法启动",
                "登录态已过期且自动登录失败。请在 data/credentials.yaml 填入"
                "学号与数字杭电密码（或交互模式重新登录一次）后重试。",
                success=False,
            )
            return ExitCode.AUTH_FAILED

        plans = self.plans.list_enabled()
        if not plans:
            self.notifier.send("抢座任务无可用方案", "没有启用的预约方案，任务跳过。", success=False)
            return ExitCode.NO_PLANS

        def on_progress(result: BookingResult) -> None:
            print(self._progress_line(result, indent=""))

        # 复用 book_now：同一 Sniper 构造 + 活动登记 + 取消支持，避免重复编排样板。
        results = self.book_now(plans, on_progress=on_progress)
        return ExitCode.SUCCESS if any(r.success for r in results) else ExitCode.ALL_FAILED
