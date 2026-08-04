"""Boundary tests for cached and HTTP-assisted authentication."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import hdu_sniper.library.login as login_module
from hdu_sniper.config import Settings
from hdu_sniper.library.client import CookieError, HduLibraryError
from hdu_sniper.library.login import (
    LibraryLogin,
    _aes_ecb_encrypt_base64,
    _build_login_payload,
    _http_login_failure_reason,
    _parse_login_form,
    _SsoLoginForm,
)
from hdu_sniper.paths import AppPaths


def _login(tmp_path: Path, client: Mock | None = None) -> LibraryLogin:
    paths = AppPaths(
        config_dir=tmp_path / "config",
        data_dir=tmp_path / "data",
        state_dir=tmp_path / "state",
        log_dir=tmp_path / "state" / "logs",
    )
    return LibraryLogin(client or Mock(), Settings(paths=paths))


def test_try_cache_requires_valid_cookie_and_uid(tmp_path: Path) -> None:
    client = Mock()
    client.validate_cookie.return_value = True
    login = _login(tmp_path, client)

    assert login.try_cache() is True
    client.resolve_uid.assert_called_once_with()

    client.validate_cookie.return_value = False
    assert login.try_cache() is False

    client.load_cookie_cache.side_effect = CookieError("bad cache")
    assert login.try_cache() is False


def test_try_cache_handles_remote_validation_failure(tmp_path: Path) -> None:
    client = Mock()
    client.validate_cookie.side_effect = HduLibraryError("offline")

    assert _login(tmp_path, client).try_cache() is False


def test_export_session_cookies_only_keeps_library_domain(tmp_path: Path) -> None:
    session = SimpleNamespace(
        cookies=[
            SimpleNamespace(name="auth", value="abc", domain=".huitu.zhishulib.com"),
            SimpleNamespace(name="sso", value="xyz", domain="sso.hdu.edu.cn"),
        ],
    )

    assert _login(tmp_path)._export_session_cookies(session) == "auth=abc"


def test_aes_ecb_encrypt_matches_cas_login_capture() -> None:
    key = "1mcPSH/ZqOj0jk2wqciiwg=="

    assert _aes_ecb_encrypt_base64(key, "CodexTest123!") == "9oiR8BBNglnNCsP3kEU1nA=="
    assert _aes_ecb_encrypt_base64(key, "{}") == "gvbg2FZxnxzbGL00krtoUg=="


def test_parse_login_form_extracts_key_hidden_fields_and_action() -> None:
    html = """
    <form id="normalLoginForm" action="/login">
      <input type="hidden" name="execution" value="flow-key">
      <input type="hidden" name="_eventId" value="submit">
      <input name="username">
      <div id="login-croypto"><span> 1mcPSH/ZqOj0jk2wqciiwg== </span></div>
      <p id="login-page-flowkey">flow-key</p>
    </form>
    """

    form = _parse_login_form(html)

    assert form.action == "/login"
    assert form.croypto == "1mcPSH/ZqOj0jk2wqciiwg=="
    assert form.execution == "flow-key"
    assert form.fields["execution"] == "flow-key"
    assert form.fields["_eventId"] == "submit"


def test_build_login_payload_uses_plain_username_and_aes_password() -> None:
    form = _SsoLoginForm(
        action="/login",
        croypto="1mcPSH/ZqOj0jk2wqciiwg==",
        execution="flow-key",
        fields={"execution": "flow-key"},
    )

    payload = _build_login_payload(form, "codex_test_user", "CodexTest123!")

    assert payload["username"] == "codex_test_user"
    assert payload["type"] == "UsernamePassword"
    assert payload["_eventId"] == "submit"
    assert payload["execution"] == "flow-key"
    assert payload["password"] == "9oiR8BBNglnNCsP3kEU1nA=="
    assert payload["captcha_payload"] == "gvbg2FZxnxzbGL00krtoUg=="


def test_http_login_submits_cas_form_and_exports_library_cookie(
    tmp_path: Path,
    monkeypatch,
) -> None:
    login_page = """
    <form id="normalLoginForm" action="/login">
      <input type="hidden" name="execution" value="flow-key">
      <div id="login-croypto">1mcPSH/ZqOj0jk2wqciiwg==</div>
      <p id="login-page-flowkey">flow-key</p>
    </form>
    """
    login_response = SimpleNamespace(
        status_code=200,
        url="https://sso.hdu.edu.cn/login",
        text=login_page,
    )
    cookie = SimpleNamespace(
        name="auth",
        value="abc",
        domain=".hdu.huitu.zhishulib.com",
    )

    class FakeSession:
        def __init__(self) -> None:
            self.headers = {}
            self.verify = True
            self.cookies = [cookie]
            self.submitted: dict[str, str] = {}

        def get(self, _url: str, **_kwargs):
            return login_response

        def post(
            self,
            _url: str,
            data: dict[str, str],
            _headers: dict | None = None,
            **_kwargs,
        ):
            self.submitted = data
            return SimpleNamespace(
                status_code=200,
                url="https://hdu.huitu.zhishulib.com/",
                text="",
            )

    fake_session = FakeSession()
    monkeypatch.setattr(login_module.requests, "Session", lambda: fake_session)
    login = _login(tmp_path)
    login._validate_and_save = Mock(return_value=(True, "ok"))

    success, message = login._login_via_http("codex_test_user", "CodexTest123!")

    assert (success, message) == (True, "ok")
    assert fake_session.submitted["username"] == "codex_test_user"
    assert fake_session.submitted["password"] == "9oiR8BBNglnNCsP3kEU1nA=="
    login._validate_and_save.assert_called_once_with("auth=abc")


def test_http_login_requires_library_auth_cookie(tmp_path: Path, monkeypatch) -> None:
    login_page = """
    <div id="login-croypto">1mcPSH/ZqOj0jk2wqciiwg==</div>
    <p id="login-page-flowkey">flow-key</p>
    """
    login_response = SimpleNamespace(
        status_code=200,
        url="https://sso.hdu.edu.cn/login",
        text=login_page,
    )

    class FakeSession:
        def __init__(self) -> None:
            self.headers = {}
            self.verify = True
            self.cookies = [
                SimpleNamespace(name="PHPSESSID", value="abc", domain="hdu.huitu.zhishulib.com"),
            ]
            self.submitted: dict[str, str] = {}

        def get(self, _url: str, **_kwargs):
            return login_response

        def post(
            self,
            _url: str,
            data: dict[str, str],
            _headers: dict | None = None,
            **_kwargs,
        ):
            self.submitted = data
            return SimpleNamespace(
                status_code=200,
                url="https://sso.hdu.edu.cn/login",
                text="",
            )

    monkeypatch.setattr(login_module.requests, "Session", FakeSession)
    login = _login(tmp_path)
    login._validate_and_save = Mock(return_value=(True, "unexpected"))

    success, message = login._login_via_http("codex_test_user", "CodexTest123!")

    assert success is False
    assert "未跳转" in message
    login._validate_and_save.assert_not_called()


def test_http_failure_reason_detects_credentials_and_captcha() -> None:
    assert "密码" in _http_login_failure_reason("用户名或密码错误", "https://sso.hdu.edu.cn/login")
    assert "验证码" in _http_login_failure_reason("geetest", "https://sso.hdu.edu.cn/login")
    assert "未跳转" in _http_login_failure_reason("", "https://hdu.huitu.zhishulib.com/")


def test_validate_and_save_checks_each_authentication_contract(tmp_path: Path) -> None:
    client = Mock(name="client")
    login = _login(tmp_path, client)
    client.name = "Alice"
    client.uid = "uid-1"
    client.validate_cookie.return_value = True

    success, message = login._validate_and_save("auth=abc")

    assert success is True
    assert "Alice" in message
    client.save_cookie_cache.assert_called_once_with(login.settings.paths.session_cache, "auth=abc")

    client.set_cookie_header.side_effect = HduLibraryError("invalid cookie")
    assert login._validate_and_save("bad")[0] is False
    client.set_cookie_header.side_effect = None
    client.validate_cookie.side_effect = HduLibraryError("offline")
    assert login._validate_and_save("auth=abc")[0] is False
    client.validate_cookie.side_effect = None
    client.validate_cookie.return_value = False
    assert login._validate_and_save("auth=abc")[0] is False
    client.validate_cookie.return_value = True
    client.resolve_uid.side_effect = HduLibraryError("unknown user")
    assert login._validate_and_save("auth=abc")[0] is False


def test_login_with_credentials_delegates_to_http(tmp_path: Path) -> None:
    login = _login(tmp_path)
    login._login_via_http = Mock(return_value=(True, "ok"))

    assert login.login_with_credentials("student", "password") == (True, "ok")
    login._login_via_http.assert_called_once_with("student", "password")
