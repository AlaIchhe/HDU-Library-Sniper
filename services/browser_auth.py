"""浏览器认证服务：用 Playwright 起 headed 浏览器让用户完成登录，导出 Cookie 写入缓存。

与 AuthService（纯 requests 缓存复用）分工：
- AuthService.try_cache：非交互读 session.cache，供 --run-now / SYSTEM 任务 / CI 复用。
- BrowserAuthService.login_and_save：交互式首次登录 / 失效刷新，产出登录态 Cookie。
两者读写同一个 session.cache 文件。
"""

from __future__ import annotations

from typing import Any

from config.setting import Settings
from core.client import HduLibraryError, LibraryClient

# 登录入口：慧图 H5 根域名，浏览器会自然走微信授权 / 杭电 CAS 重定向链。
LOGIN_ENTRY_URL = "https://hdu.huitu.zhishulib.com/"
# 导出 Cookie 时只取目标域（登录流程会经过微信 / CAS 等其他域，只留慧图平台域）。
TARGET_DOMAIN_FRAGMENT = "huitu.zhishulib.com"


class BrowserAuthService:
    """用 Playwright 驱动真实浏览器完成登录，产出登录态 Cookie 写入 session.cache。"""

    def __init__(self, client: LibraryClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings

    def login_and_save(self) -> tuple[bool, str]:
        """起 headed 浏览器，等用户完成登录后导出 Cookie 并写入缓存。

        返回 (是否成功, 给用户的提示消息)。Playwright 缺失 / 无桌面环境时给出
        可操作的报错，不抛异常。
        """
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            return (
                False,
                "未安装 Playwright，无法启动浏览器登录。请执行：\n"
                "  pip install playwright\n  playwright install chromium",
            )

        try:
            with sync_playwright() as p:
                try:
                    browser = p.chromium.launch(headless=False)
                except Exception as exc:
                    return (
                        False,
                        f"无法启动浏览器（可能无桌面环境）：{exc}\n"
                        "请在有桌面环境的机器运行 python main.py 完成登录，"
                        "或把别处生成的 data/session.cache 拷贝过来。",
                    )

                try:
                    context = browser.new_context()
                    page = context.new_page()
                    try:
                        page.goto(LOGIN_ENTRY_URL, wait_until="domcontentloaded")
                    except Exception as exc:
                        # 初始页面加载慢 / 超时不阻断——浏览器已打开，用户可继续手动登录。
                        print(f"（提示：初始页面加载较慢：{exc}，浏览器已打开，请继续登录）")

                    print(
                        "\n请在弹出的浏览器中完成登录（微信扫码 / 杭电统一身份认证）。"
                        "\n登录成功后，回到本终端按 Enter 继续..."
                    )
                    try:
                        input()
                    except KeyboardInterrupt:
                        return False, "已取消登录。"
                    except EOFError:
                        return False, "当前环境无交互终端，无法使用浏览器登录。请在真实终端运行。"

                    cookie_str = self._export_cookies(context)
                    if not cookie_str:
                        return (
                            False,
                            f"未检测到 {TARGET_DOMAIN_FRAGMENT} 域的有效 Cookie，"
                            "请确认浏览器已完成登录后重试。",
                        )

                    return self._validate_and_save(cookie_str)
                finally:
                    try:
                        context.close()
                    except Exception:
                        pass
                    try:
                        browser.close()
                    except Exception:
                        pass
        except Exception as exc:
            return False, f"浏览器登录过程出错：{exc}"

    def _export_cookies(self, context: Any) -> str:
        """从 Playwright context 导出目标域 Cookie，拼成请求头字符串。"""
        cookies = context.cookies()
        pairs = [
            f"{c['name']}={c['value']}"
            for c in cookies
            if TARGET_DOMAIN_FRAGMENT in (c.get("domain") or "")
        ]
        return "; ".join(pairs)

    def _validate_and_save(self, cookie_str: str) -> tuple[bool, str]:
        """把 Cookie 字符串塞进 client，联网验证 is_login + 解析 uid，通过则写缓存。

        复用 LibraryClient 的契约确认（set_cookie_header / validate_cookie /
        resolve_uid / save_cookie_cache），不重写验证逻辑，也不依赖 AuthService。
        """
        try:
            self.client.set_cookie_header(cookie_str)
        except HduLibraryError as exc:
            return False, f"Cookie 加载失败：{exc}"

        try:
            valid = self.client.validate_cookie()
        except HduLibraryError as exc:
            return False, f"Cookie 校验请求失败：{exc}"

        if not valid:
            return False, "Cookie 无效或登录态未生效，请确认浏览器已完成登录后重试。"

        try:
            self.client.resolve_uid()
        except HduLibraryError as exc:
            return False, f"用户信息识别失败：{exc}"

        self.client.save_cookie_cache(self.settings.session_cache, cookie_str)
        return (
            True,
            f"认证成功：{self.client.name or '(未知姓名)'} (UID: {self.client.uid})"
            f"，已写入 {self.settings.session_cache}",
        )
