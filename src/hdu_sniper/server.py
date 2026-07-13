"""FastAPI/ASGI 入口：健康接口与 Flet Web UI 共用一个服务进程。"""

from __future__ import annotations

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


@app.get("/api/v1/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/status", tags=["system"])
def status() -> dict:
    application = get_app()
    if not application.authenticated:
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="authentication required",
        )
    plans = application.list_plans()
    return {
        "state": application.state,
        "authenticated": application.authenticated,
        "plans": len(plans),
        "enabled_plans": sum(plan.enabled for plan in plans),
    }


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
