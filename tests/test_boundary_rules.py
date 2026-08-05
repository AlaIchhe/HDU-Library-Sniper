"""Boundary rules documented in docs/analysis and docs/api."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from hdu_sniper.booking.models import BookingPlan
from hdu_sniper.booking.time import CST, parse_execute_at
from hdu_sniper.library import responses
from hdu_sniper.server import create_server_app


def _plan(**changes: object) -> BookingPlan:
    values: dict[str, object] = {
        "room_type": 1,
        "floor_id": 100,
        "seat_num": "001",
        "start_hour": 8,
        "duration_hours": 4,
    }
    values.update(changes)
    return BookingPlan(**values)


def test_parse_execute_at_accepts_iso_utc_naive_cst_and_epochs() -> None:
    utc_target = datetime(2026, 8, 5, 20, 0, tzinfo=UTC)
    cst_target = datetime(2026, 8, 5, 20, 0, tzinfo=CST)

    assert parse_execute_at("2026-08-05T20:00:00Z") == pytest.approx(utc_target.timestamp())
    assert parse_execute_at("2026-08-05T20:00:00") == pytest.approx(cst_target.timestamp())
    assert parse_execute_at(utc_target) == pytest.approx(utc_target.timestamp())
    assert parse_execute_at(str(utc_target.timestamp())) == pytest.approx(
        utc_target.timestamp()
    )
    assert parse_execute_at(str(int(utc_target.timestamp() * 1000))) == pytest.approx(
        utc_target.timestamp()
    )


def test_parse_execute_at_rejects_empty_value() -> None:
    with pytest.raises(ValueError):
        parse_execute_at("")


def test_seat_candidates_preserve_order_and_deduplicate() -> None:
    plan = _plan(
        seat_num=" 001 ",
        fallback_seats=["002", " 001 ", "", "002"],
    )

    assert plan.seat_candidates == ["001", "002"]


@pytest.mark.parametrize(
    ("changes", "expected_error"),
    [
        ({"room_type": 0}, "无效的房间类型"),
        ({"room_type": 5}, "无效的房间类型"),
        ({"floor_id": 0}, "无效的楼层 ID"),
        ({"floor_id": -1}, "无效的楼层 ID"),
        ({"seat_num": ""}, "座位号不能为空"),
        ({"seat_num": "   "}, "座位号不能为空"),
        ({"start_hour": -1}, "开始小时超出范围"),
        ({"start_hour": 24}, "开始小时超出范围"),
        ({"duration_hours": 0}, "时长必须为正数"),
        ({"duration_hours": -2}, "时长必须为正数"),
        ({"fallback_seats": "002"}, "备选座位必须是列表"),
    ],
)
def test_booking_plan_validation_rejects_boundary_values(
    changes: dict[str, object],
    expected_error: str,
) -> None:
    errors = _plan(**changes).validate()

    assert any(expected_error in error for error in errors)


def test_booking_plan_validation_accepts_boundary_values() -> None:
    assert _plan(
        room_type=4,
        floor_id=1,
        seat_num="999",
        start_hour=0,
        duration_hours=1,
        fallback_seats=[],
    ).validate() == []
    assert _plan(start_hour=23).validate() == []


def test_booking_state_maps_actionable_statuses_and_fail_closed_window() -> None:
    pending = {
        "status": "0",
        "time": "2000",
        "nowTime": "0",
        "limitSignAgo": "1800",
        "limitSignBack": "1800",
    }
    check_in_available = {**pending, "nowTime": "1000"}

    assert responses.booking_state(pending) == responses.BOOKING_STATE_PENDING
    assert responses.booking_state(check_in_available) == responses.BOOKING_STATE_CHECK_IN
    assert responses.booking_state({"status": "1"}) == responses.BOOKING_STATE_IN_USE
    assert responses.booking_state({"status": "2"}) == responses.BOOKING_STATE_AWAY
    assert responses.booking_state({"status": "6"}) == responses.BOOKING_STATUS_AWAY_EXPIRED
    assert responses.booking_state({"status": "3"}) == responses.BOOKING_STATUS_FINISHED
    assert responses.booking_is_check_in_available({"status": "0"}) is False


def test_local_api_maps_domain_errors_to_http_statuses() -> None:
    application = Mock(authenticated=True)
    application.cancel_remote_booking.side_effect = ValueError("预约 ID 必须是数字")
    application.check_in_booking.return_value = (False, "当前预约状态为 1，不能签到")
    application.run_booking.side_effect = ValueError("没有启用的预约方案")
    application.list_scheduled_tasks.side_effect = RuntimeError("任务计划程序不可用")

    client = TestClient(create_server_app(application))

    assert client.delete("/api/v1/bookings/abc").status_code == 404
    assert client.post("/api/v1/bookings/1/check-in").status_code == 409
    assert client.post("/api/v1/booking/run").status_code == 409
    assert client.get("/api/v1/schedules").status_code == 503


def test_local_api_requires_authentication_for_protected_routes() -> None:
    client = TestClient(create_server_app(Mock(authenticated=False)))

    assert client.get("/api/v1/status").status_code == 401
    assert client.get("/api/v1/bookings").status_code == 401
    assert client.post("/api/v1/booking/run").status_code == 401
    assert client.get("/api/v1/schedules").status_code == 401
