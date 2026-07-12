"""慧图图书馆 HTTP 客户端。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import requests

from core import contract
from utils.encrypt import generate_api_token


URLS = {
    "book_seat": "https://hdu.huitu.zhishulib.com/Seat/Index/bookSeats",
    "query_seats": "https://hdu.huitu.zhishulib.com/Seat/Index/searchSeats",
    "query_rooms": "https://hdu.huitu.zhishulib.com/Space/Category/list",
    "user_base_info": "https://hdu.huitu.zhishulib.com/User/Center/baseInfo",
    # 契约验证:myBookingList?fromType=web 才返回预约列表(content.defaultItems)。
    # todayUserBookSeat 只返回字符串 'todayUserBookSeatAction',拿不到数据——不可用。
    "today_schedule": "https://hdu.huitu.zhishulib.com/Seat/Index/myBookingList?fromType=web",
}

DEFAULT_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
    "Content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    "Host": "hdu.huitu.zhishulib.com",
    "Origin": "https://hdu.huitu.zhishulib.com",
    "Referer": "https://hdu.huitu.zhishulib.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 12; Pixel 3 Build/SP1A.210812.016.C2; wv) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.99 "
        "Mobile Safari/537.36 MicroMessenger/8.0.30 Language/zh_CN"
    ),
}

DEFAULT_SESSION_PARAMS = {"LAB_JSON": "1"}

ROOM_TYPE_MAP = {
    "1": "自习室",
    "2": "教师休息室",
    "3": "阅览室",
    "4": "讨论室",
}


class HduLibraryError(Exception):
    """HDU 图书馆相关异常基类。

    is_timeout: 标记该异常源自网络读/连超时。调用方可据此决定
    是否去服务端做幂等确认（因为超时时服务器可能已写入数据）。
    """

    def __init__(self, message: str, is_timeout: bool = False) -> None:
        super().__init__(message)
        self.is_timeout = is_timeout


class CookieError(HduLibraryError):
    """Cookie 加载失败或无效。"""


class RoomQueryError(HduLibraryError):
    """房间查询失败。"""


class SeatQueryError(HduLibraryError):
    """座位查询失败。"""


class LibraryClient:
    """慧图图书馆平台客户端。

    仅负责 HTTP 传输与今日预约归一化；响应结构解析(魔法路径)统一委托
    ``core.contract`` 访问器，本类在边界捕获 ``KeyError``/``IndexError``/
    ``TypeError`` 并转 ``RoomQueryError``/``SeatQueryError``。
    """

    def __init__(
        self,
        *,
        timeout: float | tuple[float, float] = (5, 20),
        headers: dict[str, str] | None = None,
        params: dict[str, str] | None = None,
        verify: bool = False,
        trust_env: bool = False,
        uid: str = "",
        name: str = "",
        urls: dict[str, str] | None = None,
    ) -> None:
        self.timeout = timeout
        self.urls = {**URLS, **(urls or {})}
        self.session = requests.Session()
        self.session.headers.update(headers or DEFAULT_HEADERS)
        self.session.params = params or DEFAULT_SESSION_PARAMS
        self.session.verify = verify
        self.session.trust_env = trust_env
        self.uid = str(uid or "")
        self.name = str(name or "")
        requests.packages.urllib3.disable_warnings()  # type: ignore[attr-defined]

    def _request(
        self,
        method: str,
        url: str,
        data: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            if method.upper() == "GET":
                response = self.session.get(url, params=params, timeout=self.timeout)
            else:
                response = self.session.post(url, data=data, params=params, timeout=self.timeout)
        except requests.Timeout as exc:
            # 读/连超时单独标记：服务器可能已经执行了请求，只是响应缓慢。
            raise HduLibraryError(f"请求超时：{exc}", is_timeout=True) from exc
        except requests.RequestException as exc:
            raise HduLibraryError(f"请求失败：{exc}") from exc

        if response.status_code not in (200, 302):
            raise HduLibraryError(f"请求失败：HTTP {response.status_code} {url}")
        try:
            parsed = response.json()
        except Exception as exc:
            raise HduLibraryError(f"JSON 解析失败：{exc}") from exc
        if not isinstance(parsed, dict):
            raise HduLibraryError("接口返回不是 JSON 对象")
        return parsed

    def set_cookie_header(self, cookie_string: str) -> None:
        """从原始 Cookie 请求头字符串加载 Cookie。"""
        loaded = False
        for part in cookie_string.split(";"):
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            name = name.strip()
            value = value.strip()
            if not name:
                continue
            self.session.cookies.set(name, value, domain="hdu.huitu.zhishulib.com", path="/")
            loaded = True
        if not loaded:
            raise CookieError("Cookie 字符串中没有有效的键值对")

    def load_cookie_cache(self, cache_path: str | Path) -> None:
        """加载 session.cache（原始 Cookie 字符串，由 ``save_cookie_cache`` 写入）。"""
        path = Path(cache_path).expanduser()
        if not path.is_absolute():
            raise ValueError(f"会话缓存路径必须是绝对路径: {path}")
        if not path.exists() or not path.read_text(encoding="utf-8").strip():
            raise CookieError(f"Cookie 缓存为空或不存在：{path}")
        self.set_cookie_header(path.read_text(encoding="utf-8").strip())

    def save_cookie_cache(self, cache_path: str | Path, cookie_string: str) -> None:
        """把原始 Cookie 字符串写入 session.cache，供下次非交互模式复用。

        写入失败（如磁盘不可写）静默忽略——缓存仅用于加速后续非交互登录，
        失败不应阻断当前已成功的认证流程（与历史行为一致）。
        """
        path = Path(cache_path).expanduser()
        if not path.is_absolute():
            raise ValueError(f"会话缓存路径必须是绝对路径: {path}")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(cookie_string, encoding="utf-8")
        except OSError:
            pass

    def validate_cookie(self) -> bool:
        """验证当前 Session 中的 Cookie 是否仍有效。

        baseInfo 在未指定 LAB_JSON 时返回干净的 ``DATA`` 对象（服务器
        ``_debug_info`` 会注明"没有指定LAB平台模板"），其中 ``is_login`` 与
        ``uid`` 是平台明确的会话/标识字段，直接判定即可，无需递归猜测。
        契约见 docs/contracts/samples/baseInfo.json。
        """
        try:
            data = self._request("GET", self.urls["user_base_info"], params={"LAB_JSON": None})
        except HduLibraryError:
            return False
        try:
            info = contract.base_info_data(data)
        except KeyError:
            return False
        return contract.base_info_is_login(info) and contract.base_info_uid(info).isdigit()

    def resolve_uid(self) -> str:
        """从 baseInfo 的 ``DATA.uid`` 读取当前登录用户 uid。契约见
        docs/contracts/samples/baseInfo.json。"""
        if self.uid:
            return self.uid
        try:
            data = self._request("GET", self.urls["user_base_info"], params={"LAB_JSON": None})
        except HduLibraryError as exc:
            raise HduLibraryError(f"用户信息请求失败：{exc}") from exc
        try:
            info = contract.base_info_data(data)
        except KeyError as exc:
            raise HduLibraryError(f"用户信息解析失败：{exc}") from exc
        if not contract.base_info_is_login(info):
            raise HduLibraryError("Cookie 无效或已过期，无法获取 uid。")
        uid = contract.base_info_uid(info)
        if not uid.isdigit():
            raise HduLibraryError(
                f"未能从接口识别 uid（got {uid!r}），请在配置中填写 uid 或更新 Cookie。",
            )
        self.uid = uid
        return self.uid

    def get_room_types(self) -> list[dict[str, Any]]:
        """获取所有可用房间类型。契约见 docs/contracts/samples/room_types.json。"""
        data = self._request("GET", self.urls["query_rooms"])
        try:
            return contract.room_types_from_response(data)
        except (KeyError, IndexError, TypeError) as exc:
            raise RoomQueryError(f"房间类型解析失败：{exc}") from exc

    def get_room_detail(self, room_query_string: str) -> dict[str, Any]:
        """查询单个房间详情。契约见 docs/contracts/samples/room_detail.json。"""
        response = self._request("GET", self.urls["query_seats"] + "?" + room_query_string)
        try:
            return contract.room_detail_from_response(response)
        except (KeyError, TypeError) as exc:
            raise RoomQueryError(f"房间信息解析失败：{exc}") from exc

    def get_seat_map(
        self,
        category_id: str,
        content_id: str,
        lookup_time: Any,
        duration_hours: int = 1,
        num: int = 1,
    ) -> list[dict[str, Any]]:
        """根据分类和参考时间查询座位布局。契约见 docs/contracts/samples/seat_map.json。"""
        payload = {
            "beginTime": lookup_time.timestamp(),
            "duration": int(duration_hours * 3600),
            "num": num,
            "space_category[category_id]": str(category_id),
            "space_category[content_id]": str(content_id),
        }
        response = self._request("POST", self.urls["query_seats"], payload)
        try:
            return contract.floors_from_response(response)
        except (KeyError, IndexError, TypeError) as exc:
            raise SeatQueryError(f"座位分布解析失败：{exc}") from exc

    def get_todays_bookings(self) -> list[dict[str, Any]]:
        """查询当前用户的预约记录(含今日)。

        端点 ``myBookingList?fromType=web``(契约验证,见
        docs/contracts/samples/myBookingList.json):响应为
        ``{content:{defaultItems:[order_item,...]}}``,order item 字段为
        ``seatNum``/``time``/``id`` 等。用于 post-bookSeats 超时后的幂等确认。
        访问器容错(结构漂移返回 ``[]``)，故此处不包错。
        """
        data = self._request("GET", self.urls["today_schedule"])
        return contract.bookings_from_response(data)

    def find_confirmed_booking(self, begin_ts: int) -> dict[str, Any] | None:
        """超时幂等确认：在用户预约记录中查找与 begin_ts 匹配的预约。

        用于 post-bookSeats 超时后确认服务端是否已写入预约。

        匹配规则：order item 的 ``time``(开始时间戳)与 begin_ts 相差 ≤1 秒。
        不按 seat_id 匹配——预约记录字段是 ``seatNum``(座位号,非 seat_id),
        无法直接比对;而 bookSeats 若真超时,用户此前在该 begin_ts 不应有预约
        (否则会立即返回 duplicate 而非超时),故 time 单字段即可唯一识别本次
        预约。

        任何查询异常保守返回 None，让调用方按原逻辑重试。
        契约见 docs/contracts/samples/myBookingList.json。
        """
        try:
            bookings = self.get_todays_bookings()
        except Exception:
            return None

        for item in bookings:
            if not isinstance(item, dict):
                continue
            try:
                item_begin_ts = contract.booking_begin_ts(item)
            except (TypeError, ValueError):
                continue
            if abs(item_begin_ts - begin_ts) <= 1:
                return item
        return None

    def book_seat(
        self,
        seat_id: str,
        uid: str,
        begin_time: Any,
        duration_hours: int,
        is_recommend: int = 1,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """提交预约请求。签名见 utils/encrypt.py,契约见
        docs/contracts/samples/book_seats.json。"""
        begin_ts = int(begin_time.timestamp())
        duration_sec = int(duration_hours * 3600)
        uid_str = str(uid)
        seat_str = str(seat_id)
        api_token, api_time = generate_api_token(
            seat_id=seat_str,
            uid=uid_str,
            begin_time=begin_ts,
            duration=duration_sec,
            is_recommend=is_recommend,
        )
        payload = {
            "beginTime": begin_ts,
            "duration": duration_sec,
            "is_recommend": is_recommend,
            "api_time": api_time,
            "seats[0]": seat_str,
            "seatBookers[0]": uid_str,
        }
        if dry_run:
            return {"dry_run": True, "payload": payload, "api_token": api_token}

        self.session.headers["Api-Token"] = api_token
        return self._request("POST", self.urls["book_seat"], payload)
