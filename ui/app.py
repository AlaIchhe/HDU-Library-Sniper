"""PySide6 GUI 应用入口。"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from ui.main_window import MainWindow


def run_gui() -> None:
    """启动 GUI 应用。"""
    app = QApplication(sys.argv)
    app.setApplicationName("HDU 图书馆抢座工具")
    app.setOrganizationName("HDU")

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    run_gui()
