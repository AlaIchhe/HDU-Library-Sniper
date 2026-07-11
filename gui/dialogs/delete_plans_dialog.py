"""方案删除对话框。"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QVBoxLayout,
)

from services import PlanService


class DeletePlansDialog(QDialog):
    """方案删除对话框：支持多选删除。"""

    def __init__(self, plan_service: PlanService, parent=None) -> None:
        super().__init__(parent)
        self.plan_service = plan_service

        self._setup_ui()
        self._load_plans()

    def _setup_ui(self) -> None:
        """构建用户界面。"""
        self.setWindowTitle("删除方案")
        self.setMinimumSize(500, 400)

        layout = QVBoxLayout(self)

        # 说明文本
        label = QLabel("请选择要删除的方案（可多选）:")
        layout.addWidget(label)

        # 方案列表（多选模式）
        self.plan_list = QListWidget()
        self.plan_list.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        layout.addWidget(self.plan_list)

        # 提示
        hint = QLabel("提示: 按住 Ctrl 或 Shift 键可多选")
        hint.setStyleSheet("color: gray; font-size: 11px;")
        layout.addWidget(hint)

        # 按钮
        self.button_box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        self.button_box.button(QDialogButtonBox.StandardButton.Ok).setText("删除")
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
                # 存储 plan_id 到 item 数据中
                item.setData(Qt.ItemDataRole.UserRole, plan.plan_id)
                self.plan_list.addItem(item)

        except Exception as e:
            QMessageBox.critical(self, "错误", f"加载方案失败:\n{e}")
            self.reject()

    def accept(self) -> None:
        """提交删除。"""
        # 获取选中项的 plan_id
        selected_items = self.plan_list.selectedItems()
        if not selected_items:
            QMessageBox.warning(self, "提示", "请至少选择一个方案")
            return

        selected_ids = [
            item.data(Qt.ItemDataRole.UserRole) for item in selected_items
        ]

        # 二次确认
        reply = QMessageBox.question(
            self,
            "确认删除",
            f"确定要删除选中的 {len(selected_ids)} 个方案吗？\n\n此操作不可撤销！",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No
        )

        if reply != QMessageBox.StandardButton.Yes:
            return

        # 调用服务层删除
        try:
            count = self.plan_service.delete_plans(selected_ids)
            QMessageBox.information(
                self,
                "成功",
                f"已成功删除 {count} 个方案"
            )
            super().accept()

        except Exception as e:
            QMessageBox.critical(self, "错误", f"删除方案时出错:\n{e}")
