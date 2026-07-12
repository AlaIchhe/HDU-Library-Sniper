"""图书馆登录：复用 Cookie 缓存或通过 Playwright 获取新会话。

用 Playwright 起 headless 浏览器，以学号+密码走杭电统一身份认证
（sso.hdu.edu.cn）完成登录，导出慧图平台 Cookie 写入缓存。

同时支持复用 ``session.cache`` 与通过学号、密码进行 headless 登录。
两者读写同一个 session.cache 文件。

登录链路（实测）：
  hdu.huitu.zhishulib.com/ → /User/Index/hduCASLogin → sso.hdu.edu.cn/login
  填学号+密码提交 → CAS 重定向回 hduCASLogin?ticket=... → huitu 落地 auth/uid/PHPSESSID。
密码由 SSO 页面自身 JS（CryptoJS AES-ECB）加密，headless 让页面 JS 自行处理，无需逆向。
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

from hdu_sniper.config import Settings
from hdu_sniper.library.client import CookieError, HduLibraryError, LibraryClient


# 登录入口：慧图根域名，浏览器会自动重定向到杭电统一身份认证 (sso.hdu.edu.cn)。
LOGIN_ENTRY_URL = "https://hdu.huitu.zhishulib.com/"
# 导出 Cookie 时只取目标域（登录流程会经过 sso.hdu.edu.cn 等其他域，只留慧图平台域）。
TARGET_DOMAIN_FRAGMENT = "huitu.zhishulib.com"
# 桌面 Chrome UA（SSO Angular 页对桌面 UA 渲染账号密码表单）。
DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
# 登录成功后 CAS 会重定向回慧图域；以此作为登录成功的信号。
_HUITU_URL = re.compile(r"huitu\.zhishulib\.com")


def configure_packaged_browser() -> Path | None:
    """Point Playwright at Chromium bundled with a frozen desktop app."""
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "").strip()
    if configured:
        return Path(configured)
    if not getattr(sys, "frozen", False):
        return None

    executable_dir = Path(sys.executable).resolve().parent
    bundle_dir = Path(getattr(sys, "_MEIPASS", executable_dir))
    for candidate in (
        bundle_dir / "playwright-browsers",
        executable_dir / "playwright-browsers",
    ):
        if candidate.is_dir():
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(candidate)
            return candidate
    return None


class LibraryLogin:
    """用 Playwright 驱动 headless 浏览器以学号+密码登录，产出登录态 Cookie 写入 session.cache。"""

    def __init__(self, client: LibraryClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings

    def try_cache(self) -> bool:
        """尝试复用 session.cache 中的登录态。"""
        try:
            self.client.load_cookie_cache(self.settings.paths.session_cache)
            if self.client.validate_cookie():
                self.client.resolve_uid()
                return True
        except (CookieError, HduLibraryError):
            pass
        return False

    def login_with_credentials(
        self,
        student_id: str,
        password: str,
        headless: bool = True,
    ) -> tuple[bool, str]:
        """headless 起浏览器，用学号+密码走杭电统一身份认证登录，导出 Cookie 并写入缓存。

        返回 (是否成功, 给用户的提示消息)。Playwright 缺失 / 登录失败时给出可操作的报错，
        不抛异常。
        """
        configure_packaged_browser()
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            return (
                False,
                "未安装 Playwright，无法登录。请执行：\n"
                "  pip install playwright\n  playwright install chromium",
            )

        try:
            with sync_playwright() as p:
                try:
                    browser = p.chromium.launch(
                        headless=headless,
                        args=["--disable-blink-features=AutomationControlled"],
                    )
                except Exception as exc:
                    packaged_hint = (
                        "安装包缺少内置浏览器，请重新安装桌面应用。"
                        if getattr(sys, "frozen", False)
                        else "请执行 `playwright install chromium`。"
                    )
                    return (
                        False,
                        f"无法启动登录浏览器：{exc}\n{packaged_hint}",
                    )

                try:
                    context = browser.new_context(
                        user_agent=DESKTOP_UA,
                        viewport={"width": 1280, "height": 800},
                    )
                    # 抹掉 navigator.webdriver，降低 headless 被识别的概率。
                    context.add_init_script(
                        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
                    )
                    page = context.new_page()

                    # 1) 打开入口，自动重定向到 SSO 登录页。
                    try:
                        page.goto(LOGIN_ENTRY_URL, wait_until="domcontentloaded", timeout=60000)
                    except Exception:
                        # 初始加载慢/超时不阻断——但 SSO 页通常已可继续；若彻底没加载，下方等表单会失败。
                        pass
                    try:
                        page.wait_for_load_state("networkidle", timeout=20000)
                    except Exception:
                        pass

                    # 2) 等 Angular 渲染出账号输入框。
                    #    注意：可见 username 输入框无显式 type 属性（Angular nz-input），
                    #    不能用 input[type=text]，要用 :not([type=hidden]) 排除隐藏的同名字段。
                    try:
                        page.wait_for_selector(
                            "input[name='username']:not([type=hidden])",
                            state="visible",
                            timeout=20000,
                        )
                    except Exception:
                        return (
                            False,
                            "登录页未加载完成或结构变化（未找到账号输入框），请稍后重试。",
                        )

                    page.fill("input[name='username']:not([type=hidden])", student_id)
                    page.fill("input[type='password']", password)
                    page.wait_for_timeout(600)
                    try:
                        page.wait_for_selector("button.login-button:not(.disabled)", timeout=8000)
                    except Exception:
                        pass  # 即使按钮仍 disabled 也尝试点击，由服务端响应判定

                    # 3) 提交，等 CAS 重定向回慧图域。
                    try:
                        page.click("button.login-button")
                    except Exception as exc:
                        return False, f"点击登录按钮失败：{exc}"

                    navigated = True
                    try:
                        page.wait_for_url(_HUITU_URL, timeout=30000)
                    except Exception:
                        navigated = False
                    page.wait_for_timeout(1500)

                    if not navigated:
                        return self._diagnose_failure(page)

                    # 4) 导出慧图域 Cookie 并校验落盘。
                    cookie_str = self._export_cookies(context)
                    if not cookie_str:
                        return (
                            False,
                            f"登录后未检测到 {TARGET_DOMAIN_FRAGMENT} 域的有效 Cookie，请重试。",
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

    def _diagnose_failure(self, page: Any) -> tuple[bool, str]:
        """登录未跳回慧图域时，从页面诊断失败原因（凭据错误 / 验证码 / 其他）。"""
        reason = "登录失败：未跳转回图书馆站点。"
        try:
            texts = page.eval_on_selector_all(
                ".ant-message, [class*='error'], [role='alert'], "
                ".ant-form-item-explain-error, .tip, .toast",
                "els => els.map(e => (e.innerText||'').trim()).filter(Boolean).slice(0,5)",
            )
            if texts:
                reason = "登录失败：" + " / ".join(texts)
        except Exception:
            pass
        # 探测验证码是否出现（风控触发型，正常单次登录不应出现）。
        try:
            has_captcha = page.evaluate(
                """() => {
                    const s = document.body.innerHTML || '';
                    return /captcha|geetest|recaptcha|验证码/i.test(s) &&
                           !!document.querySelector('iframe[src*="recaptcha"], .geetest, [class*="captcha"]');
                }""",
            )
            if has_captcha:
                reason += " 检测到验证码（风控触发），headless 无法自动通过，请稍后重试或核对凭据。"
        except Exception:
            pass
        if "密码" in reason or "password" in reason.lower():
            reason += " 请核对学号与数字杭电密码。"
        return False, reason

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
        resolve_uid / save_cookie_cache），不重写验证逻辑。
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
            return False, "Cookie 无效或登录态未生效，请核对凭据后重试。"

        try:
            self.client.resolve_uid()
        except HduLibraryError as exc:
            return False, f"用户信息识别失败：{exc}"

        self.client.save_cookie_cache(self.settings.paths.session_cache, cookie_str)
        return (
            True,
            f"认证成功：{self.client.name or '(未知姓名)'} (UID: {self.client.uid})"
            f"，已写入 {self.settings.paths.session_cache}",
        )
