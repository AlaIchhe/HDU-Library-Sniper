"""图书馆登录：复用 Cookie 缓存或 HTTP 直连获取新会话。

从 ``sso.hdu.edu.cn/login`` 提取 ``#login-croypto`` 密钥和
``#login-page-flowkey``，用 AES-128/ECB/Pkcs7 加密密码后按 CAS 表单提交，
导出慧图平台 Cookie。

登录链路（实测）：
  hdu.huitu.zhishulib.com/ → /User/Index/hduCASLogin → sso.hdu.edu.cn/login
  填学号+密码提交 → CAS 重定向回 hduCASLogin?ticket=... → huitu 落地 auth/uid/PHPSESSID。
密码由 SSO 页面自身 JS（CryptoJS AES-ECB）加密；HTTP 直连按同样算法复现。
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin

import requests
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from hdu_sniper.config import Settings
from hdu_sniper.library.client import CookieError, HduLibraryError, LibraryClient


# HTTP 直连直接请求已确认的 CAS 入口，避免依赖根页面 JS 跳转。
LOGIN_CAS_ENTRY_URL = "https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin"
# SSO 表单实际提交地址（见 main-es2015.js 的 normalLoginForm 逻辑）。
SSO_LOGIN_ORIGIN = "https://sso.hdu.edu.cn"
# 导出 Cookie 时只取目标域（登录流程会经过 sso.hdu.edu.cn 等其他域，只留慧图平台域）。
TARGET_DOMAIN_FRAGMENT = "huitu.zhishulib.com"
# 桌面 Chrome UA（SSO Angular 页对桌面 UA 渲染账号密码表单）。
DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


@dataclass
class _SsoLoginForm:
    """从 SSO 登录页解析出的表单信息。"""

    action: str = ""
    croypto: str = ""
    execution: str = ""
    fields: dict[str, str] = field(default_factory=dict)


class _LoginFormParser(HTMLParser):
    """解析 SSO 页里的 ``#login-croypto`` 与 ``#login-page-flowkey``。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.form = _SsoLoginForm()
        self._in_login_form = 0
        self._capture_id: str | None = None
        self._capture_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "form":
            if attributes.get("id") == "normalLoginForm":
                self._in_login_form += 1
                self.form.action = attributes.get("action", "") or ""
            return
        element_id = attributes.get("id")
        if self._capture_id is None and element_id in {"login-croypto", "login-page-flowkey"}:
            self._capture_id = element_id
            self._capture_depth = 1
        elif self._capture_id is not None:
            self._capture_depth += 1
        if not self._in_login_form:
            return
        if tag == "input":
            name = attributes.get("name")
            input_type = (attributes.get("type") or "text").lower()
            if name and input_type not in {
                "button",
                "checkbox",
                "image",
                "password",
                "radio",
                "submit",
            }:
                self.form.fields[name] = attributes.get("value", "") or ""

    def handle_endtag(self, tag: str) -> None:
        if tag == "form" and self._in_login_form:
            self._in_login_form -= 1
        elif self._capture_id is not None:
            self._capture_depth -= 1
            if self._capture_depth <= 0:
                self._capture_id = None

    def handle_data(self, data: str) -> None:
        if self._capture_id == "login-croypto":
            self.form.croypto += data
        elif self._capture_id == "login-page-flowkey":
            self.form.execution += data


def _parse_login_form(html: str) -> _SsoLoginForm:
    """解析 SSO 登录页，返回表单 action、密钥和隐藏字段。"""
    parser = _LoginFormParser()
    parser.feed(html)
    parser.close()
    parser.form.croypto = parser.form.croypto.strip()
    parser.form.execution = parser.form.execution.strip()
    return parser.form


def _aes_ecb_encrypt_base64(key_b64: str, plaintext: str) -> str:
    """按 SSO 前端逻辑加密：Base64 密钥作为 AES-128，ECB 模式 + Pkcs7。"""
    key = base64.b64decode(key_b64)
    if len(key) != 16:
        raise ValueError("SSO 加密密钥不是 16 字节，无法使用 AES-128")
    encryptor = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    padder = padding.PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(ciphertext).decode("ascii")


def _build_login_payload(
    form: _SsoLoginForm,
    username: str,
    password: str,
) -> dict[str, str]:
    """组装 SSO 实际提交的表单字段（username 明文，密码和 captcha_payload 加密）。"""
    payload = dict(form.fields)
    payload.update(
        {
            "username": username,
            "type": "UsernamePassword",
            "_eventId": "submit",
            "execution": form.execution,
            "croypto": form.croypto,
            "password": _aes_ecb_encrypt_base64(form.croypto, password),
            "captcha_payload": _aes_ecb_encrypt_base64(form.croypto, "{}"),
        },
    )
    return payload


def _http_login_failure_reason(html: str, final_url: str) -> str:
    """从 SSO 返回页推断登录失败原因。"""
    if "sso.hdu.edu.cn" not in final_url:
        return "登录失败：未跳转回图书馆站点。"
    lowered = html.lower()
    if re.search(r"密码错误|用户名或密码|账号或密码|认证失败|登录失败|请输入正确", lowered):
        return "登录失败：请核对学号与数字杭电密码。"
    if re.search(
        r"验证码错误|请输入验证码|请完成人机验证|验证码已失效|geetest|g-recaptcha",
        lowered,
    ):
        return "登录失败：检测到验证码（风控触发），请稍后重试或核对凭据。"
    return "登录失败：SSO 未跳转回图书馆站点，请稍后重试。"


class LibraryLogin:
    """管理慧图登录态：通过 HTTP 直连 CAS 获取会话 Cookie。"""

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
    ) -> tuple[bool, str]:
        """用学号+密码完成杭电统一身份认证登录，导出 Cookie 并写入缓存。

        HTTP 直连复现 SSO 的 AES-ECB 加密表单提交。返回
        (是否成功, 给用户的提示消息)，不抛异常。
        """
        return self._login_via_http(student_id, password)

    def _login_via_http(
        self,
        student_id: str,
        password: str,
    ) -> tuple[bool, str]:
        """复现 SSO 表单提交：AES-128/ECB/Pkcs7 加密密码后走 CAS 重定向。

        成功时把慧图域 Cookie 交给 ``_validate_and_save``；失败返回提示消息。
        """
        requests.packages.urllib3.disable_warnings()  # type: ignore[attr-defined]
        session = requests.Session()
        session.verify = False
        session.headers.update(
            {
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "User-Agent": DESKTOP_UA,
            },
        )
        try:
            response = session.get(
                LOGIN_CAS_ENTRY_URL,
                timeout=(10, 30),
                allow_redirects=True,
            )
        except requests.RequestException as exc:
            return False, f"HTTP 登录失败：{exc}"

        if response.status_code >= 400:
            return False, f"HTTP 登录失败：SSO 返回 {response.status_code}"
        if "sso.hdu.edu.cn" not in response.url:
            return False, "HTTP 登录失败：未进入 SSO 登录页"

        form = _parse_login_form(response.text)
        if not form.croypto or not form.execution:
            return False, "HTTP 登录失败：SSO 表单缺少 croypto/execution"
        try:
            payload = _build_login_payload(form, student_id, password)
        except (RuntimeError, ValueError) as exc:
            return False, f"HTTP 登录失败：{exc}"

        try:
            response = session.post(
                urljoin(response.url, form.action or response.url),
                data=payload,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": SSO_LOGIN_ORIGIN,
                    "Referer": response.url,
                },
                timeout=(10, 30),
                allow_redirects=True,
            )
        except requests.RequestException as exc:
            return False, f"HTTP 登录失败：{exc}"

        if response.status_code >= 400:
            return False, f"HTTP 登录失败：SSO 返回 {response.status_code}"

        has_auth_cookie = any(
            cookie.name in {"auth", "uid"}
            for cookie in session.cookies
            if "huitu" in (cookie.domain or "")
        )
        if has_auth_cookie:
            cookie_str = self._export_session_cookies(session)
            if cookie_str:
                return self._validate_and_save(cookie_str)
        return False, _http_login_failure_reason(response.text, response.url)

    def _export_session_cookies(self, session: requests.Session) -> str:
        """从 requests Session 导出目标域 Cookie，拼成请求头字符串。"""
        pairs = [
            f"{cookie.name}={cookie.value}"
            for cookie in session.cookies
            if TARGET_DOMAIN_FRAGMENT in (cookie.domain or "")
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
