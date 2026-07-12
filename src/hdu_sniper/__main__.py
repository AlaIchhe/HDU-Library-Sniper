"""HDU 图书馆抢座工具 - 统一入口。"""

from __future__ import annotations

import sys


def main() -> None:
    """统一入口：Flet 桌面/Web 界面或后台执行。

    模式：
    - 默认: 启动 Flet 桌面界面
    - --web: 启动 Flet Web 服务（Docker/服务器）
    - --daemon / --run-now: 后台执行（由系统定时任务调用，用户不可见）
    """

    if "--daemon" in sys.argv[1:] or "--run-now" in sys.argv[1:]:
        # 后台守护进程模式：静默执行抢座
        # 用于系统定时任务调用，用户不应该直接运行此模式
        from hdu_sniper.runtime import get_app

        sys.exit(get_app().booking.run_once())

    else:
        from hdu_sniper.ui.app import run_flet_app

        run_flet_app(web="--web" in sys.argv[1:])


if __name__ == "__main__":
    main()
