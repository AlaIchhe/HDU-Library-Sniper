"""Fixed booking-day and three-day planning rules."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import Mock

import pytest

from hdu_sniper.booking.models import BookingPlan
from hdu_sniper.booking.time import CST, build_begin_time, planning_lookup_times
from hdu_sniper.library.client import HduLibraryError
from hdu_sniper.library.rooms import LibraryRooms
from hdu_sniper.scheduler import DAILY_RUN_TIME, SchedulerService


def _floor(floor_id: str, name: str, *seats: str) -> dict:
    return {
        "roomName": name,
        "seatMap": {
            "info": {"id": floor_id},
            "POIs": [{"id": f"id-{seat}", "title": seat} for seat in seats],
        },
    }


def test_booking_time_is_always_day_after_tomorrow() -> None:
    now = datetime(2026, 7, 13, 23, 59, tzinfo=CST)

    result = build_begin_time(8, now)

    assert result == datetime(2026, 7, 15, 8, 0, tzinfo=CST)


def test_planning_queries_today_tomorrow_and_day_after() -> None:
    now = datetime(2026, 7, 13, 21, 30, tzinfo=CST)

    result = planning_lookup_times(now)

    assert result == (
        datetime(2026, 7, 13, 8, 0, tzinfo=CST),
        datetime(2026, 7, 14, 8, 0, tzinfo=CST),
        datetime(2026, 7, 15, 8, 0, tzinfo=CST),
    )


def test_booking_plan_rejects_day_offset() -> None:
    with pytest.raises(TypeError):
        BookingPlan(
            room_type=1,
            floor_id=100,
            seat_num="001",
            start_hour=8,
            duration_hours=4,
            days_offset=1,
        )


def test_floor_browser_merges_three_days_and_tolerates_one_failure(monkeypatch) -> None:
    lookups = planning_lookup_times(datetime(2026, 7, 13, 12, tzinfo=CST))
    monkeypatch.setattr("hdu_sniper.library.rooms.planning_lookup_times", lambda: lookups)
    client = Mock()
    client.get_room_detail.return_value = {
        "space_category": {"category_id": "cat", "content_id": "content"},
    }
    client.get_seat_map.side_effect = [
        [_floor("100", "一楼", "001")],
        HduLibraryError("明日暂不可查"),
        [_floor("100", "一楼", "001", "002"), _floor("200", "二楼", "101")],
    ]

    floors = LibraryRooms(client).list_floors("query")

    assert [(floor.floor_id, floor.seat_titles) for floor in floors] == [
        ("100", ["001", "002"]),
        ("200", ["101"]),
    ]
    assert [call.args[2] for call in client.get_seat_map.call_args_list] == list(lookups)


def test_floor_browser_fails_only_when_all_three_queries_fail(monkeypatch) -> None:
    lookups = planning_lookup_times(datetime(2026, 7, 13, 12, tzinfo=CST))
    monkeypatch.setattr("hdu_sniper.library.rooms.planning_lookup_times", lambda: lookups)
    client = Mock()
    client.get_room_detail.return_value = {
        "space_category": {"category_id": "cat", "content_id": "content"},
    }
    client.get_seat_map.side_effect = HduLibraryError("不可查询")

    with pytest.raises(HduLibraryError, match="今天至后天"):
        LibraryRooms(client).list_floors("query")


def test_scheduler_public_configuration_is_fixed_to_20_00(tmp_path) -> None:
    scheduler = SchedulerService(Mock(), tmp_path)
    scheduler.system = "Windows"
    scheduler._configure_windows_task = Mock(return_value=(True, "ok"))

    assert scheduler.configure_task(wake_to_run=False) == (True, "ok")
    scheduler._configure_windows_task.assert_called_once_with(DAILY_RUN_TIME, False)
