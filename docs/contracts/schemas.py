"""慧图 API 响应 TypedDict 契约(类型参考)。

真实脱敏样例见 ``samples/*.json``；运行期结构校验见 ``tests/test_contracts.py``。
本模块仅作类型注解参考,不参与运行期校验——服务器响应字段以样例为准。

魔法路径与 ``MSG_*`` 常量的运行期定义在 ``core/contract.py``(单一源)；
本文件不导入它(位于 docs/，非运行期 sys.path)，避免双份漂移。
"""

from __future__ import annotations

from typing import Any, TypedDict


class HuituEnvelope(TypedDict):
    """不带 LAB_JSON 的只读 GET / 写 POST 的通用信封。"""

    CODE: str | int  # "ok" | "ParamError" | "请检查参数设置" | 1(限流) | ...
    MESSAGE: str
    DATA: dict[str, Any]
    ui_type: str  # "com.Message" 等
    _debug_info: list[str]  # 仅不带 LAB_JSON 时出现,如 ["没有指定LAB平台模板"]


class BaseInfoData(TypedDict):
    """``/User/Center/baseInfo``(不带 LAB_JSON)的 DATA。"""

    is_login: bool
    uid: str  # 平台用户 id(签名用),如 "304174"
    uname: str
    unickname: str
    user_info: dict[str, Any]  # 含 name/cardno(学号)、mobile 等
    lab_content_org_id: str


class RoomTypeItem(TypedDict):
    """``/Space/Category/list`` 的 ``content.children[1].defaultItems[]``。"""

    name: str  # "自习室" 等
    engName: str
    link: dict[str, str]  # link.url 含 space_category[category_id]=..&[content_id]=..


class SeatPoi(TypedDict):
    """座位图里的单个座位 ``seatMap.POIs[]``。"""

    id: str  # seat_id,bookSeats 的 seats[0]
    title: str  # 座位号,RoomBrowser.find_seat 用它匹配 plan.seat_num
    state: str | int  # 可用性状态(0/'1'/'3' 见过;含义未完全确定,'3' 对应某时刻已被占)
    x: str
    y: str
    w: str
    h: str
    have_socket: str
    gender: int  # 可缺省
    locker: list


class FloorItem(TypedDict):
    """座位图楼层项 ``allContent.children[2].children.children[]``。"""

    roomName: str
    seatMap: dict[str, Any]  # seatMap.info.id(楼层 id) + seatMap.POIs[](SeatPoi)
    orderInfo: Any
    userInfo: Any
    collapsed: bool
    ifAdjust: bool


class BookingOrderItem(TypedDict):
    """``/Seat/Index/myBookingList`` 的 order item。注意字段名。"""

    roomName: str
    seatNum: str  # 座位号(= POI title,非 seat_id)
    time: str  # 预约开始时间戳(秒)
    duration: str
    status: str  # "1"/"4"/"7" 等
    ifSponsor: bool
    limitSignAgo: int
    limitSignBack: int
    limitLeftBack: int
    orderTime: str
    id: int  # 预约记录 id
    nowTime: int
    link: dict[str, str]  # /Seat/Index/bookingInfo?bookingId=...
    spaceId: Any
    ibeacons: list


# MSG_* 运行期定义在 core/contract.py(单一源,与 samples/book_seats.json 实抓对齐)；
# 本文件仅作类型注解参考,不再持有常量副本,避免双份漂移。
