"""ASGI 系统接口测试。"""

from __future__ import annotations

from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from hdu_sniper.events import JobState
from hdu_sniper.scheduler import ScheduledTask
from hdu_sniper.server import app


def test_health_endpoint_precedes_flet_mount() -> None:
    response = TestClient(app).get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_web_host_serves_bundled_chinese_font() -> None:
    response = TestClient(app).get("/fonts/MiSansVF.ttf")

    assert response.status_code == 200
    assert response.content[:4] == b"\x00\x01\x00\x00"


def test_status_endpoint_does_not_expose_secrets() -> None:
    application = Mock()
    application.state = JobState.IDLE
    application.authenticated = True
    application.list_plans.return_value = [Mock(enabled=True), Mock(enabled=False)]

    with patch("hdu_sniper.server.get_app", return_value=application):
        response = TestClient(app).get("/api/v1/status")

    assert response.status_code == 200
    assert response.json() == {
        "state": "idle",
        "authenticated": True,
        "plans": 2,
        "enabled_plans": 1,
    }
    assert "password" not in response.text


def test_status_requires_authentication_and_api_schema_is_hidden() -> None:
    application = Mock(authenticated=False)

    with patch("hdu_sniper.server.get_app", return_value=application):
        response = TestClient(app).get("/api/v1/status")

    assert response.status_code == 401
    assert response.json() == {"detail": "authentication required"}
    assert TestClient(app).get("/api/docs").status_code == 404
    assert TestClient(app).get("/api/openapi.json").status_code == 404


def test_schedule_endpoints_list_and_manage_application_tasks() -> None:
    application = Mock(authenticated=True)
    task = ScheduledTask(
        name="HDU-Library-Sniper-Daily",
        status="Ready",
        next_run="2026-07-26 20:00:00",
        last_run="2026-07-25 20:00:00",
        last_result="0",
    )
    application.list_scheduled_tasks.return_value = [task]
    application.run_scheduled_task.return_value = (True, "started")
    application.delete_scheduled_task.return_value = (True, "deleted")

    with patch("hdu_sniper.server.get_app", return_value=application):
        client = TestClient(app)
        list_response = client.get("/api/v1/schedules")
        run_response = client.post("/api/v1/schedules/HDU-Library-Sniper-Daily/run")
        delete_response = client.delete("/api/v1/schedules/HDU-Library-Sniper-Daily")

    assert list_response.status_code == 200
    assert list_response.json() == {
        "tasks": [
            {
                "name": "HDU-Library-Sniper-Daily",
                "status": "Ready",
                "next_run": "2026-07-26 20:00:00",
                "last_run": "2026-07-25 20:00:00",
                "last_result": "0",
            }
        ]
    }
    assert run_response.json() == {"success": True, "message": "started"}
    assert delete_response.json() == {"success": True, "message": "deleted"}
    application.run_scheduled_task.assert_called_once_with("HDU-Library-Sniper-Daily")
    application.delete_scheduled_task.assert_called_once_with("HDU-Library-Sniper-Daily")


def test_schedule_endpoints_require_authentication() -> None:
    application = Mock(authenticated=False)

    with patch("hdu_sniper.server.get_app", return_value=application):
        response = TestClient(app).get("/api/v1/schedules")

    assert response.status_code == 401
    assert response.json() == {"detail": "authentication required"}


def test_booking_endpoints_delegate_account_actions() -> None:
    application = Mock(authenticated=True)
    application.leave_booking.return_value = (True, "已暂离座位")
    application.sign_out_booking.return_value = (True, "已签退，预约结束")
    application.list_bookings.return_value = [{"id": "1", "status": "0"}]
    application.get_booking_status.return_value = {"CODE": "ok", "DATA": {"status": "0"}}
    application.get_latest_comeback_time.return_value = {
        "CODE": "ok",
        "DATA": {"latestComeBackTime": "123"},
    }
    application.cancel_remote_booking.return_value = (True, "预约已取消")
    application.check_in_booking.return_value = (True, "签到成功，座位使用中")
    application.come_back_booking.return_value = (True, "已返回座位，座位使用中")

    with patch("hdu_sniper.server.get_app", return_value=application):
        client = TestClient(app)
        assert client.get("/api/v1/bookings").json()["bookings"][0]["id"] == "1"
        assert client.get("/api/v1/bookings/1/status").json()["response"]["CODE"] == "ok"
        assert (
            client.get("/api/v1/bookings/1/latest-comeback-time").json()["response"]["CODE"]
            == "ok"
        )
        assert client.delete("/api/v1/bookings/1").status_code == 200
        assert client.post("/api/v1/bookings/1/check-in").status_code == 200
        assert client.post("/api/v1/bookings/1/come-back").status_code == 200
        assert client.post("/api/v1/bookings/1/leave").status_code == 200
        assert client.post("/api/v1/bookings/1/sign-out").status_code == 200

    application.cancel_remote_booking.assert_called_once_with("1")
    application.get_booking_status.assert_called_once_with("1")
    application.get_latest_comeback_time.assert_called_once_with("1")
    application.check_in_booking.assert_called_once_with("1")
    application.come_back_booking.assert_called_once_with("1")
    application.leave_booking.assert_called_once_with("1")
    application.sign_out_booking.assert_called_once_with("1")
