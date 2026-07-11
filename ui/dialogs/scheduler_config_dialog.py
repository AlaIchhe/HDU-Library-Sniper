"""定时任务配置对话框。"""

from __future__ import annotations

from PySide6.QtCore import QTime
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QTimeEdit,
    QVBoxLayout,
)


class SchedulerConfigDialog(QDialog):
    """定时任务配置对话框。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("配置定时任务")
        self.setMinimumWidth(450)

        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)

        # 说明
        info = QLabel(
            "设置每天自动执行抢座的时间。\n\n"
            "建议设置在预约开放时间前几秒，例如图书馆 0:00 开放预约，\n"
            "可设置为 23:59:55，提前 5 秒开始执行。"
        )
        info.setWordWrap(True)
        layout.addWidget(info)

        # 时间选择
        form = QFormLayout()

        self.time_edit = QTimeEdit()
        self.time_edit.setDisplayFormat("HH:mm:ss")
        self.time_edit.setTime(QTime(23, 59, 55))  # 默认 23:59:55
        form.addRow("执行时间:", self.time_edit)

        layout.addLayout(form)

        # Windows 专用选项
        import platform

        if platform.system() == "Windows":
            self.wake_checkbox = QCheckBox("唤醒计算机以运行任务（推荐）")
            self.wake_checkbox.setChecked(True)
            self.wake_checkbox.setToolTip(
                "启用后，即使电脑处于睡眠状态，也会在指定时间唤醒执行任务。\n"
                "注意：完全关机状态无法唤醒。"
            )
            layout.addWidget(self.wake_checkbox)

        # 提示
        hint = QLabel(
            "注意:\n"
            "• 配置后每天该时间会自动执行\n"
            "• Windows: 需要保持电脑开机或睡眠（支持唤醒）\n"
            "• Linux: 需要保持电脑开机\n"
            "• 执行结果会推送通知（如已配置通知渠道）\n"
            "• 详细日志保存在 logs/ 目录"
        )
        hint.setStyleSheet("color: gray; font-size: 11px; padding: 10px;")
        hint.setWordWrap(True)
        layout.addWidget(hint)

        # 按钮
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def get_execute_time(self) -> str:
        """获取设置的执行时间（HH:mm:ss）。"""
        time = self.time_edit.time()
        return time.toString("HH:mm:ss")

    def get_wake_to_run(self) -> bool:
        """获取是否唤醒计算机（仅 Windows）。"""
        import platform

        if platform.system() == "Windows" and hasattr(self, "wake_checkbox"):
            return self.wake_checkbox.isChecked()
        return False
