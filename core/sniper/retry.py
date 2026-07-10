"""预约结果判定与重试决策。"""

from __future__ import annotations

from typing import Any

from core import contract
from core.sniper.plan import BookingPlan


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
    return contract.MSG_TIME_OUT_OF_RANGE in _extract_message(result)


def default_retry_decider(result: dict[str, Any]) -> RetryDecision:
    """根据服务器错误消息决定继续重试 / 跳过方案 / 停止全部。

    用 MESSAGE 子串匹配(非 CODE 判定):契约验证 CODE=ParamError 被
    time_out_of_range / duplicate / seat_unavailable 共用,只能靠 MESSAGE 区分。
    ``MSG_*`` 常量已实抓验证(见 docs/contracts/00_overview.md 与
    samples/book_seats.json)，运行期单一源在 ``core.contract``。
    """
    message = _extract_message(result)
    if contract.MSG_TIME_OUT_OF_RANGE in message:
        return RetryDecision(RetryDecision.CONTINUE, "预约窗口尚未开放，等待后重试")
    if contract.MSG_DUPLICATE in message:
        return RetryDecision(RetryDecision.SKIP, "已有预约，无需重复")
    if contract.MSG_SEAT_UNAVAILABLE in message:
        return RetryDecision(RetryDecision.SKIP, "座位不可用，换下一个方案")
    if contract.MSG_INVALID_REQUEST in message:
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
