"""系统调度服务与统一路径配置测试。"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class TestSchedulerService(unittest.TestCase):
    """SchedulerService 单元测试。"""

    def setUp(self):
        from config.paths import AppPaths
        from services.scheduler import SchedulerService

        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name).resolve()
        self.paths = AppPaths(root / "config", root / "data", root / "state", root / "logs")
        self.install_root = Path(__file__).resolve().parent
        self.service = SchedulerService(self.paths, self.install_root)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_init(self):
        self.assertEqual(self.service.install_root, self.install_root)
        self.assertEqual(self.service.paths, self.paths)
        self.assertIsNotNone(self.service.system)
        self.assertEqual(self.service.task_name, "HDU-Library-Sniper-Daily")

    def test_task_status_structure(self):
        from services.scheduler import TaskStatus

        status = TaskStatus(exists=False)
        self.assertFalse(status.exists)
        self.assertIsNone(status.execute_time)

        status = TaskStatus(exists=True, execute_time="23:59:55", next_run="2026-07-12 23:59:55")
        self.assertTrue(status.exists)
        self.assertEqual(status.execute_time, "23:59:55")
        self.assertEqual(status.next_run, "2026-07-12 23:59:55")

    @patch("platform.system")
    def test_platform_detection(self, mock_system):
        from services.scheduler import SchedulerService

        for platform_name in ("Windows", "Linux", "Darwin"):
            mock_system.return_value = platform_name
            service = SchedulerService(self.paths, self.install_root)
            self.assertEqual(service.system, platform_name)

    @patch("subprocess.run")
    @patch("platform.system")
    def test_get_task_status_windows_not_exists(self, mock_system, mock_run):
        from services.scheduler import SchedulerService

        mock_system.return_value = "Windows"
        mock_run.return_value = Mock(returncode=1, stdout="")

        status = SchedulerService(self.paths, self.install_root).get_task_status()
        self.assertFalse(status.exists)

    @patch("subprocess.run")
    @patch("platform.system")
    def test_get_task_status_windows_exists(self, mock_system, mock_run):
        from services.scheduler import SchedulerService

        mock_system.return_value = "Windows"
        mock_run.return_value = Mock(
            returncode=0,
            stdout="""
            Task Name: HDU-Library-Sniper-Daily
            Next Run Time: 2026-07-12 23:59:55
            Start Time: 23:59:55
            """,
        )

        status = SchedulerService(self.paths, self.install_root).get_task_status()
        self.assertTrue(status.exists)

    def test_find_pythonw_returns_optional_path(self):
        if self.service.system != "Windows":
            self.skipTest("仅适用于 Windows")

        service = self.service.__class__(self.paths, Path("/nonexistent/path"))
        result = service._find_pythonw()
        self.assertTrue(result is None or isinstance(result, Path))

    @patch("subprocess.Popen")
    @patch("subprocess.run")
    def test_linux_cron_carries_app_home(self, mock_run, mock_popen):
        mock_run.return_value = Mock(returncode=1, stdout="")
        process = Mock(returncode=0)
        process.communicate.return_value = ("", "")
        mock_popen.return_value = process
        self.service.system = "Linux"

        with patch.dict(os.environ, {"HDU_SNIPER_HOME": self.temp_dir.name}):
            success, _ = self.service._configure_linux_cron("20:00:00")

        self.assertTrue(success)
        crontab = process.communicate.call_args.kwargs["input"]
        self.assertIn("HDU_SNIPER_HOME=", crontab)
        self.assertIn(str(self.service.paths.task_log), crontab)
        self.assertIn("# HDU-Library-Sniper", crontab)


class TestSettingsPaths(unittest.TestCase):
    """Settings 使用统一绝对路径。"""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_settings_other_attributes(self):
        from config.paths import resolve_app_paths
        from config.settings import load_settings

        paths = resolve_app_paths({"HDU_SNIPER_HOME": self.temp_dir.name})
        settings = load_settings(paths, env={})

        self.assertTrue(hasattr(settings, "max_trials"))
        self.assertTrue(hasattr(settings, "retry_delay"))
        self.assertFalse(hasattr(settings, "project_root"))
        self.assertTrue(settings.paths.plans_file.is_absolute())
        self.assertTrue(settings.paths.credentials_file.is_absolute())
        self.assertEqual(settings.paths.plans_file, paths.config_dir / "plans.yaml")
        self.assertEqual(settings.max_trials, 5)
        self.assertGreater(settings.retry_delay, 0)
