"""HTTP client and room-domain boundary tests without external requests."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests

from hdu_sniper.booking.models import BookingPlan
from hdu_sniper.library.client import (
    AuthenticationExpiredError,
    CookieError,
    HduLibraryError,
    LibraryClient,
    RoomQueryError,
    SeatQueryError,
)
from hdu_sniper.library.rooms import LibraryRooms


def _response(status: int = 200, payload=None) -> Mock:
    response = Mock(status_code=status)
    response.json.return_value = {} if payload is None else payload
    return response


def _floor(floor_id: str = "100", *seats: str) -> dict:
    return {
        "roomName": "一楼",
        "seatMap": {
            "info": {"id": floor_id},
            "POIs": [{"id": f"id-{seat}", "title": seat} for seat in seats],
        },
    }


def test_client_initializes_custom_transport_options() -> None:
    client = LibraryClient(
        timeout=3,
        headers={"X-Test": "yes"},
        params={"p": "1"},
        verify=True,
        trust_env=True,
        uid=123,
        name="Alice",
        urls={"book_seat": "https://example.invalid/book"},
    )
    assert client.timeout == 3
    assert client.session.headers["X-Test"] == "yes"
    assert client.session.params == {"p": "1"}
    assert client.session.verify is True
    assert client.session.trust_env is True
    assert client.uid == "123"
    assert client.name == "Alice"
    assert client.urls["book_seat"] == "https://example.invalid/book"


def test_request_supports_get_post_and_redirect() -> None:
    client = LibraryClient()
    client.session = Mock()
    client.session.get.return_value = _response(302, {"get": True})
    client.session.post.return_value = _response(200, {"post": True})

    assert client._request("GET", "url", params={"a": 1}) == {"get": True}
    assert client._request("POST", "url", data={"b": 2}) == {"post": True}
    client.session.get.assert_called_once_with("url", params={"a": 1}, timeout=client.timeout)
    client.session.post.assert_called_once_with(
        "url", data={"b": 2}, params=None, timeout=client.timeout
    )


@pytest.mark.parametrize(
    ("side_effect", "is_timeout"),
    [(requests.Timeout("slow"), True), (requests.RequestException("offline"), False)],
)
def test_request_translates_transport_errors(side_effect: Exception, is_timeout: bool) -> None:
    client = LibraryClient()
    client.session = Mock()
    client.session.get.side_effect = side_effect
    with pytest.raises(HduLibraryError) as captured:
        client._request("GET", "url")
    assert captured.value.is_timeout is is_timeout


def test_request_rejects_http_json_and_shape_errors() -> None:
    client = LibraryClient()
    client.session = Mock()
    client.session.get.return_value = _response(500)
    with pytest.raises(HduLibraryError, match="HTTP 500"):
        client._request("GET", "url")

    broken = _response()
    broken.json.side_effect = ValueError("bad json")
    client.session.get.return_value = broken
    with pytest.raises(HduLibraryError, match="JSON"):
        client._request("GET", "url")

    client.session.get.return_value = _response(payload=[])
    with pytest.raises(HduLibraryError):
        client._request("GET", "url")

    client.session.get.return_value = _response(payload={"data": {"is_login": False}})
    with pytest.raises(AuthenticationExpiredError):
        client._request("GET", "url")


def test_cookie_header_cache_round_trip_and_validation(tmp_path: Path) -> None:
    client = LibraryClient()
    client.set_cookie_header("sid=abc; token=xyz; invalid")
    assert client.session.cookies.get("sid", domain="hdu.huitu.zhishulib.com", path="/") == "abc"
    with pytest.raises(CookieError):
        client.set_cookie_header("invalid-only")

    cache = (tmp_path / "session.cache").resolve()
    client.save_cookie_cache(cache, "sid=cached")
    assert cache.read_text(encoding="utf-8") == "sid=cached"
    client.load_cookie_cache(cache)
    with pytest.raises(ValueError):
        client.load_cookie_cache("relative.cache")
    with pytest.raises(CookieError):
        client.load_cookie_cache((tmp_path / "missing.cache").resolve())
    with pytest.raises(ValueError):
        client.save_cookie_cache("relative.cache", "cookie")


@pytest.mark.parametrize(
    ("payload", "valid"),
    [
        ({"DATA": {"is_login": True, "uid": "123"}}, True),
        ({"DATA": {"is_login": False, "uid": "123"}}, False),
        ({"DATA": {"is_login": True, "uid": "abc"}}, False),
        ({"invalid": True}, False),
    ],
)
def test_validate_cookie_uses_contract(payload: dict, valid: bool) -> None:
    client = LibraryClient()
    client._request = Mock(return_value=payload)
    assert client.validate_cookie() is valid

    client._request.side_effect = HduLibraryError("offline")
    assert client.validate_cookie() is False


def test_resolve_uid_caches_valid_value_and_rejects_invalid_responses() -> None:
    client = LibraryClient(uid="42")
    assert client.resolve_uid() == "42"

    client.uid = ""
    client._request = Mock(return_value={"DATA": {"is_login": True, "uid": "123"}})
    assert client.resolve_uid() == "123"
    assert client.resolve_uid() == "123"
    client._request.assert_called_once()

    for payload in (
        {"invalid": True},
        {"DATA": {"is_login": False, "uid": "123"}},
        {"DATA": {"is_login": True, "uid": "abc"}},
    ):
        client.uid = ""
        client._request = Mock(return_value=payload)
        with pytest.raises(HduLibraryError):
            client.resolve_uid()

    client._request = Mock(side_effect=HduLibraryError("offline"))
    with pytest.raises(HduLibraryError):
        client.resolve_uid()


def test_room_and_seat_queries_parse_contracts() -> None:
    client = LibraryClient()
    client._request = Mock(
        side_effect=[
            {
                "content": {
                    "children": [
                        {},
                        {"defaultItems": [{"name": "自习室", "link": {"url": "page?room=query"}}]},
                    ]
                }
            },
            {"data": {"space_category": {"category_id": "c", "content_id": "x"}}},
            {"allContent": {"children": [{}, {}, {"children": {"children": [_floor()]}}]}},
        ]
    )

    assert client.get_room_types() == [{"name": "自习室", "query": "room=query"}]
    assert client.get_room_detail("room=query")["space_category"]["category_id"] == "c"
    when = datetime(2026, 1, 1, tzinfo=UTC)
    assert client.get_seat_map("c", "x", when, duration_hours=2) == [_floor()]
    payload = client._request.call_args_list[2].args[2]
    assert payload["duration"] == 7200
    assert payload["space_category[category_id]"] == "c"


@pytest.mark.parametrize(
    ("method", "error_type"),
    [
        (lambda client: client.get_room_types(), RoomQueryError),
        (lambda client: client.get_room_detail("query"), RoomQueryError),
        (
            lambda client: client.get_seat_map("c", "x", datetime.now(UTC)),
            SeatQueryError,
        ),
    ],
)
def test_room_and_seat_queries_translate_contract_errors(method, error_type) -> None:
    client = LibraryClient()
    client._request = Mock(return_value={})
    with pytest.raises(error_type):
        method(client)


def test_booking_history_confirmation_is_best_effort() -> None:
    client = LibraryClient()
    client._request = Mock(return_value={"content": {"defaultItems": [{"time": "100"}]}})
    assert client.get_todays_bookings() == [{"time": "100"}]
    assert client.find_confirmed_booking(101) == {"time": "100"}

    client.get_todays_bookings = Mock(return_value=[None, {"time": "bad"}, {"time": "500"}])
    assert client.find_confirmed_booking(100) is None
    client.get_todays_bookings.side_effect = RuntimeError("offline")
    assert client.find_confirmed_booking(100) is None


def test_book_seat_builds_preview_and_real_request(monkeypatch) -> None:
    client = LibraryClient()
    token_generator = Mock(return_value=("token", 456))
    monkeypatch.setattr("hdu_sniper.library.client.generate_api_token", token_generator)
    begin = datetime(2026, 1, 1, tzinfo=UTC)

    preview = client.book_seat("seat", "uid", begin, 2, dry_run=True)
    assert preview["dry_run"] is True
    assert preview["payload"]["duration"] == 7200
    assert preview["api_token"] == "token"

    client._request = Mock(return_value={"CODE": "ok"})
    assert client.book_seat("seat", "uid", begin, 2) == {"CODE": "ok"}
    assert client.session.headers["Api-Token"] == "token"


def test_library_rooms_resolution_and_seat_errors() -> None:
    client = Mock()
    rooms = LibraryRooms(client)
    plan = BookingPlan(1, 100, "001", 8, 4, room_query="stored=query")
    assert rooms.list_room_types() is client.get_room_types.return_value
    assert rooms.resolve_room_query(plan) == "stored=query"

    plan.room_query = ""
    client.get_room_types.return_value = [{"name": "自习室", "query": "resolved=query"}]
    assert rooms.resolve_room_query(plan) == "resolved=query"
    floor = _floor("100", "001")
    assert rooms.find_seat([floor], 100, "001")[1]["id"] == "id-001"

    with pytest.raises(SeatQueryError):
        rooms.find_seat([floor], 999, "001")
    with pytest.raises(SeatQueryError):
        rooms.find_seat([floor], 100, "999")
    duplicate = _floor("100", "001", "001")
    with pytest.raises(SeatQueryError):
        rooms.find_seat([duplicate], 100, "001")

    client.get_room_types.return_value = []
    with pytest.raises(HduLibraryError):
        rooms.resolve_room_query(plan)
    client.get_room_types.return_value = [{"name": "讨论室", "query": "other"}]
    with pytest.raises(HduLibraryError):
        rooms.resolve_room_query(plan)


def test_library_rooms_loads_booking_floor_map(monkeypatch) -> None:
    client = Mock()
    client.get_room_detail.return_value = {
        "space_category": {"category_id": "c", "content_id": "x"}
    }
    client.get_seat_map.return_value = [_floor()]
    rooms = LibraryRooms(client)
    plan = BookingPlan(1, 100, "001", 8, 4, room_query="query")
    begin = datetime(2026, 1, 3, 8, tzinfo=UTC)
    monkeypatch.setattr("hdu_sniper.library.rooms.build_begin_time", lambda _hour: begin)

    assert rooms.get_floors_for_booking(plan) == [_floor()]
    client.get_seat_map.assert_called_once_with("c", "x", begin, 4)
    assert LibraryRooms.resolve_room_type("安静自习室") == 1
    assert LibraryRooms.resolve_room_type("unknown") is None
