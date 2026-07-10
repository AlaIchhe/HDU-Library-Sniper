"""认证服务：Cookie 缓存认证（非交互复用，纯逻辑无 UI）。

交互式浏览器登录见 services.browser_auth.BrowserAuthService。
"""

from __future__ import annotations

from config.settings import Settings
from core.client import CookieError, HduLibraryError, LibraryClient


class AuthService:
    """封装 Cookie 缓存认证流程；交互式登录由 BrowserAuthService 负责。"""

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
