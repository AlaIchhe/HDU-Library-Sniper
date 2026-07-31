"""慧图图书馆 HTTP 客户端。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import requests

from hdu_sniper.library import responses
from hdu_sniper.library.signing import generate_api_token


URLS = {
    "book_seat": "https://hdu.huitu.zhishulib.com/Seat/Index/bookSeats",
    "cancel_booking": "https://hdu.huitu.zhishulib.com/Seat/Index/cancelBooking",
    "check_in": "https://hdu.huitu.zhishulib.com/Seat/Index/checkIn",
    "leave": "https://hdu.huitu.zhishulib.com/Seat/Index/leave",
    "come_back": "https://hdu.huitu.zhishulib.com/Seat/Index/comeBack",
    "sign_out": "https://hdu.huitu.zhishulib.com/Seat/Index/signOut",
    "booking_status": "https://hdu.huitu.zhishulib.com/Seat/Index/bookingStatus",
    "step_out_latest_comeback_time": (
        "https://hdu.huitu.zhishulib.com/Seat/Index/stepOutLatestComeBackTime"
    ),
    "query_seats": "https://hdu.huitu.zhishulib.com/Seat/Index/searchSeats",
    "query_rooms": "https://hdu.huitu.zhishulib.com/Space/Category/list",
    "user_base_info": "https://hdu.huitu.zhishulib.com/User/Center/baseInfo",
    # 契约验证:myBookingList?fromType=web 才返回预约列表(content.defaultItems)。
    # todayUserBookSeat 只返回字符串 'todayUserBookSeatAction',拿不到数据——不可用。
    "booking_list": "https://hdu.huitu.zhishulib.com/Seat/Index/myBookingList?fromType=web",
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


class AuthenticationExpiredError(HduLibraryError):
    """远端明确表示当前图书馆会话未登录或已经失效。"""


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
        for key in ("DATA", "data"):
            authentication = parsed.get(key)
            if isinstance(authentication, dict) and authentication.get("is_login") is False:
                raise AuthenticationExpiredError("图书馆登录状态已失效")
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
            info = responses.base_info_data(data)
        except KeyError:
            return False
        return responses.base_info_is_login(info) and responses.base_info_uid(info).isdigit()

    def resolve_uid(self) -> str:
        """从 baseInfo 的 ``DATA.uid`` 读取当前登录用户 uid。契约见
        docs/contracts/samples/baseInfo.json。"""
        if self.uid:
            return self.uid
        try:
            data = self._request("GET", self.urls["user_base_info"], params={"LAB_JSON": None})
        except AuthenticationExpiredError:
            raise
        except HduLibraryError as exc:
            raise HduLibraryError(f"用户信息请求失败：{exc}") from exc
        try:
            info = responses.base_info_data(data)
        except KeyError as exc:
            raise HduLibraryError(f"用户信息解析失败：{exc}") from exc
        if not responses.base_info_is_login(info):
            raise AuthenticationExpiredError("Cookie 无效或已过期，无法获取 uid。")
        uid = responses.base_info_uid(info)
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
            return responses.room_types_from_response(data)
        except (KeyError, IndexError, TypeError) as exc:
            raise RoomQueryError(f"房间类型解析失败：{exc}") from exc

    def get_room_detail(self, room_query_string: str) -> dict[str, Any]:
        """查询单个房间详情。契约见 docs/contracts/samples/room_detail.json。"""
        response = self._request("GET", self.urls["query_seats"] + "?" + room_query_string)
        try:
            return responses.room_detail_from_response(response)
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
        if "allContent" not in response and str(response.get("CODE") or "").lower() != "ok":
            raise SeatQueryError(f"座位分布查询失败：{responses.operation_message(response)}")
        try:
            return responses.floors_from_response(response)
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
        data = self._request("GET", self.urls["booking_list"])
        return responses.bookings_from_response(data)

    def get_bookings(self) -> list[dict[str, Any]]:
        """获取当前用户的全部座位预约记录。

        真实 Web 端调用为 ``GET /Seat/Index/myBookingList?fromType=web``；返回既包括
        待签到/使用中的预约，也包括已结束和已取消的历史记录。与超时幂等确认使用的
        :meth:`get_todays_bookings` 不同，这里在响应结构不符合契约时明确报错，避免界面
        把接口结构漂移误显示为“暂无预约”。
        """
        data = self._request("GET", self.urls["booking_list"])
        content = data.get("content")
        items = content.get("defaultItems") if isinstance(content, dict) else None
        if not isinstance(items, list):
            raise HduLibraryError("预约列表解析失败：响应中缺少 content.defaultItems")
        return items

    def cancel_remote_booking(self, booking_id: str | int) -> dict[str, Any]:
        """取消一条待签到预约。

        Web 端实测调用为 ``POST /Seat/Index/cancelBooking?bookingId=<id>``，无请求体、
        无 ``Api-Token``。成功响应满足 ``CODE == 'ok'`` 且 ``DATA.result == 'success'``。
        调用方应只对列表中 ``status == '0'``（待签到）的条目暴露此操作。
        """
        return self._booking_action_request("POST", "cancel_booking", booking_id)

    def check_in_booking(self, booking_id: str | int) -> dict[str, Any]:
        """为待签到预约执行签到。

        请求契约为 ``POST /Seat/Index/checkIn?bookingId=<id>``，无请求体；成功
        响应为 ``CODE=ok`` 且 ``DATA.result=success``，预约状态随后由 ``0`` 变为
        ``1``。接口不需要蓝牙、定位或 ``Api-Token`` 请求字段。
        """
        return self._booking_action_request("POST", "check_in", booking_id)

    def come_back_booking(self, booking_id: str | int) -> dict[str, Any]:
        """让暂离中的预约恢复为使用中。

        请求契约为 ``POST /Seat/Index/comeBack?bookingId=<id>``，无请求体；成功
        响应与签到相同，预约状态随后由 ``2`` 变为 ``1``。
        """
        return self._booking_action_request("POST", "come_back", booking_id)

    def leave_booking(self, booking_id: str | int) -> dict[str, Any]:
        """Temporarily leave an in-use booking."""
        return self._booking_action_request("POST", "leave", booking_id)

    def sign_out_booking(self, booking_id: str | int) -> dict[str, Any]:
        """Sign out of an in-use booking."""
        return self._booking_action_request("POST", "sign_out", booking_id)

    def get_booking_status(self, booking_id: str | int) -> dict[str, Any]:
        """Read the server-side status for one booking without changing it."""
        return self._booking_query_request("booking_status", booking_id)

    def get_latest_comeback_time(self, booking_id: str | int) -> dict[str, Any]:
        """Read the latest allowed return time for a temporarily-away booking."""
        return self._booking_query_request("step_out_latest_comeback_time", booking_id)

    def _booking_query_request(
        self, url_key: str, booking_id: str | int
    ) -> dict[str, Any]:
        normalized_id = str(booking_id).strip()
        if not normalized_id or not normalized_id.isdigit():
            raise ValueError("预约 ID 必须是数字")
        # Read-only booking endpoints use the session cookie, not bookSeats' one-time token.
        self.session.headers.pop("Api-Token", None)
        return self._request(
            "GET",
            self.urls[url_key],
            params={"bookingId": normalized_id},
        )

    def _booking_action_request(
        self, method: str, url_key: str, booking_id: str | int
    ) -> dict[str, Any]:
        normalized_id = str(booking_id).strip()
        if not normalized_id or not normalized_id.isdigit():
            raise ValueError("预约 ID 必须是数字")
        # 这些端点均不使用 bookSeats 的一次性签名。
        self.session.headers.pop("Api-Token", None)
        return self._request(
            method,
            self.urls[url_key],
            params={"bookingId": normalized_id},
        )

    def find_confirmed_booking(
        self,
        begin_ts: int,
        seat_num: str | None = None,
        duration_hours: int | None = None,
    ) -> dict[str, Any] | None:
        """在用户预约记录中确认一次预约是否真正落库。

        用于 post-bookSeats 超时后确认服务端是否已写入预约。

        如果提供 seat_num 和 duration_hours，则同时核对预约列表中的座位号、
        开始时间和时长；正常成功响应也必须经过这条路径复核。

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
                if seat_num is not None and duration_hours is not None:
                    if responses.booking_matches(
                        item,
                        seat_num=seat_num,
                        begin_ts=begin_ts,
                        duration_seconds=int(duration_hours * 3600),
                    ):
                        return item
                    continue
                item_begin_ts = responses.booking_begin_ts(item)
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
