"""Unit tests for small services and persistence boundaries."""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path
from unittest.mock import MagicMock, Mock

import pytest
import yaml

from hdu_sniper.booking.models import BookingPlan, PlanStatus
from hdu_sniper.booking.plans import BookingPlans
from hdu_sniper.booking.retry import (
    RetryDecision,
    booking_failed,
    default_retry_decider,
    is_time_out_of_range,
)
from hdu_sniper.config import Settings
from hdu_sniper.diagnostics import desktop_self_check
from hdu_sniper.library import responses
from hdu_sniper.library.signing import generate_api_token
from hdu_sniper.notifier import Notifier
from hdu_sniper.paths import AppPaths


def _paths(tmp_path: Path) -> AppPaths:
    return AppPaths(
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        state_dir=tmp_path / "state",
        log_dir=tmp_path / "state" / "logs",
    )


def _plan(**changes) -> BookingPlan:
    values = {
        "room_type": 1,
        "floor_id": 100,
        "seat_num": "001",
        "start_hour": 8,
        "duration_hours": 4,
    }
    values.update(changes)
    return BookingPlan(**values)


def test_booking_plan_validation_serialization_and_status() -> None:
    invalid = _plan(room_type=9, floor_id=0, seat_num=" ", start_hour=24, duration_hours=0)

    assert len(invalid.validate()) == 5
    restored = BookingPlan.from_dict({**_plan().to_dict(), "unknown": "ignored"})
    assert restored.to_plan_code() == "1:100:001:8:4"
    assert restored.enabled is True
    restored.status = PlanStatus.DISABLED
    assert restored.enabled is False


def test_booking_plans_requires_absolute_storage_path(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        BookingPlans("plans.yaml", Mock(), Mock())


def test_booking_plans_persistence_crud_and_cache(tmp_path: Path) -> None:
    path = (tmp_path / "config" / "plans.yaml").resolve()
    repository = BookingPlans(path, Mock(), Mock())
    first = _plan(status=PlanStatus.DISABLED)
    second = _plan(seat_num="002")

    assert repository.list_all() == []
    repository.add(first)
    repository.add(second)

    assert first.plan_id and first.created_at
    assert [plan.seat_num for plan in repository.list_all()] == ["001", "002"]
    assert [plan.seat_num for plan in repository.list_enabled()] == ["002"]
    assert repository.update_times([second.plan_id], start_hour=9, duration_hours=2) == 1
    assert repository.list_all()[1].start_hour == 9
    assert repository.delete([first.plan_id]) == 1
    assert repository.delete(["missing"]) == 0
    assert yaml.safe_load(path.read_text(encoding="utf-8"))[0]["seat_num"] == "002"

    reloaded = BookingPlans(path, Mock(), Mock()).list_all()
    assert len(reloaded) == 1
    assert reloaded[0].duration_hours == 2


def test_booking_plans_handles_empty_or_non_list_yaml(tmp_path: Path) -> None:
    path = (tmp_path / "plans.yaml").resolve()
    path.write_text("schema: invalid\n", encoding="utf-8")
    assert BookingPlans(path, Mock(), Mock()).list_all() == []

    path.write_text("", encoding="utf-8")
    assert BookingPlans(path, Mock(), Mock()).list_all() == []


def test_booking_plans_delegates_queries_and_creates_valid_plan(tmp_path: Path) -> None:
    client = Mock(name="client")
    client.name = "Alice"
    client.uid = "uid-1"
    rooms = Mock()
    rooms.list_room_types.return_value = [{"name": "自习室"}]
    rooms.list_floors.return_value = ["floor"]
    repository = BookingPlans((tmp_path / "plans.yaml").resolve(), client, rooms)

    assert repository.list_room_types() == [{"name": "自习室"}]
    assert repository.list_floors("query") == ["floor"]
    plan, errors, fell_back = repository.create(
        room_type_name="自习室",
        room_query="query",
        floor_id=100,
        seat_num="001",
        start_hour=8,
        duration_hours=4,
    )

    assert errors == []
    assert fell_back is False
    assert plan.booker_name == "Alice"
    assert repository.list_all() == [plan]


def test_booking_plans_invalid_creation_is_not_persisted(tmp_path: Path) -> None:
    client = Mock(name="client")
    client.name = ""
    client.uid = "uid-1"
    repository = BookingPlans((tmp_path / "plans.yaml").resolve(), client, Mock())

    plan, errors, fell_back = repository.create(
        room_type_name="unknown",
        room_query="query",
        floor_id=0,
        seat_num="",
        start_hour=-1,
        duration_hours=0,
    )

    assert plan.room_type == 1
    assert fell_back is True
    assert len(errors) == 4
    assert repository.list_all() == []


@pytest.mark.parametrize(
    ("result", "failed"),
    [
        (None, True),
        ({}, True),
        ({"CODE": "error"}, True),
        ({"CODE": "ok", "DATA": {"result": "fail"}}, True),
        ({"CODE": " OK ", "DATA": {"result": "success"}}, False),
    ],
)
def test_booking_failed_is_conservative(result, failed: bool) -> None:
    assert booking_failed(result) is failed


@pytest.mark.parametrize(
    ("message", "action"),
    [
        (responses.MSG_TIME_OUT_OF_RANGE, RetryDecision.CONTINUE),
        (responses.MSG_DUPLICATE, RetryDecision.SKIP),
        (responses.MSG_SEAT_UNAVAILABLE, RetryDecision.SKIP),
        (responses.MSG_INVALID_REQUEST, RetryDecision.STOP),
        ("unknown failure", RetryDecision.SKIP),
    ],
)
def test_default_retry_decider_maps_server_messages(message: str, action: str) -> None:
    result = {"CODE": "error", "DATA": {"msg": message}}
    assert default_retry_decider(result).action == action
    assert is_time_out_of_range(result) is (message == responses.MSG_TIME_OUT_OF_RANGE)


def test_retry_decider_allows_explicit_success() -> None:
    decision = default_retry_decider({"CODE": "ok"})
    assert decision.action == RetryDecision.CONTINUE
    assert decision.reason == ""


def test_notifier_writes_log_and_posts_webhook(tmp_path: Path, monkeypatch) -> None:
    post = Mock()
    monkeypatch.setattr("hdu_sniper.notifier.requests.post", post)
    log_file = tmp_path / "logs" / "booking.log"

    Notifier(log_file, "https://example.invalid/webhook").send("title", "body", success=False)

    text = log_file.read_text(encoding="utf-8")
    assert "[FAILED] title" in text
    assert "body" in text
    post.assert_called_once_with(
        "https://example.invalid/webhook",
        json={"title": "title", "content": "body"},
        timeout=10,
    )


def test_notifier_ignores_log_and_webhook_failures(tmp_path: Path, monkeypatch) -> None:
    import requests

    monkeypatch.setattr(
        "hdu_sniper.notifier.requests.post",
        Mock(side_effect=requests.RequestException("offline")),
    )
    Notifier(tmp_path, "https://example.invalid/webhook").send("title", "body")


def test_generate_api_token_is_deterministic() -> None:
    token, api_time = generate_api_token("seat-1", "uid-1", 123, 4, api_time=456)
    source = (
        "post&/Seat/Index/bookSeats?LAB_JSON=1"
        "&api_time456&beginTime123&duration4&is_recommend1"
        "&seatBookers[0]uid-1&seats[0]seat-1"
    )
    expected = base64.b64encode(
        hashlib.md5(source.encode(), usedforsecurity=False).hexdigest().encode()
    ).decode()
    assert (token, api_time) == (expected, 456)


def test_generate_api_token_supplies_current_time(monkeypatch) -> None:
    class FixedDateTime:
        @staticmethod
        def now(_timezone):
            return MagicMock(timestamp=Mock(return_value=789.9))

    monkeypatch.setattr("hdu_sniper.library.signing.datetime", FixedDateTime)
    assert generate_api_token("seat", "uid", 1, 2)[1] == 789


def test_runtime_create_app_wires_shared_dependencies(tmp_path: Path, monkeypatch) -> None:
    from hdu_sniper import runtime

    settings = Settings(paths=_paths(tmp_path))
    client = Mock(name="client")
    rooms = Mock(name="rooms")
    plans = Mock(name="plans")
    login = Mock(name="login")
    notifier = Mock(name="notifier")
    booking = Mock(name="booking")
    scheduler = Mock(name="scheduler")
    monkeypatch.setattr(runtime, "load_settings", Mock(return_value=settings))
    monkeypatch.setattr(runtime, "LibraryClient", Mock(return_value=client))
    monkeypatch.setattr(runtime, "LibraryRooms", Mock(return_value=rooms))
    monkeypatch.setattr(runtime, "BookingPlans", Mock(return_value=plans))
    monkeypatch.setattr(runtime, "LibraryLogin", Mock(return_value=login))
    monkeypatch.setattr(runtime, "Notifier", Mock(return_value=notifier))
    monkeypatch.setattr(runtime, "BookingRunner", Mock(return_value=booking))
    monkeypatch.setattr(runtime, "SchedulerService", Mock(return_value=scheduler))

    app = runtime.create_app()

    assert app.client is client
    assert app.plans is plans
    runtime.BookingRunner.assert_called_once_with(
        settings, client, plans, notifier, rooms=rooms, login=login
    )


def test_get_app_is_cached(monkeypatch) -> None:
    from hdu_sniper import runtime

    runtime.get_app.cache_clear()
    create = Mock(return_value=object())
    monkeypatch.setattr(runtime, "create_app", create)
    assert runtime.get_app() is runtime.get_app()
    create.assert_called_once_with()
    runtime.get_app.cache_clear()


def test_desktop_self_check_handles_frozen_missing_browser(monkeypatch) -> None:
    monkeypatch.setattr("hdu_sniper.diagnostics.sys.frozen", True, raising=False)
    monkeypatch.setattr("hdu_sniper.diagnostics.configure_packaged_browser", lambda: None)
    assert desktop_self_check() == 10


def test_desktop_self_check_launch_success_and_failure(monkeypatch) -> None:
    monkeypatch.setattr("hdu_sniper.diagnostics.sys.frozen", False, raising=False)
    monkeypatch.setattr("hdu_sniper.diagnostics.configure_packaged_browser", lambda: None)
    playwright = MagicMock()
    context = MagicMock()
    context.__enter__.return_value = playwright
    monkeypatch.setattr("hdu_sniper.diagnostics.sync_playwright", Mock(return_value=context))
    assert desktop_self_check() == 0
    playwright.chromium.launch.return_value.close.assert_called_once_with()

    context.__enter__.side_effect = RuntimeError("browser failed")
    assert desktop_self_check() == 11
