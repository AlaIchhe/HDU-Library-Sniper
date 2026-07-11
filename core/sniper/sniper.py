"""抢座尝试引擎：重试循环 / 窗口轮询 / 指数退避 / 超时幂等确认调度。

房间与座位解析由 RoomBrowser 承担，HTTP 传输与今日预约归一化由 LibraryClient
承担；本模块只管"对一组方案依次尝试、按服务器反馈决定继续 / 跳过 / 停止"的循环。
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from datetime import datetime

from core import contract
from core.client import HduLibraryError, LibraryClient
from core.room_browser import RoomBrowser
from core.sniper.plan import BookingPlan
from core.sniper.retry import (
    BookingResult,
    RetryDecision,
    _extract_message,
    booking_failed,
    default_retry_decider,
    is_time_out_of_range,
)
from utils.notifier import Notifier
from utils.time_sync import build_begin_time, now_cst


class Sniper:
    """抢座尝试引擎：重试循环 / 窗口轮询 / 指数退避 / 超时幂等确认调度。"""

    def __init__(
        self,
        client: LibraryClient,
        notifier: Notifier,
        room_browser: RoomBrowser,
        max_trials: int = 5,
        retry_delay: float = 1.0,
        dry_run: bool = False,
        window_wait_seconds: float = 30.0,
        window_poll_interval: float = 1.0,
    ) -> None:
        self.client = client
        self.notifier = notifier
        self.room_browser = room_browser
        self.max_trials = max_trials
        self.retry_delay = retry_delay
        self.dry_run = dry_run
        # "预约窗口未开放"用独立的固定间隔轮询预算，不占用 max_trials 的指数退避次数。
        # 场景：定时任务卡在整点发起请求，服务器实际开闸比预期晚几秒。
        self.window_wait_seconds = window_wait_seconds
        self.window_poll_interval = window_poll_interval
        self.cancelled = False

    def book_single(self, plan: BookingPlan) -> BookingResult:
        """执行单个方案的一次预约尝试。"""
        try:
            floors = self.room_browser.get_floors_for_booking(plan)
        except HduLibraryError as exc:
            return BookingResult(plan, False, f"房间/座位查询失败: {exc}")

        try:
            _, seat = self.room_browser.find_seat(floors, plan.floor_id, plan.seat_num)
        except HduLibraryError as exc:
            return BookingResult(plan, False, f"座位定位失败: {exc}")

        seat_id = contract.seat_id(seat)
        uid = self.client.resolve_uid()
        begin_time = build_begin_time(plan.start_hour, plan.book_days)

        try:
            result = self.client.book_seat(
                seat_id, uid, begin_time, plan.duration_hours, dry_run=self.dry_run
            )
        except HduLibraryError as exc:
            # 读/连超时 ≠ 预约失败。服务器很可能已处理请求只是响应缓慢。
            # 去服务端查询今日预约做幂等确认，避免重复请求并正确报告结果。
            if exc.is_timeout:
                confirmed = self.client.find_confirmed_booking(int(begin_time.timestamp()))
                if confirmed:
                    return BookingResult(plan, True, "预约成功（响应超时，已服务端确认）")
            return BookingResult(plan, False, f"预约请求失败: {exc}")

        if self.dry_run:
            return BookingResult(plan, True, f"[预览模式] 参数已就绪: {result}", result)

        if booking_failed(result):
            return BookingResult(
                plan, False, _extract_message(result) or "预约接口返回失败", result
            )

        return BookingResult(plan, True, _extract_message(result) or "预约成功", result)

    def _backoff_delay(self, attempt: int) -> float:
        delay = self.retry_delay * (2 ** (attempt - 1))
        return max(random.uniform(0, delay), 0.1)

    def book_all(
        self,
        plans: list[BookingPlan],
        on_progress: Callable[[BookingResult], None] | None = None,
    ) -> list[BookingResult]:
        """依次尝试方案列表，任一成功即停止。"""
        results: list[BookingResult] = []

        for plan in plans:
            if self.cancelled:
                break

            attempt = 0
            window_deadline: float | None = None  # 首次遇到"窗口未开放"时启动的墙钟截止时间

            while attempt < self.max_trials:
                if self.cancelled:
                    break

                result = self.book_single(plan)
                results.append(result)
                if on_progress:
                    on_progress(result)

                if result.success:
                    self.notifier.send("预约成功！", self._format_success(result), success=True)
                    return results

                waiting_for_window = bool(
                    result.raw_response and is_time_out_of_range(result.raw_response)
                )

                if waiting_for_window:
                    # 预约窗口尚未开放：不占用 max_trials 指数退避预算，
                    # 按固定短间隔轮询，直到窗口开放或等待超时。
                    if window_deadline is None:
                        window_deadline = time.monotonic() + self.window_wait_seconds
                    if self.cancelled or time.monotonic() >= window_deadline:
                        break
                    time.sleep(self.window_poll_interval)
                    continue

                if result.raw_response:
                    decision = default_retry_decider(result.raw_response)
                    if decision.action == RetryDecision.STOP:
                        self.notifier.send(
                            "预约中止", f"服务器返回: {decision.reason}", success=False
                        )
                        return results
                    if decision.action == RetryDecision.SKIP:
                        break

                attempt += 1
                if attempt < self.max_trials:
                    time.sleep(self._backoff_delay(attempt))

        if results:
            last = results[-1]
            self.notifier.send(
                "预约失败",
                f"已尝试 {len(plans)} 个方案，共 {len(results)} 次请求，均未成功。\n最后错误: {last.message}",
                success=False,
            )
        return results

    def book_at(
        self,
        plans: list[BookingPlan],
        execute_at: datetime,
        on_countdown: Callable[[int], None] | None = None,
        on_progress: Callable[[BookingResult], None] | None = None,
    ) -> list[BookingResult]:
        """等待至指定时间后执行预约，期间可通过 self.cancelled 取消。"""
        now = now_cst()
        if execute_at.tzinfo is None:
            execute_at = execute_at.replace(tzinfo=now.tzinfo)
        wait_seconds = (execute_at - now).total_seconds()

        while wait_seconds > 0:
            if self.cancelled:
                return []
            if on_countdown:
                on_countdown(int(wait_seconds))
            sleep_for = min(1.0, wait_seconds)
            time.sleep(sleep_for)
            wait_seconds -= sleep_for

        return self.book_all(plans, on_progress=on_progress)

    @staticmethod
    def _format_success(result: BookingResult) -> str:
        plan = result.plan
        return "\n".join(
            [
                f"方案: {plan.to_plan_code()}",
                f"座位号: {plan.seat_num}",
                f"预约人: {plan.booker_name or '(未设置)'}",
                f"开始时间: {build_begin_time(plan.start_hour, plan.book_days).isoformat()}",
                f"时长: {plan.duration_hours} 小时",
                f"服务器响应: {result.message}",
            ]
        )
