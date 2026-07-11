"""慧图 API 契约结构校验。

加载 ``docs/contracts/samples/*.json``,对每条 ``core.contract`` 访问器在样例上
断言其输出——测试与运行代码共享**同一**魔法路径真源(访问器名),服务器改响应结构
→ 重新抓包更新样例 → 本测试非零退出,提醒契约漂移。

运行::

    python tests/test_contracts.py

依赖:仅 stdlib(json/pathlib/sys),无需 pytest。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))  # 使 from core import contract 可导入

from core import contract  # noqa: E402

CONTRACTS_DIR = REPO_ROOT / "docs" / "contracts"
SAMPLES_DIR = CONTRACTS_DIR / "samples"

FAILURES: list[str] = []


def _load(name: str) -> dict:
    return json.loads((SAMPLES_DIR / name).read_text(encoding="utf-8"))


def _check(cond: bool, msg: str) -> None:
    if not cond:
        FAILURES.append(msg)


def test_room_types() -> None:
    """contract.room_types_from_response: samples/room_types.json"""
    s = _load("room_types.json")
    items = contract.room_types_from_response(s)
    _check(isinstance(items, list) and len(items) > 0, "room_types: 解析出非空列表")
    for it in items:
        _check(
            contract.room_type_name(it) and contract.room_type_query(it),
            f"room_types: 项缺 name/query: {it}",
        )


def test_room_detail() -> None:
    """contract.room_detail_from_response / space_category_id: samples/room_detail.json"""
    s = _load("room_detail.json")
    detail = contract.room_detail_from_response(s)
    _check(contract.space_category_id(detail), "room_detail: space_category_id 空")
    _check(contract.space_category_content_id(detail), "room_detail: content_id 空")


def test_seat_map() -> None:
    """contract.floors_from_response + floor_id/floor_seats/seat_id/seat_title: samples/seat_map.json"""
    s = _load("seat_map.json")
    floors = contract.floors_from_response(s)
    _check(isinstance(floors, list) and len(floors) > 0, "seat_map: 楼层非空列表")
    for f in floors:
        _check(contract.floor_id(f), f"seat_map: 楼层缺 floor_id: {contract.floor_name(f)}")
        seats = contract.floor_seats(f)
        _check(isinstance(seats, list), f"seat_map: {contract.floor_name(f)} seats 非列表")
        for p in seats:
            _check(
                contract.seat_id(p) and contract.seat_title(p), f"seat_map: seat 缺 id/title: {p}"
            )


def test_base_info() -> None:
    """contract.base_info_data → is_login/uid;学号 vs uid 钉死"""
    s = _load("baseInfo.json")
    data = contract.base_info_data(s)
    _check(contract.base_info_is_login(data) is True, "baseInfo: DATA.is_login != True")
    _check(contract.base_info_uid(data), "baseInfo: DATA.uid 空")
    _check(
        "cardno" in data.get("user_info", {}),
        "baseInfo: DATA.user_info.cardno 缺(学号 vs uid 区分)",
    )


def test_book_seats() -> None:
    """已验证的 bookSeats 各场景 CODE/MESSAGE。"""
    s = _load("book_seats.json")

    def code(k: str) -> object:
        return s[k]["response"]["CODE"]

    def msg(k: str) -> str:
        return s[k]["response"]["MESSAGE"]

    _check(
        "超出可预约座位时间范围" in msg("time_out_of_range"),
        "book_seats: time_out_of_range MESSAGE 错",
    )
    _check(code("time_out_of_range") == "ParamError", "book_seats: time_out_of_range CODE 错")
    _check("已有预约" in msg("duplicate"), "book_seats: duplicate MESSAGE 错")
    _check(
        "选择的座位无法预约" in msg("seat_unavailable"), "book_seats: seat_unavailable MESSAGE 错"
    )
    _check(code("rate_limited") == 1, "book_seats: rate_limited CODE 非 1")


def test_my_booking_list() -> None:
    """contract.bookings_from_response + booking_begin_ts:真实字段 seatNum/time/id。"""
    s = _load("myBookingList.json")
    items = contract.bookings_from_response(s)
    _check(isinstance(items, list), "myBookingList: content.defaultItems 非列表")
    for it in items:
        _check(
            all(k in it for k in ("seatNum", "time", "id")),
            f"myBookingList: 项缺 seatNum/time/id: {it}",
        )
        _check(
            isinstance(contract.booking_begin_ts(it), int),
            f"myBookingList: time 非可解析 int: {it}",
        )


def test_msg_constants_match_samples() -> None:
    """contract.MSG_* 必须与样例一致(单一源,不再两份对齐)。"""
    s = _load("book_seats.json")
    _check(
        contract.MSG_TIME_OUT_OF_RANGE in s["time_out_of_range"]["response"]["MESSAGE"],
        "contract.MSG_TIME_OUT_OF_RANGE 与样例不一致",
    )
    _check(
        contract.MSG_DUPLICATE in s["duplicate"]["response"]["MESSAGE"],
        "contract.MSG_DUPLICATE 与样例不一致",
    )
    _check(
        contract.MSG_SEAT_UNAVAILABLE in s["seat_unavailable"]["response"]["MESSAGE"],
        "contract.MSG_SEAT_UNAVAILABLE 与样例不一致",
    )


TESTS = [
    test_room_types,
    test_room_detail,
    test_seat_map,
    test_base_info,
    test_book_seats,
    test_my_booking_list,
    test_msg_constants_match_samples,
]


def main() -> None:
    for t in TESTS:
        t()
    if FAILURES:
        print(f"FAIL ({len(FAILURES)}):", file=sys.stderr)
        for f in FAILURES:
            print(f"  - {f}", file=sys.stderr)
        sys.exit(1)
    print(f"OK — {len(TESTS)} 项契约校验通过")


if __name__ == "__main__":
    main()
