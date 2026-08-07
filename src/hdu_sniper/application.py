"""统一应用门面：Flet、API 和后台入口只依赖这一层。"""

from __future__ import annotations

import contextlib
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import RLock
from typing import Protocol

from hdu_sniper.booking.models import BookingPlan, BookingResult
from hdu_sniper.booking.plans import BookingPlans
from hdu_sniper.booking.runner import BookingRunner
from hdu_sniper.booking.time import BOOKING_DAY_OFFSET, CST
from hdu_sniper.config import (
    CHECK_IN_AGREEMENT_TEXT,
    CHECK_IN_AGREEMENT_VERSION,
    Credentials,
    Settings,
    load_credentials,
    save_credentials,
    save_settings,
)
from hdu_sniper.dto import (
    BookingView,
    DownloadProgress,
    FloorView,
    PlanView,
    RoomTypeView,
    SavedCredentialsView,
    ScheduledTaskView,
    SchedulePolicyView,
    SchedulerStatusView,
    UpdateInfo,
    WeekdayOption,
)
from hdu_sniper.events import ApplicationEvent, EventKind, JobState
from hdu_sniper.library import responses
from hdu_sniper.library.client import (
    ROOM_TYPE_MAP,
    AuthenticationExpiredError,
    LibraryClient,
)
from hdu_sniper.library.login import LibraryLogin
from hdu_sniper.notifier import Notifier
from hdu_sniper.schedule_policy import ALL_WEEKDAYS, WEEKDAY_NAMES, SchedulePolicy
from hdu_sniper.scheduler import SchedulerService
from hdu_sniper.updater import UpdateService


EventHandler = Callable[[ApplicationEvent], None]


class SniperAppProtocol(Protocol):
    """UI 与 API 依赖的应用门面接口。"""

    authenticated: bool

    def subscribe(self, handler: EventHandler) -> Callable[[], None]: ...

    def saved_credentials(self) -> SavedCredentialsView | None: ...

    def try_cached_authentication(self) -> bool: ...

    def authenticate(self, student_id: str, password: str) -> tuple[bool, str]: ...

    def list_plans(self) -> list[PlanView]: ...

    def list_room_types(self) -> list[RoomTypeView]: ...

    def list_floors(self, room_query: str) -> list[FloorView]: ...

    def create_plan(
        self, **values
    ) -> tuple[PlanView, list[str], bool, DailySchedulerActivation | None]: ...

    def delete_plans(self, plan_ids: list[str]) -> int: ...

    def modify_plan_times(self, plan_ids: list[str], **values) -> int: ...

    def list_bookings(self) -> list[BookingView]: ...

    def cancel_remote_booking(self, booking_id: str | int) -> tuple[bool, str]: ...

    def check_in_booking(self, booking_id: str | int) -> tuple[bool, str]: ...

    def come_back_booking(self, booking_id: str | int) -> tuple[bool, str]: ...

    def renew_booking(self, booking_id: str | int) -> tuple[bool, str]: ...

    def leave_booking(self, booking_id: str | int) -> tuple[bool, str]: ...

    def sign_out_booking(self, booking_id: str | int) -> tuple[bool, str]: ...

    def test_check_in(self, booking_id: str | int) -> tuple[bool, str]: ...

    def check_in_test(self) -> list[dict[str, str | bool]]: ...

    def auto_check_in(self) -> list[dict[str, str | bool]]: ...

    def auto_check_in_status(self) -> dict: ...

    def enable_auto_check_in(self) -> tuple[bool, str]: ...

    def disable_auto_check_in(self) -> tuple[bool, str]: ...

    def schedule_policy(self) -> SchedulePolicyView: ...

    def schedule_policy_preview(self, weekdays: list[int]) -> str: ...

    def save_schedule_policy(
        self,
        *,
        enabled: bool | None = None,
        weekdays: list[int] | None = None,
    ) -> SchedulePolicyView: ...

    def scheduler_status(self) -> SchedulerStatusView: ...

    def list_scheduled_tasks(self) -> list[ScheduledTaskView]: ...

    def repair_daily_scheduler(self) -> tuple[bool, str]: ...

    def delete_scheduled_task(self, task_name: str) -> tuple[bool, str]: ...

    def enabled_plan_count(self) -> int: ...

    def run_booking_override(self) -> int: ...

    def booking_day_text(self) -> str: ...

    def check_in_agreement_text(self) -> str: ...

    def check_for_update(self) -> UpdateInfo | None: ...

    def update_install_supported(self, update: UpdateInfo) -> bool: ...

    def download_update(
        self,
        update: UpdateInfo,
        *,
        progress: Callable[[DownloadProgress], None] | None = None,
        cancel: Callable[[], bool] | None = None,
    ) -> Path: ...

    def launch_installer(self, installer: Path) -> None: ...


class AuthenticationRequiredError(PermissionError):
    """当前操作要求有效的图书馆认证状态。"""


@dataclass(frozen=True)
class DailySchedulerActivation:
    """创建方案时固定每日调度的配置结果。"""

    success: bool
    already_existed: bool
    message: str


class CheckInExitCode:
    """无头自动签到运行的退出码。"""

    SUCCESS = 0
    FAILED = 1
    AUTH_FAILED = 2
    NOT_ENABLED = 3


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
        update_service: UpdateService | None = None,
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
        self.update_service = update_service or UpdateService()

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

    def saved_credentials(self) -> SavedCredentialsView | None:
        credentials = load_credentials(self.settings.paths.credentials_file)
        if credentials is None:
            return None
        return SavedCredentialsView(student_id=credentials.student_id)

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

    def list_plans(self) -> list[PlanView]:
        plans = self._authenticated_call(self.plans.list_all)
        return [self._plan_view(plan) for plan in plans]

    def list_enabled_plans(self) -> list[BookingPlan]:
        return self._authenticated_call(self.plans.list_enabled)

    def list_room_types(self) -> list[RoomTypeView]:
        items = self._authenticated_call(self.plans.list_room_types)
        return [
            RoomTypeView(
                query=str(item.get("query", "")),
                name=str(item.get("name") or item.get("query", "")),
            )
            for item in items
        ]

    def list_floors(self, room_query: str) -> list[FloorView]:
        floors = self._authenticated_call(self.plans.list_floors, room_query)
        return [
            FloorView(
                floor_id=item.floor_id,
                room_name=item.room_name,
                seat_count=item.seat_count,
                seat_titles=list(item.seat_titles),
            )
            for item in floors
        ]

    def create_plan(
        self, **values
    ) -> tuple[PlanView, list[str], bool, DailySchedulerActivation | None]:
        plan, errors, fell_back = self._authenticated_call(self.plans.create, **values)
        plan_view = self._plan_view(plan)
        if errors:
            return plan_view, errors, fell_back, None
        try:
            already_existed = self.scheduler.get_task_status().exists
        except Exception:
            already_existed = False
        success, message = self._configure_daily_scheduler()
        activation = DailySchedulerActivation(success, already_existed, message)
        self._sync_auto_checkin_for_current_policy()
        return plan_view, errors, fell_back, activation

    @staticmethod
    def _plan_view(plan: BookingPlan) -> PlanView:
        return PlanView(
            plan_id=plan.plan_id,
            room_name=ROOM_TYPE_MAP.get(str(plan.room_type), f"类型 {plan.room_type}"),
            seat_num=plan.seat_num,
            start_hour=plan.start_hour,
            duration_hours=plan.duration_hours,
            fallback_seats=list(plan.fallback_seats),
            enabled=plan.enabled,
        )

    def delete_plans(self, plan_ids: list[str]) -> int:
        removed = self._authenticated_call(self.plans.delete, plan_ids)
        self._sync_auto_checkin_for_current_policy()
        return removed

    def modify_plan_times(self, plan_ids: list[str], **values) -> int:
        modified = self._authenticated_call(self.plans.update_times, plan_ids, **values)
        self._sync_auto_checkin_for_current_policy()
        return modified

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

    def list_bookings(self) -> list[BookingView]:
        """查询图书馆账户的座位预约记录并转换为 UI 展示模型。"""
        return [self._booking_view(item) for item in self._raw_bookings()]

    def _raw_bookings(self) -> list[dict]:
        """读取图书馆原始预约记录，仅供应用层内部校验使用。"""
        return self._authenticated_call(self.client.get_bookings)

    @staticmethod
    def _booking_view(item: dict) -> BookingView:
        status = responses.booking_status(item)
        state = responses.booking_state(item)
        booking_id = responses.booking_id(item)
        room_name = str(item.get("roomName") or "未知房间")
        seat_num = str(item.get("seatNum") or "-")
        try:
            start_text = datetime.fromtimestamp(
                responses.booking_begin_ts(item),
                tz=CST,
            ).strftime("%Y-%m-%d %H:%M")
        except (TypeError, ValueError, OSError):
            start_text = "未知时间"
        try:
            duration_hours = int(item.get("duration") or 0) / 3600
            duration_text = f"{duration_hours:g} 小时" if duration_hours else "时长未知"
        except (TypeError, ValueError):
            duration_text = "时长未知"

        status_labels = {
            "0": "待签到",
            "1": "使用中",
            "2": "暂离中",
            "3": "已结束",
            "4": "已取消",
            "5": "未签到结束",
            "6": "暂离未归结束",
            "7": "系统签退结束",
            "8": "预约待确认",
            "9": "已拒绝",
        }
        if state == responses.BOOKING_STATE_CHECK_IN:
            status_label = "可签到"
        elif state == responses.BOOKING_STATE_IN_USE:
            status_label = "签到成功，使用中"
        else:
            status_label = status_labels.get(status) or f"状态 {status or '未知'}"

        return BookingView(
            booking_id=booking_id,
            room_name=room_name,
            seat_num=seat_num,
            start_text=start_text,
            duration_text=duration_text,
            status=status,
            state=state,
            status_label=status_label,
            summary=f"{room_name} · 座位 {seat_num} · {start_text}",
            can_cancel=status in {"0", "8"} and bool(booking_id),
            can_check_in=(
                status in {"0", "8"} and state == responses.BOOKING_STATE_CHECK_IN
            ),
            can_sign_out=state == responses.BOOKING_STATE_IN_USE and bool(booking_id),
            can_leave=state == responses.BOOKING_STATE_IN_USE and bool(booking_id),
            can_renew=state == responses.BOOKING_STATE_AWAY and bool(booking_id),
            show_in_list=status
            not in {
                responses.BOOKING_STATUS_FINISHED,
                responses.BOOKING_STATUS_CANCELLED,
                responses.BOOKING_STATUS_SYSTEM_SIGNED_OUT,
            },
        )

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
        success, message = self._run_booking_action(
            booking_id,
            allowed_statuses={responses.BOOKING_STATUS_PENDING},
            allowed_item=responses.booking_is_check_in_available,
            unavailable_message="当前预约尚未进入可签到时间窗口",
            operation=self.client.check_in_booking,
            expected_status=responses.BOOKING_STATUS_IN_USE,
            action_name="签到",
            success_message="签到成功，座位使用中",
        )
        if success:
            self.notifier.send("签到成功", message, success=True)
        return success, message

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
        if not self._auto_check_in_consented():
            return [
                {
                    "success": False,
                    "message": "自动签到未启用：请先在“调度”页阅读并勾选风险协议后开启",
                }
            ]
        if self.busy:
            return [{"success": False, "message": "当前任务正在运行，请稍后再自动签到"}]
        results: list[dict[str, str | bool]] = []
        for item in self._raw_bookings():
            booking_id = responses.booking_id(item)
            if not booking_id or not responses.booking_is_check_in_available(item):
                continue
            success, message = self.check_in_booking(booking_id)
            results.append({"id": booking_id, "success": success, "message": message})
        if not results:
            return [{"success": False, "message": "没有处于可签到窗口的预约"}]
        return results

    def auto_check_in_status(self) -> dict:
        """返回自动签到开关、协议同意状态与当前协议版本。"""
        return {
            "enabled": self.settings.auto_check_in_enabled,
            "agreement_version": self.settings.auto_check_in_agreement_version,
            "agreed_at": self.settings.auto_check_in_agreed_at,
            "current_agreement_version": CHECK_IN_AGREEMENT_VERSION,
            "consent_valid": self._auto_check_in_consented(),
            "tasks_ready": self.scheduler.checkin_tasks_ready(),
        }

    def enable_auto_check_in(self) -> tuple[bool, str]:
        """记录风险协议同意并启用自动签到，随后同步系统任务。

        同步失败时回滚已启用的开关，避免界面显示已启用但系统任务未创建。
        """
        self._require_authenticated()
        if self.busy:
            return False, "当前任务正在运行，请稍后再开启自动签到"
        updated = replace(
            self.settings,
            auto_check_in_enabled=True,
            auto_check_in_agreement_version=CHECK_IN_AGREEMENT_VERSION,
            auto_check_in_agreed_at=datetime.now(UTC).isoformat(timespec="seconds"),
        )
        try:
            save_settings(updated, self.settings.paths.settings_file)
        except OSError as exc:
            return False, f"保存配置失败: {exc}"
        self.settings = updated

        try:
            bookings = self._authenticated_call(self.client.get_bookings)
            plans = self.plans.list_enabled()
            policy = SchedulePolicy.load(self.settings.paths.schedule_policy_file)
            weekdays = policy.weekdays if policy.enabled and not policy.corrupt else None
            if plans:
                success, message = self.scheduler.sync_checkin_tasks(
                    bookings,
                    enabled=True,
                    plans=plans,
                    weekdays=weekdays,
                )
            else:
                success, message = self.scheduler.sync_checkin_tasks(
                    bookings,
                    enabled=True,
                )
        except AuthenticationExpiredError:
            self._expire_authentication()
            return self._fail_checkin_enable("登录态已失效，未能同步自动签到系统任务")
        except AuthenticationRequiredError:
            return self._fail_checkin_enable(
                "登录态已失效，未能同步自动签到系统任务",
                cleanup=False,
            )
        except Exception as exc:
            return self._fail_checkin_enable(f"调度配置失败: {exc}")
        if not success:
            return self._fail_checkin_enable(message)
        return True, "自动签到已启用，登录触发与日期方案签到任务已同步"

    def _fail_checkin_enable(
        self,
        message: str,
        *,
        cleanup: bool = True,
    ) -> tuple[bool, str]:
        """自动签到启用失败时清理部分任务并回滚开关。"""
        if cleanup:
            with contextlib.suppress(Exception):
                self.scheduler.remove_checkin_tasks()
        rolled_back = replace(self.settings, auto_check_in_enabled=False)
        try:
            save_settings(rolled_back, self.settings.paths.settings_file)
            self.settings = rolled_back
        except OSError as exc:
            message = f"{message}\n回滚自动签到开关失败: {exc}"
        full_message = f"自动签到未启用：{message}"
        self.notifier.send("自动签到调度配置失败", full_message, success=False)
        return False, full_message

    def disable_auto_check_in(self) -> tuple[bool, str]:
        """关闭自动签到并移除相关系统任务，保留历史同意记录。"""
        self._require_authenticated()
        if self.busy:
            return False, "当前任务正在运行，请稍后再关闭自动签到"
        updated = replace(self.settings, auto_check_in_enabled=False)
        try:
            save_settings(updated, self.settings.paths.settings_file)
        except OSError as exc:
            return False, f"保存配置失败: {exc}"
        self.settings = updated
        try:
            success, message = self.scheduler.remove_checkin_tasks()
        except Exception as exc:
            return False, f"自动签到已关闭，但清理系统任务失败: {exc}"
        if not success:
            return False, f"自动签到已关闭，但清理系统任务失败:\n{message}"
        return True, "自动签到已关闭，相关系统任务已移除"

    def run_checkin(self, *, wait: bool = False) -> int:
        """无头自动签到入口；wait 时在签到窗口内持续重试。"""
        if not self._auto_check_in_consented():
            self.notifier.send(
                "自动签到未启用",
                "请在应用内阅读并同意风险协议后开启自动签到；"
                "本工具不对账号封禁等后果负责。",
                success=False,
            )
            return CheckInExitCode.NOT_ENABLED
        if not self.booking.ensure_login():
            self.notifier.send(
                "自动签到无法启动",
                "登录态已过期且自动登录失败，请重新登录。",
                success=False,
            )
            return CheckInExitCode.AUTH_FAILED
        with self._lock:
            self._authenticated = True

        interval = max(float(self.settings.check_in_retry_interval), 10.0)
        deadline: float | None = None
        while True:
            results = self.auto_check_in()
            if any(result.get("success") for result in results):
                return CheckInExitCode.SUCCESS
            if not wait:
                return CheckInExitCode.FAILED
            if deadline is None:
                deadline = self._checkin_window_deadline()
            if deadline is None:
                return CheckInExitCode.FAILED
            remaining = deadline - time.time()
            if remaining <= 0:
                self.notifier.send(
                    "自动签到失败",
                    "签到窗口已结束，仍未完成签到。",
                    success=False,
                )
                return CheckInExitCode.FAILED
            time.sleep(min(interval, max(remaining, 1.0)))

    def _auto_check_in_consented(self) -> bool:
        return (
            self.settings.auto_check_in_enabled
            and self.settings.auto_check_in_agreement_version == CHECK_IN_AGREEMENT_VERSION
        )

    def _sync_auto_checkin_for_current_policy(self) -> None:
        """启用自动签到时按当前日期方案重新同步窗口任务。"""
        if not self._auto_check_in_consented():
            return
        try:
            bookings = self.client.get_bookings()
            plans = self.plans.list_enabled()
            if not plans:
                return
            policy = SchedulePolicy.load(self.settings.paths.schedule_policy_file)
            weekdays = policy.weekdays if policy.enabled and not policy.corrupt else None
            success, message = self.scheduler.sync_checkin_tasks(
                bookings,
                enabled=True,
                plans=plans,
                weekdays=weekdays,
            )
            if not success:
                self.notifier.send("自动签到调度同步失败", message, success=False)
        except Exception:
            pass

    def _checkin_window_deadline(self) -> float | None:
        """返回待签到预约中最晚的窗口关闭时间戳；没有待签到预约时返回 None。"""
        try:
            bookings = self.client.get_bookings()
        except Exception:
            return None
        deadlines: list[float] = []
        for item in bookings:
            try:
                if responses.booking_status(item) != responses.BOOKING_STATUS_PENDING:
                    continue
                begin_ts = responses.booking_begin_ts(item)
                sign_back = int(item.get("limitSignBack") or 1800)
            except (TypeError, ValueError):
                continue
            deadlines.append(float(begin_ts + sign_back))
        return max(deadlines) if deadlines else None

    def check_in_test(self) -> list[dict[str, str | bool]]:
        """测试全部预约的签到条件，供界面一次性诊断。"""
        results: list[dict[str, str | bool]] = []
        for item in self._raw_bookings():
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
        bookings = self._raw_bookings()
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

    def scheduler_status(self) -> SchedulerStatusView:
        """返回固定每日任务的只读状态，不暴露调度配置。"""
        self._require_authenticated()
        status = self.scheduler.get_task_status()
        return SchedulerStatusView(
            exists=status.exists,
            execute_time=status.execute_time,
            wake_to_run=status.wake_to_run,
            next_run=status.next_run,
        )

    def list_scheduled_tasks(self) -> list[ScheduledTaskView]:
        """列出由本应用创建并允许管理的系统调度任务。"""
        self._require_authenticated()
        return [
            ScheduledTaskView(
                name=task.name,
                status=task.status,
                next_run=task.next_run,
                last_run=task.last_run,
                last_result=task.last_result,
            )
            for task in self.scheduler.list_tasks()
        ]

    def run_scheduled_task(self, task_name: str) -> tuple[bool, str]:
        """请求系统任务计划程序立即运行一个应用托管任务。"""
        self._require_authenticated()
        return self.scheduler.run_task(task_name)

    def delete_scheduled_task(self, task_name: str) -> tuple[bool, str]:
        """删除一个应用托管的系统调度任务。"""
        self._require_authenticated()
        return self.scheduler.delete_task(task_name)

    def repair_daily_scheduler(self) -> tuple[bool, str]:
        """检查前置条件并重新确保按日期方案配置系统任务。"""
        self._require_authenticated()
        if not self.plans.list_enabled():
            return False, "请先创建并启用至少一个预约方案"
        return self._configure_daily_scheduler(allow_elevated_repair=True)

    def schedule_policy(self) -> SchedulePolicyView:
        """返回当前预约日期策略的展示快照。"""
        self._require_authenticated()
        policy = SchedulePolicy.load(self.settings.paths.schedule_policy_file)
        return self._schedule_policy_view(policy)

    def schedule_policy_preview(self, weekdays: list[int]) -> str:
        """返回星期选择组合的摘要文案，供 UI 实时预览。"""
        if not weekdays:
            return "未选择"
        return SchedulePolicy(enabled=True, weekdays=frozenset(weekdays)).summary_label()

    def save_schedule_policy(
        self,
        *,
        enabled: bool | None = None,
        weekdays: list[int] | None = None,
    ) -> SchedulePolicyView:
        """保存星期规则或暂停状态，返回更新后的策略。"""
        self._require_authenticated()
        updated = SchedulePolicy.load(self.settings.paths.schedule_policy_file).with_updates(
            enabled=enabled,
            weekdays=weekdays,
        )
        updated.save(self.settings.paths.schedule_policy_file)
        if self.plans.list_enabled():
            self._configure_daily_scheduler()
        self._sync_auto_checkin_for_current_policy()
        return self._schedule_policy_view(updated)

    def _schedule_policy_view(self, policy: SchedulePolicy) -> SchedulePolicyView:
        today = datetime.now(CST).date()
        next_date = policy.next_booking_date(today) if policy.enabled else None
        next_run_text = None
        today_excluded = False
        if next_date is not None:
            execute_date = next_date - timedelta(days=BOOKING_DAY_OFFSET)
            execute_label = (
                "今天"
                if execute_date == today
                else f"{execute_date.month} 月 {execute_date.day} 日"
            )
            next_run_text = (
                f"下一次预约 {next_date.month} 月 {next_date.day} 日"
                f" · {execute_label} 20:00 执行"
            )
            today_excluded = (
                (today + timedelta(days=BOOKING_DAY_OFFSET)).isoweekday()
                not in policy.weekdays
            )
        options = tuple(
            WeekdayOption(value=day, label=WEEKDAY_NAMES[day]) for day in ALL_WEEKDAYS
        )
        return SchedulePolicyView(
            enabled=policy.enabled,
            corrupt=policy.corrupt,
            weekdays=policy.weekdays,
            summary_label=policy.summary_label() if not policy.corrupt else "待修复",
            options=options,
            next_run_text=next_run_text,
            today_excluded=today_excluded,
        )

    def enabled_plan_count(self) -> int:
        """返回当前启用的预约方案数量。"""
        return len(self.plans.list_enabled())

    def run_booking_override(self) -> int:
        """人工立即执行：绕过暂停与日期规则，不修改已保存配置。"""
        self._require_authenticated()
        return self.booking.run_once(bypass_policy=True)

    def run_daemon(
        self,
        execute_at: str | None = None,
        *,
        bypass_policy: bool = False,
    ) -> int:
        """后台一次性执行入口，与系统任务调用保持同一路径。"""
        return self.booking.run_once(execute_at=execute_at, bypass_policy=bypass_policy)

    def booking_day_text(self) -> str:
        """返回固定预约日期（后天）的展示文案。"""
        target = datetime.now(CST).date() + timedelta(days=BOOKING_DAY_OFFSET)
        return f"{target.month} 月 {target.day} 日"

    def check_in_agreement_text(self) -> str:
        """返回自动签到风险协议的完整文案。"""
        return CHECK_IN_AGREEMENT_TEXT

    def check_for_update(self) -> UpdateInfo | None:
        """检查桌面端是否有可用更新。"""
        return self.update_service.check_for_update()

    def update_install_supported(self, update: UpdateInfo) -> bool:
        """判断当前环境是否支持应用内下载并启动安装包。"""
        return self.update_service.install_supported(update)

    def download_update(
        self,
        update: UpdateInfo,
        *,
        progress: Callable[[DownloadProgress], None] | None = None,
        cancel: Callable[[], bool] | None = None,
    ) -> Path:
        """下载并校验更新安装包。"""
        return self.update_service.download(
            update,
            progress=progress,
            cancel=cancel,
        )

    def launch_installer(self, installer: Path) -> None:
        """启动已下载的安装程序。"""
        self.update_service.launch(installer)

    def _ensure_daily_scheduler(self) -> None:
        """有效方案存在时，静默确保每天 20:00 的系统任务。"""
        if not self.plans.list_enabled():
            return
        self._configure_daily_scheduler()

    def _configure_daily_scheduler(
        self, *, allow_elevated_repair: bool = False
    ) -> tuple[bool, str]:
        try:
            policy = SchedulePolicy.load(self.settings.paths.schedule_policy_file)
            weekdays = policy.execution_weekdays() if not policy.corrupt else None
            if allow_elevated_repair:
                success, message = self.scheduler.configure_task(
                    weekdays=weekdays,
                    allow_elevated_repair=True,
                )
            else:
                success, message = self.scheduler.configure_task(weekdays=weekdays)
        except Exception as exc:
            message = str(exc)
            self.notifier.send("自动调度配置失败", message, success=False)
            return False, message
        if not success:
            self.notifier.send("自动调度配置失败", message, success=False)
        return success, message
