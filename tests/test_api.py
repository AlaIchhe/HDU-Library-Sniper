"""ASGI 系统接口测试。"""

from __future__ import annotations

from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from application import JobState
from interfaces.api import app


def test_health_endpoint_precedes_flet_mount() -> None:
    response = TestClient(app).get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_status_endpoint_does_not_expose_secrets() -> None:
    application = Mock()
    application.state = JobState.IDLE
    application.authenticated = True
    application.list_plans.return_value = [Mock(enabled=True), Mock(enabled=False)]

    with patch("interfaces.api.get_application", return_value=application):
        response = TestClient(app).get("/api/v1/status")

    assert response.status_code == 200
    assert response.json() == {
        "state": "idle",
        "authenticated": True,
        "plans": 2,
        "enabled_plans": 1,
    }
    assert "password" not in response.text
