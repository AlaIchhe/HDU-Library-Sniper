# -*- coding: utf-8 -*-
"""Qt GUI 按钮自动化测试：使用 pytest-qt 测试各个按钮点击功能。"""

import sys
from unittest.mock import Mock, patch, MagicMock

import pytest
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import QApplication, QMessageBox

from gui.main_window import MainWindow


@pytest.fixture
def app(qtbot):
    """创建 Qt 应用实例。"""
    # Mock 掉一些依赖，避免实际网络请求
    with patch('gui.main_window.build_runtime') as mock_runtime:
        # Mock 返回值
        mock_settings = Mock()
        mock_settings.project_root = "."
        mock_settings.credentials_file = "test_credentials.json"
        mock_settings.max_trials = 3
        mock_settings.retry_delay = 1.0
        mock_settings.window_wait_seconds = 10
        mock_settings.window_poll_interval = 0.5

        mock_client = Mock()
        mock_plans = Mock()
        mock_notifier = Mock()

        mock_runtime.return_value = (mock_settings, mock_client, mock_plans, mock_notifier)

        with patch('gui.main_window.load_credentials') as mock_load:
            mock_load.return_value = None

            # 创建主窗口
            window = MainWindow()
            qtbot.addWidget(window)

            # 禁用自动认证定时器
            for timer in window.findChildren(QTimer):
                timer.stop()

            yield window


class TestAuthTab:
    """测试认证标签页的按钮。"""

    def test_login_button_click(self, app, qtbot, monkeypatch):
        """测试登录按钮点击。"""
        # 切换到认证标签页
        app.tabs.setCurrentIndex(0)

        # 填写学号和密码
        app.sid_input.setText("20210001")
        app.pwd_input.setText("test_password")

        # Mock 认证服务
        mock_auth_worker = Mock()
        with patch('gui.main_window.AuthWorker') as MockAuthWorker:
            MockAuthWorker.return_value = mock_auth_worker

            # 点击登录按钮
            qtbot.mouseClick(app.login_btn, Qt.MouseButton.LeftButton)

            # 验证按钮被禁用
            assert not app.login_btn.isEnabled()

            # 验证认证工作线程被创建并启动
            MockAuthWorker.assert_called_once()
            mock_auth_worker.start.assert_called_once()

        print("✓ 登录按钮测试通过")

    def test_login_button_empty_fields(self, app, qtbot, monkeypatch):
        """测试空字段时登录按钮点击。"""
        app.tabs.setCurrentIndex(0)

        # Mock QMessageBox
        with patch.object(QMessageBox, 'warning') as mock_warning:
            # 清空输入
            app.sid_input.clear()
            app.pwd_input.clear()

            # 点击登录按钮
            qtbot.mouseClick(app.login_btn, Qt.MouseButton.LeftButton)

            # 验证显示警告对话框
            mock_warning.assert_called_once()

        print("✓ 空字段登录测试通过")


class TestPlansTab:
    """测试方案管理标签页的按钮。"""

    def test_refresh_plans_button(self, app, qtbot):
        """测试刷新方案列表按钮。"""
        app.tabs.setCurrentIndex(1)

        # Mock plan_service
        app.plan_service.list_plans = Mock(return_value=[])
        app.plan_service.list_enabled = Mock(return_value=[])

        # 点击刷新按钮
        qtbot.mouseClick(app.refresh_plans_btn, Qt.MouseButton.LeftButton)

        # 验证服务方法被调用
        app.plan_service.list_plans.assert_called()
        app.plan_service.list_enabled.assert_called()

        print("✓ 刷新方案按钮测试通过")

    def test_create_plan_button(self, app, qtbot):
        """测试创建方案按钮。"""
        app.tabs.setCurrentIndex(1)

        # Mock 对话框
        with patch('gui.main_window.CreatePlanDialog') as MockDialog:
            mock_dialog = Mock()
            mock_dialog.exec.return_value = 0  # Rejected
            MockDialog.return_value = mock_dialog

            # 点击创建方案按钮
            qtbot.mouseClick(app.create_plan_btn, Qt.MouseButton.LeftButton)

            # 验证对话框被创建
            MockDialog.assert_called_once()
            mock_dialog.exec.assert_called_once()

        print("✓ 创建方案按钮测试通过")

    def test_delete_plan_button_no_plans(self, app, qtbot):
        """测试删除方案按钮（无方案时）。"""
        app.tabs.setCurrentIndex(1)

        # Mock 无方案
        app.plan_service.list_plans = Mock(return_value=[])

        with patch.object(QMessageBox, 'information') as mock_info:
            # 点击删除按钮
            qtbot.mouseClick(app.delete_plan_btn, Qt.MouseButton.LeftButton)

            # 验证显示提示信息
            mock_info.assert_called_once()

        print("✓ 删除方案按钮（无方案）测试通过")

    def test_modify_time_button_no_plans(self, app, qtbot):
        """测试批量修改时间按钮（无方案时）。"""
        app.tabs.setCurrentIndex(1)

        app.plan_service.list_plans = Mock(return_value=[])

        with patch.object(QMessageBox, 'information') as mock_info:
            qtbot.mouseClick(app.modify_time_btn, Qt.MouseButton.LeftButton)
            mock_info.assert_called_once()

        print("✓ 批量修改时间按钮测试通过")

    def test_browse_rooms_button(self, app, qtbot):
        """测试浏览房间按钮。"""
        app.tabs.setCurrentIndex(1)

        with patch('gui.main_window.BrowseRoomsDialog') as MockDialog:
            mock_dialog = Mock()
            MockDialog.return_value = mock_dialog

            qtbot.mouseClick(app.browse_rooms_btn, Qt.MouseButton.LeftButton)

            MockDialog.assert_called_once()
            mock_dialog.exec.assert_called_once()

        print("✓ 浏览房间按钮测试通过")


class TestBookingTab:
    """测试抢座标签页的按钮。"""

    def test_start_booking_button_no_plans(self, app, qtbot):
        """测试开始抢座按钮（无方案时）。"""
        app.tabs.setCurrentIndex(2)

        # Mock 无启用方案
        app.plan_service.list_enabled = Mock(return_value=[])

        with patch.object(QMessageBox, 'warning') as mock_warning:
            qtbot.mouseClick(app.start_btn, Qt.MouseButton.LeftButton)
            mock_warning.assert_called_once()

        print("✓ 开始抢座按钮（无方案）测试通过")

    def test_start_booking_button_with_plans(self, app, qtbot):
        """测试开始抢座按钮（有方案时）。"""
        app.tabs.setCurrentIndex(2)

        # Mock 有方案
        mock_plan = Mock()
        mock_plan.enabled = True
        app.plan_service.list_enabled = Mock(return_value=[mock_plan])

        # 清空时间输入（立即执行）
        app.time_input.clear()

        with patch('gui.main_window.BookingWorker') as MockWorker:
            mock_worker = Mock()
            MockWorker.return_value = mock_worker

            qtbot.mouseClick(app.start_btn, Qt.MouseButton.LeftButton)

            # 验证按钮状态改变
            assert not app.start_btn.isEnabled()
            assert app.cancel_btn.isEnabled()

            # 验证工作线程被创建
            MockWorker.assert_called_once()
            mock_worker.start.assert_called_once()

        print("✓ 开始抢座按钮（有方案）测试通过")

    def test_cancel_button(self, app, qtbot):
        """测试取消按钮。"""
        app.tabs.setCurrentIndex(2)

        # 模拟正在运行的工作线程
        mock_worker = Mock()
        mock_worker.isRunning.return_value = True
        app.booking_worker = mock_worker

        app.cancel_btn.setEnabled(True)

        qtbot.mouseClick(app.cancel_btn, Qt.MouseButton.LeftButton)

        # 验证取消方法被调用
        mock_worker.cancel.assert_called_once()

        print("✓ 取消按钮测试通过")


class TestSchedulerTab:
    """测试定时任务标签页的按钮。"""

    def test_refresh_status_button(self, app, qtbot):
        """测试刷新状态按钮。"""
        app.tabs.setCurrentIndex(3)

        # Mock 调度器服务
        mock_status = Mock()
        mock_status.exists = False
        app.scheduler_service.get_task_status = Mock(return_value=mock_status)

        qtbot.mouseClick(app.refresh_status_btn, Qt.MouseButton.LeftButton)

        # 验证服务方法被调用
        app.scheduler_service.get_task_status.assert_called()

        print("✓ 刷新状态按钮测试通过")

    def test_config_task_button_no_plans(self, app, qtbot):
        """测试配置定时任务按钮（无方案时）。"""
        app.tabs.setCurrentIndex(3)

        # Mock 无启用方案
        app.plan_service.list_enabled = Mock(return_value=[])

        with patch.object(QMessageBox, 'warning') as mock_warning:
            qtbot.mouseClick(app.config_task_btn, Qt.MouseButton.LeftButton)
            mock_warning.assert_called_once()

        print("✓ 配置定时任务按钮（无方案）测试通过")

    def test_config_task_button_with_plans(self, app, qtbot):
        """测试配置定时任务按钮（有方案时）。"""
        app.tabs.setCurrentIndex(3)

        # Mock 有方案
        mock_plan = Mock()
        app.plan_service.list_enabled = Mock(return_value=[mock_plan])

        with patch('gui.main_window.SchedulerConfigDialog') as MockDialog:
            mock_dialog = Mock()
            mock_dialog.exec.return_value = 0  # Rejected
            MockDialog.return_value = mock_dialog

            qtbot.mouseClick(app.config_task_btn, Qt.MouseButton.LeftButton)

            MockDialog.assert_called_once()
            mock_dialog.exec.assert_called_once()

        print("✓ 配置定时任务按钮（有方案）测试通过")

    def test_remove_task_button(self, app, qtbot):
        """测试移除定时任务按钮。"""
        app.tabs.setCurrentIndex(3)

        with patch.object(QMessageBox, 'question') as mock_question:
            # 模拟用户点击"否"
            mock_question.return_value = QMessageBox.StandardButton.No

            qtbot.mouseClick(app.remove_task_btn, Qt.MouseButton.LeftButton)

            # 验证显示确认对话框
            mock_question.assert_called_once()

        print("✓ 移除定时任务按钮测试通过")

    def test_test_execution_button_no_plans(self, app, qtbot):
        """测试测试执行按钮（无方案时）。"""
        app.tabs.setCurrentIndex(3)

        app.plan_service.list_enabled = Mock(return_value=[])

        with patch.object(QMessageBox, 'warning') as mock_warning:
            qtbot.mouseClick(app.test_exec_btn, Qt.MouseButton.LeftButton)
            mock_warning.assert_called_once()

        print("✓ 测试执行按钮（无方案）测试通过")


def run_all_tests():
    """运行所有按钮测试。"""
    print("=" * 70)
    print("开始 Qt 界面按钮自动化测试")
    print("=" * 70)

    # 使用 pytest 运行测试
    pytest_args = [
        __file__,
        "-v",  # 详细输出
        "-s",  # 显示 print 输出
        "--tb=short",  # 简短的错误回溯
    ]

    exit_code = pytest.main(pytest_args)

    print("\n" + "=" * 70)
    if exit_code == 0:
        print("✓✓✓ 所有按钮测试通过！✓✓✓")
    else:
        print("✗✗✗ 部分测试失败 ✗✗✗")
    print("=" * 70)

    return exit_code


if __name__ == "__main__":
    sys.exit(run_all_tests())
