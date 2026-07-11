"""HDU 图书馆抢座工具 — 多模式入口。"""

from __future__ import annotations

import sys

from cli.app import InteractiveApp
from services.booking import BookingService
from services.runtime import build_runtime


def main() -> None:
    if "--gui" in sys.argv[1:]:
        # GUI 模式
        from gui.app import run_gui
        run_gui()
    elif "--run-now" in sys.argv[1:]:
        # 非交互模式：不打印菜单、不等待任何键盘输入，跑完立即退出。
        # 退出码：0=成功 1=全部尝试失败 2=认证失败 3=无启用方案，方便任务计划程序按结果判断。
        sys.exit(BookingService(*build_runtime()).run_once())
    else:
        # 默认：终端交互模式
        InteractiveApp().run()


if __name__ == "__main__":
    main()
