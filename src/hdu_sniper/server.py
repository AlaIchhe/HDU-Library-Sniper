"""FastAPI/ASGI 入口：健康接口与 Flet Web UI 共用一个服务进程。"""

from __future__ import annotations

from dataclasses import asdict

import flet as ft
from fastapi import FastAPI, HTTPException
from fastapi import status as http_status

from hdu_sniper import __version__
from hdu_sniper.runtime import get_app
from hdu_sniper.ui.app import flet_main, resolve_assets_dir


app = FastAPI(
    title="HDU Library Sniper",
    version=__version__,
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


@app.get("/api/v1/bookings", tags=["bookings"])
def list_bookings() -> dict:
    """返回当前图书馆账户的预约记录。"""
    return {"bookings": _authenticated_application().list_bookings()}


def _booking_query(operation, booking_id: str) -> dict:
    application = _authenticated_application()
    try:
        return {"response": operation(application, booking_id)}
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@app.get("/api/v1/bookings/{booking_id}/status", tags=["bookings"])
def get_booking_status(booking_id: str) -> dict:
    """读取一条预约的服务端状态，不执行预约状态变更。"""
    return _booking_query(
        lambda application, value: application.get_booking_status(value), booking_id
    )


@app.get("/api/v1/bookings/{booking_id}/latest-comeback-time", tags=["bookings"])
def get_latest_comeback_time(booking_id: str) -> dict:
    """读取暂离预约允许返回座位的最晚时间，不执行预约状态变更。"""
    return _booking_query(
        lambda application, value: application.get_latest_comeback_time(value), booking_id
    )


@app.post("/api/v1/booking/run", tags=["booking"])
def run_booking(execute_at: str | None = None) -> dict:
    """执行抢座；execute_at 可传 ISO 时间或毫秒级 Unix 时间戳。"""
    application = _authenticated_application()
    try:
        results = application.run_booking(execute_at=execute_at)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return {
        "success": any(item.success for item in results),
        "attempts": len(results),
        "results": [
            {
                "plan_id": item.plan.plan_id,
                "seat_num": item.plan.seat_num,
                "success": item.success,
                "verified": item.verified,
                "message": item.message,
                "elapsed_ms": item.elapsed_ms,
            }
            for item in results
        ],
    }


def _booking_action(operation, booking_id: str) -> dict[str, str | bool]:
    application = _authenticated_application()
    try:
        success, message = operation(application, booking_id)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if not success:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=message)
    return {"success": True, "message": message}


@app.delete("/api/v1/bookings/{booking_id}", tags=["bookings"])
def cancel_remote_booking(booking_id: str) -> dict[str, str | bool]:
    """检查取消限制后取消一条待签到或待确认预约。"""
    return _booking_action(
        lambda application, value: application.cancel_remote_booking(value), booking_id
    )


@app.post("/api/v1/bookings/{booking_id}/check-in", tags=["bookings"])
def check_in_booking(booking_id: str) -> dict[str, str | bool]:
    """签到一条待签到预约。"""
    return _booking_action(
        lambda application, value: application.check_in_booking(value), booking_id
    )


@app.post("/api/v1/bookings/{booking_id}/come-back", tags=["bookings"])
def come_back_booking(booking_id: str) -> dict[str, str | bool]:
    """让暂离中的预约恢复为使用中。"""
    return _booking_action(
        lambda application, value: application.come_back_booking(value), booking_id
    )


@app.post("/api/v1/bookings/{booking_id}/renew", tags=["bookings"])
def renew_booking(booking_id: str) -> dict[str, str | bool]:
    """将暂离中的预约续回为使用中。"""
    return _booking_action(
        lambda application, value: application.renew_booking(value), booking_id
    )


@app.post("/api/v1/bookings/{booking_id}/check-in-test", tags=["bookings"])
def test_check_in(booking_id: str) -> dict[str, str | bool]:
    """测试一条预约是否进入签到窗口，不会执行签到。"""
    application = _authenticated_application()
    try:
        success, message = application.test_check_in(booking_id)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return {"success": success, "message": message}


@app.post("/api/v1/bookings/auto-check-in", tags=["bookings"])
def auto_check_in() -> dict:
    """自动签到所有已经进入签到窗口的预约。"""
    return {"results": _authenticated_application().auto_check_in()}


@app.get("/api/v1/auto-check-in", tags=["auto-check-in"])
def auto_check_in_status() -> dict:
    """返回自动签到的开关、协议同意状态与当前协议版本。"""
    return _authenticated_application().auto_check_in_status()


@app.post("/api/v1/auto-check-in/enable", tags=["auto-check-in"])
def enable_auto_check_in() -> dict[str, str | bool]:
    """记录风险协议同意并启用自动签到，同步登录触发与窗口任务。"""
    application = _authenticated_application()
    success, message = application.enable_auto_check_in()
    if not success:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=message)
    return {"success": True, "message": message}


@app.post("/api/v1/auto-check-in/disable", tags=["auto-check-in"])
def disable_auto_check_in() -> dict[str, str | bool]:
    """关闭自动签到并移除相关系统任务。"""
    application = _authenticated_application()
    success, message = application.disable_auto_check_in()
    if not success:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=message)
    return {"success": True, "message": message}


@app.post("/api/v1/bookings/{booking_id}/leave", tags=["bookings"])
def leave_booking(booking_id: str) -> dict[str, str | bool]:
    """让使用中的预约暂离。"""
    return _booking_action(
        lambda application, value: application.leave_booking(value), booking_id
    )


@app.post("/api/v1/bookings/{booking_id}/sign-out", tags=["bookings"])
def sign_out_booking(booking_id: str) -> dict[str, str | bool]:
    """签退一条使用中的预约。"""
    return _booking_action(
        lambda application, value: application.sign_out_booking(value), booking_id
    )


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
