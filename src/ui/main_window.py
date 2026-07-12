"""HDU 图书馆抢座工具 GUI 主窗口。"""

from __future__ import annotations

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
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

from config.settings import Credentials, load_credentials, save_credentials
from core.sniper.retry import BookingResult
from services import (
    AuthService,
    BookingService,
    BrowserAuthService,
    PlanService,
    build_runtime,
)
from services.scheduler import SchedulerService
from ui.dialogs import (
    BrowseRoomsDialog,
    CreatePlanDialog,
    DeletePlansDialog,
    ModifyTimeDialog,
    SchedulerConfigDialog,
)
from ui.styles import (
    COUNTDOWN_STYLE,
    GLOBAL_STYLE,
    INFO_BOX_STYLE,
    SECTION_TITLE_STYLE,
    TITLE_STYLE,
)
from ui.workers import AuthWorker, BookingWorker, TestExecutionWorker
from utils.time_utils import parse_execute_time


class MainWindow(QMainWindow):
    """图书馆抢座工具主窗口。"""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("HDU 图书馆抢座工具")
        self.resize(900, 700)

        # 应用全局样式
        self.setStyleSheet(GLOBAL_STYLE)

        # 初始化服务层
        settings, client, plans, notifier = build_runtime()
        self.settings = settings
        self.auth = AuthService(client, settings)
        self.browser_auth = BrowserAuthService(client, settings)
        self.booking = BookingService(settings, client, plans, notifier)
        self.plan_service = PlanService(client, plans, self.booking.room_browser)
        self.scheduler_service = SchedulerService(settings.paths)
        self.credentials = load_credentials(settings.paths.credentials_file)

        # 工作线程
        self.booking_worker: BookingWorker | None = None
        self.auth_worker: AuthWorker | None = None
        self.test_worker: TestExecutionWorker | None = None

        # 构建 UI
        self._setup_ui()

        # 尝试自动认证
        QTimer.singleShot(500, self._auto_authenticate)

    def _setup_ui(self) -> None:
        """构建用户界面。"""
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # 标题
        title = QLabel("🎯 HDU 图书馆抢座工具")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setStyleSheet(TITLE_STYLE)
        layout.addWidget(title)

        # Tab 切换
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs)

        # Tab 1: 认证
        self.tabs.addTab(self._create_auth_tab(), "🔐 认证")

        # Tab 2: 方案管理
        self.tabs.addTab(self._create_plans_tab(), "📋 方案管理")

        # Tab 3: 抢座
        self.tabs.addTab(self._create_booking_tab(), "⚡ 抢座")

        # Tab 4: 定时任务
        self.tabs.addTab(self._create_scheduler_tab(), "⏰ 定时任务")

        # 状态栏
        self.statusBar().showMessage("就绪")

    def _create_auth_tab(self) -> QWidget:
        """创建认证标签页。"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(16)

        # 说明信息
        info = QLabel(
            "💡 使用学号和密码登录杭电统一身份认证系统\n登录后将自动保存凭据，下次启动可快速认证",
        )
        info.setWordWrap(True)
        info.setStyleSheet(INFO_BOX_STYLE)
        layout.addWidget(info)

        # 登录表单
        from PySide6.QtWidgets import QFormLayout

        form_layout = QFormLayout()
        form_layout.setSpacing(12)
        form_layout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        # 学号输入
        self.sid_input = QLineEdit()
        self.sid_input.setPlaceholderText("请输入学号")
        if self.credentials:
            self.sid_input.setText(self.credentials.student_id)
        form_layout.addRow("学号:", self.sid_input)

        # 密码输入
        self.pwd_input = QLineEdit()
        self.pwd_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.pwd_input.setPlaceholderText("请输入密码")
        form_layout.addRow("密码:", self.pwd_input)

        layout.addLayout(form_layout)

        # 登录按钮
        self.login_btn = QPushButton("🔓 登录")
        self.login_btn.setMinimumHeight(44)
        self.login_btn.clicked.connect(self._handle_login)
        layout.addWidget(self.login_btn)

        # 认证状态
        status_label = QLabel("认证状态")
        status_label.setStyleSheet(SECTION_TITLE_STYLE)
        layout.addWidget(status_label)

        self.auth_status = QTextEdit()
        self.auth_status.setReadOnly(True)
        self.auth_status.setMaximumHeight(150)
        layout.addWidget(self.auth_status)

        layout.addStretch()
        return widget

    def _create_plans_tab(self) -> QWidget:
        """创建方案管理标签页。"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(16)

        # 说明信息
        info = QLabel(
            "📝 创建和管理预约方案，每个方案对应一个座位预约规则\n启用的方案将在抢座时自动执行",
        )
        info.setWordWrap(True)
        info.setStyleSheet(INFO_BOX_STYLE)
        layout.addWidget(info)

        # 按钮组
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(8)

        self.refresh_plans_btn = QPushButton("🔄 刷新")
        self.refresh_plans_btn.setProperty("secondary", "true")
        self.refresh_plans_btn.clicked.connect(self._refresh_plans)
        btn_layout.addWidget(self.refresh_plans_btn)

        self.create_plan_btn = QPushButton("➕ 创建方案")
        self.create_plan_btn.setProperty("success", "true")
        self.create_plan_btn.clicked.connect(self._create_plan)
        btn_layout.addWidget(self.create_plan_btn)

        self.delete_plan_btn = QPushButton("🗑️ 删除方案")
        self.delete_plan_btn.setProperty("danger", "true")
        self.delete_plan_btn.clicked.connect(self._delete_plans)
        btn_layout.addWidget(self.delete_plan_btn)

        self.modify_time_btn = QPushButton("⏱️ 修改时间")
        self.modify_time_btn.setProperty("secondary", "true")
        self.modify_time_btn.clicked.connect(self._modify_time)
        btn_layout.addWidget(self.modify_time_btn)

        self.browse_rooms_btn = QPushButton("🏢 浏览房间")
        self.browse_rooms_btn.setProperty("secondary", "true")
        self.browse_rooms_btn.clicked.connect(self._browse_rooms)
        btn_layout.addWidget(self.browse_rooms_btn)

        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        # 方案列表
        plans_label = QLabel("方案列表")
        plans_label.setStyleSheet(SECTION_TITLE_STYLE)
        layout.addWidget(plans_label)

        self.plans_display = QTextEdit()
        self.plans_display.setReadOnly(True)
        layout.addWidget(self.plans_display)

        return widget

    def _create_booking_tab(self) -> QWidget:
        """创建抢座标签页。"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(16)

        # 说明信息
        info = QLabel("⚡ 手动执行抢座任务\n可以立即执行或设置定时执行，支持倒计时显示")
        info.setWordWrap(True)
        info.setStyleSheet(INFO_BOX_STYLE)
        layout.addWidget(info)

        # 定时设置
        from PySide6.QtWidgets import QFormLayout

        time_form = QFormLayout()
        time_form.setSpacing(12)

        self.time_input = QLineEdit()
        self.time_input.setPlaceholderText("留空立即执行，或输入时间如: 23:59:59")
        time_form.addRow("执行时间:", self.time_input)

        layout.addLayout(time_form)

        # 执行按钮
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(12)

        self.start_btn = QPushButton("🚀 开始抢座")
        self.start_btn.setMinimumHeight(44)
        self.start_btn.setProperty("success", "true")
        self.start_btn.clicked.connect(self._handle_start_booking)
        btn_layout.addWidget(self.start_btn)

        self.cancel_btn = QPushButton("⛔ 取消")
        self.cancel_btn.setMinimumHeight(44)
        self.cancel_btn.setProperty("danger", "true")
        self.cancel_btn.clicked.connect(self._handle_cancel_booking)
        self.cancel_btn.setEnabled(False)
        btn_layout.addWidget(self.cancel_btn)

        layout.addLayout(btn_layout)

        # 倒计时显示
        self.countdown_label = QLabel("")
        self.countdown_label.setStyleSheet(COUNTDOWN_STYLE)
        self.countdown_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.countdown_label.setVisible(False)
        layout.addWidget(self.countdown_label)

        # 日志输出
        log_label = QLabel("执行日志")
        log_label.setStyleSheet(SECTION_TITLE_STYLE)
        layout.addWidget(log_label)

        self.log_display = QTextEdit()
        self.log_display.setReadOnly(True)
        layout.addWidget(self.log_display)

        return widget

    def _create_scheduler_tab(self) -> QWidget:
        """创建定时任务标签页。"""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(16)

        # 标题说明
        info = QLabel(
            "⏰ 配置系统定时任务，实现每天自动抢座\n"
            "配置后无需保持软件运行，系统会在指定时间自动执行",
        )
        info.setWordWrap(True)
        info.setStyleSheet(INFO_BOX_STYLE)
        layout.addWidget(info)

        # 当前状态
        status_label = QLabel("当前任务状态")
        status_label.setStyleSheet(SECTION_TITLE_STYLE)
        layout.addWidget(status_label)

        self.task_status_display = QTextEdit()
        self.task_status_display.setReadOnly(True)
        self.task_status_display.setMaximumHeight(120)
        layout.addWidget(self.task_status_display)

        # 按钮组
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(8)

        self.config_task_btn = QPushButton("⚙️ 配置任务")
        self.config_task_btn.setProperty("success", "true")
        self.config_task_btn.clicked.connect(self._configure_scheduler)
        btn_layout.addWidget(self.config_task_btn)

        self.remove_task_btn = QPushButton("🗑️ 移除任务")
        self.remove_task_btn.setProperty("danger", "true")
        self.remove_task_btn.clicked.connect(self._remove_scheduler)
        btn_layout.addWidget(self.remove_task_btn)

        self.test_exec_btn = QPushButton("🧪 测试执行")
        self.test_exec_btn.setProperty("secondary", "true")
        self.test_exec_btn.clicked.connect(self._test_execution)
        btn_layout.addWidget(self.test_exec_btn)

        self.refresh_status_btn = QPushButton("🔄 刷新状态")
        self.refresh_status_btn.setProperty("secondary", "true")
        self.refresh_status_btn.clicked.connect(self._refresh_scheduler_status)
        btn_layout.addWidget(self.refresh_status_btn)

        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        # 执行日志
        log_label = QLabel("执行日志")
        log_label.setStyleSheet(SECTION_TITLE_STYLE)
        layout.addWidget(log_label)

        self.scheduler_log_display = QTextEdit()
        self.scheduler_log_display.setReadOnly(True)
        layout.addWidget(self.scheduler_log_display)

        # 初始化时刷新状态
        QTimer.singleShot(100, self._refresh_scheduler_status)

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
            self._append_auth_status('检测到已保存的凭据，请点击"登录"按钮')

    def _handle_login(self) -> None:
        """处理登录按钮点击。"""
        student_id = self.sid_input.text().strip()
        password = self.pwd_input.text().strip()

        if not student_id or not password:
            QMessageBox.warning(self, "输入错误", "请输入学号和密码")
            return

        # 清理旧的 worker（如果存在）
        if self.auth_worker:
            try:
                self.auth_worker.finished.disconnect()
                self.auth_worker.error_occurred.disconnect()
            except (RuntimeError, TypeError):
                pass  # 信号已断开或不存在
            if self.auth_worker.isRunning():
                self.auth_worker.requestInterruption()
                self.auth_worker.wait(1000)
            self.auth_worker.deleteLater()
            self.auth_worker = None

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
                password=self.pwd_input.text().strip(),
            )
            try:
                save_credentials(self.settings.paths.credentials_file, creds)
                self._append_auth_status(f"凭据已保存到 {self.settings.paths.credentials_file}")
            except OSError as exc:
                self._append_auth_status(f"凭据保存失败: {exc}")
        else:
            self._append_auth_status(f"✗ {message}")
            self.statusBar().showMessage("认证失败")
            QMessageBox.warning(self, "认证失败", message)

        # 清理 worker 对象
        if self.auth_worker:
            self.auth_worker.deleteLater()
            self.auth_worker = None

    def _on_auth_error(self, error_msg: str) -> None:
        """认证错误回调。"""
        self.login_btn.setEnabled(True)
        self._append_auth_status(f"✗ 认证出错: {error_msg}")
        self.statusBar().showMessage("认证出错")
        QMessageBox.critical(self, "错误", f"认证过程出错:\n{error_msg}")

        # 清理 worker 对象
        if self.auth_worker:
            self.auth_worker.deleteLater()
            self.auth_worker = None

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
                f"提前 {plan.book_days} 天\n",
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
    # 定时任务相关
    # ------------------------------------------------------------------
    def _refresh_scheduler_status(self) -> None:
        """刷新定时任务状态。"""
        status = self.scheduler_service.get_task_status()

        if status.exists:
            lines = ["✓ 定时任务已配置\n"]
            if status.execute_time:
                lines.append(f"执行时间: {status.execute_time}")
            if status.next_run:
                lines.append(f"下次运行: {status.next_run}")
            if status.wake_to_run is not None:
                lines.append(f"唤醒计算机: {'是' if status.wake_to_run else '否'}")

            lines.append(f"\n任务名称: {self.scheduler_service.task_name}")
            lines.append(f"系统平台: {self.scheduler_service.system}")

            self.task_status_display.setText("\n".join(lines))
        else:
            self.task_status_display.setText('✗ 未配置定时任务\n\n点击"配置定时任务"按钮开始设置')

    def _configure_scheduler(self) -> None:
        """配置定时任务对话框。"""
        # 检查是否有启用的方案
        plans = self.plan_service.list_enabled()
        if not plans:
            QMessageBox.warning(
                self,
                "无可用方案",
                '没有启用的预约方案。\n\n请先在"方案管理"标签页创建并启用方案。',
            )
            return

        # 打开配置对话框
        dialog = SchedulerConfigDialog(self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return

        # 获取配置参数
        execute_time = dialog.get_execute_time()
        wake_to_run = dialog.get_wake_to_run()

        # 配置任务
        self._append_scheduler_log(f"\n正在配置定时任务（{execute_time}）...")
        self.config_task_btn.setEnabled(False)

        success, message = self.scheduler_service.configure_task(execute_time, wake_to_run)

        self.config_task_btn.setEnabled(True)

        if success:
            self._append_scheduler_log(f"✓ {message}")
            self.statusBar().showMessage("定时任务配置成功")
            self._refresh_scheduler_status()
            QMessageBox.information(self, "成功", message)
        else:
            self._append_scheduler_log(f"✗ 配置失败: {message}")
            self.statusBar().showMessage("定时任务配置失败")
            QMessageBox.critical(self, "配置失败", message)

    def _remove_scheduler(self) -> None:
        """移除定时任务。"""
        # 确认对话框
        reply = QMessageBox.question(
            self,
            "确认移除",
            "确定要移除定时任务吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )

        if reply != QMessageBox.StandardButton.Yes:
            return

        self._append_scheduler_log("\n正在移除定时任务...")
        self.remove_task_btn.setEnabled(False)

        success, message = self.scheduler_service.remove_task()

        self.remove_task_btn.setEnabled(True)

        if success:
            self._append_scheduler_log(f"✓ {message}")
            self.statusBar().showMessage("定时任务已移除")
            self._refresh_scheduler_status()
            QMessageBox.information(self, "成功", message)
        else:
            self._append_scheduler_log(f"✗ 移除失败: {message}")
            self.statusBar().showMessage("移除失败")
            QMessageBox.critical(self, "移除失败", message)

    def _test_execution(self) -> None:
        """测试执行一次后台任务（异步）。"""
        # 检查是否有启用的方案
        plans = self.plan_service.list_enabled()
        if not plans:
            QMessageBox.warning(
                self,
                "无可用方案",
                '没有启用的预约方案。\n\n请先在"方案管理"标签页创建并启用方案。',
            )
            return

        # 确认对话框
        reply = QMessageBox.question(
            self,
            "确认测试",
            f"将立即执行一次抢座任务（{len(plans)} 个方案）。\n\n"
            "这会实际尝试预约座位，确定继续吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )

        if reply != QMessageBox.StandardButton.Yes:
            return

        self._append_scheduler_log("\n正在测试执行...")
        self.test_exec_btn.setEnabled(False)
        self.statusBar().showMessage("测试执行中...")

        # 启动异步测试 worker
        self.test_worker = TestExecutionWorker(self.scheduler_service)
        self.test_worker.finished.connect(self._on_test_finished)
        self.test_worker.error_occurred.connect(self._on_test_error)
        self.test_worker.start()

    def _on_test_finished(self, success: bool, output: str) -> None:
        """测试执行完成回调。"""
        self.test_exec_btn.setEnabled(True)

        if success:
            self._append_scheduler_log(f"✓ 测试执行成功\n{output}")
            self.statusBar().showMessage("测试执行成功")
            QMessageBox.information(self, "测试成功", f"测试执行成功！\n\n{output[:500]}")
        else:
            self._append_scheduler_log(f"✗ 测试执行失败\n{output}")
            self.statusBar().showMessage("测试执行失败")
            QMessageBox.critical(self, "测试失败", f"测试执行失败。\n\n{output[:500]}")

        # 清理 worker
        if self.test_worker:
            self.test_worker.deleteLater()
            self.test_worker = None

    def _on_test_error(self, error_msg: str) -> None:
        """测试执行错误回调。"""
        self.test_exec_btn.setEnabled(True)
        self._append_scheduler_log(f"✗ 测试执行出错: {error_msg}")
        self.statusBar().showMessage("测试执行出错")
        QMessageBox.critical(self, "错误", f"测试执行过程出错:\n{error_msg}")

        # 清理 worker
        if self.test_worker:
            self.test_worker.deleteLater()
            self.test_worker = None

    def _append_scheduler_log(self, text: str) -> None:
        """追加定时任务日志。"""
        self.scheduler_log_display.append(text)
        self.scheduler_log_display.verticalScrollBar().setValue(
            self.scheduler_log_display.verticalScrollBar().maximum(),
        )

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
                QMessageBox.warning(
                    self,
                    "时间格式错误",
                    f"请输入有效的时间格式 (HH:MM 或 HH:MM:SS)\n错误: {exc}",
                )
                return

        # 清理旧的 worker（如果存在）
        if self.booking_worker:
            try:
                self.booking_worker.countdown_updated.disconnect()
                self.booking_worker.progress_updated.disconnect()
                self.booking_worker.finished.disconnect()
                self.booking_worker.error_occurred.disconnect()
            except (RuntimeError, TypeError):
                pass  # 信号已断开或不存在
            if self.booking_worker.isRunning():
                self.booking_worker.cancel()
                self.booking_worker.wait(1000)
            self.booking_worker.deleteLater()
            self.booking_worker = None

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
            text = f"⏱️ 倒计时: {hours:02d}:{minutes:02d}:{seconds:02d}"
        else:
            text = f"⏱️ 倒计时: {minutes:02d}:{seconds:02d}"

        self.countdown_label.setText(text)
        self.countdown_label.setVisible(True)

    def _on_progress_update(self, result: BookingResult) -> None:
        """单次尝试进度更新回调。"""
        status = "✓" if result.success else "✗"
        self._append_log(
            f"{status} {result.plan.to_plan_code()} | "
            f"座位 {result.plan.seat_num} | "
            f"{result.message}",
        )

    def _on_booking_finished(self, results: list[BookingResult]) -> None:
        """抢座完成回调。"""
        self.start_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.countdown_label.clear()
        self.countdown_label.setVisible(False)

        success = any(r.success for r in results)

        if success:
            self._append_log(f"\n✓✓✓ 预约成功！共尝试 {len(results)} 次 ✓✓✓")
            self.statusBar().showMessage("预约成功！")
            QMessageBox.information(self, "成功", "预约成功！")
        else:
            self._append_log(f"\n✗✗✗ 预约失败。共尝试 {len(results)} 次 ✗✗✗")
            self.statusBar().showMessage("预约失败")
            QMessageBox.warning(self, "失败", f"预约失败，共尝试 {len(results)} 次")

        # 清理 worker 对象
        if self.booking_worker:
            self.booking_worker.deleteLater()
            self.booking_worker = None

    def _on_booking_error(self, error_msg: str) -> None:
        """抢座错误回调。"""
        self.start_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.countdown_label.clear()
        self.countdown_label.setVisible(False)

        self._append_log(f"\n✗ 错误: {error_msg}")
        self.statusBar().showMessage("执行出错")
        QMessageBox.critical(self, "错误", f"执行过程出错:\n{error_msg}")

        # 清理 worker 对象
        if self.booking_worker:
            self.booking_worker.deleteLater()
            self.booking_worker = None

    def _append_log(self, text: str) -> None:
        """追加日志文本。"""
        self.log_display.append(text)
        # 自动滚动到底部
        self.log_display.verticalScrollBar().setValue(
            self.log_display.verticalScrollBar().maximum(),
        )

    def closeEvent(self, event) -> None:
        """窗口关闭事件：清理工作线程。"""
        # 收集所有活动的 worker
        active_workers = []
        if self.booking_worker and self.booking_worker.isRunning():
            active_workers.append(("booking", self.booking_worker))
        if self.auth_worker and self.auth_worker.isRunning():
            active_workers.append(("auth", self.auth_worker))
        if self.test_worker and self.test_worker.isRunning():
            active_workers.append(("test", self.test_worker))

        # 如果有活动任务，询问确认
        if active_workers:
            task_names = {"booking": "抢座", "auth": "认证", "test": "测试执行"}
            tasks_str = "、".join(task_names[name] for name, _ in active_workers)
            reply = QMessageBox.question(
                self,
                "确认退出",
                f"{tasks_str}任务正在执行中，确定要退出吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )

            if reply == QMessageBox.StandardButton.No:
                event.ignore()
                return

            # 取消并等待所有线程结束
            for name, worker in active_workers:
                if name == "booking":
                    worker.cancel()
                else:
                    worker.requestInterruption()

                # 等待线程结束，超时后强制终止
                if not worker.wait(3000):  # 3秒超时
                    worker.terminate()
                    worker.wait()  # 等待终止完成

        event.accept()
