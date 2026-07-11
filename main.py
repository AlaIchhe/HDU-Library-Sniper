"""HDU 图书馆抢座工具 - 统一入口。"""

from __future__ import annotations

import sys


def main() -> None:
    """统一入口：GUI 界面 / 后台守护进程。

    模式：
    - 默认: 启动 GUI 界面（用户唯一交互方式）
    - --daemon / --run-now: 后台执行（由系统定时任务调用，用户不可见）
    """

    if "--daemon" in sys.argv[1:] or "--run-now" in sys.argv[1:]:
        # 后台守护进程模式：静默执行抢座
        # 用于系统定时任务调用，用户不应该直接运行此模式
        from services.booking import BookingService
        from services.runtime import build_runtime
        sys.exit(BookingService(*build_runtime()).run_once())

    else:
        # GUI 界面模式（默认）
        # 这是用户唯一应该看到的交互界面
        from gui.app import run_gui
        run_gui()


if __name__ == "__main__":
    main()

