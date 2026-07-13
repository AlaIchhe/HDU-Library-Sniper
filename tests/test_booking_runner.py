"""Booking runner workflow tests with all network boundaries mocked."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

import pytest

from hdu_sniper.booking.models import BookingPlan, BookingResult
from hdu_sniper.booking.runner import BookingRunner, ExitCode
from hdu_sniper.config import Credentials, Settings
from hdu_sniper.library import responses
from hdu_sniper.library.client import HduLibraryError
from hdu_sniper.paths import AppPaths


def _plan(seat_num: str = "001") -> BookingPlan:
    return BookingPlan(1, 100, seat_num, 8, 4, booker_name="Alice")


def _runner(tmp_path: Path, **setting_changes) -> tuple[BookingRunner, dict[str, Mock]]:
    paths = AppPaths(
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        state_dir=tmp_path / "state",
        log_dir=tmp_path / "state" / "logs",
    )
    values = {
        "paths": paths,
        "max_trials": 3,
        "retry_delay": 0,
        "window_wait_seconds": 0,
        "window_poll_interval": 0.001,
    }
    values.update(setting_changes)
    dependencies = {
        "client": Mock(),
        "plans": Mock(),
        "notifier": Mock(),
        "rooms": Mock(),
        "login": Mock(),
    }
    runner = BookingRunner(
        Settings(**values),
        dependencies["client"],
        dependencies["plans"],
        dependencies["notifier"],
        rooms=dependencies["rooms"],
        login=dependencies["login"],
    )
    dependencies["rooms"].get_floors_for_booking.return_value = ["floor"]
    dependencies["rooms"].find_seat.return_value = ({"roomName": "一楼"}, {"id": "seat-1"})
    dependencies["client"].resolve_uid.return_value = "uid-1"
    return runner, dependencies


def test_runner_activity_and_cancellation_state(tmp_path: Path) -> None:
    runner, _ = _runner(tmp_path)
    assert runner.is_active is False
    assert runner.cancel() is False

    runner._begin()
    assert runner.is_active is True
    assert runner.cancel() is True
    assert runner._is_cancelled() is True
    with pytest.raises(RuntimeError):
        runner._begin()
    runner._finish()
    assert runner.is_active is False
    assert runner._is_cancelled() is False


def test_book_single_returns_room_query_failure(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path)
    dependencies["rooms"].get_floors_for_booking.side_effect = HduLibraryError("missing")

    result = runner._book_single(_plan())

    assert result.success is False
    assert "missing" in result.message
    dependencies["client"].book_seat.assert_not_called()


def test_book_single_handles_success_and_server_failure(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path)
    dependencies["client"].book_seat.return_value = {"CODE": "ok", "MESSAGE": "done"}

    success = runner._book_single(_plan())

    assert success.success is True
    assert success.message == "done"
    assert success.raw_response == {"CODE": "ok", "MESSAGE": "done"}
    args = dependencies["client"].book_seat.call_args.args
    assert args[0:2] == ("seat-1", "uid-1")
    assert args[3] == 4

    dependencies["client"].book_seat.return_value = {
        "CODE": "error",
        "DATA": {"msg": "denied"},
    }
    failure = runner._book_single(_plan())
    assert failure.success is False
    assert failure.message == "denied"


def test_book_single_dry_run_is_success(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path, dry_run=True)
    response = {"preview": True}
    dependencies["client"].book_seat.return_value = response

    result = runner._book_single(_plan())

    assert result.success is True
    assert result.raw_response is response
    assert dependencies["client"].book_seat.call_args.kwargs == {"dry_run": True}


@pytest.mark.parametrize("confirmed", [True, False])
def test_book_single_checks_confirmation_after_timeout(tmp_path: Path, confirmed: bool) -> None:
    runner, dependencies = _runner(tmp_path)
    dependencies["client"].book_seat.side_effect = HduLibraryError("timeout", is_timeout=True)
    dependencies["client"].find_confirmed_booking.return_value = {"id": 1} if confirmed else None

    result = runner._book_single(_plan())

    assert result.success is confirmed
    dependencies["client"].find_confirmed_booking.assert_called_once()


def test_book_single_does_not_confirm_non_timeout_error(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path)
    dependencies["client"].book_seat.side_effect = HduLibraryError("offline")

    result = runner._book_single(_plan())

    assert result.success is False
    dependencies["client"].find_confirmed_booking.assert_not_called()


def test_run_now_stops_after_first_success_and_reports_progress(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path)
    first, second = _plan("001"), _plan("002")
    success = BookingResult(first, True, "done")
    runner._book_single = Mock(return_value=success)
    progress = Mock()

    results = runner.run_now([first, second], on_progress=progress)

    assert results == [success]
    progress.assert_called_once_with(success)
    dependencies["notifier"].send.assert_called_once()
    assert runner.is_active is False


def test_execute_plans_skips_unavailable_plan_then_tries_next(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path)
    first, second = _plan("001"), _plan("002")
    unavailable = BookingResult(
        first,
        False,
        "unavailable",
        {"CODE": "error", "MESSAGE": responses.MSG_SEAT_UNAVAILABLE},
    )
    success = BookingResult(second, True, "done")
    runner._book_single = Mock(side_effect=[unavailable, success])

    results = runner.run_now([first, second])

    assert results == [unavailable, success]
    assert dependencies["notifier"].send.call_args.kwargs["success"] is True


def test_execute_plans_stops_on_invalid_request(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path)
    plan = _plan()
    invalid = BookingResult(
        plan,
        False,
        "invalid",
        {"CODE": "error", "MESSAGE": responses.MSG_INVALID_REQUEST},
    )
    runner._book_single = Mock(return_value=invalid)

    assert runner.run_now([plan]) == [invalid]
    assert dependencies["notifier"].send.call_args.kwargs["success"] is False


def test_execute_plans_retries_transport_failures(tmp_path: Path, monkeypatch) -> None:
    runner, dependencies = _runner(tmp_path, max_trials=2, retry_delay=1)
    plan = _plan()
    failure = BookingResult(plan, False, "offline")
    runner._book_single = Mock(return_value=failure)
    sleep = Mock()
    monkeypatch.setattr("hdu_sniper.booking.runner.time.sleep", sleep)
    monkeypatch.setattr("hdu_sniper.booking.runner.random.uniform", lambda _low, _high: 0)

    results = runner.run_now([plan])

    assert results == [failure, failure]
    sleep.assert_called_once_with(0.1)
    assert dependencies["notifier"].send.call_args.kwargs["success"] is False


def test_execute_plans_stops_when_booking_window_deadline_expires(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path, window_wait_seconds=0)
    plan = _plan()
    waiting = BookingResult(
        plan,
        False,
        "too early",
        {"CODE": "error", "MESSAGE": responses.MSG_TIME_OUT_OF_RANGE},
    )
    runner._book_single = Mock(return_value=waiting)

    assert runner.run_now([plan]) == [waiting]
    assert dependencies["notifier"].send.call_args.kwargs["success"] is False


def test_execute_plans_honors_preexisting_cancellation(tmp_path: Path) -> None:
    runner, _ = _runner(tmp_path)
    runner._is_cancelled = Mock(return_value=True)
    assert runner._execute_plans([_plan()], None) == []


def test_run_once_authentication_and_plan_exit_codes(tmp_path: Path) -> None:
    runner, dependencies = _runner(tmp_path)
    dependencies["login"].try_cache.return_value = False
    runner._relogin_with_credentials = Mock(return_value=False)
    assert runner.run_once() == ExitCode.AUTH_FAILED

    dependencies["login"].try_cache.return_value = True
    dependencies["plans"].list_enabled.return_value = []
    assert runner.run_once() == ExitCode.NO_PLANS


@pytest.mark.parametrize(
    ("success", "exit_code"),
    [(True, ExitCode.SUCCESS), (False, ExitCode.ALL_FAILED)],
)
def test_run_once_maps_booking_results(
    tmp_path: Path, success: bool, exit_code: int, capsys
) -> None:
    runner, dependencies = _runner(tmp_path)
    plan = _plan()
    result = BookingResult(plan, success, "result")
    dependencies["login"].try_cache.return_value = True
    dependencies["plans"].list_enabled.return_value = [plan]

    def run_now(_plans, on_progress):
        on_progress(result)
        return [result]

    runner.run_now = Mock(side_effect=run_now)
    assert runner.run_once() == exit_code
    assert "result" in capsys.readouterr().out


def test_relogin_with_credentials_branches(tmp_path: Path, monkeypatch) -> None:
    runner, dependencies = _runner(tmp_path)
    monkeypatch.setattr("hdu_sniper.booking.runner.load_credentials", lambda _path: None)
    assert runner._relogin_with_credentials() is False

    monkeypatch.setattr(
        "hdu_sniper.booking.runner.load_credentials",
        lambda _path: Credentials("student", "password"),
    )
    dependencies["login"].login_with_credentials.return_value = (False, "denied")
    assert runner._relogin_with_credentials() is False
    dependencies["notifier"].send.assert_called_once_with("自动登录失败", "denied", success=False)

    dependencies["login"].login_with_credentials.return_value = (True, "ok")
    assert runner._relogin_with_credentials() is True


def test_format_success_contains_plan_details(tmp_path: Path) -> None:
    runner, _ = _runner(tmp_path)
    result = BookingResult(_plan(), True, "done")
    text = runner._format_success(result)
    assert "1:100:001:8:4" in text
    assert "Alice" in text
    assert "done" in text
