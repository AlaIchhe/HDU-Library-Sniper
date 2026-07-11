"""批量修改时间对话框。"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QVBoxLayout,
)

from services import PlanService


class ModifyTimeDialog(QDialog):
    """批量修改时间对话框：多选方案，部分字段更新。"""

    def __init__(self, plan_service: PlanService, parent=None) -> None:
        super().__init__(parent)
        self.plan_service = plan_service

        self._setup_ui()
        self._load_plans()

    def _setup_ui(self) -> None:
        """构建用户界面。"""
        self.setWindowTitle("批量修改时间")
        self.setMinimumSize(500, 500)

        layout = QVBoxLayout(self)

        # 说明文本
        label = QLabel("1. 选择要修改的方案（可多选）:")
        layout.addWidget(label)

        # 方案列表（多选模式）
        self.plan_list = QListWidget()
        self.plan_list.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        layout.addWidget(self.plan_list)

        # 提示
        hint = QLabel("提示: 按住 Ctrl 或 Shift 键可多选")
        hint.setStyleSheet("color: gray; font-size: 11px;")
        layout.addWidget(hint)

        # 修改参数输入
        param_label = QLabel("2. 输入要修改的参数（留空保持原值）:")
        layout.addWidget(param_label)

        form = QFormLayout()

        # 开始小时
        self.start_hour_input = QLineEdit()
        self.start_hour_input.setPlaceholderText("0-23，留空不修改")
        form.addRow("开始小时:", self.start_hour_input)

        # 使用时长
        self.duration_input = QLineEdit()
        self.duration_input.setPlaceholderText("1-15，留空不修改")
        form.addRow("使用时长:", self.duration_input)

        # 天数偏移
        self.book_days_input = QLineEdit()
        self.book_days_input.setPlaceholderText("0-7，留空不修改")
        form.addRow("天数偏移:", self.book_days_input)

        layout.addLayout(form)

        # 说明
        info = QLabel(
            "说明:\n"
            "• 留空的字段将保持原值\n"
            "• 所有选中的方案将使用相同的新值"
        )
        info.setStyleSheet("color: gray; font-size: 11px;")
        info.setWordWrap(True)
        layout.addWidget(info)

        # 按钮
        self.button_box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        self.button_box.button(QDialogButtonBox.StandardButton.Ok).setText("修改")
        self.button_box.accepted.connect(self.accept)
        self.button_box.rejected.connect(self.reject)
        layout.addWidget(self.button_box)

    def _load_plans(self) -> None:
        """加载所有方案。"""
        try:
            plans = self.plan_service.list_plans()

            if not plans:
                QMessageBox.information(self, "提示", "暂无方案")
                self.reject()
                return

            for plan in plans:
                # 格式化显示
                status = "✓" if plan.enabled else "✗"
                text = (
                    f"[{status}] {plan.room_type_name} - 座位 {plan.seat_num} | "
                    f"{plan.start_hour}:00 起 {plan.duration_hours}h | "
                    f"提前 {plan.book_days} 天"
                )

                item = QListWidgetItem(text)
                # 存储 plan_id
                item.setData(Qt.ItemDataRole.UserRole, plan.plan_id)
                self.plan_list.addItem(item)

        except Exception as e:
            QMessageBox.critical(self, "错误", f"加载方案失败:\n{e}")
            self.reject()

    def _build_kwargs(self) -> dict:
        """构造更新参数字典，只包含非空字段。"""
        kwargs = {}

        # 开始小时
        sh = self.start_hour_input.text().strip()
        if sh:
            try:
                start_hour = int(sh)
                if 0 <= start_hour <= 23:
                    kwargs["start_hour"] = start_hour
                else:
                    raise ValueError("开始小时必须在 0-23 之间")
            except ValueError as e:
                raise ValueError(f"开始小时格式错误: {e}")

        # 使用时长
        dh = self.duration_input.text().strip()
        if dh:
            try:
                duration_hours = int(dh)
                if 1 <= duration_hours <= 15:
                    kwargs["duration_hours"] = duration_hours
                else:
                    raise ValueError("使用时长必须在 1-15 之间")
            except ValueError as e:
                raise ValueError(f"使用时长格式错误: {e}")

        # 天数偏移
        bd = self.book_days_input.text().strip()
        if bd:
            try:
                book_days = int(bd)
                if 0 <= book_days <= 7:
                    kwargs["book_days"] = book_days
                else:
                    raise ValueError("天数偏移必须在 0-7 之间")
            except ValueError as e:
                raise ValueError(f"天数偏移格式错误: {e}")

        return kwargs

    def accept(self) -> None:
        """提交修改。"""
        # 获取选中项
        selected_items = self.plan_list.selectedItems()
        if not selected_items:
            QMessageBox.warning(self, "提示", "请至少选择一个方案")
            return

        selected_ids = [
            item.data(Qt.ItemDataRole.UserRole) for item in selected_items
        ]

        # 构造更新参数
        try:
            kwargs = self._build_kwargs()
        except ValueError as e:
            QMessageBox.warning(self, "输入错误", str(e))
            return

        if not kwargs:
            QMessageBox.warning(
                self,
                "提示",
                "请至少输入一个要修改的参数\n\n"
                "留空表示保持原值，但至少要修改一个字段"
            )
            return

        # 确认修改
        fields = []
        if "start_hour" in kwargs:
            fields.append(f"开始小时 → {kwargs['start_hour']}")
        if "duration_hours" in kwargs:
            fields.append(f"使用时长 → {kwargs['duration_hours']}h")
        if "book_days" in kwargs:
            fields.append(f"天数偏移 → {kwargs['book_days']}天")

        reply = QMessageBox.question(
            self,
            "确认修改",
            f"将对 {len(selected_ids)} 个方案进行以下修改:\n\n" +
            "\n".join(f"• {f}" for f in fields) +
            "\n\n确定要继续吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes
        )

        if reply != QMessageBox.StandardButton.Yes:
            return

        # 调用服务层修改
        try:
            count = self.plan_service.modify_time(selected_ids, **kwargs)
            QMessageBox.information(
                self,
                "成功",
                f"已成功修改 {count} 个方案"
            )
            super().accept()

        except Exception as e:
            QMessageBox.critical(self, "错误", f"修改方案时出错:\n{e}")
