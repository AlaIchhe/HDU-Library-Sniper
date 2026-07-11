"""QThread 工作线程：处理阻塞操作（抢座、认证等）。"""

from __future__ import annotations

from datetime import datetime

from PySide6.QtCore import QThread, Signal

from core.sniper.plan import BookingPlan
from core.sniper.retry import BookingResult
from services import BookingService


class BookingWorker(QThread):
    """抢座工作线程：在后台执行抢座任务，通过信号回传进度。"""

    # 信号：倒计时剩余秒数
    countdown_updated = Signal(int)
    # 信号：单次尝试结果 - 使用具体类型而非 object
    progress_updated = Signal(BookingResult)
    # 信号：全部完成，传递结果列表
    finished = Signal(list)  # list[BookingResult]
    # 信号：发生错误
    error_occurred = Signal(str)

    def __init__(
        self,
        booking_service: BookingService,
        plans: list[BookingPlan],
        execute_at: datetime | None = None,
        max_trials: int | None = None,
        retry_delay: float | None = None,
        window_wait_seconds: float | None = None,
        window_poll_interval: float | None = None,
    ) -> None:
        super().__init__()
        self.booking_service = booking_service
        self.plans = plans
        self.execute_at = execute_at
        self.max_trials = max_trials
        self.retry_delay = retry_delay
        self.window_wait_seconds = window_wait_seconds
        self.window_poll_interval = window_poll_interval
        self._cancelled = False
        self.sniper = None  # 将在 run() 中创建

    def run(self) -> None:
        """线程主函数：执行抢座任务。"""
        try:
            # 准备回调函数
            def on_countdown(remaining: int) -> None:
                if not self._cancelled:
                    self.countdown_updated.emit(remaining)

            def on_progress(result: BookingResult) -> None:
                if not self._cancelled:
                    self.progress_updated.emit(result)

            # 执行抢座
            if self.execute_at:
                results = self.booking_service.book_scheduled(
                    self.plans,
                    self.execute_at,
                    on_countdown=on_countdown,
                    on_progress=on_progress,
                    max_trials=self.max_trials,
                    retry_delay=self.retry_delay,
                    window_wait_seconds=self.window_wait_seconds,
                    window_poll_interval=self.window_poll_interval,
                )
            else:
                results = self.booking_service.book_now(
                    self.plans,
                    on_progress=on_progress,
                )

            if not self._cancelled:
                self.finished.emit(results)

        except Exception as exc:
            if not self._cancelled:
                self.error_occurred.emit(str(exc))

    def cancel(self) -> None:
        """取消任务（设置标志，由 BookingService 内部的 Sniper 检查）。"""
        self._cancelled = True
        # 通过 BookingService 取消活动的 Sniper
        self.booking_service.cancel_active()
        self.requestInterruption()


class AuthWorker(QThread):
    """认证工作线程：在后台执行浏览器登录。"""

    # 信号：认证完成，传递 (成功, 消息)
    finished = Signal(bool, str)
    # 信号：发生错误
    error_occurred = Signal(str)

    def __init__(self, browser_auth_service, student_id: str, password: str) -> None:
        super().__init__()
        self.browser_auth_service = browser_auth_service
        self.student_id = student_id
        self.password = password

    def run(self) -> None:
        """线程主函数：执行认证。"""
        try:
            success, message = self.browser_auth_service.login_with_credentials(
                self.student_id,
                self.password,
            )
            self.finished.emit(success, message)
        except Exception as exc:
            self.error_occurred.emit(str(exc))


class LoadFloorsWorker(QThread):
    """加载楼层工作线程：在后台查询楼层信息。"""

    # 信号：加载完成，传递楼层列表
    finished = Signal(list)  # list[FloorInfo]
    # 信号：发生错误
    error_occurred = Signal(str)

    def __init__(self, plan_service, room_query: str) -> None:
        super().__init__()
        self.plan_service = plan_service
        self.room_query = room_query

    def run(self) -> None:
        """线程主函数：执行楼层查询。"""
        try:
            floors = self.plan_service.list_floors(self.room_query)
            self.finished.emit(floors)
        except Exception as exc:
            self.error_occurred.emit(str(exc))


class TestExecutionWorker(QThread):
    """测试执行工作线程：在后台执行定时任务测试。"""

    # 信号：测试完成，传递 (成功?, 输出)
    finished = Signal(bool, str)
    # 信号：发生错误
    error_occurred = Signal(str)

    def __init__(self, scheduler_service) -> None:
        super().__init__()
        self.scheduler_service = scheduler_service

    def run(self) -> None:
        """线程主函数：执行测试。"""
        try:
            success, output = self.scheduler_service.test_execution()
            self.finished.emit(success, output)
        except Exception as exc:
            self.error_occurred.emit(str(exc))
