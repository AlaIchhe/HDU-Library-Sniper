"""FastAPI/ASGI 入口：健康接口与 Flet Web UI 共用一个服务进程。"""

from __future__ import annotations

import flet as ft
from fastapi import FastAPI

from hdu_sniper.runtime import get_app
from hdu_sniper.ui.app import flet_main


app = FastAPI(
    title="HDU Library Sniper",
    version="1.0.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)


@app.get("/api/v1/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/status", tags=["system"])
def status() -> dict:
    application = get_app()
    plans = application.list_plans()
    return {
        "state": application.state,
        "authenticated": application.authenticated,
        "plans": len(plans),
        "enabled_plans": sum(plan.enabled for plan in plans),
    }


flet_asgi = ft.run(flet_main, export_asgi_app=True)
app.mount("/", flet_asgi)
