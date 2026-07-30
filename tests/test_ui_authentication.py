"""Authentication-driven Flet shell visibility tests."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hdu_sniper.booking.models import BookingPlan
from hdu_sniper.config import Credentials
from hdu_sniper.events import ApplicationEvent, EventKind, JobState
from hdu_sniper.library.rooms import FloorInfo
from hdu_sniper.scheduler import ScheduledTask
from hdu_sniper.ui.app import (
    ACTIVE_FONT_FAMILY,
    FONT_ASSET,
    FONT_FALLBACK,
    SniperFletView,
    resolve_assets_dir,
)


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

    assert view.content_frame.content is view.auth_view
    assert view.navigation_rail.visible is False
    assert view.bottom_navigation.visible is False
    assert view.reauthenticate_button.visible is False
    assert view.back_to_app_button.visible is False
    assert page.fonts == {FONT_FALLBACK: FONT_ASSET}
    assert page.theme.font_family == ACTIVE_FONT_FAMILY
    application.list_plans.assert_not_called()
    page.run_task.assert_not_called()


def test_authenticated_shell_hides_authentication_from_primary_navigation() -> None:
    page = _page()
    application = _application(authenticated=True)

    view = SniperFletView(page, application)

    assert view.content_frame.content is view.business_views[0]
    assert len(view.navigation_rail.destinations) == 3
    assert view.navigation_rail.visible is True
    assert view.reauthenticate_button.visible is True
    application.list_plans.assert_called_once_with()
    assert page.run_task.call_count == 3


def test_reauthentication_entry_can_return_to_valid_session() -> None:
    page = _page()
    application = _application(authenticated=True)
    view = SniperFletView(page, application)

    view._open_reauthentication(None)
    assert view.content_frame.content is view.auth_view
    assert view.back_to_app_button.visible is True
    assert view.navigation_rail.visible is False

    view._return_to_app(None)
    assert view.content_frame.content is view.business_views[0]
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

    assert view.content_frame.content is view.auth_view
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


def test_schedule_view_renders_managed_task_actions() -> None:
    page = _page()
    view = SniperFletView(page, _application(authenticated=True))

    view._render_scheduled_tasks(
        [
            ScheduledTask(
                name="HDU-Library-Sniper-Daily",
                status="Ready",
                next_run="tomorrow",
            )
        ]
    )

    assert view.schedule_summary.value == "已创建 1 个调度"
    assert len(view.schedule_list.controls) == 1
    assert view.business_views[2].controls[1].content.wrap is False
    assert view.schedule_list.controls[0].content.wrap is False


def test_booking_view_renders_actions_for_each_supported_status() -> None:
    page = _page()
    view = SniperFletView(page, _application(authenticated=True))

    view._render_bookings(
        [
            {
                "id": "1",
                "status": "0",
                "roomName": "四楼自习室",
                "seatNum": "298",
                "time": "1785200400",
                "duration": "3600",
            },
            {
                "id": "8",
                "status": "8",
                "roomName": "四楼自习室",
                "seatNum": "299",
                "time": "1785200400",
                "duration": "3600",
            },
            {
                "id": "2",
                "status": "2",
                "roomName": "四楼自习室",
                "seatNum": "300",
                "time": "1785200400",
                "duration": "3600",
            },
            {
                "id": "7",
                "status": "7",
                "roomName": "四楼自习室",
                "seatNum": "298",
                "time": "1785114000",
                "duration": "3600",
            },
        ]
    )

    assert view.booking_summary.value == "共 4 条预约记录"
    pending_row = view.booking_list.controls[0].content
    confirmation_row = view.booking_list.controls[1].content
    away_row = view.booking_list.controls[2].content
    finished_row = view.booking_list.controls[3].content
    assert len(pending_row.controls) == 3
    assert len(confirmation_row.controls) == 2
    assert len(away_row.controls) == 2
    assert len(finished_row.controls) == 1
    assert all(row.wrap is False for row in (pending_row, confirmation_row, away_row, finished_row))


def test_misans_font_asset_and_license_are_distributable() -> None:
    assets = Path(resolve_assets_dir())
    font = assets / FONT_ASSET
    license_file = assets / "fonts" / "MiSans-LICENSE.pdf"

    assert font.read_bytes()[:4] == b"\x00\x01\x00\x00"
    assert license_file.read_bytes()[:5] == b"%PDF-"


def test_web_shell_declares_responsive_viewport() -> None:
    web_shell = Path(resolve_assets_dir()) / "index.html"

    content = web_shell.read_text(encoding="utf-8")
    assert 'name="viewport"' in content
    assert "width=device-width" in content


def test_frozen_assets_resolve_from_pyinstaller_bundle(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("hdu_sniper.ui.app.sys.frozen", True, raising=False)
    monkeypatch.setattr("hdu_sniper.ui.app.sys._MEIPASS", str(tmp_path), raising=False)

    assert resolve_assets_dir() == str(tmp_path / "assets")


def test_cached_credential_without_valid_session_keeps_authentication_form() -> None:
    page = _page()
    application = _application(authenticated=False)
    application.saved_credentials.return_value = Credentials("2024001", "secret")

    view = SniperFletView(page, application)

    assert view.student_id.value == "2024001"
    assert view.auth_log.value
    assert view.content_frame.content is view.auth_view
    assert view.navigation_rail.visible is False


def test_navigation_refreshes_selected_business_view() -> None:
    page = _page()
    view = SniperFletView(page, _application(authenticated=True))

    view._navigate(SimpleNamespace(control=SimpleNamespace(selected_index=1)))
    assert view.content_frame.content is view.business_views[1]
    assert page.run_task.call_args.args[0] == view._refresh_bookings

    page.run_task.reset_mock()
    view._navigate(SimpleNamespace(control=SimpleNamespace(selected_index=2)))
    assert view.content_frame.content is view.business_views[2]
    assert page.run_task.call_count == 2


def test_navigation_redirects_expired_session_to_authentication() -> None:
    page = _page()
    application = _application(authenticated=False)
    view = SniperFletView(page, application)

    view._navigate(SimpleNamespace(control=SimpleNamespace(selected_index=1)))

    assert view.content_frame.content is view.auth_view
    page.run_task.assert_not_called()


def test_responsive_layout_switches_between_desktop_and_mobile() -> None:
    page = _page()
    view = SniperFletView(page, _application(authenticated=True))

    view._apply_responsive_layout(width=480)
    assert view.navigation_rail.visible is False
    assert view.bottom_navigation.visible is True
    assert view.content_frame.width == 328
    assert view.plan_panel.height == 320

    view._apply_responsive_layout(width=900)
    assert view.navigation_rail.visible is True
    assert view.bottom_navigation.visible is False
    assert view.content_frame.width == 1080
    assert view.plan_panel.height == 520


def test_login_validates_input_and_handles_success_and_failure() -> None:
    page = _page()
    application = _application(authenticated=False)
    view = SniperFletView(page, application)

    asyncio.run(view._login(None))
    page.show_dialog.assert_called_once()
    application.authenticate.assert_not_called()

    page.show_dialog.reset_mock()
    view.student_id.value = "2024001"
    view.password.value = "secret"
    application.authenticate.return_value = (True, "ok")
    asyncio.run(view._login(None))
    application.authenticate.assert_called_once_with("2024001", "secret")
    assert view.password.value == ""
    assert view.content_frame.content is view.auth_view

    application.authenticated = False
    view.password.value = "secret"
    application.authenticate.return_value = (False, "denied")
    asyncio.run(view._login(None))
    assert view.auth_log.value == "denied"
    assert view.login_button.disabled is False


def test_room_and_floor_loading_updates_controls_and_errors() -> None:
    page = _page()
    application = _application(authenticated=True)
    view = SniperFletView(page, application)
    application.list_room_types.return_value = [
        {"query": "study", "name": "Study Room"},
        {"query": "", "name": "Ignored"},
    ]

    asyncio.run(view._load_room_types())
    assert list(view.room_types) == ["study", ""]
    assert len(view.room_type.options) == 1

    view.room_type.value = "study"
    application.list_floors.return_value = [
        FloorInfo("1", "First Floor", 2, ["001", "002"])
    ]
    asyncio.run(view._load_floors(None))
    assert view.floor.disabled is False
    assert len(view.floor.options) == 1

    view.floor.value = "1"
    view._update_seat_hint(None)
    assert "001" in view.seat_hint.value

    application.list_floors.side_effect = RuntimeError("offline")
    asyncio.run(view._load_floors(None))
    assert "offline" in view.seat_hint.value

    view.room_type.value = ""
    asyncio.run(view._load_floors(None))
    assert [call.args for call in application.list_floors.call_args_list] == [
        ("study",),
        ("study",),
    ]


def test_plan_selection_and_creation_validation() -> None:
    page = _page()
    application = _application(authenticated=True)
    view = SniperFletView(page, application)
    view._refresh_plans()
    assert view.plan_list.controls

    plan = BookingPlan(1, 100, "001", 8, 4, plan_id="plan-1")
    application.list_plans.return_value = [plan]
    view._refresh_plans()
    checkbox = view.plan_list.controls[0].content.controls[0]
    checkbox.value = True
    checkbox.on_change(SimpleNamespace(control=checkbox))
    assert view.selected_plan_ids == {"plan-1"}
    assert view.delete_button.disabled is False

    asyncio.run(view._create_plan(None))
    application.create_plan.assert_not_called()


@pytest.mark.parametrize("method_name", ["_refresh_bookings", "_refresh_scheduled_tasks"])
def test_refresh_callbacks_restore_controls_after_service_failure(method_name: str) -> None:
    page = _page()
    application = _application(authenticated=True)
    view = SniperFletView(page, application)
    service = "list_bookings" if method_name == "_refresh_bookings" else "list_scheduled_tasks"
    getattr(application, service).side_effect = RuntimeError("offline")

    asyncio.run(getattr(view, method_name)())

    control = view.refresh_bookings_button if method_name == "_refresh_bookings" else view.refresh_schedules_button
    assert control.disabled is False
    assert "offline" in (view.booking_summary.value if method_name == "_refresh_bookings" else view.schedule_summary.value)
