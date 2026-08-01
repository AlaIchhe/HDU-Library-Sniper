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
from hdu_sniper.library import responses
from hdu_sniper.library.client import AuthenticationExpiredError, LibraryClient
from hdu_sniper.library.login import LibraryLogin
from hdu_sniper.library.rooms import FloorInfo
from hdu_sniper.notifier import Notifier
from hdu_sniper.schedule_policy import SchedulePolicy
from hdu_sniper.scheduler import ScheduledTask, SchedulerService, TaskStatus


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

    def run_booking(self, execute_at=None) -> list[BookingResult]:
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
                    "verified": result.verified,
                    "elapsed_ms": result.elapsed_ms,
                },
            )

        try:
            if execute_at is None:
                results = self.booking.run_now(plans, on_progress=on_progress)
            else:
                results = self.booking.run_now(
                    plans,
                    on_progress=on_progress,
                    execute_at=execute_at,
                )
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

    def list_bookings(self) -> list[dict]:
        """查询图书馆账户的座位预约记录。"""
        return self._authenticated_call(self.client.get_bookings)

    def get_booking_status(self, booking_id: str | int) -> dict:
        """查询单条预约的服务端状态，不改变预约。"""
        return self._authenticated_call(self.client.get_booking_status, booking_id)

    def get_latest_comeback_time(self, booking_id: str | int) -> dict:
        """查询暂离预约允许返回座位的最晚时间，不改变预约。"""
        return self._authenticated_call(self.client.get_latest_comeback_time, booking_id)

    def cancel_remote_booking(self, booking_id: str | int) -> tuple[bool, str]:
        """取消一条远端待签到预约，而非取消本地抢座任务。"""
        if self.busy:
            return False, "当前任务正在运行，请在任务结束后再取消预约"
        item = self._find_booking(booking_id)
        status = responses.booking_status(item)
        if status not in {
            responses.BOOKING_STATUS_PENDING,
            responses.BOOKING_STATUS_PENDING_CONFIRMATION,
        }:
            return False, f"当前预约状态为 {status or '未知'}，不能取消"
        response = self._authenticated_call(self.client.cancel_remote_booking, booking_id)
        return self._verified_booking_action(
            booking_id,
            response,
            expected_status=responses.BOOKING_STATUS_CANCELLED,
            success_message="预约已取消",
            failure_prefix="取消预约失败",
            missing_is_success=True,
        )

    def check_in_booking(self, booking_id: str | int) -> tuple[bool, str]:
        """签到当前账户中处于待签到状态的预约。"""
        return self._run_booking_action(
            booking_id,
            allowed_statuses={responses.BOOKING_STATUS_PENDING},
            allowed_item=responses.booking_is_check_in_available,
            unavailable_message="当前预约尚未进入可签到时间窗口",
            operation=self.client.check_in_booking,
            expected_status=responses.BOOKING_STATUS_IN_USE,
            action_name="签到",
            success_message="签到成功，座位使用中",
        )

    def come_back_booking(self, booking_id: str | int) -> tuple[bool, str]:
        """让当前账户中处于暂离状态的预约恢复为使用中。"""
        return self._run_booking_action(
            booking_id,
            allowed_statuses={responses.BOOKING_STATUS_AWAY},
            operation=self.client.come_back_booking,
            expected_status=responses.BOOKING_STATUS_IN_USE,
            action_name="返回座位",
            success_message="已返回座位，座位使用中",
        )

    def renew_booking(self, booking_id: str | int) -> tuple[bool, str]:
        """续座：从暂离状态恢复当前预约，完成后再次核实为使用中。"""
        return self._run_booking_action(
            booking_id,
            allowed_statuses={responses.BOOKING_STATUS_AWAY},
            operation=self.client.come_back_booking,
            expected_status=responses.BOOKING_STATUS_IN_USE,
            action_name="续座",
            success_message="续座成功，座位使用中",
        )

    def test_check_in(self, booking_id: str | int) -> tuple[bool, str]:
        """只测试指定预约是否满足签到条件，不发送签到请求。"""
        if self.busy:
            return False, "当前任务正在运行，请稍后再测试签到"
        item = self._find_booking(booking_id)
        status = responses.booking_status(item)
        if status != responses.BOOKING_STATUS_PENDING:
            return False, f"当前预约状态为 {status or '未知'}，不能签到"
        if not responses.booking_is_check_in_available(item):
            return False, "当前预约尚未进入可签到时间窗口"
        return True, "签到测试通过：当前已进入可签到时间窗口"

    def auto_check_in(self) -> list[dict[str, str | bool]]:
        """扫描当前预约并自动签到所有已经进入窗口的预约。"""
        if self.busy:
            return [{"success": False, "message": "当前任务正在运行，请稍后再自动签到"}]
        results: list[dict[str, str | bool]] = []
        for item in self._authenticated_call(self.client.get_bookings):
            booking_id = responses.booking_id(item)
            if not booking_id or not responses.booking_is_check_in_available(item):
                continue
            success, message = self.check_in_booking(booking_id)
            results.append({"id": booking_id, "success": success, "message": message})
        if not results:
            return [{"success": False, "message": "没有处于可签到窗口的预约"}]
        return results

    def check_in_test(self) -> list[dict[str, str | bool]]:
        """测试全部预约的签到条件，供界面一次性诊断。"""
        results: list[dict[str, str | bool]] = []
        for item in self._authenticated_call(self.client.get_bookings):
            booking_id = responses.booking_id(item)
            if not booking_id:
                continue
            success, message = self.test_check_in(booking_id)
            results.append({"id": booking_id, "success": success, "message": message})
        return results

    def leave_booking(self, booking_id: str | int) -> tuple[bool, str]:
        """让使用中的预约进入暂离状态。"""
        return self._run_booking_action(
            booking_id,
            allowed_statuses={responses.BOOKING_STATUS_IN_USE},
            operation=self.client.leave_booking,
            expected_status=responses.BOOKING_STATUS_AWAY,
            action_name="暂离",
            success_message="已暂离座位",
        )

    def sign_out_booking(self, booking_id: str | int) -> tuple[bool, str]:
        """结束使用中的预约。"""
        return self._run_booking_action(
            booking_id,
            allowed_statuses={responses.BOOKING_STATUS_IN_USE},
            operation=self.client.sign_out_booking,
            expected_status={
                responses.BOOKING_STATUS_FINISHED,
                responses.BOOKING_STATUS_SYSTEM_SIGNED_OUT,
            },
            action_name="签退",
            success_message="已签退，预约结束",
        )

    def _run_booking_action(
        self,
        booking_id: str | int,
        *,
        allowed_statuses: set[str],
        operation,
        expected_status: str | set[str],
        action_name: str,
        success_message: str,
        allowed_item=None,
        unavailable_message: str = "",
    ) -> tuple[bool, str]:
        if self.busy:
            return False, f"当前任务正在运行，请在任务结束后再{action_name}"
        item = self._find_booking(booking_id)
        status = responses.booking_status(item)
        if status not in allowed_statuses:
            if status == responses.BOOKING_STATUS_AWAY_EXPIRED:
                return False, "该预约已因暂离未归结束，服务器不允许恢复"
            return False, f"当前预约状态为 {status or '未知'}，不能{action_name}"
        if allowed_item is not None and not allowed_item(item):
            return False, unavailable_message or "当前预约不允许执行此操作"
        response = self._authenticated_call(operation, booking_id)
        return self._verified_booking_action(
            booking_id,
            response,
            expected_status=expected_status,
            success_message=success_message,
            failure_prefix=f"{action_name}失败",
        )

    def _find_booking(self, booking_id: str | int) -> dict:
        normalized_id = str(booking_id).strip()
        if not normalized_id or not normalized_id.isdigit():
            raise ValueError("预约 ID 必须是数字")
        bookings = self.list_bookings()
        item = next(
            (item for item in bookings if responses.booking_id(item) == normalized_id),
            None,
        )
        if item is None:
            raise ValueError(f"当前账户中找不到预约 ID={normalized_id}")
        return item

    def _verified_booking_action(
        self,
        booking_id: str | int,
        response: dict,
        *,
        expected_status: str | set[str],
        success_message: str,
        failure_prefix: str,
        missing_is_success: bool = False,
    ) -> tuple[bool, str]:
        if not responses.operation_succeeded(response):
            return False, f"{failure_prefix}：{responses.operation_message(response)}"
        try:
            item = self._find_booking(booking_id)
        except ValueError:
            if missing_is_success:
                return True, success_message
            raise
        actual_status = responses.booking_status(item)
        expected_statuses = (
            {expected_status} if isinstance(expected_status, str) else expected_status
        )
        if actual_status not in expected_statuses:
            return (
                False,
                f"{failure_prefix}：接口返回成功，但预约状态仍为 {actual_status or '未知'}",
            )
        return True, success_message

    def scheduler_status(self) -> TaskStatus:
        """返回固定每日任务的只读状态，不暴露调度配置。"""
        self._require_authenticated()
        return self.scheduler.get_task_status()

    def list_scheduled_tasks(self) -> list[ScheduledTask]:
        """列出由本应用创建并允许管理的系统调度任务。"""
        self._require_authenticated()
        return self.scheduler.list_tasks()

    def run_scheduled_task(self, task_name: str) -> tuple[bool, str]:
        """请求系统任务计划程序立即运行一个应用托管任务。"""
        self._require_authenticated()
        return self.scheduler.run_task(task_name)

    def delete_scheduled_task(self, task_name: str) -> tuple[bool, str]:
        """删除一个应用托管的系统调度任务。"""
        self._require_authenticated()
        return self.scheduler.delete_task(task_name)

    def repair_daily_scheduler(self) -> tuple[bool, str]:
        """检查前置条件并重新确保每日 20:00 系统任务。"""
        self._require_authenticated()
        if not self.plans.list_enabled():
            return False, "请先创建并启用至少一个预约方案"
        return self._configure_daily_scheduler(allow_elevated_repair=True)

    def schedule_policy(self) -> SchedulePolicy:
        """返回当前预约日期策略的只读快照。"""
        self._require_authenticated()
        return SchedulePolicy.load(self.settings.paths.schedule_policy_file)

    def save_schedule_policy(
        self,
        *,
        enabled: bool | None = None,
        weekdays: list[int] | None = None,
    ) -> SchedulePolicy:
        """保存星期规则或暂停状态，返回更新后的策略。"""
        self._require_authenticated()
        updated = SchedulePolicy.load(self.settings.paths.schedule_policy_file).with_updates(
            enabled=enabled,
            weekdays=weekdays,
        )
        updated.save(self.settings.paths.schedule_policy_file)
        return updated

    def enabled_plan_count(self) -> int:
        """返回当前启用的预约方案数量。"""
        return len(self.plans.list_enabled())

    def run_booking_override(self) -> int:
        """人工立即执行：绕过暂停与日期规则，不修改已保存配置。"""
        self._require_authenticated()
        return self.booking.run_once(bypass_policy=True)

    def _ensure_daily_scheduler(self) -> None:
        """有效方案存在时，静默确保每天 20:00 的系统任务。"""
        if not self.plans.list_enabled():
            return
        self._configure_daily_scheduler()

    def _configure_daily_scheduler(
        self, *, allow_elevated_repair: bool = False
    ) -> tuple[bool, str]:
        try:
            if allow_elevated_repair:
                success, message = self.scheduler.configure_task(allow_elevated_repair=True)
            else:
                success, message = self.scheduler.configure_task()
        except Exception as exc:
            message = str(exc)
            self.notifier.send("自动调度配置失败", message, success=False)
            return False, message
        if not success:
            self.notifier.send("自动调度配置失败", message, success=False)
        return success, message
