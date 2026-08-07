"""系统调度服务与统一路径配置测试。"""

import base64
import os
import tempfile
import time
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import Mock, patch


class TestSchedulerService(unittest.TestCase):
    """SchedulerService 单元测试。"""

    def setUp(self):
        from hdu_sniper.paths import AppPaths
        from hdu_sniper.scheduler import SchedulerService

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
        from hdu_sniper.scheduler import TaskStatus

        status = TaskStatus(exists=False)
        self.assertFalse(status.exists)
        self.assertIsNone(status.execute_time)

        status = TaskStatus(exists=True, execute_time="23:59:55", next_run="2026-07-12 23:59:55")
        self.assertTrue(status.exists)
        self.assertEqual(status.execute_time, "23:59:55")
        self.assertEqual(status.next_run, "2026-07-12 23:59:55")

    @patch("platform.system")
    def test_platform_detection(self, mock_system):
        from hdu_sniper.scheduler import SchedulerService

        for platform_name in ("Windows", "Linux", "Darwin"):
            mock_system.return_value = platform_name
            service = SchedulerService(self.paths, self.install_root)
            self.assertEqual(service.system, platform_name)

    @patch("subprocess.run")
    @patch("platform.system")
    def test_get_task_status_windows_not_exists(self, mock_system, mock_run):
        from hdu_sniper.scheduler import SchedulerService

        mock_system.return_value = "Windows"
        mock_run.return_value = Mock(returncode=1, stdout="")

        status = SchedulerService(self.paths, self.install_root).get_task_status()
        self.assertFalse(status.exists)

    @patch("subprocess.run")
    @patch("platform.system")
    def test_get_task_status_windows_exists(self, mock_system, mock_run):
        from hdu_sniper.scheduler import SchedulerService

        mock_system.return_value = "Windows"
        mock_run.return_value = Mock(
            returncode=0,
            stdout='{"name":"HDU-Library-Sniper-Daily","next_run":"2026-07-12 23:59:55"}',
            stderr="",
        )

        status = SchedulerService(self.paths, self.install_root).get_task_status()
        self.assertTrue(status.exists)

    @patch("subprocess.run")
    @patch("platform.system")
    def test_list_windows_tasks_parses_managed_task_details(self, mock_system, mock_run):
        from hdu_sniper.scheduler import SchedulerService

        mock_system.return_value = "Windows"
        mock_run.return_value = Mock(
            returncode=0,
            stdout=(
                '[{"name":"HDU-Library-Sniper-Daily","status":"Ready",'
                '"next_run":"2026-07-26 20:00:00",'
                '"last_run":"2026-07-25 20:00:01","last_result":"0"}]'
            ),
            stderr="",
        )

        tasks = SchedulerService(self.paths, self.install_root).list_tasks()

        self.assertEqual(len(tasks), 1)
        task = tasks[0]
        self.assertEqual(task.name, "HDU-Library-Sniper-Daily")
        self.assertEqual(task.status, "Ready")
        self.assertEqual(task.next_run, "2026-07-26 20:00:00")
        self.assertEqual(task.last_run, "2026-07-25 20:00:01")
        self.assertEqual(task.last_result, "0")
        command = mock_run.call_args.args[0]
        assert command[:4] == ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
        assert "Get-ScheduledTask -TaskName 'HDU-Library-Sniper-*'" in command[-1]
        assert "Get-ScheduledTaskInfo" in command[-1]
        assert "function Format-TaskTime($value)" in command[-1]
        assert "if ($null -eq $value)" in command[-1]

    def test_checkin_tasks_ready_reflects_logon_task(self):
        from hdu_sniper.scheduler import CHECKIN_LOGON_TASK, ScheduledTask

        self.service.list_tasks = Mock(return_value=[ScheduledTask(name=CHECKIN_LOGON_TASK)])
        self.assertTrue(self.service.checkin_tasks_ready())

        self.service.list_tasks = Mock(
            return_value=[ScheduledTask(name="HDU-Library-Sniper-Daily")]
        )
        self.assertFalse(self.service.checkin_tasks_ready())

        self.service.list_tasks = Mock(side_effect=RuntimeError("denied"))
        self.assertFalse(self.service.checkin_tasks_ready())

    @patch("subprocess.run")
    def test_list_windows_tasks_surfaces_scheduler_access_errors(self, mock_run):
        self.service.system = "Windows"
        mock_run.return_value = Mock(
            returncode=1,
            stdout="",
            stderr="ERROR: Access is denied.",
        )

        with self.assertRaisesRegex(RuntimeError, "Access is denied"):
            self.service.list_tasks()

    @patch("subprocess.run")
    def test_list_windows_tasks_treats_scheduledtasks_not_found_as_empty(self, mock_run):
        self.service.system = "Windows"
        mock_run.return_value = Mock(
            returncode=0,
            stdout="[]",
            stderr="",
        )

        self.assertEqual(self.service.list_tasks(), [])

    @patch("subprocess.run")
    def test_run_and_delete_only_allow_managed_windows_task(self, mock_run):
        self.service.system = "Windows"
        mock_run.return_value = Mock(returncode=0, stdout="", stderr="")

        self.assertEqual(
            self.service.run_task("HDU-Library-Sniper-Daily"),
            (True, "已请求任务计划程序立即运行 HDU-Library-Sniper-Daily"),
        )
        command = mock_run.call_args.args[0]
        assert command[:4] == ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
        assert "Start-ScheduledTask -TaskName 'HDU-Library-Sniper-Daily'" in command[-1]

        mock_run.reset_mock()
        self.assertEqual(
            self.service.delete_task("HDU-Library-Sniper-Daily"),
            (True, "已删除调度任务 HDU-Library-Sniper-Daily"),
        )
        command = mock_run.call_args.args[0]
        assert command[:4] == ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
        assert "Unregister-ScheduledTask" in command[-1]
        assert "-TaskName 'HDU-Library-Sniper-Daily'" in command[-1]

        with self.assertRaises(ValueError):
            self.service.run_task("Unrelated-System-Task")

    @patch("subprocess.run")
    def test_windows_configuration_falls_back_to_schtasks_after_access_denied(self, mock_run):
        from hdu_sniper.scheduler import SchedulerService

        service = SchedulerService(self.paths, Path(__file__).resolve().parents[1])
        service.system = "Windows"
        service._task_name_occupied_inaccessible = Mock(return_value=False)
        mock_run.side_effect = [
            Mock(returncode=1, stdout="", stderr="Register-ScheduledTask : Access is denied."),
            Mock(returncode=0, stdout="SUCCESS", stderr=""),
        ]

        fake_ctypes = Mock()
        fake_ctypes.windll.advapi32.GetUserNameW.return_value = False
        with (
            patch.dict(os.environ, {"USERNAME": "student", "USERDOMAIN": "HDU"}),
            patch("hdu_sniper.scheduler.ctypes", fake_ctypes),
        ):
            success, message = service._configure_windows_task("20:00:00", wake_to_run=True)

        self.assertTrue(success)
        self.assertIn("schtasks", message)
        fallback_command = mock_run.call_args_list[1].args[0]
        self.assertEqual(fallback_command[0], "schtasks.exe")
        self.assertIn("/TR", fallback_command)
        self.assertEqual(fallback_command[fallback_command.index("/RU") + 1], "HDU\\student")
        self.assertEqual(fallback_command[fallback_command.index("/RL") + 1], "LIMITED")
        self.assertIn("/IT", fallback_command)

    @patch("subprocess.run")
    def test_windows_configuration_falls_back_for_common_permission_errors(self, mock_run):
        from hdu_sniper.scheduler import SchedulerService

        service = SchedulerService(self.paths, Path(__file__).resolve().parents[1])
        service.system = "Windows"
        service._task_name_occupied_inaccessible = Mock(return_value=False)
        mock_run.side_effect = [
            Mock(returncode=1, stdout="", stderr="0x80070005: permission denied"),
            Mock(returncode=0, stdout="SUCCESS", stderr=""),
        ]

        fake_ctypes = Mock()
        fake_ctypes.windll.advapi32.GetUserNameW.return_value = False
        with (
            patch.dict(os.environ, {"USERNAME": "student", "USERDOMAIN": ""}),
            patch("hdu_sniper.scheduler.ctypes", fake_ctypes),
        ):
            success, _ = service._configure_windows_task("20:00:00", wake_to_run=True)

        self.assertTrue(success)
        fallback_command = mock_run.call_args_list[1].args[0]
        self.assertEqual(fallback_command[fallback_command.index("/RU") + 1], "student")

    @patch("subprocess.run")
    def test_windows_configuration_repairs_blocking_task_when_allowed(self, mock_run):
        from hdu_sniper.scheduler import SchedulerService

        service = SchedulerService(self.paths, Path(__file__).resolve().parents[1])
        service.system = "Windows"
        service._task_name_occupied_inaccessible = Mock(return_value=True)
        service._delete_windows_task_elevated = Mock(return_value=(True, "已删除"))
        mock_run.side_effect = [
            Mock(returncode=1, stdout="", stderr="Register-ScheduledTask : Access is denied."),
            Mock(returncode=0, stdout="", stderr=""),
        ]

        success, message = service._configure_windows_task(
            "20:00:00", wake_to_run=True, allow_elevated_repair=True
        )

        self.assertTrue(success)
        service._delete_windows_task_elevated.assert_called_once_with("HDU-Library-Sniper-Daily")
        self.assertIn("已自动清理", message)
        self.assertEqual(mock_run.call_count, 2)

    @patch("subprocess.run")
    def test_windows_configuration_blocker_requires_repair_button(self, mock_run):
        from hdu_sniper.scheduler import SchedulerService

        service = SchedulerService(self.paths, Path(__file__).resolve().parents[1])
        service.system = "Windows"
        service._task_name_occupied_inaccessible = Mock(return_value=True)
        mock_run.return_value = Mock(returncode=1, stdout="", stderr="拒绝访问")

        success, message = service._configure_windows_task("20:00:00", wake_to_run=True)

        self.assertFalse(success)
        self.assertIn("检查并修复", message)
        mock_run.assert_called_once()

    @patch("subprocess.run")
    def test_task_name_occupied_inaccessible_detects_access_denied(self, mock_run):
        self.service.system = "Windows"
        mock_run.return_value = Mock(returncode=1, stdout="", stderr="ERROR: Access is denied.")

        self.assertTrue(self.service._task_name_occupied_inaccessible("HDU-Library-Sniper-Daily"))
        command = mock_run.call_args.args[0]
        self.assertEqual(command[:3], ["schtasks.exe", "/Query", "/TN"])

    @patch("subprocess.run")
    def test_task_name_occupied_inaccessible_false_when_missing(self, mock_run):
        self.service.system = "Windows"
        mock_run.return_value = Mock(
            returncode=1,
            stdout="",
            stderr="ERROR: The system cannot find the file specified.",
        )

        self.assertFalse(self.service._task_name_occupied_inaccessible("HDU-Library-Sniper-Daily"))

    @patch("hdu_sniper.scheduler.SchedulerService._run_elevated_hidden")
    def test_delete_windows_task_elevated_success(self, mock_elevated):
        self.service.system = "Windows"
        mock_elevated.return_value = (0, "")

        success, _ = self.service._delete_windows_task_elevated("HDU-Library-Sniper-Daily")

        self.assertTrue(success)
        command = mock_elevated.call_args.args[0]
        marker = "-EncodedCommand"
        encoded = command[command.index(marker) + 1]
        inner = base64.b64decode(encoded).decode("utf-16-le")
        self.assertIn("schtasks.exe /Delete /TN 'HDU-Library-Sniper-Daily' /F", inner)

    @patch("hdu_sniper.scheduler.SchedulerService._run_elevated_hidden")
    def test_delete_windows_task_elevated_cancel(self, mock_elevated):
        self.service.system = "Windows"
        mock_elevated.return_value = (1223, "已取消管理员授权")

        success, message = self.service._delete_windows_task_elevated("HDU-Library-Sniper-Daily")

        self.assertFalse(success)
        self.assertIn("授权", message)

    @patch("subprocess.run")
    def test_windows_configuration_uses_oem_output_encoding(self, mock_run):
        from hdu_sniper.scheduler import SchedulerService, _windows_output_encoding

        service = SchedulerService(self.paths, Path(__file__).resolve().parents[1])
        service.system = "Windows"
        mock_run.return_value = Mock(returncode=0, stdout="", stderr="")

        service._configure_windows_task("20:00:00", wake_to_run=True)

        self.assertEqual(mock_run.call_args.kwargs["encoding"], _windows_output_encoding())

    @patch("subprocess.run")
    def test_windows_configuration_passes_date_plan_days(self, mock_run):
        from hdu_sniper.scheduler import SchedulerService

        service = SchedulerService(self.paths, Path(__file__).resolve().parents[1])
        service.system = "Windows"
        service._task_name_occupied_inaccessible = Mock(return_value=False)
        mock_run.return_value = Mock(returncode=0, stdout="", stderr="")

        success, _message = service._configure_windows_task(
            "20:00:00",
            wake_to_run=True,
            weekdays=frozenset({1, 3, 5}),
        )

        self.assertTrue(success)
        self.assertEqual(
            mock_run.call_args.kwargs["env"]["SNIPER_DAYS_OF_WEEK"],
            "Monday,Wednesday,Friday",
        )

    def test_windows_output_encoding_is_registered_codec(self):
        import codecs

        from hdu_sniper.scheduler import _windows_output_encoding

        encoding = _windows_output_encoding()
        self.assertTrue(encoding)
        codecs.lookup(encoding)

    def test_windows_user_task_requires_current_username(self):
        fake_ctypes = Mock()
        fake_ctypes.windll.advapi32.GetUserNameW.return_value = False
        with (
            patch.dict(os.environ, {"USERNAME": "", "USERDOMAIN": ""}),
            patch("hdu_sniper.scheduler.ctypes", fake_ctypes),
        ):
            self.assertIsNone(self.service._current_windows_user())

    def test_windows_user_task_prefers_token_identity(self):
        buffer = Mock()
        buffer.value = "tokenuser"
        fake_ctypes = Mock()
        fake_ctypes.create_unicode_buffer.return_value = buffer
        fake_ctypes.windll.advapi32.GetUserNameW.return_value = True
        with (
            patch.dict(os.environ, {"USERNAME": "envuser", "USERDOMAIN": "HDU"}),
            patch("hdu_sniper.scheduler.ctypes", fake_ctypes),
        ):
            self.assertEqual(self.service._current_windows_user(), "tokenuser")

    def test_auto_schedule_script_falls_back_to_unelevated_current_user_task(self):
        script = (
            Path(__file__).resolve().parents[1] / "scripts" / "Register-AutoSchedule.ps1"
        ).read_text(encoding="utf-8")

        # 时间先独立校验，避免把任务计划程序的真实错误误报为时间格式无效。
        self.assertIn("[datetime]::TryParse", script)
        self.assertIn("New-ScheduledTaskTrigger -Daily -At $ParsedDailyAt", script)
        self.assertIn(
            "New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DaysOfWeek -At $ParsedDailyAt",
            script,
        )
        # 注册失败统一由应用侧用短启动脚本回退，脚本内不再拼长 /TR 命令行。
        self.assertNotIn('"/RU", $CurrentUserId', script)
        self.assertNotIn("& schtasks.exe", script)
        self.assertNotIn("SchtasksArguments", script)
        self.assertNotIn('"SYSTEM"', script)

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

    def test_plan_checkin_tasks_filters_pending_future_bookings(self):
        from hdu_sniper.scheduler import CHECKIN_WINDOW_PREFIX

        future = int(time.time()) + 7200
        now = int(time.time())
        bookings = [
            {"id": "1", "status": "0", "time": str(future), "limitSignAgo": 1800},
            {"id": "2", "status": "1", "time": str(future), "limitSignAgo": 1800},
            {"id": "3", "status": "0", "time": str(now), "limitSignAgo": 1800},
            {"id": "4", "status": "0", "time": str(future), "limitSignAgo": 10000},
            {"id": "5", "status": "0", "time": "not-a-time", "limitSignAgo": 1800},
        ]

        planned = self.service._plan_checkin_tasks(bookings)

        self.assertEqual([name for name, _start in planned], [f"{CHECKIN_WINDOW_PREFIX}1"])
        task_name, start_str = planned[0]
        expected_start = (
            datetime.fromtimestamp(future - 1800 + 60, tz=UTC)
            .astimezone()
            .strftime("%Y-%m-%d %H:%M:%S")
        )
        self.assertEqual(start_str, expected_start)

    def test_sync_checkin_tasks_disabled_removes_tasks(self):
        self.service.remove_checkin_tasks = Mock(return_value=(True, "removed"))

        ok, message = self.service.sync_checkin_tasks([], enabled=False)

        self.assertTrue(ok)
        self.assertEqual(message, "removed")
        self.service.remove_checkin_tasks.assert_called_once_with()

    def test_sync_windows_checkin_tasks_registers_and_cleans_stale(self):
        from hdu_sniper.scheduler import CHECKIN_LOGON_TASK, CHECKIN_WINDOW_PREFIX

        self.service.system = "Windows"
        future = int(time.time()) + 7200
        self.service._existing_checkin_task_names = Mock(
            return_value=[f"{CHECKIN_WINDOW_PREFIX}stale"]
        )
        self.service._register_windows_checkin_task = Mock(return_value=(True, "ok"))
        self.service._delete_windows_task = Mock(return_value=(True, "deleted"))
        bookings = [{"id": "10", "status": "0", "time": str(future), "limitSignAgo": 1800}]

        ok, _message = self.service.sync_checkin_tasks(bookings, enabled=True)

        self.assertTrue(ok)
        registered = [
            call.args[0] for call in self.service._register_windows_checkin_task.call_args_list
        ]
        self.assertIn(CHECKIN_LOGON_TASK, registered)
        self.assertIn(f"{CHECKIN_WINDOW_PREFIX}10", registered)
        self.service._delete_windows_task.assert_called_once_with(f"{CHECKIN_WINDOW_PREFIX}stale")

    def test_sync_windows_checkin_tasks_uses_date_plan(self):
        from hdu_sniper.booking.models import BookingPlan
        from hdu_sniper.scheduler import CHECKIN_LOGON_TASK, CHECKIN_WINDOW_PREFIX

        self.service.system = "Windows"
        self.service._existing_checkin_task_names = Mock(return_value=[])
        self.service._register_windows_checkin_task = Mock(return_value=(True, "ok"))
        self.service._delete_windows_task = Mock(return_value=(True, "deleted"))
        plans = [BookingPlan(1, 100, "A001", 8, 4, plan_id="p1")]

        ok, _message = self.service.sync_checkin_tasks(
            [],
            enabled=True,
            plans=plans,
            weekdays=frozenset({1, 3, 5}),
        )

        self.assertTrue(ok)
        calls = self.service._register_windows_checkin_task.call_args_list
        self.assertEqual(calls[0].args[0], CHECKIN_LOGON_TASK)
        weekly_calls = [call for call in calls if call.kwargs["trigger"] == "Weekly"]
        self.assertEqual(len(weekly_calls), 3)
        self.assertTrue(
            all(call.args[0].startswith(CHECKIN_WINDOW_PREFIX) for call in weekly_calls)
        )
        self.assertTrue(
            all("weekday" in call.kwargs and "time_str" in call.kwargs for call in weekly_calls)
        )
        self.service._delete_windows_task.assert_not_called()

    def test_windows_checkin_logon_trigger_limits_to_current_user(self):
        from hdu_sniper.scheduler import CHECKIN_LOGON_TASK

        self.service.system = "Windows"
        self.service._write_checkin_runner = Mock(return_value=Path("C:/runner.ps1"))
        self.service._current_windows_user = Mock(return_value="DESKTOP-X\\zhuhe")
        result = Mock(returncode=0, stdout="", stderr="")
        self.service._run_windows_powershell = Mock(return_value=result)

        ok, _message = self.service._register_windows_checkin_task(
            CHECKIN_LOGON_TASK,
            trigger="Logon",
            wait=False,
        )

        self.assertTrue(ok)
        script = self.service._run_windows_powershell.call_args.args[0]
        self.assertIn("New-ScheduledTaskTrigger -AtLogOn -User 'DESKTOP-X\\zhuhe'", script)

    def test_windows_checkin_weekly_trigger_uses_date_plan_day(self):
        from hdu_sniper.scheduler import CHECKIN_WINDOW_PREFIX

        self.service.system = "Windows"
        self.service._write_checkin_runner = Mock(return_value=Path("C:/runner.ps1"))
        self.service._current_windows_user = Mock(return_value="DESKTOP-X\\zhuhe")
        result = Mock(returncode=0, stdout="", stderr="")
        self.service._run_windows_powershell = Mock(return_value=result)

        ok, _message = self.service._register_windows_checkin_task(
            f"{CHECKIN_WINDOW_PREFIX}1-0731",
            trigger="Weekly",
            weekday=1,
            time_str="07:31",
            wait=True,
        )

        self.assertTrue(ok)
        script = self.service._run_windows_powershell.call_args.args[0]
        self.assertIn(
            "New-ScheduledTaskTrigger -Weekly -DaysOfWeek 'Monday' "
            "-At ([datetime]::Parse('07:31'))",
            script,
        )

    def test_require_managed_task_allows_checkin_tasks(self):
        from hdu_sniper.scheduler import CHECKIN_LOGON_TASK, CHECKIN_WINDOW_PREFIX

        self.service._require_managed_task("HDU-Library-Sniper-Daily")
        self.service._require_managed_task(CHECKIN_LOGON_TASK)
        self.service._require_managed_task(f"{CHECKIN_WINDOW_PREFIX}123")

        with self.assertRaises(ValueError):
            self.service._require_managed_task("Unrelated-System-Task")

    def test_remove_windows_checkin_tasks_deletes_logon_and_window_tasks(self):
        from hdu_sniper.scheduler import (
            CHECKIN_LOGON_TASK,
            CHECKIN_WINDOW_PREFIX,
        )

        self.service.system = "Windows"
        self.service._existing_checkin_task_names = Mock(return_value=[f"{CHECKIN_WINDOW_PREFIX}9"])
        self.service._delete_windows_task = Mock(return_value=(True, "deleted"))

        ok, _message = self.service.remove_checkin_tasks()

        self.assertTrue(ok)
        calls = [call.args[0] for call in self.service._delete_windows_task.call_args_list]
        self.assertEqual(calls, [CHECKIN_LOGON_TASK, f"{CHECKIN_WINDOW_PREFIX}9"])

    @patch("subprocess.Popen")
    @patch("subprocess.run")
    def test_posix_checkin_cron_configure_and_remove(self, mock_run, mock_popen):
        self.service.system = "Linux"
        mock_run.return_value = Mock(returncode=1, stdout="")
        process = Mock(returncode=0)
        process.communicate.return_value = ("", "")
        mock_popen.return_value = process

        ok, _message = self.service._configure_posix_checkin_cron()

        self.assertTrue(ok)
        crontab = process.communicate.call_args.kwargs["input"]
        self.assertIn("@reboot", crontab)
        self.assertIn("--checkin-run", crontab)
        self.assertIn("# HDU-Library-Sniper-CheckIn", crontab)

        mock_run.return_value = Mock(
            returncode=0,
            stdout=process.communicate.call_args.kwargs["input"],
        )
        process.communicate.reset_mock()
        process.communicate.return_value = ("", "")
        ok, _message = self.service._remove_posix_checkin_cron()

        self.assertTrue(ok)
        removed_crontab = process.communicate.call_args.kwargs["input"]
        self.assertNotIn("# HDU-Library-Sniper-CheckIn", removed_crontab)

    @patch("subprocess.Popen")
    @patch("subprocess.run")
    def test_posix_checkin_weekly_cron(self, mock_run, mock_popen):
        from hdu_sniper.scheduler import CHECKIN_WINDOW_PREFIX

        self.service.system = "Linux"
        mock_run.return_value = Mock(returncode=1, stdout="")
        process = Mock(returncode=0)
        process.communicate.return_value = ("", "")
        mock_popen.return_value = process

        ok, _message = self.service._schedule_posix_checkin_weekly(
            f"{CHECKIN_WINDOW_PREFIX}1-0731",
            1,
            "07:31",
        )

        self.assertTrue(ok)
        crontab = process.communicate.call_args.kwargs["input"]
        self.assertIn("31 07 * * 1", crontab)
        self.assertIn("--checkin-wait", crontab)


class TestSettingsPaths(unittest.TestCase):
    """Settings 使用统一绝对路径。"""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_settings_other_attributes(self):
        from hdu_sniper.config import load_settings
        from hdu_sniper.paths import resolve_app_paths

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
