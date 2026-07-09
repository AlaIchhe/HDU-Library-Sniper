"""慧图图书馆 HTTP 客户端。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import requests
from requests.cookies import create_cookie

from utils.encrypt import generate_api_token

URLS = {
    "book_seat": "https://hdu.huitu.zhishulib.com/Seat/Index/bookSeats",
    # "login": "https://hdu.huitu.zhishulib.com/User/Index/login",  # 走 Cookie 认证，未使用
    "query_seats": "https://hdu.huitu.zhishulib.com/Seat/Index/searchSeats",
    "query_rooms": "https://hdu.huitu.zhishulib.com/Space/Category/list",
    # "index": "https://hdu.huitu.zhishulib.com/",  # 未使用
    "user_base_info": "https://hdu.huitu.zhishulib.com/User/Center/baseInfo",
    # "user_center": "https://hdu.huitu.zhishulib.com/User/Center/index",  # 未使用，实际用 user_base_info
    # 预约查询接口：在 bookSeats 超时后用于幂等确认（服务器可能已实际写入预约）。
    "today_schedule": "https://hdu.huitu.zhishulib.com/Seat/Index/todayUserBookSeat",
    # "book_history": "https://hdu.huitu.zhishulib.com/Seat/Index/historyBookSeat",  # 未使用
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

MSG_TIME_OUT_OF_RANGE = "超出可预约座位时间范围"
MSG_DUPLICATE = "已有预约，请勿重复预约！"
MSG_SEAT_UNAVAILABLE = "选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用，请换一个再试"
MSG_INVALID_REQUEST = "非法请求"


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
    """慧图图书馆平台客户端。"""

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

    def set_cookies_from_json_file(self, json_path: str | Path) -> None:
        """从浏览器导出的 JSON Cookie 文件加载 Cookie。"""
        path = Path(json_path).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            raise CookieError(f"Cookie 文件不存在：{path}")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise CookieError(f"Cookie 文件 JSON 解析失败：{path}") from exc

        cookies = data.get("cookies") if isinstance(data, dict) else data
        if not isinstance(cookies, list):
            raise CookieError("Cookie 文件格式无效：缺少 cookies 列表")

        loaded = False
        for item in cookies:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            value = item.get("value")
            if not name or value is None:
                continue
            cookie = create_cookie(
                name=str(name),
                value=str(value),
                domain=item.get("domain") or "hdu.huitu.zhishulib.com",
                path=item.get("path") or "/",
                secure=bool(item.get("secure", False)),
            )
            self.session.cookies.set_cookie(cookie)
            loaded = True
        if not loaded:
            raise CookieError("Cookie 文件中没有可用 Cookie")

    def load_cookie_cache(self, cache_path: str | Path) -> None:
        """加载 session.cache；支持原始 Cookie 字符串或 JSON Cookie。"""
        path = Path(cache_path).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists() or not path.read_text(encoding="utf-8").strip():
            raise CookieError(f"Cookie 缓存为空或不存在：{path}")
        text = path.read_text(encoding="utf-8").strip()
        if text[0] in "[{":
            self.set_cookies_from_json_file(path)
        else:
            self.set_cookie_header(text)

    def save_cookie_cache(self, cache_path: str | Path, cookie_string: str) -> None:
        """把原始 Cookie 字符串写入 session.cache，供下次非交互模式复用。

        写入失败（如磁盘不可写）静默忽略——缓存仅用于加速后续非交互登录，
        失败不应阻断当前已成功的认证流程（与历史行为一致）。
        """
        try:
            path = Path(cache_path).expanduser()
            if not path.is_absolute():
                path = Path.cwd() / path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(cookie_string, encoding="utf-8")
        except OSError:
            pass

    def validate_cookie(self) -> bool:
        """验证当前 Session 中的 Cookie 是否仍有效。

        baseInfo 在未指定 LAB_JSON 时返回干净的 DATA 对象（服务器 _debug_info
        会注明"没有指定LAB平台模板"），其中 is_login 与 uid 是平台明确的会话/
        标识字段，直接判定即可，无需递归猜测。
        """
        try:
            data = self._request("GET", self.urls["user_base_info"], params={"LAB_JSON": None})
        except HduLibraryError:
            return False
        info = data.get("DATA")
        if not isinstance(info, dict):
            return False
        return bool(info.get("is_login") and str(info.get("uid") or "").isdigit())

    def resolve_uid(self) -> str:
        """从 baseInfo 的 DATA.uid 读取当前登录用户 uid。"""
        if self.uid:
            return self.uid
        try:
            data = self._request("GET", self.urls["user_base_info"], params={"LAB_JSON": None})
        except HduLibraryError as exc:
            raise HduLibraryError(f"用户信息请求失败：{exc}") from exc
        info = data.get("DATA")
        if not isinstance(info, dict) or not info.get("is_login"):
            raise HduLibraryError("Cookie 无效或已过期，无法获取 uid。")
        uid = str(info.get("uid") or "")
        if not uid.isdigit():
            raise HduLibraryError(
                f"未能从接口识别 uid（got {uid!r}），请在配置中填写 uid 或更新 Cookie。"
            )
        self.uid = uid
        return self.uid

    def get_room_types(self) -> list[dict[str, Any]]:
        """获取所有可用房间类型。"""
        data = self._request("GET", self.urls["query_rooms"])
        try:
            raw_items = data["content"]["children"][1]["defaultItems"]
        except Exception as exc:
            raise RoomQueryError(f"房间类型解析失败：{exc}") from exc

        room_items: list[dict[str, Any]] = []
        for item in raw_items:
            link_url = unquote(item["link"]["url"])
            query = link_url.split("?", 1)[1]
            room_items.append({"name": item["name"], "query": query})
        return room_items

    def get_room_detail(self, room_query_string: str) -> dict[str, Any]:
        """查询单个房间详情。"""
        response = self._request("GET", self.urls["query_seats"] + "?" + room_query_string)
        detail = response.get("data")
        if not isinstance(detail, dict):
            raise RoomQueryError("房间信息为空")
        return detail

    def get_seat_map(
        self,
        category_id: str,
        content_id: str,
        lookup_time: Any,
        duration_hours: int = 1,
        num: int = 1,
    ) -> list[dict[str, Any]]:
        """根据分类和参考时间查询座位布局。"""
        payload = {
            "beginTime": lookup_time.timestamp(),
            "duration": int(duration_hours * 3600),
            "num": num,
            "space_category[category_id]": str(category_id),
            "space_category[content_id]": str(content_id),
        }
        response = self._request("POST", self.urls["query_seats"], payload)
        try:
            return response["allContent"]["children"][2]["children"]["children"]
        except Exception as exc:
            raise SeatQueryError(f"座位分布解析失败：{exc}") from exc

    def find_seat_in_floors(
        self, floors: list[dict[str, Any]], floor_id: str | int, seat_num: str | int
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """在楼层列表中定位指定楼层和座位号。"""
        floor_id = str(floor_id)
        seat_num = str(seat_num)
        floor_names: list[str] = []
        target_floor = None

        for item in floors:
            info = item.get("seatMap", {}).get("info", {})
            floor_names.append(f"{item.get('roomName', '?')}={info.get('id', '?')}")
            if str(info.get("id")) == floor_id:
                target_floor = item
                break

        if not target_floor:
            raise SeatQueryError(f"找不到楼层 id={floor_id}。可用楼层：{', '.join(floor_names)}")

        seats = target_floor["seatMap"]["POIs"]
        matches = [seat for seat in seats if str(seat.get("title")) == seat_num]
        if not matches:
            raise SeatQueryError(f"{target_floor.get('roomName')} 中找不到 {seat_num} 座")
        if len(matches) > 1:
            raise SeatQueryError(f"{target_floor.get('roomName')} 中存在多个 {seat_num} 座")
        return target_floor, matches[0]

    def get_todays_bookings(self) -> list[dict[str, Any]]:
        """查询当前用户当日所有预约记录。

        用于 post-bookSeats 超时后的幂等确认：超时仅代表客户端未收到
        响应，并不代表服务端未写入预约。调用方应以 seat_id + begin_ts 比对。
        """
        data = self._request("GET", self.urls["today_schedule"])
        # 兼容多种常见返回结构
        if isinstance(data, list):
            return data
        for key in ("data", "content", "list", "DATA", "CONTENT"):
            block = data.get(key) if isinstance(data, dict) else None
            if isinstance(block, dict):
                for sub in ("list", "data", "content", "items"):
                    if isinstance(block.get(sub), list):
                        return block[sub]
            elif isinstance(block, list):
                return block
        return []

    def book_seat(
        self,
        seat_id: str,
        uid: str,
        begin_time: Any,
        duration_hours: int,
        is_recommend: int = 1,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """提交预约请求。"""
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
    
