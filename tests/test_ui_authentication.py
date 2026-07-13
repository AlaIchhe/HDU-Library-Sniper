"""Authentication-driven Flet shell visibility tests."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

from hdu_sniper.events import ApplicationEvent, EventKind, JobState
from hdu_sniper.ui.app import FONT_ASSET, FONT_FAMILY, SniperFletView, resolve_assets_dir


def _page() -> Mock:
    page = Mock()
    page.width = 1000
    return page


def _application(*, authenticated: bool) -> Mock:
    application = Mock()
    application.authenticated = authenticated
    application.saved_credentials.return_value = None
    application.try_cached_authentication.return_value = authenticated
    application.subscribe.return_value = Mock()
    application.list_plans.return_value = []
    return application


def test_unauthenticated_shell_exposes_only_authentication() -> None:
    page = _page()
    application = _application(authenticated=False)

    view = SniperFletView(page, application)

    assert view.view_host.content is view.auth_view
    assert view.navigation_rail.visible is False
    assert view.bottom_navigation.visible is False
    assert view.reauthenticate_button.visible is False
    assert view.back_to_app_button.visible is False
    assert page.fonts == {FONT_FAMILY: FONT_ASSET}
    assert page.theme.font_family == FONT_FAMILY
    application.list_plans.assert_not_called()
    page.run_task.assert_not_called()


def test_authenticated_shell_hides_authentication_from_primary_navigation() -> None:
    page = _page()
    application = _application(authenticated=True)

    view = SniperFletView(page, application)

    assert view.view_host.content is view.business_views[0]
    assert len(view.navigation_rail.destinations) == 2
    assert view.navigation_rail.visible is True
    assert view.reauthenticate_button.visible is True
    application.list_plans.assert_called_once_with()
    assert page.run_task.call_count == 2


def test_reauthentication_entry_can_return_to_valid_session() -> None:
    page = _page()
    application = _application(authenticated=True)
    view = SniperFletView(page, application)

    view._open_reauthentication(None)
    assert view.view_host.content is view.auth_view
    assert view.back_to_app_button.visible is True
    assert view.navigation_rail.visible is False

    view._return_to_app(None)
    assert view.view_host.content is view.business_views[0]
    assert view.reauthenticate_button.visible is True


def test_authentication_expiry_event_forces_authentication_shell() -> None:
    page = _page()
    application = _application(authenticated=True)
    view = SniperFletView(page, application)
    application.authenticated = False

    view._on_application_event(
        ApplicationEvent(
            EventKind.AUTH_REQUIRED,
            JobState.IDLE,
            "登录状态已失效，请重新认证",
            {"authenticated": False},
        )
    )

    assert view.view_host.content is view.auth_view
    assert view.auth_state.value == "认证已失效"
    assert view.navigation_rail.visible is False


def test_plan_creation_result_uses_confirmation_dialog() -> None:
    page = _page()
    view = SniperFletView(page, _application(authenticated=False))

    view._show_plan_creation_dialog(
        "方案和自动调度已就绪",
        "每日 20:00 自动调度已创建",
    )

    dialog = page.show_dialog.call_args.args[0]
    assert dialog.modal is True
    assert dialog.title.value == "方案和自动调度已就绪"
    assert "20:00" in dialog.content.value


def test_font_asset_and_license_are_distributable() -> None:
    assets = Path(resolve_assets_dir())
    font = assets / FONT_ASSET
    license_file = assets / "fonts" / "OFL.txt"

    assert font.read_bytes()[:4] == b"\x00\x01\x00\x00"
    assert "SIL OPEN FONT LICENSE" in license_file.read_text(encoding="utf-8")


def test_frozen_assets_resolve_from_pyinstaller_bundle(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("hdu_sniper.ui.app.sys.frozen", True, raising=False)
    monkeypatch.setattr("hdu_sniper.ui.app.sys._MEIPASS", str(tmp_path), raising=False)

    assert resolve_assets_dir() == str(tmp_path / "assets")
