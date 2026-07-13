"""预约执行器：立即执行、定时等待、重试、取消和后台单次运行。"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from threading import Lock

from hdu_sniper.booking.models import BookingPlan, BookingResult
from hdu_sniper.booking.plans import BookingPlans
from hdu_sniper.booking.retry import (
    RetryDecision,
    _extract_message,
    booking_failed,
    default_retry_decider,
    is_time_out_of_range,
)
from hdu_sniper.booking.time import build_begin_time
from hdu_sniper.config import Settings, load_credentials
from hdu_sniper.library import responses
from hdu_sniper.library.client import AuthenticationExpiredError, HduLibraryError, LibraryClient
from hdu_sniper.library.login import LibraryLogin
from hdu_sniper.library.rooms import LibraryRooms
from hdu_sniper.notifier import Notifier


class ExitCode:
    """后台单次运行的退出码。"""

    SUCCESS = 0
    ALL_FAILED = 1
    AUTH_FAILED = 2
    NO_PLANS = 3


class BookingRunner:
    """执行预约工作流，同一实例同一时间只允许一个活动任务。"""

    def __init__(
        self,
        settings: Settings,
        client: LibraryClient,
        plans: BookingPlans,
        notifier: Notifier,
        *,
        rooms: LibraryRooms | None = None,
        login: LibraryLogin | None = None,
    ) -> None:
        self.settings = settings
        self.client = client
        self.plans = plans
        self.notifier = notifier
        self.rooms = rooms or LibraryRooms(client)
        self.login = login or LibraryLogin(client, settings)
        self._job_lock = Lock()
        self._active = False
        self._cancelled = False

    @property
    def is_active(self) -> bool:
        with self._job_lock:
            return self._active

    def cancel(self) -> bool:
        """协作式取消活动任务；进行中的网络请求返回后才会停止。"""
        with self._job_lock:
            if not self._active:
                return False
            self._cancelled = True
            return True

    def _is_cancelled(self) -> bool:
        with self._job_lock:
            return self._cancelled

    def _begin(self) -> None:
        with self._job_lock:
            if self._active:
                raise RuntimeError("已有预约任务正在运行")
            self._active = True
            self._cancelled = False

    def _finish(self) -> None:
        with self._job_lock:
            self._active = False
            self._cancelled = False

    def _book_single(self, plan: BookingPlan) -> BookingResult:
        try:
            floors = self.rooms.get_floors_for_booking(plan)
            _, seat = self.rooms.find_seat(floors, plan.floor_id, plan.seat_num)
        except AuthenticationExpiredError:
            raise
        except HduLibraryError as exc:
            return BookingResult(plan, False, f"房间或座位查询失败: {exc}")

        seat_id = responses.seat_id(seat)
        uid = self.client.resolve_uid()
        begin_time = build_begin_time(plan.start_hour)
        try:
            result = self.client.book_seat(
                seat_id,
                uid,
                begin_time,
                plan.duration_hours,
                dry_run=self.settings.dry_run,
            )
        except AuthenticationExpiredError:
            raise
        except HduLibraryError as exc:
            if exc.is_timeout:
                confirmed = self.client.find_confirmed_booking(int(begin_time.timestamp()))
                if confirmed:
                    return BookingResult(plan, True, "预约成功（响应超时，已服务端确认）")
            return BookingResult(plan, False, f"预约请求失败: {exc}")

        if self.settings.dry_run:
            return BookingResult(plan, True, f"[预览模式] 参数已就绪: {result}", result)
        if booking_failed(result):
            return BookingResult(
                plan, False, _extract_message(result) or "预约接口返回失败", result
            )
        return BookingResult(plan, True, _extract_message(result) or "预约成功", result)

    def _backoff_delay(self, attempt: int) -> float:
        delay = self.settings.retry_delay * (2 ** (attempt - 1))
        return max(random.uniform(0, delay), 0.1)

    def _execute_plans(
        self,
        plans: list[BookingPlan],
        on_progress: Callable[[BookingResult], None] | None,
    ) -> list[BookingResult]:
        results: list[BookingResult] = []
        for plan in plans:
            if self._is_cancelled():
                break
            attempt = 0
            window_deadline: float | None = None
            while attempt < self.settings.max_trials:
                if self._is_cancelled():
                    break
                result = self._book_single(plan)
                results.append(result)
                if on_progress:
                    on_progress(result)
                if result.success:
                    self.notifier.send("预约成功！", self._format_success(result), success=True)
                    return results

                waiting_for_window = bool(
                    result.raw_response and is_time_out_of_range(result.raw_response),
                )
                if waiting_for_window:
                    if window_deadline is None:
                        window_deadline = time.monotonic() + self.settings.window_wait_seconds
                    if self._is_cancelled() or time.monotonic() >= window_deadline:
                        break
                    time.sleep(self.settings.window_poll_interval)
                    continue

                if result.raw_response:
                    decision = default_retry_decider(result.raw_response)
                    if decision.action == RetryDecision.STOP:
                        self.notifier.send(
                            "预约中止",
                            f"服务器返回: {decision.reason}",
                            success=False,
                        )
                        return results
                    if decision.action == RetryDecision.SKIP:
                        break

                attempt += 1
                if attempt < self.settings.max_trials:
                    time.sleep(self._backoff_delay(attempt))

        if results:
            last = results[-1]
            self.notifier.send(
                "预约失败",
                f"已尝试 {len(plans)} 个方案，共 {len(results)} 次请求，均未成功。\n"
                f"最后错误: {last.message}",
                success=False,
            )
        return results

    def run_now(
        self,
        plans: list[BookingPlan],
        on_progress: Callable[[BookingResult], None] | None = None,
    ) -> list[BookingResult]:
        self._begin()
        try:
            return self._execute_plans(plans, on_progress)
        finally:
            self._finish()

    def run_once(self) -> int:
        """恢复登录态并执行所有启用方案，供计划任务和容器调用。"""
        if not self.login.try_cache() and not self._relogin_with_credentials():
            self.notifier.send(
                "抢座任务无法启动",
                "登录态已过期且自动登录失败，请重新登录或提供环境 secret。",
                success=False,
            )
            return ExitCode.AUTH_FAILED

        plans = self.plans.list_enabled()
        if not plans:
            self.notifier.send("抢座任务无可用方案", "没有启用的预约方案。", success=False)
            return ExitCode.NO_PLANS

        def on_progress(result: BookingResult) -> None:
            marker = "OK" if result.success else "X"
            print(f"[{marker}] [{result.plan.to_plan_code()}] {result.message}")

        try:
            results = self.run_now(plans, on_progress=on_progress)
        except AuthenticationExpiredError:
            self.notifier.send(
                "抢座任务无法启动",
                "图书馆登录状态已失效，请重新认证。",
                success=False,
            )
            return ExitCode.AUTH_FAILED
        return (
            ExitCode.SUCCESS if any(result.success for result in results) else ExitCode.ALL_FAILED
        )

    def _relogin_with_credentials(self) -> bool:
        credentials = load_credentials(self.settings.paths.credentials_file)
        if not credentials:
            return False
        success, message = self.login.login_with_credentials(
            credentials.student_id,
            credentials.password,
        )
        if not success:
            self.notifier.send("自动登录失败", message, success=False)
        return success

    @staticmethod
    def _format_success(result: BookingResult) -> str:
        plan = result.plan
        return "\n".join(
            [
                f"方案: {plan.to_plan_code()}",
                f"座位号: {plan.seat_num}",
                f"预约人: {plan.booker_name or '(未设置)'}",
                f"开始时间: {build_begin_time(plan.start_hour).isoformat()}",
                f"时长: {plan.duration_hours} 小时",
                f"服务器响应: {result.message}",
            ],
        )
