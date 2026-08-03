"""HDU 图书馆抢座工具 - 统一入口。"""

from __future__ import annotations

import os


def main() -> None:
    """统一入口：Flet 桌面/Web 界面或后台执行。

    模式：
    - 默认: 启动 Flet 桌面界面
    - --web: 启动 Flet Web 服务（Docker/服务器）
    - --daemon / --run-now: 后台执行（由系统定时任务调用，用户不可见）
    """

    import sys

    if "--web" in sys.argv[1:]:
        import uvicorn

        from hdu_sniper.runtime import get_app
        from hdu_sniper.server import create_server_app

        host = os.environ.get("FLET_SERVER_IP", "0.0.0.0")
        port = int(os.environ.get("FLET_SERVER_PORT", "8000"))
        uvicorn.run(create_server_app(get_app()), host=host, port=port)
        return

    from hdu_sniper.desktop import main as desktop_main
    from hdu_sniper.diagnostics import desktop_self_check
    from hdu_sniper.runtime import get_app

    desktop_main(application=get_app(), self_check=desktop_self_check)


if __name__ == "__main__":
    main()
