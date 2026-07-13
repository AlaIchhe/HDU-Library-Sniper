"""Process entry-point routing tests."""

from __future__ import annotations

from unittest.mock import Mock

import pytest


def test_package_main_routes_web_mode(monkeypatch) -> None:
    import uvicorn

    from hdu_sniper import __main__

    run = Mock()
    monkeypatch.setattr(uvicorn, "run", run)
    monkeypatch.setattr("sys.argv", ["hdu-sniper", "--web"])
    monkeypatch.setenv("FLET_SERVER_IP", "127.0.0.1")
    monkeypatch.setenv("FLET_SERVER_PORT", "9000")

    __main__.main()

    run.assert_called_once_with("hdu_sniper.server:app", host="127.0.0.1", port=9000)


def test_package_main_routes_desktop_mode(monkeypatch) -> None:
    from hdu_sniper import __main__, desktop

    desktop_main = Mock()
    monkeypatch.setattr(desktop, "main", desktop_main)
    monkeypatch.setattr("sys.argv", ["hdu-sniper"])

    __main__.main()

    desktop_main.assert_called_once_with()


def test_desktop_routes_self_check(monkeypatch) -> None:
    from hdu_sniper import desktop

    monkeypatch.setattr("sys.argv", ["hdu-sniper", "--self-check"])
    monkeypatch.setattr(desktop, "desktop_self_check", Mock(return_value=11))

    with pytest.raises(SystemExit) as captured:
        desktop.main()

    assert captured.value.code == 11


@pytest.mark.parametrize("argument", ["--daemon", "--run-now"])
def test_desktop_routes_background_booking(argument: str, monkeypatch) -> None:
    from hdu_sniper import desktop

    application = Mock()
    application.booking.run_once.return_value = 3
    monkeypatch.setattr("sys.argv", ["hdu-sniper", argument])
    monkeypatch.setattr(desktop, "get_app", Mock(return_value=application))

    with pytest.raises(SystemExit) as captured:
        desktop.main()

    assert captured.value.code == 3


def test_desktop_starts_flet_by_default(monkeypatch) -> None:
    from hdu_sniper import desktop

    run_flet_app = Mock()
    monkeypatch.setattr("sys.argv", ["hdu-sniper"])
    monkeypatch.setattr(desktop, "run_flet_app", run_flet_app)

    desktop.main()

    run_flet_app.assert_called_once_with()
