"""慧图 API 契约的运行期单一入口：魔法路径 + ``MSG_*`` 常量。

每个访问器标注样例来源(见 ``docs/contracts/samples/<file>.json``)；
``tests/test_contracts.py`` 对每条访问器在样例上断言——服务器改响应结构
→ 重新抓包更新样例 → 测试非零退出，提醒契约漂移。

本模块是**纯叶模块**(仅依赖 stdlib，不导入 ``core/*``)，故与 ``client.py``/
``room_browser.py``/``retry.py`` 无环。结构漂移时访问器自然抛
``KeyError``/``IndexError``/``TypeError``，由 ``LibraryClient`` 边界捕获并
转 ``RoomQueryError``/``SeatQueryError``；只有 ``bookings_from_response``
刻意容错(返回 ``[]``)，因 ``get_todays_bookings`` 是超时幂等确认的
best-effort 查询，不应因结构漂移把"未确认"升级成"硬错误"。

契约文档(人读形状规约、TypedDict)见 ``docs/contracts/schemas.md`` 与
``docs/contracts/00_overview.md``；本模块不导入它(schema 在 docs/，非运行期
sys.path)，避免双份常量漂移。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import unquote

# ---- MSG_* (实抓验证，见 samples/book_seats.json) ----------------------------------------
# CODE=ParamError 被 time_out_of_range / duplicate / seat_unavailable 共用，
# 只能靠 MESSAGE 子串区分(契约关键发现 #2)。
MSG_TIME_OUT_OF_RANGE = "超出可预约座位时间范围"
MSG_DUPLICATE = "已有预约，请勿重复预约！"
MSG_SEAT_UNAVAILABLE = "选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用，请换一个再试"
MSG_INVALID_REQUEST = "非法请求"  # 未实抓(需坏签名触发)


# ---- 房间类型: GET /Space/Category/list  (见 samples/room_types.json) --------------------
def room_types_from_response(data: dict[str, Any]) -> list[dict[str, Any]]:
    """``content.children[1].defaultItems`` → ``[{name, query}, ...]``。

    ``children`` = [Ridge, com.List, null]；``[1]`` = com.List，其
    ``defaultItems`` 项含 ``name`` + ``link.url``(解码后取 ``?`` 后的 query 串，
    带 ``space_category[category_id/content_id]``)。
    """
    raw_items = data["content"]["children"][1]["defaultItems"]
    items: list[dict[str, Any]] = []
    for item in raw_items:
        link_url = unquote(item["link"]["url"])
        items.append({"name": item["name"], "query": link_url.split("?", 1)[1]})
    return items


def room_type_name(item: dict[str, Any]) -> str:
    return item["name"]


def room_type_query(item: dict[str, Any]) -> str:
    return item["query"]


# ---- 房间详情: GET /Seat/Index/searchSeats?{query}  (见 samples/room_detail.json) --------
def room_detail_from_response(response: dict[str, Any]) -> dict[str, Any]:
    """``response.data``(小写) = ``{ui_type, is_login, uid, space_category:{...}, ...}``。

    注意是小写 ``data``(LAB_JSON=1 时返回 UI 页面树，信封顶层键之一)，
    非非-LAB_JSON 的 ``DATA``。``_load_seat_map`` 取
    ``data.space_category.{category_id, content_id}`` 调 ``get_seat_map``。
    """
    data = response.get("data")
    if not isinstance(data, dict):
        raise KeyError("room_detail: response.data 缺失或非对象")
    return data


def space_category_id(detail: dict[str, Any]) -> str:
    return str(detail["space_category"]["category_id"])


def space_category_content_id(detail: dict[str, Any]) -> str:
    return str(detail["space_category"]["content_id"])


# ---- 座位分布图: POST /Seat/Index/searchSeats  (见 samples/seat_map.json) --------------
def floors_from_response(response: dict[str, Any]) -> list[dict[str, Any]]:
    """``allContent.children[2].children.children`` = 楼层数组。

    ``allContent.children`` = [UI block, UI block, com.CatCon]；``[2].children``
    是 object wrapper(非数组)，其 ``.children`` 才是楼层数组。每层
    ``seatMap.info.id`` = 楼层 id，``seatMap.POIs[]`` = 座位项。
    """
    return response["allContent"]["children"][2]["children"]["children"]


def floor_id(floor: dict[str, Any]) -> str:
    """楼层 ``seatMap.info.id``(字符串)。"""
    return str((floor.get("seatMap") or {}).get("info", {}).get("id", ""))


def floor_name(floor: dict[str, Any]) -> str:
    return str(floor.get("roomName", "?"))


def floor_seats(floor: dict[str, Any]) -> list[dict[str, Any]]:
    """楼层 ``seatMap.POIs`` 列表(每项 = SeatPoi: id/title/state/...)。"""
    seats = (floor.get("seatMap") or {}).get("POIs", [])
    return seats if isinstance(seats, list) else []


def seat_id(seat: dict[str, Any]) -> str:
    """座位 ``id``(seat_id，``bookSeats`` 的 ``seats[0]`` 用它)。"""
    return str(seat["id"])


def seat_title(seat: dict[str, Any]) -> str:
    """座位 ``title``(座位号，``RoomBrowser.find_seat`` 用它匹配 plan.seat_num)。"""
    return str(seat.get("title", ""))


# ---- baseInfo: GET /User/Center/baseInfo (不带 LAB_JSON)  (见 samples/baseInfo.json) -----
def base_info_data(response: dict[str, Any]) -> dict[str, Any]:
    """``DATA`` = ``{is_login, uid, user_info:{cardno/name(学号)}, ...}``。

    ``uid``(平台用户 id，签名用) ≠ ``user_info.cardno/name``(学号)。
    """
    data = response.get("DATA")
    if not isinstance(data, dict):
        raise KeyError("baseInfo: DATA 缺失或非对象")
    return data


def base_info_is_login(data: dict[str, Any]) -> bool:
    return bool(data.get("is_login"))


def base_info_uid(data: dict[str, Any]) -> str:
    return str(data.get("uid") or "")


# ---- 今日/近期预约列表: GET /Seat/Index/myBookingList?fromType=web  (见 samples/myBookingList.json) ----
def bookings_from_response(data: dict[str, Any]) -> list[dict[str, Any]]:
    """``content.defaultItems`` = order_item[]。

    order item 字段: ``seatNum``(座位号，非 seat_id) / ``time``(开始戳，秒，字符串) /
    ``id``(预约记录 id)。**容错**: ``data`` 非 dict 或缺 ``content.defaultItems``
    返回 ``[]``——本访问器供超时幂等确认(``find_confirmed_booking``)用，是
    best-effort 查询，结构漂移时按"未找到"处理，不应升级为硬错误。
    """
    items = (data.get("content") or {}).get("defaultItems") if isinstance(data, dict) else None
    return items if isinstance(items, list) else []


def booking_begin_ts(item: dict[str, Any]) -> int:
    """order ``time``(秒级戳，字符串)→ int。"""
    return int(item.get("time") or 0)
