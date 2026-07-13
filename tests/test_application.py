"""应用门面状态与事件契约测试。"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

import pytest

from hdu_sniper.app import AuthenticationRequiredError, DailySchedulerActivation, SniperApp
from hdu_sniper.booking.models import BookingPlan, BookingResult
from hdu_sniper.config import Settings
from hdu_sniper.events import EventKind, JobState
from hdu_sniper.library.client import AuthenticationExpiredError
from hdu_sniper.paths import AppPaths
from hdu_sniper.scheduler import TaskStatus


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
        plan,
        [],
        False,
        DailySchedulerActivation(success=True, already_existed=False, message="ok"),
    )
    dependencies["scheduler"].configure_task.assert_called_once_with()


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

    assert result[0] is plan
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
    dependencies["plans"].list_all.return_value = ["plan"]
    dependencies["plans"].list_room_types.return_value = ["room"]
    dependencies["plans"].list_floors.return_value = ["floor"]
    dependencies["plans"].delete.return_value = 2
    dependencies["plans"].update_times.return_value = 1

    assert application.list_plans() == ["plan"]
    assert application.list_room_types() == ["room"]
    assert application.list_floors("query") == ["floor"]
    assert application.delete_plans(["a", "b"]) == 2
    assert application.modify_plan_times(["a"], start_hour=9) == 1


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
    dependencies["scheduler"].configure_task.assert_called_once_with()

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
    status = Mock(exists=True, next_run="tomorrow")
    dependencies["scheduler"].get_task_status.return_value = status
    dependencies["plans"].list_enabled.return_value = [BookingPlan(1, 100, "A001", 8, 4)]

    assert application.scheduler_status() is status
    assert application.repair_daily_scheduler() == (True, "ok")
    dependencies["scheduler"].configure_task.assert_called_once_with()


def test_scheduler_repair_requires_an_enabled_plan(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["plans"].list_enabled.return_value = []

    success, message = application.repair_daily_scheduler()

    assert success is False
    assert "至少一个预约方案" in message
    dependencies["scheduler"].configure_task.assert_not_called()
