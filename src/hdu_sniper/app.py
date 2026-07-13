"""统一应用门面：Flet、API 和后台入口只依赖这一层。"""

from __future__ import annotations

import contextlib
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from threading import RLock

from hdu_sniper.booking.models import BookingPlan, BookingResult
from hdu_sniper.booking.plans import BookingPlans
from hdu_sniper.booking.runner import BookingRunner
from hdu_sniper.config import Credentials, Settings, load_credentials, save_credentials
from hdu_sniper.events import ApplicationEvent, EventKind, JobState
from hdu_sniper.library.client import AuthenticationExpiredError, LibraryClient
from hdu_sniper.library.login import LibraryLogin
from hdu_sniper.library.rooms import FloorInfo
from hdu_sniper.notifier import Notifier
from hdu_sniper.scheduler import SchedulerService, TaskStatus


EventHandler = Callable[[ApplicationEvent], None]


class AuthenticationRequiredError(PermissionError):
    """当前操作要求有效的图书馆认证状态。"""


@dataclass(frozen=True)
class DailySchedulerActivation:
    """创建方案时固定每日调度的配置结果。"""

    success: bool
    already_existed: bool
    message: str


class SniperApp:
    """线程安全的应用用例门面，不暴露 UI 框架或工作线程类型。"""

    def __init__(
        self,
        settings: Settings,
        client: LibraryClient,
        plans: BookingPlans,
        notifier: Notifier,
        *,
        login: LibraryLogin | None = None,
        booking: BookingRunner | None = None,
        scheduler: SchedulerService | None = None,
    ) -> None:
        self.settings = settings
        self.client = client
        self.plans = plans
        self.notifier = notifier
        self.login = login or LibraryLogin(client, settings)
        self.booking = booking or BookingRunner(
            settings,
            client,
            plans,
            notifier,
            rooms=plans.rooms,
            login=self.login,
        )
        self.scheduler = scheduler or SchedulerService(settings.paths)

        self._lock = RLock()
        self._state = JobState.IDLE
        self._authenticated = False
        self._subscribers: dict[str, EventHandler] = {}

    @property
    def state(self) -> JobState:
        with self._lock:
            return self._state

    @property
    def authenticated(self) -> bool:
        with self._lock:
            return self._authenticated

    @property
    def busy(self) -> bool:
        return self.state in {
            JobState.AUTHENTICATING,
            JobState.RUNNING,
            JobState.CANCELLING,
        }

    def subscribe(self, handler: EventHandler) -> Callable[[], None]:
        """订阅应用事件，返回幂等的取消订阅函数。"""
        token = uuid.uuid4().hex
        with self._lock:
            self._subscribers[token] = handler

        def unsubscribe() -> None:
            with self._lock:
                self._subscribers.pop(token, None)

        return unsubscribe

    def _publish(
        self,
        kind: EventKind,
        message: str = "",
        payload: dict | None = None,
    ) -> None:
        with self._lock:
            handlers = list(self._subscribers.values())
            state = self._state
        event = ApplicationEvent(kind, state, message, payload or {})
        for handler in handlers:
            with contextlib.suppress(Exception):
                handler(event)

    def _set_state(self, state: JobState, message: str = "") -> None:
        with self._lock:
            self._state = state
        self._publish(EventKind.STATE, message)

    def try_cached_authentication(self) -> bool:
        authenticated = self.login.try_cache()
        with self._lock:
            self._authenticated = authenticated
        self._publish(
            EventKind.AUTH,
            "已恢复缓存登录态" if authenticated else "未找到可用登录态",
            {"authenticated": authenticated},
        )
        if authenticated:
            self._ensure_daily_scheduler()
        return authenticated

    def saved_credentials(self) -> Credentials | None:
        return load_credentials(self.settings.paths.credentials_file)

    def _require_authenticated(self) -> None:
        if not self.authenticated:
            raise AuthenticationRequiredError("请先完成认证")

    def _expire_authentication(self, message: str = "登录状态已失效，请重新认证") -> None:
        with self._lock:
            self._authenticated = False
        self._set_state(JobState.IDLE, message)
        self._publish(EventKind.AUTH_REQUIRED, message, {"authenticated": False})

    def _authenticated_call(self, operation, *args, **kwargs):
        self._require_authenticated()
        try:
            return operation(*args, **kwargs)
        except AuthenticationExpiredError as exc:
            self._expire_authentication()
            raise AuthenticationRequiredError("登录状态已失效，请重新认证") from exc

    def authenticate(self, student_id: str, password: str) -> tuple[bool, str]:
        if self.busy:
            return False, "已有任务正在运行"
        was_authenticated = self.authenticated
        self._set_state(JobState.AUTHENTICATING, "正在认证")
        try:
            success, message = self.login.login_with_credentials(student_id, password)
            if success:
                save_credentials(
                    self.settings.paths.credentials_file,
                    Credentials(student_id=student_id, password=password),
                )
                self._ensure_daily_scheduler()
            with self._lock:
                self._authenticated = success or was_authenticated
                authenticated = self._authenticated
            self._publish(EventKind.AUTH, message, {"authenticated": authenticated})
            self._set_state(JobState.IDLE if authenticated else JobState.FAILED, message)
            return success, message
        except Exception as exc:
            message = f"认证过程出错: {exc}"
            self._set_state(JobState.IDLE if self.authenticated else JobState.FAILED, message)
            self._publish(EventKind.ERROR, message)
            return False, message

    def list_plans(self) -> list[BookingPlan]:
        return self._authenticated_call(self.plans.list_all)

    def list_enabled_plans(self) -> list[BookingPlan]:
        return self._authenticated_call(self.plans.list_enabled)

    def list_room_types(self) -> list[dict]:
        return self._authenticated_call(self.plans.list_room_types)

    def list_floors(self, room_query: str) -> list[FloorInfo]:
        return self._authenticated_call(self.plans.list_floors, room_query)

    def create_plan(
        self, **values
    ) -> tuple[BookingPlan, list[str], bool, DailySchedulerActivation | None]:
        result = self._authenticated_call(self.plans.create, **values)
        if result[1]:
            return *result, None
        try:
            already_existed = self.scheduler.get_task_status().exists
        except Exception:
            already_existed = False
        success, message = self._configure_daily_scheduler()
        activation = DailySchedulerActivation(success, already_existed, message)
        return *result, activation

    def delete_plans(self, plan_ids: list[str]) -> int:
        return self._authenticated_call(self.plans.delete, plan_ids)

    def modify_plan_times(self, plan_ids: list[str], **values) -> int:
        return self._authenticated_call(self.plans.update_times, plan_ids, **values)

    def run_booking(self) -> list[BookingResult]:
        self._require_authenticated()
        if self.busy:
            raise RuntimeError("已有任务正在运行")
        plans = self.list_enabled_plans()
        if not plans:
            raise ValueError("没有启用的预约方案")

        self._set_state(JobState.RUNNING)

        def on_progress(result: BookingResult) -> None:
            self._publish(
                EventKind.PROGRESS,
                result.message,
                {
                    "success": result.success,
                    "plan_id": result.plan.plan_id,
                    "plan_code": result.plan.to_plan_code(),
                    "seat_num": result.plan.seat_num,
                },
            )

        try:
            results = self.booking.run_now(plans, on_progress=on_progress)
        except AuthenticationExpiredError as exc:
            self._expire_authentication()
            raise AuthenticationRequiredError("登录状态已失效，请重新认证") from exc
        except Exception as exc:
            message = f"抢座任务出错: {exc}"
            self._set_state(JobState.FAILED, message)
            self._publish(EventKind.ERROR, message)
            raise

        if self.state == JobState.CANCELLING:
            final_state = JobState.CANCELLED
        else:
            final_state = (
                JobState.SUCCEEDED if any(item.success for item in results) else JobState.FAILED
            )
        message = "预约成功" if final_state == JobState.SUCCEEDED else "任务已结束"
        self._set_state(final_state, message)
        self._publish(
            EventKind.RESULT,
            message,
            {"success": final_state == JobState.SUCCEEDED, "attempts": len(results)},
        )
        return results

    def cancel_booking(self) -> bool:
        if self.state != JobState.RUNNING:
            return False
        self._set_state(JobState.CANCELLING, "正在取消任务")
        return self.booking.cancel()

    def scheduler_status(self) -> TaskStatus:
        """返回固定每日任务的只读状态，不暴露调度配置。"""
        self._require_authenticated()
        return self.scheduler.get_task_status()

    def repair_daily_scheduler(self) -> tuple[bool, str]:
        """检查前置条件并重新确保每日 20:00 系统任务。"""
        self._require_authenticated()
        if not self.plans.list_enabled():
            return False, "请先创建并启用至少一个预约方案"
        return self._configure_daily_scheduler()

    def _ensure_daily_scheduler(self) -> None:
        """有效方案存在时，静默确保每天 20:00 的系统任务。"""
        if not self.plans.list_enabled():
            return
        self._configure_daily_scheduler()

    def _configure_daily_scheduler(self) -> tuple[bool, str]:
        try:
            success, message = self.scheduler.configure_task()
        except Exception as exc:
            message = str(exc)
            self.notifier.send("自动调度配置失败", message, success=False)
            return False, message
        if not success:
            self.notifier.send("自动调度配置失败", message, success=False)
        return success, message
