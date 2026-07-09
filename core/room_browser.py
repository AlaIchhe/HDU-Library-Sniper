"""房间与楼层浏览：收编创建方案 / 浏览座位中重复的领域查询逻辑。"""

from __future__ import annotations

from dataclasses import dataclass

from core.client import ROOM_TYPE_MAP, LibraryClient
from utils.time_sync import get_seat_lookup_time


@dataclass
class FloorInfo:
    """单个楼层的结构化信息。"""

    floor_id: str
    room_name: str
    seat_count: int
    seat_titles: list[str]


class RoomBrowser:
    """封装慧图房间类型 / 楼层座位布局的查询，供交互式选房与浏览共用。"""

    def __init__(self, client: LibraryClient) -> None:
        self.client = client

    def list_room_types(self) -> list[dict]:
        """获取所有可用房间类型（透传 client）。"""
        return self.client.get_room_types()

    def list_floors(self, room_query: str) -> list[FloorInfo]:
        """查询某房间类型下的楼层列表（含座位数与座位号）。

        字段契约：cat_id / con_id 取自 detail["space_category"]；
        楼层 id 取自 seatMap.info.id；座位号取自 seatMap.POIs[].title。
        """
        detail = self.client.get_room_detail(room_query)
        space = detail["space_category"]
        cat_id = space["category_id"]
        con_id = space["content_id"]
        lookup_time = get_seat_lookup_time()
        floors = self.client.get_seat_map(cat_id, con_id, lookup_time, 1)

        result: list[FloorInfo] = []
        for f in floors:
            seatmap = f.get("seatMap", {}) or {}
            info = seatmap.get("info", {}) or {}
            seats = seatmap.get("POIs", []) or []
            titles = sorted(s.get("title", "") for s in seats if s.get("title"))
            result.append(
                FloorInfo(
                    floor_id=str(info.get("id", "")),
                    room_name=f.get("roomName", "?"),
                    seat_count=len(seats),
                    seat_titles=titles,
                )
            )
        return result

    @staticmethod
    def resolve_room_type(name: str) -> int | None:
        """房间类型名 -> 编号（1=自习室 …）；无法识别返回 None。"""
        for num, label in ROOM_TYPE_MAP.items():
            if label in name:
                return int(num)
        return None
