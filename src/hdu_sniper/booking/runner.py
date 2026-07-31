"""预约执行器：立即执行、定时等待、重试、取消和后台单次运行。"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from datetime import UTC, datetime
from json import dumps
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
from hdu_sniper.booking.time import build_begin_time, parse_execute_at
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


class _BookingAuditLog:
    """抢座细粒度审计日志；只写元数据，不写 Cookie、密码或请求签名。"""

    def __init__(self, path) -> None:
        self.path = path
        self._lock = Lock()

    def record(self, event: str, **fields) -> None:
        entry = {
            "event": event,
            "at": datetime.now(UTC).isoformat(timespec="milliseconds"),
            **fields,
        }
        try:
            with self._lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as stream:
                    stream.write(f"[AUDIT] {dumps(entry, ensure_ascii=False, sort_keys=True)}\n")
        except OSError:
            # 日志不可写不应阻断抢座请求。
            return


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
        self._audit = _BookingAuditLog(settings.paths.booking_log)
        self._prewarmed_seats: dict[tuple[str, str], dict] = {}
        self._prewarmed_uid = ""

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
        cache_key = (plan.to_plan_code(), plan.seat_num)
        seat = self._prewarmed_seats.get(cache_key)
        if seat is None:
            try:
                floors = self.rooms.get_floors_for_booking(plan)
                _, seat = self.rooms.find_seat(floors, plan.floor_id, plan.seat_num)
            except AuthenticationExpiredError:
                raise
            except HduLibraryError as exc:
                return BookingResult(plan, False, f"房间或座位查询失败: {exc}")

        seat_id = responses.seat_id(seat)
        uid = self._prewarmed_uid or self.client.resolve_uid()
        begin_time = build_begin_time(plan.start_hour)
        request_at = datetime.now(UTC).isoformat(timespec="milliseconds")
        request_started = time.perf_counter()
        self._audit.record(
            "request_sent",
            plan_id=plan.plan_id,
            plan_code=plan.to_plan_code(),
            seat_num=plan.seat_num,
            request_at=request_at,
            begin_at=begin_time.isoformat(timespec="milliseconds"),
            duration_seconds=plan.duration_hours * 3600,
        )
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
            elapsed_ms = round((time.perf_counter() - request_started) * 1000, 3)
            self._audit.record(
                "response_received",
                plan_id=plan.plan_id,
                seat_num=plan.seat_num,
                elapsed_ms=elapsed_ms,
                success=False,
                error=str(exc),
            )
            if exc.is_timeout:
                confirmed = self.client.find_confirmed_booking(
                    int(begin_time.timestamp()), plan.seat_num, plan.duration_hours
                )
                self._audit.record(
                    "final_verification",
                    plan_id=plan.plan_id,
                    seat_num=plan.seat_num,
                    begin_ts=int(begin_time.timestamp()),
                    duration_seconds=plan.duration_hours * 3600,
                    matched=bool(confirmed),
                    source="timeout_recovery",
                )
                if confirmed:
                    return BookingResult(
                        plan,
                        True,
                        "预约成功（响应超时，已服务端确认）",
                        verified=True,
                        elapsed_ms=elapsed_ms,
                    )
            return BookingResult(plan, False, f"预约请求失败: {exc}", elapsed_ms=elapsed_ms)

        elapsed_ms = round((time.perf_counter() - request_started) * 1000, 3)
        failed = booking_failed(result)
        self._audit.record(
            "response_received",
            plan_id=plan.plan_id,
            seat_num=plan.seat_num,
            elapsed_ms=elapsed_ms,
            success=not failed,
            message=_extract_message(result),
        )
        if self.settings.dry_run:
            return BookingResult(
                plan,
                True,
                f"[预览模式] 参数已就绪: {result}",
                result,
                verified=False,
                elapsed_ms=elapsed_ms,
            )
        if failed:
            return BookingResult(
                plan,
                False,
                _extract_message(result) or "预约接口返回失败",
                result,
                elapsed_ms=elapsed_ms,
            )

        confirmed = self.client.find_confirmed_booking(
            int(begin_time.timestamp()), plan.seat_num, plan.duration_hours
        )
        self._audit.record(
            "final_verification",
            plan_id=plan.plan_id,
            seat_num=plan.seat_num,
            begin_ts=int(begin_time.timestamp()),
            duration_seconds=plan.duration_hours * 3600,
            matched=bool(confirmed),
            source="success_response",
        )
        if not confirmed:
            return BookingResult(
                plan,
                False,
                "接口返回成功，但预约列表复核未找到匹配的座位、时间或时长",
                result,
                verified=False,
                elapsed_ms=elapsed_ms,
            )
        return BookingResult(
            plan,
            True,
            _extract_message(result) or "预约成功，已完成列表复核",
            result,
            verified=True,
            elapsed_ms=elapsed_ms,
        )

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
            for seat_num in plan.seat_candidates:
                candidate = plan if seat_num == plan.seat_num else plan.__class__(
                    **{**plan.to_dict(), "seat_num": seat_num}
                )
                attempt = 0
                window_deadline: float | None = None
                while attempt < self.settings.max_trials:
                    if self._is_cancelled():
                        break
                    result = self._book_single(candidate)
                    results.append(result)
                    if on_progress:
                        on_progress(result)
                    if result.success:
                        self._audit.record(
                            "run_finished",
                            success=True,
                            attempts=len(results),
                            seat_num=result.plan.seat_num,
                            verified=result.verified,
                        )
                        self.notifier.send("预约成功！", self._format_success(result), success=True)
                        return results

                    waiting_for_window = bool(
                        result.raw_response and is_time_out_of_range(result.raw_response),
                    )
                    if waiting_for_window:
                        self._audit.record(
                            "retry_decision",
                            plan_id=plan.plan_id,
                            seat_num=seat_num,
                            attempt=attempt + 1,
                            action=RetryDecision.CONTINUE,
                            reason="预约窗口尚未开放，等待后重试",
                        )
                        if window_deadline is None:
                            window_deadline = time.monotonic() + self.settings.window_wait_seconds
                        if self._is_cancelled() or time.monotonic() >= window_deadline:
                            break
                        time.sleep(self.settings.window_poll_interval)
                        continue

                    decision = (
                        default_retry_decider(result.raw_response)
                        if result.raw_response
                        else RetryDecision(RetryDecision.CONTINUE, "网络/传输失败，继续重试")
                    )
                    result.retry_reason = decision.reason
                    self._audit.record(
                        "retry_decision",
                        plan_id=plan.plan_id,
                        seat_num=seat_num,
                        attempt=attempt + 1,
                        action=decision.action,
                        reason=decision.reason,
                    )
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
                if self._is_cancelled():
                    break
                if len(plan.seat_candidates) > 1 and seat_num != plan.seat_candidates[-1]:
                    self._audit.record(
                        "fallback_switch",
                        plan_id=plan.plan_id,
                        failed_seat=seat_num,
                        next_seat=plan.seat_candidates[plan.seat_candidates.index(seat_num) + 1],
                    )

        if results:
            last = results[-1]
            self.notifier.send(
                "预约失败",
                f"已尝试 {len(plans)} 个方案，共 {len(results)} 次请求，均未成功。\n"
                f"最后错误: {last.message}",
                success=False,
            )
            self._audit.record(
                "run_finished",
                success=False,
                attempts=len(results),
                last_error=last.message,
            )
        return results

    def _prewarm_plans(self, plans: list[BookingPlan]) -> None:
        """提前解析预约所需数据，把目标时刻留给 bookSeats 请求本身。"""
        self._prewarmed_seats.clear()
        try:
            self._prewarmed_uid = self.client.resolve_uid()
        except AuthenticationExpiredError:
            raise
        except HduLibraryError as exc:
            self._prewarmed_uid = ""
            self._audit.record("prewarm_error", scope="uid", error=str(exc))
        for plan in plans:
            try:
                floors = self.rooms.get_floors_for_booking(plan)
            except AuthenticationExpiredError:
                raise
            except HduLibraryError as exc:
                self._audit.record(
                    "prewarm_error",
                    scope="seats",
                    plan_id=plan.plan_id,
                    error=str(exc),
                )
                continue
            for seat_num in plan.seat_candidates:
                candidate = plan if seat_num == plan.seat_num else plan.__class__(
                    **{**plan.to_dict(), "seat_num": seat_num}
                )
                try:
                    _, seat = self.rooms.find_seat(floors, candidate.floor_id, seat_num)
                except (AuthenticationExpiredError, HduLibraryError) as exc:
                    if isinstance(exc, AuthenticationExpiredError):
                        raise
                    self._audit.record(
                        "prewarm_error",
                        scope="seat",
                        plan_id=plan.plan_id,
                        seat_num=seat_num,
                        error=str(exc),
                    )
                    continue
                self._prewarmed_seats[(candidate.to_plan_code(), seat_num)] = seat
        self._audit.record(
            "prewarm_completed",
            plans=len(plans),
            seats=len(self._prewarmed_seats),
            uid_ready=bool(self._prewarmed_uid),
        )

    def _wait_until_execute_at(self, execute_at, plans: list[BookingPlan]) -> None:
        """等待到统一的毫秒级目标时刻，目标前 5 秒进入预热阶段。"""
        target = parse_execute_at(execute_at)
        prewarm_at = target - 5.0
        while time.time() < prewarm_at:
            if self._is_cancelled():
                return
            time.sleep(min(prewarm_at - time.time(), 0.25))
        self._audit.record(
            "prewarm",
            execute_at=datetime.fromtimestamp(target, UTC).isoformat(timespec="milliseconds"),
            prewarm_seconds=5,
        )
        self._prewarm_plans(plans)
        while time.time() < target:
            if self._is_cancelled():
                return
            remaining = target - time.time()
            if remaining > 0.003:
                time.sleep(remaining - 0.002)
        actual = time.time()
        self._audit.record(
            "execute_at_reached",
            execute_at=datetime.fromtimestamp(target, UTC).isoformat(timespec="milliseconds"),
            drift_ms=round((actual - target) * 1000, 3),
        )

    def run_now(
        self,
        plans: list[BookingPlan],
        on_progress: Callable[[BookingResult], None] | None = None,
        execute_at=None,
    ) -> list[BookingResult]:
        self._begin()
        try:
            if execute_at is not None:
                self._wait_until_execute_at(execute_at, plans)
            return self._execute_plans(plans, on_progress)
        finally:
            self._prewarmed_seats.clear()
            self._prewarmed_uid = ""
            self._finish()

    def run_once(self, execute_at=None) -> int:
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
            if execute_at is None:
                results = self.run_now(plans, on_progress=on_progress)
            else:
                results = self.run_now(
                    plans,
                    on_progress=on_progress,
                    execute_at=execute_at,
                )
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
