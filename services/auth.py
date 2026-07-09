"""认证服务：Cookie 缓存认证与交互式认证（纯逻辑，无 UI）。"""

from __future__ import annotations

from config.setting import Settings
from core.client import CookieError, HduLibraryError, LibraryClient


class AuthService:
    """封装 Cookie 认证流程；交互式输入 / 输出由调用方（cli 层）负责。"""

    def __init__(self, client: LibraryClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings

    def try_cache(self) -> bool:
        """仅尝试用已缓存的 Cookie 认证，不做任何交互式输入。供非交互模式使用。"""
        try:
            self.client.load_cookie_cache(self.settings.session_cache)
            if self.client.validate_cookie():
                self.client.resolve_uid()
                return True
        except (CookieError, HduLibraryError):
            pass
        return False

    def authenticate_with_cookie(self, cookie: str) -> tuple[bool, str]:
        """用原始 Cookie 字符串完成认证（校验 + 解析 uid）。

        返回 (是否成功, 给用户的提示消息)。成功时消息含姓名与 uid。
        """
        try:
            self.client.set_cookie_header(cookie)
        except CookieError as exc:
            return False, f"Cookie 格式无效: {exc}"

        try:
            valid = self.client.validate_cookie()
        except HduLibraryError as exc:
            return False, f"Cookie 校验请求失败: {exc}"

        if not valid:
            return False, "Cookie 无效或已过期，认证失败。"

        try:
            self.client.resolve_uid()
        except HduLibraryError as exc:
            return False, f"用户信息识别失败: {exc}"

        return True, f"认证成功：{self.client.name or '(未知姓名)'} (UID: {self.client.uid})"

    def save_cache(self, cookie: str) -> None:
        """把 Cookie 字符串写入缓存文件，供下次非交互模式复用。"""
        self.client.save_cookie_cache(self.settings.session_cache, cookie)
