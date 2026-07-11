"""慧图图书馆 API 签名工具。"""

from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime


def generate_api_token(
    seat_id: str,
    uid: str,
    begin_time: int,
    duration: int,
    is_recommend: int = 1,
    api_time: int | None = None,
) -> tuple[str, int]:
    """生成预约接口需要的 ``Api-Token``。

    慧图接口使用固定参数拼接后 MD5，再对 MD5 hex 字符串做 base64 编码。
    这里的 MD5 是接口协议要求，不用于密码哈希。
    """
    if api_time is None:
        api_time = int(datetime.now(UTC).timestamp())

    token_source = (
        "post&/Seat/Index/bookSeats?LAB_JSON=1"
        f"&api_time{api_time}"
        f"&beginTime{begin_time}"
        f"&duration{duration}"
        f"&is_recommend{is_recommend}"
        f"&seatBookers[0]{uid}"
        f"&seats[0]{seat_id}"
    )
    md5_hex = hashlib.md5(token_source.encode("utf-8"), usedforsecurity=False).hexdigest()
    api_token = base64.b64encode(md5_hex.encode("utf-8")).decode("utf-8")
    return api_token, api_time
