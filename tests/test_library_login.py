"""Boundary tests for cached and browser-assisted authentication."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import hdu_sniper.library.login as login_module
from hdu_sniper.config import Settings
from hdu_sniper.library.client import CookieError, HduLibraryError
from hdu_sniper.library.login import LibraryLogin
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


def test_export_cookies_only_keeps_library_domain(tmp_path: Path) -> None:
    context = Mock()
    context.cookies.return_value = [
        {"name": "auth", "value": "abc", "domain": ".huitu.zhishulib.com"},
        {"name": "sso", "value": "xyz", "domain": "sso.hdu.edu.cn"},
    ]

    assert _login(tmp_path)._export_cookies(context) == "auth=abc"


def test_diagnose_failure_reports_page_errors_and_captcha(tmp_path: Path) -> None:
    page = Mock()
    page.eval_on_selector_all.return_value = ["password incorrect"]
    page.evaluate.return_value = True

    success, message = _login(tmp_path)._diagnose_failure(page)

    assert success is False
    assert "password incorrect" in message
    assert "验证码" in message


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


def test_login_reports_browser_launch_failure(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(login_module, "configure_packaged_browser", lambda: None)
    playwright = SimpleNamespace(
        chromium=SimpleNamespace(launch=Mock(side_effect=RuntimeError("missing browser")))
    )
    manager = MagicMock()
    manager.__enter__.return_value = playwright
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: manager)

    success, message = _login(tmp_path).login_with_credentials("student", "password")

    assert success is False
    assert "missing browser" in message


def test_login_reports_missing_username_field(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(login_module, "configure_packaged_browser", lambda: None)
    page = Mock()
    page.wait_for_selector.side_effect = TimeoutError("not found")
    context = Mock()
    context.new_page.return_value = page
    browser = Mock()
    browser.new_context.return_value = context
    playwright = SimpleNamespace(chromium=SimpleNamespace(launch=Mock(return_value=browser)))
    manager = MagicMock()
    manager.__enter__.return_value = playwright
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: manager)

    success, message = _login(tmp_path).login_with_credentials("student", "password")

    assert success is False
    assert "输入框" in message
    context.close.assert_called_once_with()
    browser.close.assert_called_once_with()


def test_login_exports_and_validates_cookie_after_redirect(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(login_module, "configure_packaged_browser", lambda: None)
    page = Mock()
    context = Mock()
    context.new_page.return_value = page
    context.cookies.return_value = [
        {"name": "auth", "value": "abc", "domain": ".huitu.zhishulib.com"}
    ]
    browser = Mock()
    browser.new_context.return_value = context
    playwright = SimpleNamespace(chromium=SimpleNamespace(launch=Mock(return_value=browser)))
    manager = MagicMock()
    manager.__enter__.return_value = playwright
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: manager)
    login = _login(tmp_path)
    login._validate_and_save = Mock(return_value=(True, "ok"))

    success, message = login.login_with_credentials("student", "password", headless=False)

    assert (success, message) == (True, "ok")
    playwright.chromium.launch.assert_called_once_with(
        headless=False,
        args=["--disable-blink-features=AutomationControlled"],
    )
    page.click.assert_called_once_with("button.login-button")
    login._validate_and_save.assert_called_once_with("auth=abc")
