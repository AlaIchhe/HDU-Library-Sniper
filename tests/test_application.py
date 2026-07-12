"""应用门面状态与事件契约测试。"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

from application import EventKind, JobState, SniperApplication
from config.paths import AppPaths
from config.settings import Settings
from core.sniper import BookingPlan, BookingResult


def build_test_application(tmp_path: Path) -> tuple[SniperApplication, dict[str, Mock]]:
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
        "auth": Mock(),
        "browser_auth": Mock(),
        "booking": Mock(),
        "plan_service": Mock(),
        "scheduler": Mock(),
    }
    application = SniperApplication(
        settings,
        dependencies["client"],
        dependencies["plans"],
        dependencies["notifier"],
        auth=dependencies["auth"],
        browser_auth=dependencies["browser_auth"],
        booking=dependencies["booking"],
        plan_service=dependencies["plan_service"],
        scheduler=dependencies["scheduler"],
    )
    return application, dependencies


def test_authentication_publishes_state_and_saves_credentials(tmp_path: Path) -> None:
    application, dependencies = build_test_application(tmp_path)
    dependencies["browser_auth"].login_with_credentials.return_value = (True, "认证成功")
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
    dependencies["plan_service"].list_enabled.return_value = [plan]

    def book_now(_plans, on_progress):
        on_progress(result)
        return [result]

    dependencies["booking"].book_now.side_effect = book_now
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
