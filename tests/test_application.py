"""应用门面状态与事件契约测试。"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock

import pytest

from hdu_sniper.application import (
    AuthenticationRequiredError,
    CheckInExitCode,
    DailySchedulerActivation,
    SniperApp,
)
from hdu_sniper.booking.models import BookingPlan, BookingResult
from hdu_sniper.config import CHECK_IN_AGREEMENT_VERSION, Settings
from hdu_sniper.dto import (
    FloorView,
    PlanView,
    RoomTypeView,
    ScheduledTaskView,
    SchedulerStatusView,
    UpdateInfo,
)
from hdu_sniper.events import EventKind, JobState
from hdu_sniper.library.client import AuthenticationExpiredError
from hdu_sniper.library.rooms import FloorInfo
from hdu_sniper.paths import AppPaths
from hdu_sniper.schedule_policy import SchedulePolicyError
from hdu_sniper.scheduler import ScheduledTask, TaskStatus


def build_test_application(tmp_path: Path) -> tuple[SniperApp, dict[str, Mock]]:
    paths = AppPaths(
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        state_dir=tmp_path / "state",
        log_dir=tmp_path / "state" / "logs",
    )
    settings = Settings(paths=paths)
    dependencies = {
        "client": Mock(),
        "plans": Mock(),
        "notifier": Mock(),
        "login": Mock(),
        "booking": Mock(),
        "scheduler": Mock(),
    }
    dependencies["plans"].list_enabled.return_value = []
    dependencies["scheduler"].configure_task.return_value = (True, "ok")
    dependencies["scheduler"].get_task_status.return_value = TaskStatus(exists=False)
    dependencies["scheduler"].checkin_tasks_ready.return_value = False
    application = SniperApp(
        settings,
        dependencies["client"],
        dependencies["plans"],
        dependencies["notifier"],
        login=dependencies["login"],
        booking=dependencies["booking"],
        scheduler=dependencies["scheduler"],
    )
    application._authenticated = True
    return application, dependencies


def test_authentication_publishes_state_and_saves_credentials(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["login"].login_with_credentials.return_value = (True, "认证成功")
    events = []
    application.subscribe(events.append)

    success, message = application.authenticate("123456", "secret")

    assert success is True
    assert message == "认证成功"
    assert application.authenticated is True
    assert application.state == JobState.IDLE
    assert application.settings.paths.credentials_file.exists()
    assert [event.kind for event in events] == [EventKind.STATE, EventKind.AUTH, EventKind.STATE]


def test_booking_progress_is_translated_to_application_events(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    plan = BookingPlan(1, 100, "A001", 8, 4, plan_id="plan-1")
    result = BookingResult(plan, success=True, message="预约成功")
    dependencies["plans"].list_enabled.return_value = [plan]

    def book_now(_plans, on_progress):
        on_progress(result)
        return [result]

    dependencies["booking"].run_now.side_effect = book_now
    events = []
    application.subscribe(events.append)

    results = application.run_booking()

    assert results == [result]
    assert application.state == JobState.SUCCEEDED
    assert any(event.kind == EventKind.PROGRESS for event in events)
    assert events[-1].kind == EventKind.RESULT
    assert events[-1].payload == {"success": True, "attempts": 1}


def test_second_job_is_rejected_while_application_is_busy(tmp_path: Path) -> None:
    application, _dependencies = build_test_application(tmp_path)
    application._set_state(JobState.RUNNING)

    try:
        application.run_booking()
    except RuntimeError as exc:
        assert str(exc) == "已有任务正在运行"
    else:
        raise AssertionError("busy application accepted a second booking job")


def test_creating_valid_plan_silently_ensures_daily_scheduler(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    plan = BookingPlan(1, 100, "A001", 8, 4, plan_id="plan-1")
    dependencies["plans"].create.return_value = (plan, [], False)
    dependencies["plans"].list_enabled.return_value = [plan]

    result = application.create_plan(
        room_type_name="自习室",
        room_query="query",
        floor_id=100,
        seat_num="A001",
        start_hour=8,
        duration_hours=4,
    )

    assert result == (
        PlanView(
            plan_id="plan-1",
            room_name="自习室",
            seat_num="A001",
            start_hour=8,
            duration_hours=4,
            fallback_seats=[],
            enabled=True,
        ),
        [],
        False,
        DailySchedulerActivation(success=True, already_existed=False, message="ok"),
    )
    dependencies["scheduler"].configure_task.assert_called_once_with(
        weekdays=frozenset({1, 2, 3, 4, 5, 6, 7})
    )


def test_creating_plan_reports_existing_scheduler(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    plan = BookingPlan(1, 100, "A001", 8, 4, plan_id="plan-1")
    dependencies["plans"].create.return_value = (plan, [], False)
    dependencies["scheduler"].get_task_status.return_value = TaskStatus(exists=True)

    result = application.create_plan(room_type_name="自习室")

    assert result[3] == DailySchedulerActivation(
        success=True,
        already_existed=True,
        message="ok",
    )


def test_creating_plan_keeps_plan_and_reports_scheduler_failure(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    plan = BookingPlan(1, 100, "A001", 8, 4, plan_id="plan-1")
    dependencies["plans"].create.return_value = (plan, [], False)
    dependencies["scheduler"].configure_task.return_value = (False, "permission denied")

    result = application.create_plan(room_type_name="自习室")

    assert result[0].plan_id == "plan-1"
    assert result[3] == DailySchedulerActivation(
        success=False,
        already_existed=False,
        message="permission denied",
    )
    dependencies["notifier"].send.assert_called_once_with(
        "自动调度配置失败",
        "permission denied",
        success=False,
    )


def test_application_delegates_plan_queries_and_mutations(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    plan = BookingPlan(1, 100, "A001", 8, 4, plan_id="p1")
    dependencies["plans"].list_all.return_value = [plan]
    dependencies["plans"].list_room_types.return_value = [{"query": "q", "name": "自习室"}]
    dependencies["plans"].list_floors.return_value = [
        FloorInfo(floor_id="1", room_name="Room", seat_count=2, seat_titles=["001", "002"])
    ]
    dependencies["plans"].delete.return_value = 2
    dependencies["plans"].update_times.return_value = 1

    assert application.list_plans() == [
        PlanView(
            plan_id="p1",
            room_name="自习室",
            seat_num="A001",
            start_hour=8,
            duration_hours=4,
            fallback_seats=[],
            enabled=True,
        )
    ]
    assert application.list_room_types() == [RoomTypeView(query="q", name="自习室")]
    assert application.list_floors("query") == [
        FloorView(
            floor_id="1",
            room_name="Room",
            seat_count=2,
            seat_titles=["001", "002"],
        )
    ]
    assert application.delete_plans(["a", "b"]) == 2
    assert application.modify_plan_times(["a"], start_hour=9) == 1


def test_application_lists_and_cancels_remote_bookings(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["client"].get_bookings.side_effect = [
        [{"id": "1", "status": "0"}],
        [{"id": "1", "status": "0"}],
        [{"id": "1", "status": "4"}],
    ]
    dependencies["client"].cancel_remote_booking.return_value = {
        "CODE": "ok",
        "DATA": {"result": "success"},
    }

    booking = application.list_bookings()[0]
    assert booking.booking_id == "1"
    assert booking.status == "0"
    assert booking.can_cancel is True
    assert booking.summary == "未知房间 · 座位 - · 1970-01-01 08:00"
    assert application.cancel_remote_booking("1") == (True, "预约已取消")
    dependencies["client"].cancel_remote_booking.assert_called_once_with("1")

    dependencies["client"].cancel_remote_booking.return_value = {
        "CODE": "ParamError",
        "MESSAGE": "预约已结束",
    }
    dependencies["client"].get_bookings.side_effect = [[{"id": "1", "status": "0"}]]
    assert application.cancel_remote_booking("1") == (False, "取消预约失败：预约已结束")

    application._set_state(JobState.RUNNING)
    assert application.cancel_remote_booking("1") == (
        False,
        "当前任务正在运行，请在任务结束后再取消预约",
    )
    assert dependencies["client"].cancel_remote_booking.call_count == 2


def test_application_allows_pending_confirmation_cancellation(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["client"].get_bookings.side_effect = [
        [{"id": "8", "status": "8"}],
        [],
    ]
    dependencies["client"].cancel_remote_booking.return_value = {
        "CODE": "ok",
        "DATA": {"result": "success"},
    }

    assert application.cancel_remote_booking("8") == (True, "预约已取消")
    dependencies["client"].cancel_remote_booking.assert_called_once_with("8")


def test_application_checks_in_and_returns_after_status_verification(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    success_response = {"CODE": "ok", "DATA": {"result": "success"}}
    dependencies["client"].check_in_booking.return_value = success_response
    dependencies["client"].get_bookings.side_effect = [
        [
            {
                "id": "1",
                "status": "0",
                "time": "1000",
                "nowTime": "1000",
                "limitSignAgo": "1800",
                "limitSignBack": "1800",
            }
        ],
        [{"id": "1", "status": "1"}],
    ]
    assert application.check_in_booking("1") == (True, "签到成功，座位使用中")
    dependencies["notifier"].send.assert_called_once_with(
        "签到成功",
        "签到成功，座位使用中",
        success=True,
    )

    dependencies["client"].come_back_booking.return_value = success_response
    dependencies["client"].get_bookings.side_effect = [
        [{"id": "2", "status": "2"}],
        [{"id": "2", "status": "1"}],
    ]
    assert application.come_back_booking("2") == (True, "已返回座位，座位使用中")

    dependencies["client"].leave_booking.return_value = success_response
    dependencies["client"].get_bookings.side_effect = [
        [{"id": "4", "status": "1"}],
        [{"id": "4", "status": "2"}],
    ]
    assert application.leave_booking("4") == (True, "已暂离座位")

    dependencies["client"].sign_out_booking.return_value = success_response
    dependencies["client"].get_bookings.side_effect = [
        [{"id": "5", "status": "1"}],
        [{"id": "5", "status": "3"}],
    ]
    assert application.sign_out_booking("5") == (True, "已签退，预约结束")

    dependencies["client"].get_bookings.side_effect = [[{"id": "3", "status": "6"}]]
    assert application.come_back_booking("3") == (
        False,
        "该预约已因暂离未归结束，服务器不允许恢复",
    )


def test_application_rejects_check_in_outside_the_server_window(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["client"].get_bookings.return_value = [
        {
            "id": "1",
            "status": "0",
            "time": "2000",
            "nowTime": "0",
            "limitSignAgo": "1800",
            "limitSignBack": "1800",
        }
    ]

    assert application.check_in_booking("1") == (False, "当前预约尚未进入可签到时间窗口")
    dependencies["client"].check_in_booking.assert_not_called()


def test_cached_authentication_and_unsubscribe(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    plan = BookingPlan(1, 100, "A001", 8, 4)
    dependencies["login"].try_cache.return_value = True
    dependencies["plans"].list_enabled.return_value = [plan]
    events = []
    unsubscribe = application.subscribe(events.append)

    assert application.try_cached_authentication() is True
    assert application.authenticated is True
    assert events[-1].kind == EventKind.AUTH
    dependencies["scheduler"].configure_task.assert_called_once_with(
        weekdays=frozenset({1, 2, 3, 4, 5, 6, 7})
    )

    unsubscribe()
    application._publish(EventKind.ERROR, "ignored")
    assert len(events) == 1


def test_reauthentication_exception_preserves_idle_state(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["login"].login_with_credentials.side_effect = RuntimeError("offline")

    success, message = application.authenticate("student", "password")

    assert success is False
    assert "offline" in message
    assert application.state == JobState.IDLE


def test_booking_empty_failure_and_cancellation_paths(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    with pytest.raises(ValueError):
        application.run_booking()
    assert application.cancel_booking() is False

    plan = BookingPlan(1, 100, "A001", 8, 4)
    dependencies["plans"].list_enabled.return_value = [plan]
    dependencies["booking"].run_now.side_effect = RuntimeError("failed")
    with pytest.raises(RuntimeError, match="failed"):
        application.run_booking()
    assert application.state == JobState.FAILED

    application._set_state(JobState.RUNNING)
    dependencies["booking"].cancel.return_value = True
    assert application.cancel_booking() is True
    assert application.state == JobState.CANCELLING


def test_scheduler_failures_are_reported_to_notifier(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["plans"].list_enabled.return_value = [BookingPlan(1, 100, "A001", 8, 4)]
    dependencies["scheduler"].configure_task.return_value = (False, "denied")

    application._ensure_daily_scheduler()
    dependencies["notifier"].send.assert_called_once_with(
        "自动调度配置失败", "denied", success=False
    )

    dependencies["notifier"].reset_mock()
    dependencies["scheduler"].configure_task.side_effect = RuntimeError("unsupported")
    application._ensure_daily_scheduler()
    dependencies["notifier"].send.assert_called_once_with(
        "自动调度配置失败", "unsupported", success=False
    )


def test_protected_operations_reject_unauthenticated_callers(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    application._authenticated = False

    with pytest.raises(AuthenticationRequiredError, match="请先完成认证"):
        application.list_plans()
    with pytest.raises(AuthenticationRequiredError):
        application.create_plan(room_type_name="自习室")
    with pytest.raises(AuthenticationRequiredError):
        application.run_booking()

    dependencies["plans"].list_all.assert_not_called()
    dependencies["plans"].create.assert_not_called()
    dependencies["booking"].run_now.assert_not_called()


def test_expired_remote_session_clears_authentication_and_publishes_event(
    tmp_path: Path,
) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["plans"].list_room_types.side_effect = AuthenticationExpiredError("expired")
    events = []
    application.subscribe(events.append)

    with pytest.raises(AuthenticationRequiredError, match="登录状态已失效"):
        application.list_room_types()

    assert application.authenticated is False
    assert application.state == JobState.IDLE
    assert events[-1].kind == EventKind.AUTH_REQUIRED
    assert events[-1].payload == {"authenticated": False}


def test_failed_reauthentication_preserves_valid_session(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["login"].login_with_credentials.return_value = (False, "wrong password")

    success, _message = application.authenticate("student", "wrong")

    assert success is False
    assert application.authenticated is True
    assert application.state == JobState.IDLE


def test_scheduler_health_is_read_only_and_repair_uses_fixed_configuration(
    tmp_path: Path,
) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["scheduler"].get_task_status.return_value = TaskStatus(
        exists=True,
        next_run="tomorrow",
    )
    dependencies["plans"].list_enabled.return_value = [BookingPlan(1, 100, "A001", 8, 4)]

    assert application.scheduler_status() == SchedulerStatusView(
        exists=True,
        next_run="tomorrow",
    )
    assert application.repair_daily_scheduler() == (True, "ok")
    dependencies["scheduler"].configure_task.assert_called_once_with(
        weekdays=frozenset({1, 2, 3, 4, 5, 6, 7}),
        allow_elevated_repair=True,
    )


def test_application_delegates_managed_schedule_operations(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    task = ScheduledTask(name="HDU-Library-Sniper-Daily", status="Ready")
    dependencies["scheduler"].list_tasks.return_value = [task]
    dependencies["scheduler"].run_task.return_value = (True, "started")
    dependencies["scheduler"].delete_task.return_value = (True, "deleted")

    assert application.list_scheduled_tasks() == [
        ScheduledTaskView(name="HDU-Library-Sniper-Daily", status="Ready")
    ]
    assert application.run_scheduled_task(task.name) == (True, "started")
    assert application.delete_scheduled_task(task.name) == (True, "deleted")
    dependencies["scheduler"].list_tasks.assert_called_once_with()
    dependencies["scheduler"].run_task.assert_called_once_with(task.name)
    dependencies["scheduler"].delete_task.assert_called_once_with(task.name)


def test_scheduler_repair_requires_an_enabled_plan(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["plans"].list_enabled.return_value = []

    success, message = application.repair_daily_scheduler()

    assert success is False
    assert "至少一个预约方案" in message
    dependencies["scheduler"].configure_task.assert_not_called()


def test_schedule_policy_round_trip_through_facade(tmp_path: Path) -> None:
    application, _ = build_test_application(tmp_path)

    updated = application.save_schedule_policy(weekdays=[1, 3, 5])

    assert updated.weekdays == frozenset({1, 3, 5})
    assert updated.summary_label == "周一、周三、周五"
    policy = application.schedule_policy()
    assert policy.weekdays == frozenset({1, 3, 5})
    assert policy.summary_label == "周一、周三、周五"
    assert application.schedule_policy_preview([1, 3, 5]) == "周一、周三、周五"
    assert application.schedule_policy_preview([]) == "未选择"


def test_saving_schedule_policy_recreates_daily_task_with_execution_days(
    tmp_path: Path,
) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["plans"].list_enabled.return_value = [
        BookingPlan(1, 100, "A001", 8, 4, plan_id="p1")
    ]

    application.save_schedule_policy(weekdays=[1, 3, 5])

    dependencies["scheduler"].configure_task.assert_called_once_with(weekdays=frozenset({6, 1, 3}))


def test_schedule_policy_pause_and_resume_through_facade(tmp_path: Path) -> None:
    application, _ = build_test_application(tmp_path)

    paused = application.save_schedule_policy(enabled=False)
    assert paused.enabled is False
    assert application.schedule_policy().enabled is False

    resumed = application.save_schedule_policy(enabled=True)
    assert resumed.enabled is True


def test_schedule_policy_requires_at_least_one_day(tmp_path: Path) -> None:
    application, _ = build_test_application(tmp_path)

    with pytest.raises(SchedulePolicyError):
        application.save_schedule_policy(weekdays=[])


def test_run_booking_override_bypasses_policy(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["booking"].run_once.return_value = 0

    assert application.run_booking_override() == 0

    dependencies["booking"].run_once.assert_called_once_with(bypass_policy=True)


def test_run_daemon_delegates_to_booking_runner(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["booking"].run_once.return_value = 2

    assert application.run_daemon("2026-08-05T20:00:00", bypass_policy=True) == 2
    dependencies["booking"].run_once.assert_called_once_with(
        execute_at="2026-08-05T20:00:00",
        bypass_policy=True,
    )


def test_update_facade_delegates_to_update_service(tmp_path: Path) -> None:
    application, _ = build_test_application(tmp_path)
    update = UpdateInfo(
        version="1.2.0",
        tag_name="v1.2.0",
        release_url="https://example.test/r",
        download_url="https://example.test/setup.exe",
    )
    service = Mock()
    service.check_for_update.return_value = update
    service.install_supported.return_value = True
    service.download.return_value = Path("C:/Downloads/setup.exe")
    application.update_service = service

    assert application.check_for_update() is update
    assert application.update_install_supported(update) is True
    progress = Mock()
    cancel = Mock()
    installer = application.download_update(update, progress=progress, cancel=cancel)
    assert installer == Path("C:/Downloads/setup.exe")
    application.launch_installer(installer)

    service.download.assert_called_once_with(update, progress=progress, cancel=cancel)
    service.launch.assert_called_once_with(Path("C:/Downloads/setup.exe"))


def test_booking_day_and_agreement_text_are_stable(tmp_path: Path) -> None:
    application, _ = build_test_application(tmp_path)

    assert application.booking_day_text()
    assert "自动签到功能" in application.check_in_agreement_text()


def test_enabled_plan_count_uses_enabled_plans(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["plans"].list_enabled.return_value = [
        BookingPlan(1, 100, "A001", 8, 4),
        BookingPlan(1, 100, "A002", 8, 4),
    ]

    assert application.enabled_plan_count() == 2


def _grant_checkin_consent(application: SniperApp) -> None:
    application.settings = replace(
        application.settings,
        auto_check_in_enabled=True,
        auto_check_in_agreement_version=CHECK_IN_AGREEMENT_VERSION,
        auto_check_in_agreed_at="2026-08-02T08:00:00+00:00",
    )


def test_auto_check_in_requires_consent_gate(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)

    results = application.auto_check_in()

    assert results == [
        {
            "success": False,
            "message": "自动签到未启用：请先在“调度”页阅读并勾选风险协议后开启",
        }
    ]
    dependencies["client"].get_bookings.assert_not_called()


def test_auto_check_in_runs_when_consented(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    _grant_checkin_consent(application)
    booking = {
        "id": "1",
        "status": "0",
        "time": "1000",
        "nowTime": "1000",
        "limitSignAgo": "1800",
        "limitSignBack": "1800",
    }
    dependencies["client"].get_bookings.side_effect = [
        [booking],
        [booking],
        [{"id": "1", "status": "1"}],
    ]
    dependencies["client"].check_in_booking.return_value = {
        "CODE": "ok",
        "DATA": {"result": "success"},
    }

    results = application.auto_check_in()

    assert results == [{"id": "1", "success": True, "message": "签到成功，座位使用中"}]
    dependencies["notifier"].send.assert_called_once_with(
        "签到成功",
        "签到成功，座位使用中",
        success=True,
    )


def test_enable_auto_check_in_persists_consent_and_syncs_tasks(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    bookings = [{"id": "1", "status": "0"}]
    dependencies["client"].get_bookings.return_value = bookings
    dependencies["scheduler"].sync_checkin_tasks.return_value = (True, "ok")

    success, message = application.enable_auto_check_in()

    assert success is True
    assert application.settings.auto_check_in_enabled is True
    assert application.settings.auto_check_in_agreement_version == CHECK_IN_AGREEMENT_VERSION
    assert application.settings.auto_check_in_agreed_at
    stored = application.settings.paths.settings_file.read_text(encoding="utf-8")
    assert "enabled: true" in stored
    dependencies["scheduler"].sync_checkin_tasks.assert_called_once_with(
        bookings,
        enabled=True,
    )


def test_enable_auto_check_in_creates_daily_tasks_when_plans_exist(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    plan = BookingPlan(1, 100, "A001", 8, 4, plan_id="p1")
    dependencies["plans"].list_enabled.return_value = [plan]
    bookings = [{"id": "1", "status": "0"}]
    dependencies["client"].get_bookings.return_value = bookings
    dependencies["scheduler"].sync_checkin_tasks.return_value = (True, "ok")

    success, _message = application.enable_auto_check_in()

    assert success is True
    dependencies["scheduler"].sync_checkin_tasks.assert_called_once_with(
        bookings,
        enabled=True,
        plans=[plan],
    )


def test_plan_changes_resync_auto_checkin_daily_tasks(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    application.settings = replace(
        application.settings,
        auto_check_in_enabled=True,
        auto_check_in_agreement_version=CHECK_IN_AGREEMENT_VERSION,
    )
    plan = BookingPlan(1, 100, "A001", 8, 4, plan_id="p1")
    dependencies["plans"].list_enabled.return_value = [plan]
    dependencies["plans"].update_times.return_value = 1
    dependencies["client"].get_bookings.return_value = []
    dependencies["scheduler"].sync_checkin_tasks.return_value = (True, "ok")

    assert application.modify_plan_times(["p1"], start_hour=9) == 1

    dependencies["scheduler"].sync_checkin_tasks.assert_called_once_with(
        [],
        enabled=True,
        plans=[plan],
    )


def test_enable_auto_check_in_rolls_back_when_sync_fails(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["client"].get_bookings.return_value = []
    dependencies["scheduler"].sync_checkin_tasks.return_value = (False, "denied")
    dependencies["scheduler"].remove_checkin_tasks.return_value = (True, "removed")

    success, message = application.enable_auto_check_in()

    assert success is False
    assert "denied" in message
    assert application.settings.auto_check_in_enabled is False
    assert application.settings.auto_check_in_agreement_version == CHECK_IN_AGREEMENT_VERSION
    assert application.settings.auto_check_in_agreed_at
    stored = application.settings.paths.settings_file.read_text(encoding="utf-8")
    assert "enabled: false" in stored
    dependencies["scheduler"].remove_checkin_tasks.assert_called_once_with()
    dependencies["notifier"].send.assert_called_once_with(
        "自动签到调度配置失败",
        message,
        success=False,
    )


def test_enable_auto_check_in_rolls_back_when_sync_raises(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["client"].get_bookings.return_value = []
    dependencies["scheduler"].sync_checkin_tasks.side_effect = RuntimeError("denied")
    dependencies["scheduler"].remove_checkin_tasks.return_value = (True, "removed")

    success, message = application.enable_auto_check_in()

    assert success is False
    assert "denied" in message
    assert application.settings.auto_check_in_enabled is False
    dependencies["scheduler"].remove_checkin_tasks.assert_called_once_with()


def test_enable_auto_check_in_rolls_back_when_login_expired(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["client"].get_bookings.side_effect = AuthenticationExpiredError("expired")

    success, message = application.enable_auto_check_in()

    assert success is False
    assert "登录态已失效" in message
    assert application.settings.auto_check_in_enabled is False
    assert application.authenticated is False
    dependencies["scheduler"].remove_checkin_tasks.assert_not_called()


def test_disable_auto_check_in_removes_tasks_and_keeps_history(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    _grant_checkin_consent(application)
    dependencies["scheduler"].remove_checkin_tasks.return_value = (True, "removed")

    success, message = application.disable_auto_check_in()

    assert success is True
    assert application.settings.auto_check_in_enabled is False
    assert application.settings.auto_check_in_agreement_version == CHECK_IN_AGREEMENT_VERSION
    assert application.settings.auto_check_in_agreed_at
    dependencies["scheduler"].remove_checkin_tasks.assert_called_once_with()


def test_auto_check_in_status_reflects_consent(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)

    status = application.auto_check_in_status()
    assert status["enabled"] is False
    assert status["consent_valid"] is False
    assert status["tasks_ready"] is False
    assert status["current_agreement_version"] == CHECK_IN_AGREEMENT_VERSION

    _grant_checkin_consent(application)
    dependencies["scheduler"].checkin_tasks_ready.return_value = True
    status = application.auto_check_in_status()
    assert status["enabled"] is True
    assert status["consent_valid"] is True
    assert status["tasks_ready"] is True


def test_auto_check_in_status_reports_missing_tasks(tmp_path: Path) -> None:
    application, _dependencies = build_test_application(tmp_path)
    _grant_checkin_consent(application)

    status = application.auto_check_in_status()

    assert status["enabled"] is True
    assert status["consent_valid"] is True
    assert status["tasks_ready"] is False


def test_run_checkin_exit_codes(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)

    assert application.run_checkin() == CheckInExitCode.NOT_ENABLED

    _grant_checkin_consent(application)
    dependencies["booking"].ensure_login.return_value = False
    assert application.run_checkin() == CheckInExitCode.AUTH_FAILED

    dependencies["booking"].ensure_login.return_value = True
    dependencies["client"].get_bookings.return_value = []
    assert application.run_checkin() == CheckInExitCode.FAILED

    booking = {
        "id": "1",
        "status": "0",
        "time": "1000",
        "nowTime": "1000",
        "limitSignAgo": "1800",
        "limitSignBack": "1800",
    }
    dependencies["client"].get_bookings.side_effect = [
        [booking],
        [booking],
        [{"id": "1", "status": "1"}],
    ]
    dependencies["client"].check_in_booking.return_value = {
        "CODE": "ok",
        "DATA": {"result": "success"},
    }
    assert application.run_checkin() == CheckInExitCode.SUCCESS
