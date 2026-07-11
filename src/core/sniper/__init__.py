"""抢座尝试引擎包：方案模型、持久化、重试决策与预约尝试循环。"""

from core.sniper.plan import BookingPlan, PlanStatus
from core.sniper.repository import PlanRepository
from core.sniper.retry import (
    BookingResult,
    RetryDecision,
    booking_failed,
    default_retry_decider,
    is_time_out_of_range,
)
from core.sniper.sniper import Sniper


__all__ = [
    "BookingPlan",
    "BookingResult",
    "PlanRepository",
    "PlanStatus",
    "RetryDecision",
    "Sniper",
    "booking_failed",
    "default_retry_decider",
    "is_time_out_of_range",
]
