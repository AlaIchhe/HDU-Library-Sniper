"""Update dialog download button tests."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from hdu_sniper.ui.app import SniperFletView
from hdu_sniper.updater import UpdateCancelled, UpdateChecksumError, UpdateInfo


def _page() -> Mock:
    page = Mock()
    page.width = 1000
    page.web = False
    page.window = Mock()
    page.window.close = AsyncMock()
    return page


def _application() -> Mock:
    application = Mock()
    application.authenticated = False
    application.saved_credentials.return_value = None
    application.try_cached_authentication.return_value = False
    application.subscribe.return_value = Mock()
    application.list_plans.return_value = []
    return application


def test_update_download_opens_installer_url() -> None:
    view = SniperFletView(_page(), _application())
    view.available_update = UpdateInfo(
        version="9.9.9",
        tag_name="v9.9.9",
        release_url="https://github.com/example/HDU-Library-Sniper/releases/tag/v9.9.9",
        download_url="https://example.test/setup.exe",
    )

    with patch("hdu_sniper.ui.app.ft.UrlLauncher") as launcher:
        launcher.return_value.launch_url = AsyncMock()
        asyncio.run(view._open_update_download(None))

        view.page.pop_dialog.assert_called_once_with()
        launcher.return_value.launch_url.assert_awaited_once_with(
            "https://example.test/setup.exe"
        )


def test_update_download_falls_back_to_release_page() -> None:
    view = SniperFletView(_page(), _application())
    view.available_update = UpdateInfo(
        version="9.9.9",
        tag_name="v9.9.9",
        release_url="https://github.com/example/HDU-Library-Sniper/releases",
        download_url=None,
    )

    with patch("hdu_sniper.ui.app.ft.UrlLauncher") as launcher:
        launcher.return_value.launch_url = AsyncMock()
        asyncio.run(view._open_update_download(None))

        launcher.return_value.launch_url.assert_awaited_once_with(
            "https://github.com/example/HDU-Library-Sniper/releases"
        )


def test_start_update_download_uses_browser_in_web_mode() -> None:
    view = SniperFletView(_page(), _application())
    view.page.web = True
    view.available_update = UpdateInfo(
        version="9.9.9",
        tag_name="v9.9.9",
        release_url="https://github.com/example/HDU-Library-Sniper/releases/tag/v9.9.9",
        download_url="https://example.test/setup.exe",
    )

    with patch("hdu_sniper.ui.app.ft.UrlLauncher") as launcher:
        launcher.return_value.launch_url = AsyncMock()
        asyncio.run(view._start_update_download(None))

        launcher.return_value.launch_url.assert_awaited_once_with(
            "https://example.test/setup.exe"
        )


def test_start_update_download_uses_browser_for_non_exe_asset() -> None:
    view = SniperFletView(_page(), _application())
    view.available_update = UpdateInfo(
        version="9.9.9",
        tag_name="v9.9.9",
        release_url="https://github.com/example/HDU-Library-Sniper/releases/tag/v9.9.9",
        download_url="https://example.test/setup.msi",
    )

    with patch("hdu_sniper.ui.app.ft.UrlLauncher") as launcher:
        launcher.return_value.launch_url = AsyncMock()
        asyncio.run(view._start_update_download(None))

        launcher.return_value.launch_url.assert_awaited_once_with(
            "https://example.test/setup.msi"
        )


def test_start_update_download_shows_progress_dialog_on_windows() -> None:
    view = SniperFletView(_page(), _application())
    view.available_update = UpdateInfo(
        version="9.9.9",
        tag_name="v9.9.9",
        release_url="https://github.com/example/HDU-Library-Sniper/releases/tag/v9.9.9",
        download_url="https://example.test/setup.exe",
    )

    asyncio.run(view._start_update_download(None))

    view.page.pop_dialog.assert_called_once_with()
    view.page.show_dialog.assert_called_once_with(view._update_dialog)
    view.page.run_task.assert_called_once()
    assert view.update_button.disabled is True


def test_perform_update_download_launches_installer_and_closes() -> None:
    view = SniperFletView(_page(), _application())
    update = UpdateInfo(
        version="9.9.9",
        tag_name="v9.9.9",
        release_url="https://github.com/example/HDU-Library-Sniper/releases/tag/v9.9.9",
        download_url="https://example.test/setup.exe",
    )
    installer = Path("C:/Downloads/setup.exe")

    with (
        patch("hdu_sniper.ui.app.download_update", return_value=installer),
        patch("hdu_sniper.ui.app.launch_installer") as launch,
    ):
        asyncio.run(view._perform_update_download(update))

    launch.assert_called_once_with(installer)
    view.page.window.close.assert_awaited_once_with()


def test_perform_update_download_reports_cancellation() -> None:
    view = SniperFletView(_page(), _application())
    update = UpdateInfo(
        version="9.9.9",
        tag_name="v9.9.9",
        release_url="https://github.com/example/HDU-Library-Sniper/releases/tag/v9.9.9",
        download_url="https://example.test/setup.exe",
    )

    with patch(
        "hdu_sniper.ui.app.download_update",
        side_effect=UpdateCancelled("cancelled"),
    ):
        asyncio.run(view._perform_update_download(update))

    assert "下载已取消" in view._update_status.value


def test_perform_update_download_reports_checksum_failure() -> None:
    view = SniperFletView(_page(), _application())
    update = UpdateInfo(
        version="9.9.9",
        tag_name="v9.9.9",
        release_url="https://github.com/example/HDU-Library-Sniper/releases/tag/v9.9.9",
        download_url="https://example.test/setup.exe",
    )

    with patch(
        "hdu_sniper.ui.app.download_update",
        side_effect=UpdateChecksumError("bad checksum"),
    ):
        asyncio.run(view._perform_update_download(update))

    assert "校验未通过" in view._update_status.value
