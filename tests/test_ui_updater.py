"""Update dialog download button tests."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, Mock, patch

from hdu_sniper.ui.app import SniperFletView
from hdu_sniper.updater import UpdateInfo


def _page() -> Mock:
    page = Mock()
    page.width = 1000
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
