"""应用编排层：运行时装配、认证、抢座与方案编排入口。

领域类型（HduLibraryError / BookingPlan / BookingResult / PlanStatus）在此透传，
使 CLI / 视图层只依赖 services 单一入口，不再直连 core 的编排符号——core 可独立
演进而不波及交互层。
"""

from core.client import HduLibraryError
from core.sniper import BookingPlan, BookingResult, PlanRepository, PlanStatus
from services.auth import AuthService
from services.booking import BookingService
from services.browser_auth import BrowserAuthService
from services.plans import PlanService
from services.runtime import build_runtime

__all__ = [
    "AuthService",
    "BookingService",
    "BrowserAuthService",
    "PlanService",
    "build_runtime",
    "HduLibraryError",
    "BookingPlan",
    "BookingResult",
    "PlanStatus",
    "PlanRepository",
]
