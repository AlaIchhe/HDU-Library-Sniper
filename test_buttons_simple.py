# -*- coding: utf-8 -*-
"""Qt GUI 按钮简单测试：直接测试按钮点击功能。"""

import sys
from unittest.mock import Mock, patch

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import QApplication, QMessageBox


def test_all_buttons():
    """测试所有按钮的点击功能。"""
    import sys
    import io

    # 设置输出编码为 UTF-8
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

    print("=" * 70)
    print("开始 Qt 界面按钮测试")
    print("=" * 70)

    # 创建 QApplication
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)

    # Mock 依赖
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

            # 导入并创建主窗口
            from gui.main_window import MainWindow
            window = MainWindow()

            # 停止自动认证定时器
            for timer in window.findChildren(QTimer):
                timer.stop()

            print("\n✓ 主窗口创建成功")

            # 测试认证标签页按钮
            test_auth_tab(window)

            # 测试方案管理标签页按钮
            test_plans_tab(window)

            # 测试抢座标签页按钮
            test_booking_tab(window)

            # 测试定时任务标签页按钮
            test_scheduler_tab(window)

            print("\n" + "=" * 70)
            print("✓✓✓ 所有按钮测试完成！✓✓✓")
            print("=" * 70)


def test_auth_tab(window):
    """测试认证标签页。"""
    print("\n【认证标签页】")
    window.tabs.setCurrentIndex(0)

    # 测试1: 空字段登录
    print("  测试：空字段登录...")
    window.sid_input.clear()
    window.pwd_input.clear()

    with patch.object(QMessageBox, 'warning') as mock_warning:
        window.login_btn.click()
        if mock_warning.called:
            print("    ✓ 空字段时显示警告")
        else:
            print("    ✗ 空字段时未显示警告")

    # 测试2: 填写凭据登录
    print("  测试：填写凭据登录...")
    window.sid_input.setText("20210001")
    window.pwd_input.setText("test_password")

    with patch('gui.main_window.AuthWorker') as MockAuthWorker:
        mock_worker = Mock()
        MockAuthWorker.return_value = mock_worker

        window.login_btn.click()

        if MockAuthWorker.called and mock_worker.start.called:
            print("    ✓ 登录按钮触发认证工作线程")
        else:
            print("    ✗ 登录按钮未正确触发")

    # 恢复按钮状态
    window.login_btn.setEnabled(True)


def test_plans_tab(window):
    """测试方案管理标签页。"""
    print("\n【方案管理标签页】")
    window.tabs.setCurrentIndex(1)

    # 测试刷新按钮
    print("  测试：刷新方案列表...")
    window.plan_service.list_plans = Mock(return_value=[])
    window.plan_service.list_enabled = Mock(return_value=[])

    window.refresh_plans_btn.click()

    if window.plan_service.list_plans.called:
        print("    ✓ 刷新按钮工作正常")
    else:
        print("    ✗ 刷新按钮未调用服务")

    # 测试创建方案按钮
    print("  测试：创建方案...")
    with patch('gui.main_window.CreatePlanDialog') as MockDialog:
        mock_dialog = Mock()
        mock_dialog.exec.return_value = 0
        MockDialog.return_value = mock_dialog

        window.create_plan_btn.click()

        if MockDialog.called:
            print("    ✓ 创建方案按钮打开对话框")
        else:
            print("    ✗ 创建方案按钮未打开对话框")

    # 测试删除按钮（无方案）
    print("  测试：删除方案（无方案）...")
    with patch.object(QMessageBox, 'information') as mock_info:
        window.delete_plan_btn.click()

        if mock_info.called:
            print("    ✓ 无方案时显示提示信息")
        else:
            print("    ✗ 无方案时未显示提示")

    # 测试修改时间按钮
    print("  测试：批量修改时间（无方案）...")
    with patch.object(QMessageBox, 'information') as mock_info:
        window.modify_time_btn.click()

        if mock_info.called:
            print("    ✓ 修改时间按钮工作正常")
        else:
            print("    ✗ 修改时间按钮异常")

    # 测试浏览房间按钮
    print("  测试：浏览房间...")
    with patch('gui.main_window.BrowseRoomsDialog') as MockDialog:
        mock_dialog = Mock()
        MockDialog.return_value = mock_dialog

        window.browse_rooms_btn.click()

        if MockDialog.called:
            print("    ✓ 浏览房间按钮打开对话框")
        else:
            print("    ✗ 浏览房间按钮未打开对话框")


def test_booking_tab(window):
    """测试抢座标签页。"""
    print("\n【抢座标签页】")
    window.tabs.setCurrentIndex(2)

    # 测试开始按钮（无方案）
    print("  测试：开始抢座（无方案）...")
    window.plan_service.list_enabled = Mock(return_value=[])

    with patch.object(QMessageBox, 'warning') as mock_warning:
        window.start_btn.click()

        if mock_warning.called:
            print("    ✓ 无方案时显示警告")
        else:
            print("    ✗ 无方案时未显示警告")

    # 测试开始按钮（有方案）
    print("  测试：开始抢座（有方案）...")
    mock_plan = Mock()
    mock_plan.enabled = True
    window.plan_service.list_enabled = Mock(return_value=[mock_plan])
    window.time_input.clear()

    with patch('gui.main_window.BookingWorker') as MockWorker:
        mock_worker = Mock()
        MockWorker.return_value = mock_worker

        window.start_btn.click()

        if MockWorker.called and mock_worker.start.called:
            print("    ✓ 开始按钮启动抢座线程")
        else:
            print("    ✗ 开始按钮未启动线程")

    # 恢复按钮状态
    window.start_btn.setEnabled(True)
    window.cancel_btn.setEnabled(False)

    # 测试取消按钮
    print("  测试：取消抢座...")
    mock_worker = Mock()
    mock_worker.isRunning.return_value = True
    window.booking_worker = mock_worker
    window.cancel_btn.setEnabled(True)

    window.cancel_btn.click()

    if mock_worker.cancel.called:
        print("    ✓ 取消按钮工作正常")
    else:
        print("    ✗ 取消按钮未调用取消方法")


def test_scheduler_tab(window):
    """测试定时任务标签页。"""
    print("\n【定时任务标签页】")
    window.tabs.setCurrentIndex(3)

    # 测试刷新状态按钮
    print("  测试：刷新状态...")
    mock_status = Mock()
    mock_status.exists = False
    window.scheduler_service.get_task_status = Mock(return_value=mock_status)

    window.refresh_status_btn.click()

    if window.scheduler_service.get_task_status.called:
        print("    ✓ 刷新状态按钮工作正常")
    else:
        print("    ✗ 刷新状态按钮异常")

    # 测试配置任务按钮（无方案）
    print("  测试：配置定时任务（无方案）...")
    window.plan_service.list_enabled = Mock(return_value=[])

    with patch.object(QMessageBox, 'warning') as mock_warning:
        window.config_task_btn.click()

        if mock_warning.called:
            print("    ✓ 无方案时显示警告")
        else:
            print("    ✗ 无方案时未显示警告")

    # 测试配置任务按钮（有方案）
    print("  测试：配置定时任务（有方案）...")
    mock_plan = Mock()
    window.plan_service.list_enabled = Mock(return_value=[mock_plan])

    with patch('gui.main_window.SchedulerConfigDialog') as MockDialog:
        mock_dialog = Mock()
        mock_dialog.exec.return_value = 0
        MockDialog.return_value = mock_dialog

        window.config_task_btn.click()

        if MockDialog.called:
            print("    ✓ 配置任务按钮打开对话框")
        else:
            print("    ✗ 配置任务按钮未打开对话框")

    # 测试移除任务按钮
    print("  测试：移除定时任务...")
    with patch.object(QMessageBox, 'question') as mock_question:
        mock_question.return_value = QMessageBox.StandardButton.No

        window.remove_task_btn.click()

        if mock_question.called:
            print("    ✓ 移除任务按钮显示确认对话框")
        else:
            print("    ✗ 移除任务按钮未显示确认")

    # 测试测试执行按钮（无方案）
    print("  测试：测试执行（无方案）...")
    window.plan_service.list_enabled = Mock(return_value=[])

    with patch.object(QMessageBox, 'warning') as mock_warning:
        window.test_exec_btn.click()

        if mock_warning.called:
            print("    ✓ 无方案时显示警告")
        else:
            print("    ✗ 无方案时未显示警告")


if __name__ == "__main__":
    test_all_buttons()
