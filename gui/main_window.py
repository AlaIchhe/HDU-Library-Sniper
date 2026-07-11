"""HDU 图书馆抢座工具 GUI 主窗口。"""

from __future__ import annotations

from datetime import datetime

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from utils.time_utils import parse_execute_time
from config.settings import Credentials, load_credentials, save_credentials
from core.sniper.retry import BookingResult
from gui.workers import AuthWorker, BookingWorker
from gui.dialogs import (
    CreatePlanDialog,
    DeletePlansDialog,
    ModifyTimeDialog,
    BrowseRoomsDialog,
)
from services import (
    AuthService,
    BookingService,
    BrowserAuthService,
    PlanService,
    build_runtime,
)


class MainWindow(QMainWindow):
    """图书馆抢座工具主窗口。"""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("HDU 图书馆抢座工具")
        self.resize(800, 600)

        # 初始化服务层
        settings, client, plans, notifier = build_runtime()
        self.settings = settings
        self.auth = AuthService(client, settings)
        self.browser_auth = BrowserAuthService(client, settings)
        self.booking = BookingService(settings, client, plans, notifier)
        self.plan_service = PlanService(client, plans, self.booking.room_browser)
        self.credentials = load_credentials(settings.credentials_file)

        # 工作线程
        self.booking_worker: BookingWorker | None = None
        self.auth_worker: AuthWorker | None = None

        # 构建 UI
        self._setup_ui()

        # 尝试自动认证
        QTimer.singleShot(500, self._auto_authenticate)

    def _setup_ui(self) -> None:
        """构建用户界面。"""
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)

        # 标题
        title = QLabel("HDU 图书馆抢座工具")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setStyleSheet("font-size: 20px; font-weight: bold; padding: 10px;")
        layout.addWidget(title)

        # Tab 切换
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs)

        # Tab 1: 认证
        self.tabs.addTab(self._create_auth_tab(), "认证")

        # Tab 2: 方案管理
        self.tabs.addTab(self._create_plans_tab(), "方案管理")

        # Tab 3: 抢座
        self.tabs.addTab(self._create_booking_tab(), "抢座")

        # 状态栏
        self.statusBar().showMessage("就绪")

    def _create_auth_tab(self) -> QWidget:
        """创建认证标签页。"""
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # 学号输入
        sid_layout = QHBoxLayout()
        sid_layout.addWidget(QLabel("学号:"))
        self.sid_input = QLineEdit()
        if self.credentials:
            self.sid_input.setText(self.credentials.student_id)
        sid_layout.addWidget(self.sid_input)
        layout.addLayout(sid_layout)

        # 密码输入
        pwd_layout = QHBoxLayout()
        pwd_layout.addWidget(QLabel("密码:"))
        self.pwd_input = QLineEdit()
        self.pwd_input.setEchoMode(QLineEdit.EchoMode.Password)
        pwd_layout.addWidget(self.pwd_input)
        layout.addLayout(pwd_layout)

        # 登录按钮
        self.login_btn = QPushButton("登录")
        self.login_btn.clicked.connect(self._handle_login)
        layout.addWidget(self.login_btn)

        # 认证状态
        self.auth_status = QTextEdit()
        self.auth_status.setReadOnly(True)
        self.auth_status.setMaximumHeight(150)
        layout.addWidget(QLabel("认证状态:"))
        layout.addWidget(self.auth_status)

        layout.addStretch()
        return widget

    def _create_plans_tab(self) -> QWidget:
        """创建方案管理标签页。"""
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # 按钮组
        btn_layout = QHBoxLayout()
        self.refresh_plans_btn = QPushButton("刷新方案列表")
        self.refresh_plans_btn.clicked.connect(self._refresh_plans)
        btn_layout.addWidget(self.refresh_plans_btn)

        self.create_plan_btn = QPushButton("创建方案")
        self.create_plan_btn.clicked.connect(self._create_plan)
        btn_layout.addWidget(self.create_plan_btn)

        self.delete_plan_btn = QPushButton("删除方案")
        self.delete_plan_btn.clicked.connect(self._delete_plans)
        btn_layout.addWidget(self.delete_plan_btn)

        self.modify_time_btn = QPushButton("批量修改时间")
        self.modify_time_btn.clicked.connect(self._modify_time)
        btn_layout.addWidget(self.modify_time_btn)

        self.browse_rooms_btn = QPushButton("浏览房间")
        self.browse_rooms_btn.clicked.connect(self._browse_rooms)
        btn_layout.addWidget(self.browse_rooms_btn)

        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        # 方案列表
        self.plans_display = QTextEdit()
        self.plans_display.setReadOnly(True)
        layout.addWidget(QLabel("方案列表:"))
        layout.addWidget(self.plans_display)

        return widget

    def _create_booking_tab(self) -> QWidget:
        """创建抢座标签页。"""
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # 定时设置
        time_layout = QHBoxLayout()
        time_layout.addWidget(QLabel("执行时间 (HH:MM:SS，留空立即执行):"))
        self.time_input = QLineEdit()
        self.time_input.setPlaceholderText("例如: 23:59:59")
        time_layout.addWidget(self.time_input)
        layout.addLayout(time_layout)

        # 执行按钮
        btn_layout = QHBoxLayout()
        self.start_btn = QPushButton("开始抢座")
        self.start_btn.clicked.connect(self._handle_start_booking)
        btn_layout.addWidget(self.start_btn)

        self.cancel_btn = QPushButton("取消")
        self.cancel_btn.clicked.connect(self._handle_cancel_booking)
        self.cancel_btn.setEnabled(False)
        btn_layout.addWidget(self.cancel_btn)

        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        # 倒计时显示
        self.countdown_label = QLabel("")
        self.countdown_label.setStyleSheet("font-size: 16px; color: blue; padding: 5px;")
        self.countdown_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.countdown_label)

        # 日志输出
        layout.addWidget(QLabel("执行日志:"))
        self.log_display = QTextEdit()
        self.log_display.setReadOnly(True)
        layout.addWidget(self.log_display)

        return widget

    # ------------------------------------------------------------------
    # 认证相关
    # ------------------------------------------------------------------
    def _auto_authenticate(self) -> None:
        """自动认证：尝试使用缓存或保存的凭据。"""
        if self.auth.try_cache():
            self._append_auth_status("✓ 使用缓存的认证状态")
            self.statusBar().showMessage("已认证")
            return

        # 如果有保存的凭据，自动填充但不自动登录
        if self.credentials:
            self._append_auth_status("检测到已保存的凭据，请点击\"登录\"按钮")

    def _handle_login(self) -> None:
        """处理登录按钮点击。"""
        student_id = self.sid_input.text().strip()
        password = self.pwd_input.text().strip()

        if not student_id or not password:
            QMessageBox.warning(self, "输入错误", "请输入学号和密码")
            return

        # 禁用登录按钮
        self.login_btn.setEnabled(False)
        self._append_auth_status(f"\n正在登录 {student_id}...")
        self.statusBar().showMessage("认证中...")

        # 启动认证工作线程
        self.auth_worker = AuthWorker(self.browser_auth, student_id, password)
        self.auth_worker.finished.connect(self._on_auth_finished)
        self.auth_worker.error_occurred.connect(self._on_auth_error)
        self.auth_worker.start()

    def _on_auth_finished(self, success: bool, message: str) -> None:
        """认证完成回调。"""
        self.login_btn.setEnabled(True)

        if success:
            self._append_auth_status(f"✓ {message}")
            self.statusBar().showMessage("认证成功")

            # 保存凭据
            creds = Credentials(
                student_id=self.sid_input.text().strip(),
                password=self.pwd_input.text().strip()
            )
            try:
                save_credentials(self.settings.credentials_file, creds)
                self._append_auth_status(f"凭据已保存到 {self.settings.credentials_file}")
            except OSError as exc:
                self._append_auth_status(f"凭据保存失败: {exc}")
        else:
            self._append_auth_status(f"✗ {message}")
            self.statusBar().showMessage("认证失败")
            QMessageBox.warning(self, "认证失败", message)

    def _on_auth_error(self, error_msg: str) -> None:
        """认证错误回调。"""
        self.login_btn.setEnabled(True)
        self._append_auth_status(f"✗ 认证出错: {error_msg}")
        self.statusBar().showMessage("认证出错")
        QMessageBox.critical(self, "错误", f"认证过程出错:\n{error_msg}")

    def _append_auth_status(self, text: str) -> None:
        """追加认证状态文本。"""
        self.auth_status.append(text)

    # ------------------------------------------------------------------
    # 方案管理相关
    # ------------------------------------------------------------------
    def _refresh_plans(self) -> None:
        """刷新方案列表。"""
        plans = self.plan_service.list_plans()
        enabled_plans = self.plan_service.list_enabled()

        if not plans:
            self.plans_display.setText("暂无预约方案")
            return

        lines = [f"共 {len(plans)} 个方案，其中 {len(enabled_plans)} 个启用\n"]
        lines.append("=" * 60)

        for i, plan in enumerate(plans, 1):
            status = "✓" if plan.enabled else "✗"
            lines.append(
                f"{i}. [{status}] {plan.room_type_name} - 座位 {plan.seat_num}\n"
                f"   时间: {plan.start_hour}:00 起，{plan.duration_hours}h，"
                f"提前 {plan.book_days} 天\n"
            )

        self.plans_display.setText("\n".join(lines))

    def _create_plan(self) -> None:
        """创建新方案对话框。"""
        dialog = CreatePlanDialog(self.plan_service, self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self._refresh_plans()
            self.statusBar().showMessage("方案创建成功")

    def _delete_plans(self) -> None:
        """删除方案对话框。"""
        plans = self.plan_service.list_plans()
        if not plans:
            QMessageBox.information(self, "提示", "暂无方案")
            return

        dialog = DeletePlansDialog(self.plan_service, self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self._refresh_plans()
            self.statusBar().showMessage("方案删除成功")

    def _modify_time(self) -> None:
        """批量修改时间对话框。"""
        plans = self.plan_service.list_plans()
        if not plans:
            QMessageBox.information(self, "提示", "暂无方案")
            return

        dialog = ModifyTimeDialog(self.plan_service, self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self._refresh_plans()
            self.statusBar().showMessage("时间修改成功")

    def _browse_rooms(self) -> None:
        """浏览房间对话框。"""
        dialog = BrowseRoomsDialog(self.plan_service, self)
        dialog.exec()  # 只读浏览，不需要处理返回值

    # ------------------------------------------------------------------
    # 抢座相关
    # ------------------------------------------------------------------
    def _handle_start_booking(self) -> None:
        """处理开始抢座按钮点击。"""
        plans = self.plan_service.list_enabled()
        if not plans:
            QMessageBox.warning(self, "无可用方案", "没有启用的预约方案，请先创建并启用方案")
            return

        # 解析执行时间
        time_str = self.time_input.text().strip()
        execute_at = None

        if time_str:
            try:
                execute_at = parse_execute_time(time_str)
                if execute_at is None:
                    raise ValueError("时间格式无效")
            except ValueError as exc:
                QMessageBox.warning(self, "时间格式错误", f"请输入有效的时间格式 (HH:MM 或 HH:MM:SS)\n错误: {exc}")
                return

        # 清空日志
        self.log_display.clear()
        self.countdown_label.clear()

        # 更新 UI 状态
        self.start_btn.setEnabled(False)
        self.cancel_btn.setEnabled(True)

        if execute_at:
            self._append_log(f"将在 {execute_at.strftime('%Y-%m-%d %H:%M:%S')} 开始执行")
            self.statusBar().showMessage("等待定时执行...")
        else:
            self._append_log("立即开始抢座...")
            self.statusBar().showMessage("抢座中...")

        # 启动抢座工作线程
        self.booking_worker = BookingWorker(
            self.booking,
            plans,
            execute_at=execute_at,
            max_trials=self.settings.max_trials,
            retry_delay=self.settings.retry_delay,
            window_wait_seconds=self.settings.window_wait_seconds,
            window_poll_interval=self.settings.window_poll_interval,
        )
        self.booking_worker.countdown_updated.connect(self._on_countdown_update)
        self.booking_worker.progress_updated.connect(self._on_progress_update)
        self.booking_worker.finished.connect(self._on_booking_finished)
        self.booking_worker.error_occurred.connect(self._on_booking_error)
        self.booking_worker.start()

    def _handle_cancel_booking(self) -> None:
        """处理取消按钮点击。"""
        if self.booking_worker and self.booking_worker.isRunning():
            self.booking_worker.cancel()
            self._append_log("\n[用户取消操作]")
            self.statusBar().showMessage("正在取消...")

    def _on_countdown_update(self, remaining: int) -> None:
        """倒计时更新回调。"""
        hours = remaining // 3600
        minutes = (remaining % 3600) // 60
        seconds = remaining % 60

        if hours > 0:
            text = f"倒计时: {hours:02d}:{minutes:02d}:{seconds:02d}"
        else:
            text = f"倒计时: {minutes:02d}:{seconds:02d}"

        self.countdown_label.setText(text)

    def _on_progress_update(self, result: BookingResult) -> None:
        """单次尝试进度更新回调。"""
        status = "✓" if result.success else "✗"
        self._append_log(
            f"{status} {result.plan.to_plan_code()} | "
            f"座位 {result.plan.seat_num} | "
            f"{result.message}"
        )

    def _on_booking_finished(self, results: list[BookingResult]) -> None:
        """抢座完成回调。"""
        self.start_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.countdown_label.clear()

        success = any(r.success for r in results)

        if success:
            self._append_log(f"\n✓✓✓ 预约成功！共尝试 {len(results)} 次 ✓✓✓")
            self.statusBar().showMessage("预约成功！")
            QMessageBox.information(self, "成功", "预约成功！")
        else:
            self._append_log(f"\n✗✗✗ 预约失败。共尝试 {len(results)} 次 ✗✗✗")
            self.statusBar().showMessage("预约失败")
            QMessageBox.warning(self, "失败", f"预约失败，共尝试 {len(results)} 次")

    def _on_booking_error(self, error_msg: str) -> None:
        """抢座错误回调。"""
        self.start_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.countdown_label.clear()

        self._append_log(f"\n✗ 错误: {error_msg}")
        self.statusBar().showMessage("执行出错")
        QMessageBox.critical(self, "错误", f"执行过程出错:\n{error_msg}")

    def _append_log(self, text: str) -> None:
        """追加日志文本。"""
        self.log_display.append(text)
        # 自动滚动到底部
        self.log_display.verticalScrollBar().setValue(
            self.log_display.verticalScrollBar().maximum()
        )

    def closeEvent(self, event) -> None:
        """窗口关闭事件：清理工作线程。"""
        # 如果有正在运行的任务，询问确认
        if self.booking_worker and self.booking_worker.isRunning():
            reply = QMessageBox.question(
                self,
                "确认退出",
                "抢座任务正在执行中，确定要退出吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No
            )

            if reply == QMessageBox.StandardButton.No:
                event.ignore()
                return

            # 取消任务
            self.booking_worker.cancel()
            self.booking_worker.wait(2000)  # 等待最多 2 秒

        event.accept()
