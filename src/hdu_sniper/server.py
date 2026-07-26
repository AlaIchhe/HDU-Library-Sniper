"""FastAPI/ASGI 入口：健康接口与 Flet Web UI 共用一个服务进程。"""

from __future__ import annotations

from dataclasses import asdict

import flet as ft
from fastapi import FastAPI, HTTPException
from fastapi import status as http_status

from hdu_sniper.runtime import get_app
from hdu_sniper.ui.app import flet_main, resolve_assets_dir


app = FastAPI(
    title="HDU Library Sniper",
    version="1.0.0",
    docs_url=None,
    openapi_url=None,
)


def _authenticated_application():
    application = get_app()
    if not application.authenticated:
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="authentication required",
        )
    return application


@app.get("/api/v1/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/status", tags=["system"])
def status() -> dict:
    application = _authenticated_application()
    plans = application.list_plans()
    return {
        "state": application.state,
        "authenticated": application.authenticated,
        "plans": len(plans),
        "enabled_plans": sum(plan.enabled for plan in plans),
    }


@app.get("/api/v1/schedules", tags=["scheduler"])
def list_schedules() -> dict:
    """返回当前应用创建并允许管理的系统调度任务。"""
    application = _authenticated_application()
    try:
        tasks = application.list_scheduled_tasks()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    return {"tasks": [asdict(task) for task in tasks]}


@app.post("/api/v1/schedules/{task_name}/run", tags=["scheduler"])
def run_schedule(task_name: str) -> dict[str, str | bool]:
    """请求 Windows 任务计划程序立即运行一个本应用任务。"""
    application = _authenticated_application()
    try:
        success, message = application.run_scheduled_task(task_name)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if not success:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=message)
    return {"success": success, "message": message}


@app.delete("/api/v1/schedules/{task_name}", tags=["scheduler"])
def delete_schedule(task_name: str) -> dict[str, str | bool]:
    """删除一个由本应用创建的系统调度任务。"""
    application = _authenticated_application()
    try:
        success, message = application.delete_scheduled_task(task_name)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if not success:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=message)
    return {"success": success, "message": message}


@app.get("/api/docs", include_in_schema=False)
@app.get("/api/openapi.json", include_in_schema=False)
def disabled_api_documentation() -> None:
    raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND)


flet_asgi = ft.run(
    flet_main,
    assets_dir=resolve_assets_dir(),
    export_asgi_app=True,
)
app.mount("/", flet_asgi)
