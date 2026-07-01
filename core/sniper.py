"""预约方案模型、YAML 持久化、通知与抢座编排。"""

from __future__ import annotations

import random
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests
import yaml

from core.client import (
    MSG_DUPLICATE,
    MSG_INVALID_REQUEST,
    MSG_SEAT_UNAVAILABLE,
    MSG_TIME_OUT_OF_RANGE,
    ROOM_TYPE_MAP,
    HduLibraryError,
    LibraryClient,
)
from utils.time_sync import build_begin_time, now_cst


# ======================================================================
# 预约方案模型
# ======================================================================
class PlanStatus:
    ENABLED = "enabled"
    DISABLED = "disabled"


@dataclass
class BookingPlan:
    """一次预约的完整参数集合。"""

    room_type: int
    floor_id: int
    seat_num: str
    start_hour: int
    duration_hours: int
    booker_name: str = ""
    book_days: int = 0
    status: str = PlanStatus.ENABLED
    room_query: str = ""
    plan_id: str | None = None
    created_at: str | None = None

    def validate(self) -> list[str]:
        """校验方案参数，返回错误列表（空列表表示通过）。"""
        errors = []
        if self.room_type not in (1, 2, 3, 4):
            errors.append(f"无效的房间类型：{self.room_type}")
        if self.floor_id <= 0:
            errors.append(f"无效的楼层 ID：{self.floor_id}")
        if not str(self.seat_num).strip():
            errors.append("座位号不能为空")
        if not (0 <= self.start_hour <= 23):
            errors.append(f"开始小时超出范围：{self.start_hour}")
        if self.duration_hours <= 0:
            errors.append(f"时长必须为正数：{self.duration_hours}")
        if self.book_days < 0:
            errors.append(f"天数偏移不能为负：{self.book_days}")
        return errors

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BookingPlan":
        known = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)

    def to_plan_code(self) -> str:
        return f"{self.room_type}:{self.floor_id}:{self.seat_num}:{self.start_hour}:{self.duration_hours}"


# ======================================================================
# YAML 方案持久化
# ======================================================================
class PlanRepository:
    """基于 YAML 文件的方案存储。"""

    def __init__(self, file_path: str) -> None:
        self._file = Path(file_path)
        self._cache: list[BookingPlan] | None = None

    def load_all(self) -> list[BookingPlan]:
        if self._cache is not None:
            return list(self._cache)
        if not self._file.exists():
            self._cache = []
            return []
        raw_text = self._file.read_text(encoding="utf-8").strip()
        data = yaml.safe_load(raw_text) if raw_text else None
        if not isinstance(data, list):
            self._cache = []
            return []
        plans = []
        for item in data:
            if isinstance(item, dict):
                plans.append(BookingPlan.from_dict(item))
        self._cache = plans
        return list(plans)

    def save_all(self, plans: list[BookingPlan]) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        raw = [p.to_dict() for p in plans]
        self._file.write_text(
            yaml.dump(raw, allow_unicode=True, encoding="utf-8").decode("utf-8"),
            encoding="utf-8",
        )
        self._cache = list(plans)

    def add(self, plan: BookingPlan) -> None:
        plans = self.load_all()
        if not plan.plan_id:
            plan.plan_id = uuid.uuid4().hex[:12]
        if not plan.created_at:
            plan.created_at = datetime.now(timezone.utc).isoformat()
        plans.append(plan)
        self.save_all(plans)

    def remove_many(self, plan_ids: list[str]) -> int:
        plans = self.load_all()
        before = len(plans)
        plans = [p for p in plans if p.plan_id not in plan_ids]
        removed = before - len(plans)
        if removed:
            self.save_all(plans)
        return removed

    def batch_set_time(
        self,
        plan_ids: list[str],
        start_hour: int | None = None,
        duration_hours: int | None = None,
        book_days: int | None = None,
    ) -> int:
        plans = self.load_all()
        modified = 0
        for p in plans:
            if p.plan_id in plan_ids:
                if start_hour is not None:
                    p.start_hour = start_hour
                if duration_hours is not None:
                    p.duration_hours = duration_hours
                if book_days is not None:
                    p.book_days = book_days
                modified += 1
        if modified:
            self.save_all(plans)
        return modified

    def list_enabled(self) -> list[BookingPlan]:
        return [p for p in self.load_all() if p.status == PlanStatus.ENABLED]


# ======================================================================
# 通知
# ======================================================================
class Notifier:
    """控制台 + 日志文件 + 微信 webhook 三合一通知。"""

    GREEN = "\033[92m"
    RED = "\033[91m"
    BOLD = "\033[1m"
    RESET = "\033[0m"

    def __init__(self, log_file: str = "logs/booking.log", wechat_webhook: str = "") -> None:
        self.log_file = log_file
        self.wechat_webhook = wechat_webhook

    def send(self, title: str, body: str, success: bool = True) -> None:
        color = self.GREEN if success else self.RED
        print(f"\n{color}{self.BOLD}== {title} =={self.RESET}")
        print(f"{color}{body}{self.RESET}\n")

        try:
            path = Path(self.log_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            status = "SUCCESS" if success else "FAILED"
            with path.open("a", encoding="utf-8") as f:
                f.write(f"[{datetime.now().isoformat()}] [{status}] {title}\n")
                f.write(f"  {body}\n")
                f.write("-" * 50 + "\n")
        except OSError:
            pass

        if self.wechat_webhook:
            try:
                requests.post(
                    self.wechat_webhook,
                    json={"title": title, "content": body},
                    timeout=10,
                )
            except requests.RequestException:
                pass


# ======================================================================
# 重试决策
# ======================================================================
class RetryDecision:
    CONTINUE = "continue"
    SKIP = "skip"
    STOP = "stop"

    def __init__(self, action: str, reason: str) -> None:
        self.action = action
        self.reason = reason


def _extract_message(result: dict[str, Any]) -> str:
    data = result.get("DATA")
    data = data if isinstance(data, dict) else {}
    return str(result.get("MESSAGE") or data.get("msg") or "")


def booking_failed(result: Any) -> bool:
    """判定预约是否失败。

    采用"默认失败"策略：只有服务器明确返回 CODE="ok" 才算成功，
    任何其它值（包括未知/未预料到的错误码，如限流提示）都视为失败。
    绝不能反过来用"未命中已知失败关键词就算成功"的白名单排除法——
    那样遇到服务器返回一个没见过的错误码时，会被误判为预约成功。
    """
    if not isinstance(result, dict):
        return True
    data = result.get("DATA")
    data = data if isinstance(data, dict) else {}
    code = str(result.get("CODE") or "").strip().lower()
    status = str(data.get("result") or "").strip().lower()
    if status == "fail":
        return True
    return code != "ok"


def is_time_out_of_range(result: dict[str, Any]) -> bool:
    """判断预约失败是否为"预约窗口尚未开放"（超出可预约座位时间范围）。"""
    return MSG_TIME_OUT_OF_RANGE in _extract_message(result)


def default_retry_decider(result: dict[str, Any]) -> RetryDecision:
    """根据服务器错误消息决定继续重试 / 跳过方案 / 停止全部。"""
    message = _extract_message(result)
    if MSG_TIME_OUT_OF_RANGE in message:
        return RetryDecision(RetryDecision.CONTINUE, "预约窗口尚未开放，等待后重试")
    if MSG_DUPLICATE in message:
        return RetryDecision(RetryDecision.SKIP, "已有预约，无需重复")
    if MSG_SEAT_UNAVAILABLE in message:
        return RetryDecision(RetryDecision.SKIP, "座位不可用，换下一个方案")
    if MSG_INVALID_REQUEST in message:
        return RetryDecision(RetryDecision.STOP, "非法请求 — 请检查系统更新")
    if booking_failed(result):
        return RetryDecision(RetryDecision.SKIP, message or "预约接口返回失败")
    return RetryDecision(RetryDecision.CONTINUE, "")


class BookingResult:
    def __init__(
        self,
        plan: BookingPlan,
        success: bool = False,
        message: str = "",
        raw_response: dict[str, Any] | None = None,
    ) -> None:
        self.plan = plan
        self.success = success
        self.message = message
        self.raw_response = raw_response


# ======================================================================
# 抢座编排器
# ======================================================================
class Sniper:
    """预约编排：房间解析 -> 座位定位 -> 提交 -> 智能重试。"""

    def __init__(
        self,
        client: LibraryClient,
        notifier: Notifier,
        max_trials: int = 5,
        retry_delay: float = 1.0,
        dry_run: bool = False,
        window_wait_seconds: float = 30.0,
        window_poll_interval: float = 1.0,
    ) -> None:
        self.client = client
        self.notifier = notifier
        self.max_trials = max_trials
        self.retry_delay = retry_delay
        self.dry_run = dry_run
        # "预约窗口未开放"用独立的固定间隔轮询预算，不占用 max_trials 的指数退避次数。
        # 场景：定时任务卡在整点发起请求，服务器实际开闸比预期晚几秒。
        self.window_wait_seconds = window_wait_seconds
        self.window_poll_interval = window_poll_interval
        self.cancelled = False

    def _resolve_floors(self, plan: BookingPlan) -> list[dict[str, Any]]:
        """定位方案对应的楼层座位数据。"""
        if plan.room_query:
            detail = self.client.get_room_detail(plan.room_query)
        else:
            room_types = self.client.get_room_types()
            target_name = ROOM_TYPE_MAP.get(str(plan.room_type), "")
            matched = [r for r in room_types if r.get("name") == target_name]
            if not matched:
                if not room_types:
                    raise HduLibraryError("无可用房间类型")
                available = ", ".join(r.get("name", "?") for r in room_types)
                raise HduLibraryError(f"未找到匹配的房间类型: 期望 '{target_name}', 可用: [{available}]")
            plan.room_query = str(matched[0]["query"])
            detail = self.client.get_room_detail(plan.room_query)

        space = detail["space_category"]
        cat_id = str(space["category_id"])
        con_id = str(space["content_id"])
        begin_time = build_begin_time(plan.start_hour, plan.book_days)
        return self.client.get_seat_map(cat_id, con_id, begin_time, plan.duration_hours)

    def book_single(self, plan: BookingPlan) -> BookingResult:
        """执行单个方案的一次预约尝试。"""
        try:
            floors = self._resolve_floors(plan)
        except HduLibraryError as exc:
            return BookingResult(plan, False, f"房间/座位查询失败: {exc}")

        try:
            _, seat = self.client.find_seat_in_floors(floors, plan.floor_id, plan.seat_num)
        except HduLibraryError as exc:
            return BookingResult(plan, False, f"座位定位失败: {exc}")

        seat_id = str(seat["id"])
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
                confirmed = self._idempotent_confirm(plan, seat_id, begin_time)
                if confirmed:
                    return BookingResult(
                        plan, True, "预约成功（响应超时，已服务端确认）"
                    )
            return BookingResult(plan, False, f"预约请求失败: {exc}")

        if self.dry_run:
            return BookingResult(plan, True, f"[预览模式] 参数已就绪: {result}", result)

        if booking_failed(result):
            return BookingResult(plan, False, _extract_message(result) or "预约接口返回失败", result)

        return BookingResult(plan, True, _extract_message(result) or "预约成功", result)

    def _idempotent_confirm(
        self, plan: BookingPlan, seat_id: str, begin_time: Any
    ) -> bool:
        """预约请求超时后，查询今日预约列表做幂等确认。

        返回 True 表示服务端已存在匹配的预约，调用方应视为本次成功。
        任何查询异常都保守返回 False，让调用方按原逻辑重试。
        """
        try:
            bookings = self.client.get_todays_bookings()
        except Exception:
            return False

        if not bookings:
            return False

        begin_ts = int(begin_time.timestamp())
        seat_id_str = str(seat_id)
        for item in bookings:
            if not isinstance(item, dict):
                continue
            item_seat = str(
                item.get("seat_id")
                or item.get("seatId")
                or item.get("seat_id2")
                or (item.get("seat", {}) or {}).get("id", "")
                if isinstance(item.get("seat"), dict) else
                item.get("seat_id") or item.get("seatId") or ""
            )
            item_begin = item.get("beginTime") or item.get("begin_time") or item.get("begin_ts") or 0
            try:
                item_begin_ts = int(item_begin)
            except (TypeError, ValueError):
                continue
            # 同一座位 + 开始时间相差不超过 1 秒即视为同一预约
            if item_seat == seat_id_str and abs(item_begin_ts - begin_ts) <= 1:
                return True
        return False

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
