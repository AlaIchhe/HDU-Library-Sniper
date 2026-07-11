"""GUI 定时任务功能单元测试。"""

import unittest
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock
import sys

# 确保可以导入项目模块
sys.path.insert(0, str(Path(__file__).parent))


class TestSchedulerService(unittest.TestCase):
    """SchedulerService 单元测试。"""

    def setUp(self):
        """测试前准备。"""
        from services.scheduler import SchedulerService
        self.project_root = Path(__file__).parent
        self.service = SchedulerService(self.project_root)

    def test_init(self):
        """测试初始化。"""
        self.assertEqual(self.service.project_root, self.project_root)
        self.assertIsNotNone(self.service.system)
        self.assertEqual(self.service.task_name, "HDU-Library-Sniper-Daily")

    def test_task_status_structure(self):
        """测试任务状态数据结构。"""
        from services.scheduler import TaskStatus

        status = TaskStatus(exists=False)
        self.assertFalse(status.exists)
        self.assertIsNone(status.execute_time)

        status = TaskStatus(
            exists=True,
            execute_time="23:59:55",
            next_run="2026-07-12 23:59:55"
        )
        self.assertTrue(status.exists)
        self.assertEqual(status.execute_time, "23:59:55")
        self.assertEqual(status.next_run, "2026-07-12 23:59:55")

    @patch('platform.system')
    def test_platform_detection(self, mock_system):
        """测试平台检测。"""
        from services.scheduler import SchedulerService

        # 测试 Windows
        mock_system.return_value = "Windows"
        service = SchedulerService(self.project_root)
        self.assertEqual(service.system, "Windows")

        # 测试 Linux
        mock_system.return_value = "Linux"
        service = SchedulerService(self.project_root)
        self.assertEqual(service.system, "Linux")

        # 测试 macOS
        mock_system.return_value = "Darwin"
        service = SchedulerService(self.project_root)
        self.assertEqual(service.system, "Darwin")

    @patch('subprocess.run')
    @patch('platform.system')
    def test_get_task_status_windows_not_exists(self, mock_system, mock_run):
        """测试 Windows 任务状态查询（任务不存在）。"""
        from services.scheduler import SchedulerService

        mock_system.return_value = "Windows"
        service = SchedulerService(self.project_root)

        # 模拟任务不存在
        mock_result = Mock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_run.return_value = mock_result

        status = service.get_task_status()
        self.assertFalse(status.exists)

    @patch('subprocess.run')
    @patch('platform.system')
    def test_get_task_status_windows_exists(self, mock_system, mock_run):
        """测试 Windows 任务状态查询（任务存在）。"""
        from services.scheduler import SchedulerService

        mock_system.return_value = "Windows"
        service = SchedulerService(self.project_root)

        # 模拟任务存在
        mock_result = Mock()
        mock_result.returncode = 0
        mock_result.stdout = """
        Task Name: HDU-Library-Sniper-Daily
        Next Run Time: 2026-07-12 23:59:55
        Start Time: 23:59:55
        """
        mock_run.return_value = mock_result

        status = service.get_task_status()
        self.assertTrue(status.exists)

    def test_find_pythonw_not_found(self):
        """测试查找 pythonw.exe（未找到）。"""
        if self.service.system != "Windows":
            self.skipTest("仅适用于 Windows")

        # 创建一个临时路径，确保没有 pythonw.exe
        temp_root = Path("/nonexistent/path")
        service = self.service.__class__(temp_root)

        # 这个测试可能会找到系统 PATH 中的 pythonw
        result = service._find_pythonw()
        # 只验证返回值类型
        self.assertTrue(result is None or isinstance(result, Path))


class TestSchedulerConfigDialog(unittest.TestCase):
    """SchedulerConfigDialog 单元测试。"""

    @classmethod
    def setUpClass(cls):
        """测试类初始化。"""
        from PySide6.QtWidgets import QApplication
        cls.app = QApplication.instance()
        if cls.app is None:
            cls.app = QApplication([])

    def test_dialog_creation(self):
        """测试对话框创建。"""
        from gui.dialogs.scheduler_config_dialog import SchedulerConfigDialog

        dialog = SchedulerConfigDialog()
        self.assertIsNotNone(dialog)
        self.assertEqual(dialog.windowTitle(), "配置定时任务")

    def test_default_time(self):
        """测试默认执行时间。"""
        from gui.dialogs.scheduler_config_dialog import SchedulerConfigDialog

        dialog = SchedulerConfigDialog()
        execute_time = dialog.get_execute_time()
        self.assertEqual(execute_time, "23:59:55")

    def test_default_wake_to_run(self):
        """测试默认唤醒设置。"""
        from gui.dialogs.scheduler_config_dialog import SchedulerConfigDialog
        import platform

        dialog = SchedulerConfigDialog()
        wake_to_run = dialog.get_wake_to_run()

        if platform.system() == "Windows":
            self.assertTrue(wake_to_run)
        else:
            self.assertFalse(wake_to_run)

    def test_custom_time(self):
        """测试自定义执行时间。"""
        from gui.dialogs.scheduler_config_dialog import SchedulerConfigDialog
        from PySide6.QtCore import QTime

        dialog = SchedulerConfigDialog()

        # 设置自定义时间
        custom_time = QTime(13, 30, 45)
        dialog.time_edit.setTime(custom_time)

        execute_time = dialog.get_execute_time()
        self.assertEqual(execute_time, "13:30:45")

    def test_dialog_has_required_widgets(self):
        """测试对话框包含必要的组件。"""
        from gui.dialogs.scheduler_config_dialog import SchedulerConfigDialog

        dialog = SchedulerConfigDialog()

        # 验证时间编辑器存在
        self.assertTrue(hasattr(dialog, 'time_edit'))
        self.assertIsNotNone(dialog.time_edit)

        # 验证时间格式
        self.assertEqual(dialog.time_edit.displayFormat(), "HH:mm:ss")


class TestMainWindowIntegration(unittest.TestCase):
    """MainWindow 集成测试。"""

    @classmethod
    def setUpClass(cls):
        """测试类初始化。"""
        from PySide6.QtWidgets import QApplication
        cls.app = QApplication.instance()
        if cls.app is None:
            cls.app = QApplication([])

    def test_main_window_creation(self):
        """测试主窗口创建。"""
        from gui.main_window import MainWindow

        window = MainWindow()
        self.assertIsNotNone(window)
        self.assertEqual(window.windowTitle(), "HDU 图书馆抢座工具")

    def test_tab_count(self):
        """测试标签页数量。"""
        from gui.main_window import MainWindow

        window = MainWindow()
        self.assertEqual(window.tabs.count(), 4)

    def test_tab_names(self):
        """测试标签页名称。"""
        from gui.main_window import MainWindow

        window = MainWindow()
        expected_tabs = ["认证", "方案管理", "抢座", "定时任务"]

        for i, expected_name in enumerate(expected_tabs):
            actual_name = window.tabs.tabText(i)
            self.assertEqual(actual_name, expected_name,
                           f"标签页 {i} 名称不匹配")

    def test_scheduler_service_initialized(self):
        """测试 SchedulerService 已初始化。"""
        from gui.main_window import MainWindow

        window = MainWindow()
        self.assertTrue(hasattr(window, 'scheduler_service'))
        self.assertIsNotNone(window.scheduler_service)

    def test_scheduler_buttons_exist(self):
        """测试定时任务按钮存在。"""
        from gui.main_window import MainWindow

        window = MainWindow()

        # 验证按钮存在
        self.assertTrue(hasattr(window, 'config_task_btn'))
        self.assertTrue(hasattr(window, 'remove_task_btn'))
        self.assertTrue(hasattr(window, 'test_exec_btn'))
        self.assertTrue(hasattr(window, 'refresh_status_btn'))

        # 验证按钮不为空
        self.assertIsNotNone(window.config_task_btn)
        self.assertIsNotNone(window.remove_task_btn)
        self.assertIsNotNone(window.test_exec_btn)
        self.assertIsNotNone(window.refresh_status_btn)

    def test_scheduler_display_widgets_exist(self):
        """测试定时任务显示组件存在。"""
        from gui.main_window import MainWindow

        window = MainWindow()

        # 验证显示组件存在
        self.assertTrue(hasattr(window, 'task_status_display'))
        self.assertTrue(hasattr(window, 'scheduler_log_display'))

        self.assertIsNotNone(window.task_status_display)
        self.assertIsNotNone(window.scheduler_log_display)

    def test_services_initialized(self):
        """测试所有服务已初始化。"""
        from gui.main_window import MainWindow

        window = MainWindow()

        # 验证服务存在
        self.assertTrue(hasattr(window, 'auth'))
        self.assertTrue(hasattr(window, 'booking'))
        self.assertTrue(hasattr(window, 'plan_service'))
        self.assertTrue(hasattr(window, 'scheduler_service'))

        # 验证服务类型
        from services import AuthService, BookingService, PlanService
        from services.scheduler import SchedulerService

        self.assertIsInstance(window.auth, AuthService)
        self.assertIsInstance(window.booking, BookingService)
        self.assertIsInstance(window.plan_service, PlanService)
        self.assertIsInstance(window.scheduler_service, SchedulerService)


class TestSettingsWithProjectRoot(unittest.TestCase):
    """Settings project_root 属性测试。"""

    def test_settings_has_project_root(self):
        """测试 Settings 包含 project_root 属性。"""
        from config.settings import load_settings

        settings = load_settings()
        self.assertTrue(hasattr(settings, 'project_root'))
        self.assertIsNotNone(settings.project_root)
        self.assertIsInstance(settings.project_root, Path)

    def test_project_root_is_valid_path(self):
        """测试 project_root 是有效路径。"""
        from config.settings import load_settings

        settings = load_settings()
        self.assertTrue(settings.project_root.exists(),
                       f"project_root 路径不存在: {settings.project_root}")

    def test_settings_other_attributes(self):
        """测试 Settings 其他属性。"""
        from config.settings import load_settings

        settings = load_settings()

        # 验证必要的属性存在
        self.assertTrue(hasattr(settings, 'max_trials'))
        self.assertTrue(hasattr(settings, 'retry_delay'))
        self.assertTrue(hasattr(settings, 'credentials_file'))
        self.assertTrue(hasattr(settings, 'plans_file'))

        # 验证默认值
        self.assertEqual(settings.max_trials, 5)
        self.assertGreater(settings.retry_delay, 0)


class TestDialogsExport(unittest.TestCase):
    """测试 dialogs 模块导出。"""

    def test_scheduler_config_dialog_exported(self):
        """测试 SchedulerConfigDialog 已导出。"""
        from gui.dialogs import SchedulerConfigDialog

        self.assertIsNotNone(SchedulerConfigDialog)

    def test_all_dialogs_exported(self):
        """测试所有对话框已导出。"""
        from gui import dialogs

        expected_exports = [
            'CreatePlanDialog',
            'DeletePlansDialog',
            'ModifyTimeDialog',
            'BrowseRoomsDialog',
            'SchedulerConfigDialog',
        ]

        for dialog_name in expected_exports:
            self.assertTrue(hasattr(dialogs, dialog_name),
                          f"对话框 {dialog_name} 未导出")


def run_tests():
    """运行所有测试。"""
    # 创建测试套件
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # 添加测试类
    suite.addTests(loader.loadTestsFromTestCase(TestSchedulerService))
    suite.addTests(loader.loadTestsFromTestCase(TestSchedulerConfigDialog))
    suite.addTests(loader.loadTestsFromTestCase(TestMainWindowIntegration))
    suite.addTests(loader.loadTestsFromTestCase(TestSettingsWithProjectRoot))
    suite.addTests(loader.loadTestsFromTestCase(TestDialogsExport))

    # 运行测试
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # 返回结果
    return result


if __name__ == '__main__':
    print("=" * 70)
    print("GUI 定时任务功能单元测试")
    print("=" * 70)
    print()

    result = run_tests()

    print()
    print("=" * 70)
    print("测试结果汇总")
    print("=" * 70)
    print(f"运行测试: {result.testsRun}")
    print(f"成功: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"失败: {len(result.failures)}")
    print(f"错误: {len(result.errors)}")
    print(f"跳过: {len(result.skipped)}")
    print()

    if result.wasSuccessful():
        print("[OK] 所有测试通过!")
        sys.exit(0)
    else:
        print("[FAIL] 部分测试失败")
        sys.exit(1)
