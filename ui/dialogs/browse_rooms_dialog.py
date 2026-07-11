"""房间浏览对话框。"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QHeaderView,
    QLabel,
    QMessageBox,
    QProgressDialog,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
)

from gui.workers import LoadFloorsWorker
from services import PlanService


class BrowseRoomsDialog(QDialog):
    """房间浏览对话框：展示所有房间类型、楼层、座位号信息。"""

    def __init__(self, plan_service: PlanService, parent=None) -> None:
        super().__init__(parent)
        self.plan_service = plan_service

        # 数据缓存
        self.current_room_types = []

        # Worker 线程
        self.floors_worker = None
        self.loading_dialog = None

        self._setup_ui()
        self._load_room_types()

    def _setup_ui(self) -> None:
        """构建用户界面。"""
        self.setWindowTitle("房间与座位浏览")
        self.setMinimumSize(700, 500)

        layout = QVBoxLayout(self)

        # 房间类型选择
        type_layout = QVBoxLayout()
        type_label = QLabel("选择房间类型:")
        type_layout.addWidget(type_label)

        self.room_type_combo = QComboBox()
        self.room_type_combo.currentIndexChanged.connect(self._on_room_type_changed)
        type_layout.addWidget(self.room_type_combo)

        layout.addLayout(type_layout)

        # 楼层信息表格
        self.floor_table = QTableWidget()
        self.floor_table.setColumnCount(4)
        self.floor_table.setHorizontalHeaderLabels(["楼层 ID", "房间名称", "座位数", "可用座位号"])
        self.floor_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.floor_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)

        # 设置列宽
        header = self.floor_table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)

        layout.addWidget(self.floor_table)

        # 说明
        hint = QLabel("说明: 此界面仅供浏览，不可编辑")
        hint.setStyleSheet("color: gray; font-size: 11px;")
        layout.addWidget(hint)

        # 按钮
        self.button_box = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
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

        # 清空表格
        self.floor_table.setRowCount(0)

        # 显示加载对话框
        self.loading_dialog = QProgressDialog("正在加载楼层信息...", "取消", 0, 0, self)
        self.loading_dialog.setWindowModality(Qt.WindowModality.WindowModal)
        self.loading_dialog.setMinimumDuration(500)
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
        """楼层加载完成，显示在表格中。"""
        if self.loading_dialog:
            self.loading_dialog.close()
            self.loading_dialog = None

        if not floors:
            QMessageBox.information(self, "提示", "该房间类型当前无可用楼层")
            return

        # 填充表格
        self._display_floors(floors)

    def _on_floors_error(self, error_msg: str) -> None:
        """楼层加载失败。"""
        if self.loading_dialog:
            self.loading_dialog.close()
            self.loading_dialog = None

        QMessageBox.critical(self, "加载失败", f"加载楼层信息失败:\n{error_msg}")

    def _display_floors(self, floors: list) -> None:
        """在表格中显示楼层信息。"""
        self.floor_table.setRowCount(len(floors))

        for i, floor in enumerate(floors):
            # 楼层 ID
            id_item = QTableWidgetItem(str(floor.floor_id))
            self.floor_table.setItem(i, 0, id_item)

            # 房间名称
            name_item = QTableWidgetItem(floor.room_name)
            self.floor_table.setItem(i, 1, name_item)

            # 座位数
            count_item = QTableWidgetItem(str(floor.seat_count))
            count_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.floor_table.setItem(i, 2, count_item)

            # 座位号列表（前 10 个 + "... (+N)"）
            seat_titles = floor.seat_titles
            if seat_titles:
                preview = ", ".join(seat_titles[:10])
                if len(seat_titles) > 10:
                    preview += f" ... (共 {len(seat_titles)} 个)"
            else:
                preview = "(无可用座位)"

            seats_item = QTableWidgetItem(preview)
            self.floor_table.setItem(i, 3, seats_item)
