"""方案创建对话框。"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressDialog,
    QSpinBox,
    QVBoxLayout,
)

from gui.workers import LoadFloorsWorker
from services import PlanService


class CreatePlanDialog(QDialog):
    """方案创建对话框：完整的交互式方案创建流程。"""

    def __init__(self, plan_service: PlanService, parent=None) -> None:
        super().__init__(parent)
        self.plan_service = plan_service

        # 数据缓存
        self.current_room_types = []
        self.current_floors = []

        # Worker 线程
        self.floors_worker = None
        self.loading_dialog = None

        self._setup_ui()
        self._load_room_types()

    def _setup_ui(self) -> None:
        """构建用户界面。"""
        self.setWindowTitle("创建预约方案")
        self.setMinimumWidth(450)

        layout = QVBoxLayout(self)
        form = QFormLayout()

        # 房间类型选择
        self.room_type_combo = QComboBox()
        self.room_type_combo.currentIndexChanged.connect(self._on_room_type_changed)
        form.addRow("房间类型:", self.room_type_combo)

        # 楼层选择
        self.floor_combo = QComboBox()
        self.floor_combo.currentIndexChanged.connect(self._on_floor_changed)
        form.addRow("楼层:", self.floor_combo)

        # 座位号输入
        self.seat_input = QLineEdit()
        self.seat_input.setPlaceholderText("例如: 101")
        self.seat_input.textChanged.connect(self._validate_and_update_ui)
        form.addRow("座位号:", self.seat_input)

        # 座位号提示
        self.seat_hint_label = QLabel()
        self.seat_hint_label.setStyleSheet("color: gray; font-size: 11px;")
        self.seat_hint_label.setWordWrap(True)
        form.addRow("", self.seat_hint_label)

        # 开始小时
        self.start_hour_spin = QSpinBox()
        self.start_hour_spin.setRange(0, 23)
        self.start_hour_spin.setValue(13)
        self.start_hour_spin.setSuffix(" 时")
        form.addRow("开始时间:", self.start_hour_spin)

        # 使用时长
        self.duration_spin = QSpinBox()
        self.duration_spin.setRange(1, 15)
        self.duration_spin.setValue(9)
        self.duration_spin.setSuffix(" 小时")
        form.addRow("使用时长:", self.duration_spin)

        # 天数偏移
        self.book_days_spin = QSpinBox()
        self.book_days_spin.setRange(0, 7)
        self.book_days_spin.setValue(1)
        self.book_days_spin.setSpecialValueText("今天")
        self.book_days_spin.setSuffix(" 天后")
        form.addRow("预约日期:", self.book_days_spin)

        layout.addLayout(form)

        # 错误提示
        self.error_label = QLabel()
        self.error_label.setStyleSheet("color: red;")
        self.error_label.setWordWrap(True)
        layout.addWidget(self.error_label)

        # 按钮
        self.button_box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        self.button_box.accepted.connect(self.accept)
        self.button_box.rejected.connect(self.reject)
        layout.addWidget(self.button_box)

    def _load_room_types(self) -> None:
        """加载房间类型列表。"""
        try:
            self.current_room_types = self.plan_service.list_room_types()

            if not self.current_room_types:
                QMessageBox.warning(self, "提示", "无可用房间类型")
                self.reject()
                return

            for room_type in self.current_room_types:
                self.room_type_combo.addItem(room_type["name"], room_type)

            # 触发第一个房间类型的楼层加载
            if self.current_room_types:
                self._on_room_type_changed(0)

        except Exception as e:
            QMessageBox.critical(self, "错误", f"加载房间类型失败:\n{e}")
            self.reject()

    def _on_room_type_changed(self, index: int) -> None:
        """房间类型改变时，异步加载楼层信息。"""
        if index < 0 or index >= len(self.current_room_types):
            return

        room_type = self.current_room_types[index]
        room_query = room_type["query"]

        # 清空楼层列表
        self.floor_combo.clear()
        self.current_floors = []
        self.seat_hint_label.clear()

        # 显示加载对话框
        self.loading_dialog = QProgressDialog("正在加载楼层信息...", "取消", 0, 0, self)
        self.loading_dialog.setWindowModality(Qt.WindowModality.WindowModal)
        self.loading_dialog.setMinimumDuration(500)  # 500ms 后才显示
        self.loading_dialog.canceled.connect(self._on_loading_canceled)

        # 启动 Worker 线程
        self.floors_worker = LoadFloorsWorker(self.plan_service, room_query)
        self.floors_worker.finished.connect(self._on_floors_loaded)
        self.floors_worker.error_occurred.connect(self._on_floors_error)
        self.floors_worker.start()

    def _on_loading_canceled(self) -> None:
        """用户取消加载。"""
        if self.floors_worker and self.floors_worker.isRunning():
            self.floors_worker.requestInterruption()

    def _on_floors_loaded(self, floors: list) -> None:
        """楼层加载完成。"""
        if self.loading_dialog:
            self.loading_dialog.close()
            self.loading_dialog = None

        self.current_floors = floors

        if not floors:
            QMessageBox.information(self, "提示", "该房间类型当前无可用楼层")
            return

        # 填充楼层下拉框
        for floor in floors:
            label = f"{floor.room_name} ({floor.seat_count} 座)"
            self.floor_combo.addItem(label, floor)

        # 触发第一个楼层的更新
        if floors:
            self._on_floor_changed(0)

    def _on_floors_error(self, error_msg: str) -> None:
        """楼层加载失败。"""
        if self.loading_dialog:
            self.loading_dialog.close()
            self.loading_dialog = None

        QMessageBox.critical(self, "加载失败", f"加载楼层信息失败:\n{error_msg}")

    def _on_floor_changed(self, index: int) -> None:
        """楼层改变时，更新座位号提示。"""
        if index < 0 or index >= len(self.current_floors):
            self.seat_hint_label.clear()
            return

        floor = self.current_floors[index]
        self._update_seat_hint(floor)
        self._validate_and_update_ui()

    def _update_seat_hint(self, floor) -> None:
        """更新座位号提示。"""
        seat_titles = floor.seat_titles

        if not seat_titles:
            self.seat_hint_label.setText("该楼层暂无可用座位")
            return

        # 显示前 10 个座位号
        preview = ", ".join(seat_titles[:10])
        if len(seat_titles) > 10:
            preview += f" ... (共 {len(seat_titles)} 个)"

        self.seat_hint_label.setText(f"可用座位: {preview}")

    def _validate_inputs(self) -> list[str]:
        """验证输入，返回错误列表。"""
        errors = []

        # 检查座位号
        seat_num = self.seat_input.text().strip()
        if not seat_num:
            errors.append("座位号不能为空")

        # 检查楼层是否已选择
        if self.floor_combo.count() == 0:
            errors.append("请先选择楼层")

        return errors

    def _validate_and_update_ui(self) -> None:
        """验证输入并更新 UI 状态。"""
        errors = self._validate_inputs()

        # 更新 OK 按钮状态
        ok_button = self.button_box.button(QDialogButtonBox.StandardButton.Ok)
        ok_button.setEnabled(len(errors) == 0)

        # 显示第一个错误
        if errors:
            self.error_label.setText(f"⚠ {errors[0]}")
        else:
            self.error_label.clear()

    def accept(self) -> None:
        """提交表单，创建方案。"""
        # 最终验证
        errors = self._validate_inputs()
        if errors:
            QMessageBox.warning(self, "验证失败", "\n".join(f"• {e}" for e in errors))
            return

        # 收集参数
        room_type = self.current_room_types[self.room_type_combo.currentIndex()]
        floor = self.current_floors[self.floor_combo.currentIndex()]

        room_type_name = room_type["name"]
        room_query = room_type["query"]
        floor_id = int(floor.floor_id)
        seat_num = self.seat_input.text().strip()
        start_hour = self.start_hour_spin.value()
        duration_hours = self.duration_spin.value()
        book_days = self.book_days_spin.value()

        # 调用服务层创建方案
        try:
            plan, errors, fell_back = self.plan_service.create_plan(
                room_type_name=room_type_name,
                room_query=room_query,
                floor_id=floor_id,
                seat_num=seat_num,
                start_hour=start_hour,
                duration_hours=duration_hours,
                book_days=book_days,
            )

            # 处理回退警告
            if fell_back:
                QMessageBox.warning(
                    self,
                    "警告",
                    f"无法识别房间类型 '{room_type_name}'，已使用默认类型（自习室）"
                )

            # 处理验证错误
            if errors:
                QMessageBox.critical(
                    self,
                    "验证失败",
                    "方案验证失败:\n" + "\n".join(f"• {e}" for e in errors)
                )
                return

            # 成功
            QMessageBox.information(
                self,
                "成功",
                f"方案已创建！\n\n"
                f"方案 ID: {plan.plan_id}\n"
                f"座位号: {seat_num}\n"
                f"时间: {start_hour}:00 起 {duration_hours} 小时"
            )
            super().accept()

        except Exception as e:
            QMessageBox.critical(self, "错误", f"创建方案时出错:\n{e}")
