"""定时任务管理服务。"""

from __future__ import annotations

import base64
import ctypes
import json
import locale
import os
import platform
import shlex
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from hdu_sniper.library import responses
from hdu_sniper.paths import APP_HOME_ENV, AppPaths


TASK_MARKER = "HDU-Library-Sniper"
DAILY_RUN_TIME = "20:00:00"
CHECKIN_LOGON_TASK = "HDU-Library-Sniper-CheckIn-Logon"
CHECKIN_WINDOW_PREFIX = "HDU-Library-Sniper-CheckIn-"
CHECKIN_MARKER = "HDU-Library-Sniper-CheckIn"
CHECKIN_START_OFFSET_SECONDS = 60
CHECKIN_DEFAULT_SIGN_AGO = 1800
WINDOWS_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _windows_output_encoding() -> str:
    """返回 Windows 控制台程序实际使用的 OEM 代码页。

    ``powershell.exe`` / ``schtasks.exe`` 在中文系统上默认以 GBK(OEM 936)
    输出错误信息；若一律按 UTF-8 解码，错误文本会变成乱码并干扰权限判断。
    非 Windows 平台仍使用 UTF-8。
    """
    if os.name == "nt":
        try:
            code_page = ctypes.windll.kernel32.GetOEMCP()
            return f"cp{code_page}"
        except Exception:
            pass
        try:
            encoding = locale.getpreferredencoding(False)
            if encoding:
                return encoding
        except Exception:
            pass
    return "utf-8"


@dataclass
class TaskStatus:
    """定时任务状态。"""

    exists: bool
    execute_time: str | None = None
    wake_to_run: bool | None = None
    next_run: str | None = None


@dataclass(frozen=True)
class ScheduledTask:
    """可在调度管理页面展示的应用托管任务。"""

    name: str
    status: str | None = None
    next_run: str | None = None
    last_run: str | None = None
    last_result: str | None = None


class SchedulerService:
    """定时任务管理服务。"""

    def __init__(self, paths: AppPaths, install_root: Path | None = None):
        self.paths = paths
        if install_root is not None:
            self.install_root = install_root
            self.resource_root = install_root
        elif getattr(sys, "frozen", False):
            self.install_root = Path(sys.executable).resolve().parent
            self.resource_root = Path(getattr(sys, "_MEIPASS", self.install_root))
        else:
            self.install_root = Path(__file__).resolve().parents[2]
            self.resource_root = self.install_root
        self.system = platform.system()
        self.task_name = "HDU-Library-Sniper-Daily"

    @property
    def managed_task_names(self) -> tuple[str, ...]:
        """返回可由本应用安全读取和操作的系统任务名称。"""
        return (self.task_name,)

    def _launcher_command(self, *, background: bool = False) -> list[str]:
        """返回当前安装形态下可再次启动本程序的命令。"""
        if getattr(sys, "frozen", False):
            return [sys.executable]

        executable = Path(sys.executable)
        if background and self.system == "Windows":
            executable = self._find_pythonw() or executable
        return [str(executable), "-m", "hdu_sniper"]

    def configure_task(
        self, wake_to_run: bool = True, *, allow_elevated_repair: bool = False
    ) -> tuple[bool, str]:
        """配置固定为每天 20:00 的系统任务。"""
        if self.system == "Windows":
            return self._configure_windows_task(DAILY_RUN_TIME, wake_to_run, allow_elevated_repair)
        if self.system == "Linux" or self.system == "Darwin":
            return self._configure_linux_cron(DAILY_RUN_TIME)
        return False, f"不支持的操作系统: {self.system}"

    def remove_task(self) -> tuple[bool, str]:
        """移除定时任务。

        Returns:
            (成功?, 消息)
        """
        if self.system == "Windows":
            return self._remove_windows_task()
        if self.system in ("Linux", "Darwin"):
            return self._remove_linux_cron()
        return False, f"不支持的操作系统: {self.system}"

    def sync_checkin_tasks(
        self,
        bookings: list[dict],
        *,
        enabled: bool = True,
    ) -> tuple[bool, str]:
        """按当前预约同步自动签到系统任务。

        启用时创建“登录触发”兜底任务，并为每个仍待签到且窗口尚未开启的
        预约创建一个窗口开启时执行的一次性任务；同时清理已过期的窗口任务。
        关闭时移除全部自动签到任务。
        """
        if not enabled:
            return self.remove_checkin_tasks()
        if self.system == "Windows":
            return self._sync_windows_checkin_tasks(bookings)
        if self.system in ("Linux", "Darwin"):
            return self._sync_posix_checkin_tasks(bookings)
        return False, f"不支持的操作系统: {self.system}"

    def remove_checkin_tasks(self) -> tuple[bool, str]:
        """移除全部由本应用创建的自动签到系统任务。"""
        if self.system == "Windows":
            return self._remove_windows_checkin_tasks()
        if self.system in ("Linux", "Darwin"):
            return self._remove_posix_checkin_cron()
        return False, f"不支持的操作系统: {self.system}"

    def get_task_status(self) -> TaskStatus:
        """获取定时任务状态。

        Returns:
            任务状态
        """
        if self.system == "Windows":
            task = self._read_windows_task(self.task_name)
            if task is None:
                return TaskStatus(exists=False)
            return TaskStatus(exists=True, next_run=task.next_run)
        if self.system in ("Linux", "Darwin"):
            return self._get_linux_cron_status()
        return TaskStatus(exists=False)

    def list_tasks(self) -> list[ScheduledTask]:
        """读取由本应用创建的调度任务，而不暴露其他系统任务。"""
        if self.system == "Windows":
            return self._list_windows_tasks()
        if self.system in ("Linux", "Darwin"):
            tasks: list[ScheduledTask] = []
            status = self._get_linux_cron_status()
            if status.exists:
                tasks.append(ScheduledTask(name=self.task_name, next_run=status.next_run))
            try:
                result = subprocess.run(
                    ["crontab", "-l"],
                    capture_output=True,
                    text=True,
                )
                crontab = result.stdout if result.returncode == 0 else ""
            except Exception:
                crontab = ""
            if CHECKIN_MARKER in crontab:
                tasks.append(ScheduledTask(name=CHECKIN_LOGON_TASK, next_run="登录触发"))
            return tasks
        return []

    def checkin_tasks_ready(self) -> bool:
        """确认自动签到的登录触发任务已注册。"""
        try:
            tasks = self.list_tasks()
        except RuntimeError:
            return False
        return any(task.name == CHECKIN_LOGON_TASK for task in tasks)

    def run_task(self, task_name: str) -> tuple[bool, str]:
        """请求 Windows 任务计划程序立即运行一个应用托管任务。"""
        self._require_managed_task(task_name)
        if self.system != "Windows":
            return False, f"立即运行仅支持 Windows 任务计划程序: {self.system}"

        try:
            result = self._run_windows_powershell(
                f"Start-ScheduledTask -TaskName {self._powershell_quote(task_name)}"
            )
        except Exception as exc:
            return False, f"请求运行任务时出错: {exc}"

        if result.returncode == 0:
            return True, f"已请求任务计划程序立即运行 {task_name}"
        return False, f"请求运行失败:\n{self._command_error(result)}"

    def delete_task(self, task_name: str) -> tuple[bool, str]:
        """删除一个应用托管的 Windows 任务计划程序任务。"""
        self._require_managed_task(task_name)
        if self.system == "Windows":
            return self._delete_windows_task(task_name)
        if self.system in ("Linux", "Darwin"):
            return self._remove_linux_cron()
        return False, f"不支持的操作系统: {self.system}"

    def test_execution(self) -> tuple[bool, str]:
        """测试执行一次后台任务。

        Returns:
            (成功?, 输出/错误消息)
        """
        # 执行测试
        try:
            result = subprocess.run(
                [*self._launcher_command(), "--daemon"],
                cwd=str(self.install_root),
                capture_output=True,
                text=True,
                timeout=60,
                encoding=_windows_output_encoding(),
                errors="replace",
                creationflags=WINDOWS_NO_WINDOW,
            )

            exit_code = result.returncode
            output = result.stdout + result.stderr

            if exit_code == 0:
                return True, f"执行成功！\n\n{output}"
            if exit_code == 2:
                return False, f"认证失败（退出码 2）\n\n{output}"
            if exit_code == 3:
                return False, f"没有启用的方案（退出码 3）\n\n{output}"
            return False, f"执行失败（退出码 {exit_code}）\n\n{output}"
        except subprocess.TimeoutExpired:
            return False, "执行超时（>60秒），请检查是否存在死循环或网络问题"
        except Exception as e:
            return False, f"执行出错: {e}"

    # Windows 实现

    def _configure_windows_task(
        self,
        execute_time: str,
        wake_to_run: bool,
        allow_elevated_repair: bool = False,
    ) -> tuple[bool, str]:
        """使用 Register-AutoSchedule.ps1 配置 Windows 任务。"""
        ps_script = self.resource_root / "scripts" / "Register-AutoSchedule.ps1"
        if not ps_script.exists():
            return False, f"未找到 Register-AutoSchedule.ps1: {ps_script}"

        # 设置环境变量
        env = os.environ.copy()
        env["SNIPER_WORKDIR"] = str(self.install_root)
        env["SNIPER_TASK_LOG"] = str(self.paths.task_log)
        env["PYTHON_EXE"] = self._launcher_command()[0]
        env["SNIPER_DAILY_AT"] = execute_time
        env["SNIPER_TASK_NAME"] = self.task_name
        env["SNIPER_WAKE_TO_RUN"] = "1" if wake_to_run else "0"
        env["SNIPER_FROZEN"] = "1" if getattr(sys, "frozen", False) else "0"

        def run_script() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", str(ps_script)],
                cwd=str(self.install_root),
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
                encoding=_windows_output_encoding(),
                errors="replace",
                creationflags=WINDOWS_NO_WINDOW,
            )

        # 执行 PowerShell 脚本
        try:
            result = run_script()
            if result.returncode == 0:
                return True, f"定时任务配置成功！\n每天 {execute_time} 自动执行"

            error = self._command_error(result)
            if not self._is_windows_task_access_denied(error):
                return False, f"配置失败:\n{error}"

            # 同名任务被其他身份占用（当前用户无权访问）时，普通创建和 schtasks
            # 回退都会因 ACL 被拒；修复入口允许先提权清理占坑任务再重试。
            if self._task_name_occupied_inaccessible(self.task_name):
                if not allow_elevated_repair:
                    return (
                        False,
                        "检测到同名旧任务被其他身份占用且当前用户无权访问，"
                        "请点击“检查并修复”自动清理后重试。",
                    )
                removed, remove_message = self._delete_windows_task_elevated(self.task_name)
                if not removed:
                    return False, remove_message

                retry = run_script()
                if retry.returncode == 0:
                    return (
                        True,
                        f"定时任务配置成功！\n每天 {execute_time} 自动执行\n"
                        "已自动清理占用的同名旧任务并重新创建。",
                    )
                retry_error = self._command_error(retry)
                return False, f"已清理占用的旧任务，但重新创建失败:\n{retry_error}"

            # 通用权限拒绝（没有同名占坑任务）时保留 schtasks 当前用户兼容回退
            return self._configure_windows_task_with_schtasks(execute_time)
        except subprocess.TimeoutExpired:
            return False, "PowerShell 脚本执行超时"
        except Exception as e:
            return False, f"执行 PowerShell 脚本出错: {e}"

    def _task_name_occupied_inaccessible(self, task_name: str) -> bool:
        """检测任务名是否被当前用户无法读取/管理的既有任务占用。"""
        try:
            result = subprocess.run(
                ["schtasks.exe", "/Query", "/TN", task_name],
                capture_output=True,
                text=True,
                timeout=15,
                encoding=_windows_output_encoding(),
                errors="replace",
                creationflags=WINDOWS_NO_WINDOW,
            )
        except (subprocess.TimeoutExpired, OSError):
            return False
        if result.returncode == 0:
            return False
        return self._is_windows_task_access_denied(self._command_error(result))

    def _delete_windows_task_elevated(self, task_name: str) -> tuple[bool, str]:
        """通过 UAC 提权删除当前用户无法访问的同名旧任务。"""
        out_fd, out_path = tempfile.mkstemp(prefix="hdu-sniper-del-", suffix=".log")
        os.close(out_fd)
        try:
            inner = (
                f"schtasks.exe /Delete /TN {self._powershell_quote(task_name)} /F "
                f"*> {self._powershell_quote(out_path)}; exit $LASTEXITCODE"
            )
            encoded = base64.b64encode(inner.encode("utf-16-le")).decode("ascii")
            outer = (
                "$ErrorActionPreference = 'Stop'; "
                "try { "
                "$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru "
                "-WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive',"
                "'-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand','"
                + encoded
                + "'); exit $p.ExitCode "
                "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1223 }"
            )
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", outer],
                capture_output=True,
                text=True,
                timeout=120,
                encoding=_windows_output_encoding(),
                errors="replace",
                creationflags=WINDOWS_NO_WINDOW,
            )
            details = ""
            try:
                details = (
                    Path(out_path)
                    .read_text(encoding=_windows_output_encoding(), errors="replace")
                    .strip()
                )
            except OSError:
                pass
            if result.returncode == 0 or self._task_is_missing(details):
                return True, "已通过管理员授权删除占用的旧任务"
            if result.returncode == 1223:
                return (
                    False,
                    "已取消管理员授权，未删除占用的旧任务；请再次点击“检查并修复”并允许授权",
                )
            return False, f"提权删除旧任务失败:\n{details or self._command_error(result)}"
        except subprocess.TimeoutExpired:
            return False, "等待管理员授权超时，未删除占用的旧任务"
        except Exception as exc:
            return False, f"提权删除旧任务时出错: {exc}"
        finally:
            try:
                Path(out_path).unlink(missing_ok=True)
            except OSError:
                pass

    def _configure_windows_task_with_schtasks(self, execute_time: str) -> tuple[bool, str]:
        """在 ScheduledTasks 模块被拒绝时，用 schtasks 创建当前用户交互任务。"""
        current_user = self._current_windows_user()
        if not current_user:
            return False, "无法确定当前 Windows 用户，不能创建非管理员调度任务"

        runner_path = self._write_windows_task_runner()
        command = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(runner_path),
        ]

        try:
            result = subprocess.run(
                [
                    "schtasks.exe",
                    "/Create",
                    "/TN",
                    self.task_name,
                    "/TR",
                    subprocess.list2cmdline(command),
                    "/SC",
                    "DAILY",
                    "/ST",
                    execute_time[:5],
                    "/RU",
                    current_user,
                    "/RL",
                    "LIMITED",
                    "/IT",
                    "/F",
                ],
                cwd=str(self.install_root),
                capture_output=True,
                text=True,
                timeout=30,
                encoding=_windows_output_encoding(),
                errors="replace",
                creationflags=WINDOWS_NO_WINDOW,
            )
        except subprocess.TimeoutExpired:
            return False, "schtasks 创建任务超时"
        except Exception as exc:
            return False, f"调用 schtasks 创建任务时出错: {exc}"

        if result.returncode == 0:
            return (
                True,
                f"定时任务配置成功！\n每天 {execute_time} 自动执行\n"
                f"当前环境使用 schtasks 当前用户兼容模式；已创建仅限 {current_user} "
                "登录时运行的任务，睡眠唤醒不可用。",
            )
        return False, f"schtasks 创建任务失败:\n{self._command_error(result)}"

    def _write_windows_task_runner(
        self,
        launch_args: list[str] | None = None,
        runner_name: str = "hdu-sniper-task.ps1",
    ) -> Path:
        """写入 schtasks 兼容回退使用的短启动脚本。"""
        runner_path = self.paths.state_dir / runner_name
        runner_path.parent.mkdir(parents=True, exist_ok=True)
        task_log = self._powershell_quote(str(self.paths.task_log))
        lines = [
            "$ErrorActionPreference = 'Stop'",
            f"$logFile = {task_log}",
            "$logDir = Split-Path -Parent -Path $logFile",
            "if (-not (Test-Path -LiteralPath $logDir)) {",
            "    New-Item -ItemType Directory -Path $logDir -Force | Out-Null",
            "}",
            f"Set-Location -LiteralPath {self._powershell_quote(str(self.install_root))}",
        ]
        app_home = os.environ.get(APP_HOME_ENV, "").strip()
        if app_home:
            lines.append(f"$env:{APP_HOME_ENV} = {self._powershell_quote(app_home)}")

        launcher = self._powershell_quote(self._launcher_command()[0])
        if launch_args is None:
            launch_args = ["--run-now"] if getattr(sys, "frozen", False) else ["-m", "hdu_sniper", "--run-now"]
        lines.append(f"& {launcher} {subprocess.list2cmdline(launch_args)} *>> $logFile")
        lines.append("exit $LASTEXITCODE")
        runner_path.write_text("\n".join(lines) + "\n", encoding="utf-8-sig")
        return runner_path

    def _windows_task_runner_path(self) -> Path:
        return self.paths.state_dir / "hdu-sniper-task.ps1"

    def _remove_windows_task_runner(self) -> None:
        try:
            self._windows_task_runner_path().unlink(missing_ok=True)
        except OSError:
            pass

    def _plan_checkin_tasks(self, bookings: list[dict]) -> list[tuple[str, str]]:
        """从预约列表筛选需要创建窗口任务的预约，返回 (任务名, 本地开始时间)。"""
        planned: list[tuple[str, str]] = []
        now_ts = time.time()
        for item in bookings or []:
            if not isinstance(item, dict):
                continue
            try:
                booking_id = responses.booking_id(item)
                status = responses.booking_status(item)
                begin_ts = responses.booking_begin_ts(item)
            except (TypeError, ValueError):
                continue
            if not booking_id or status != responses.BOOKING_STATUS_PENDING:
                continue
            try:
                sign_ago = int(item.get("limitSignAgo") or CHECKIN_DEFAULT_SIGN_AGO)
            except (TypeError, ValueError):
                sign_ago = CHECKIN_DEFAULT_SIGN_AGO
            open_ts = begin_ts - sign_ago + CHECKIN_START_OFFSET_SECONDS
            if open_ts <= now_ts + 120:
                continue
            start_str = (
                datetime.fromtimestamp(open_ts, tz=UTC)
                .astimezone()
                .strftime("%Y-%m-%d %H:%M:%S")
            )
            planned.append((f"{CHECKIN_WINDOW_PREFIX}{booking_id}", start_str))
        return planned

    def _existing_checkin_task_names(self) -> list[str]:
        """返回已注册的登录触发任务与窗口任务名称（查询失败时按空处理）。"""
        try:
            tasks = self._list_windows_tasks()
        except RuntimeError:
            return []
        return [
            task.name
            for task in tasks
            if task.name == CHECKIN_LOGON_TASK or task.name.startswith(CHECKIN_WINDOW_PREFIX)
        ]

    def _sync_windows_checkin_tasks(self, bookings: list[dict]) -> tuple[bool, str]:
        planned = self._plan_checkin_tasks(bookings)
        existing = self._existing_checkin_task_names()
        messages: list[str] = []
        ok = True

        if CHECKIN_LOGON_TASK not in existing:
            success, message = self._register_windows_checkin_task(
                CHECKIN_LOGON_TASK,
                trigger="Logon",
                wait=False,
            )
            ok = ok and success
            messages.append(message)
        else:
            messages.append("登录触发签到任务已存在")

        desired = {name for name, _start in planned}
        for task_name, start_str in planned:
            if task_name in existing:
                continue
            success, message = self._register_windows_checkin_task(
                task_name,
                trigger="Once",
                start_str=start_str,
                wait=True,
            )
            ok = ok and success
            messages.append(message)

        stale = [
            name
            for name in existing
            if name.startswith(CHECKIN_WINDOW_PREFIX) and name not in desired
        ]
        for task_name in stale:
            success, message = self._delete_windows_task(task_name)
            ok = ok and success
            messages.append(message)

        if not planned:
            messages.append("当前没有需要创建窗口任务的待签到预约")
        return ok, "\n".join(messages)

    def _register_windows_checkin_task(
        self,
        task_name: str,
        *,
        trigger: str,
        start_str: str = "",
        wait: bool,
    ) -> tuple[bool, str]:
        """注册一个自动签到系统任务（登录触发或一次性窗口触发）。"""
        runner_path = self._write_checkin_runner(wait=wait)
        current_user = self._current_windows_user()
        if not current_user:
            return False, "无法确定当前 Windows 用户，不能创建自动签到任务"

        command = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(runner_path),
        ]
        argument_line = subprocess.list2cmdline(command)
        if trigger == "Logon":
            # 不限定用户时 Windows 要求管理员权限，普通用户创建会被拒绝。
            trigger_expr = (
                "New-ScheduledTaskTrigger -AtLogOn "
                f"-User {self._powershell_quote(current_user)}"
            )
        else:
            trigger_expr = (
                "New-ScheduledTaskTrigger -Once -At "
                f"([datetime]::Parse({self._powershell_quote(start_str)}))"
            )
        execution_minutes = 90 if wait else 15
        script = "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                "$action = New-ScheduledTaskAction "
                f"-Execute {self._powershell_quote('powershell.exe')} "
                f"-Argument {self._powershell_quote(argument_line)} "
                f"-WorkingDirectory {self._powershell_quote(str(self.install_root))}",
                f"$trigger = {trigger_expr}",
                "$principal = New-ScheduledTaskPrincipal "
                f"-UserId {self._powershell_quote(current_user)} "
                "-LogonType Interactive -RunLevel Limited",
                "$settings = New-ScheduledTaskSettingsSet "
                "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries "
                "-StartWhenAvailable -WakeToRun "
                f"-ExecutionTimeLimit (New-TimeSpan -Minutes {execution_minutes}) "
                "-MultipleInstances IgnoreNew",
                "Register-ScheduledTask "
                f"-TaskName {self._powershell_quote(task_name)} "
                f"-Description {self._powershell_quote('HDU Library Sniper auto check-in')} "
                "-Action $action -Trigger $trigger -Principal $principal "
                "-Settings $settings -Force | Out-Null",
                'Write-Host "registered"',
            ]
        )
        try:
            result = self._run_windows_powershell(script)
        except Exception as exc:
            return False, f"注册签到任务失败: {exc}"

        if result.returncode == 0:
            mode = "登录触发" if trigger == "Logon" else "窗口触发"
            return True, f"已创建{mode}签到任务 {task_name}"
        error = self._command_error(result)
        if not self._is_windows_task_access_denied(error):
            return False, f"创建签到任务失败:\n{error}"
        return self._configure_windows_checkin_task_with_schtasks(
            task_name,
            trigger,
            start_str,
            runner_path,
            current_user,
        )

    def _configure_windows_checkin_task_with_schtasks(
        self,
        task_name: str,
        trigger: str,
        start_str: str,
        runner_path: Path,
        current_user: str,
    ) -> tuple[bool, str]:
        """ScheduledTasks 模块被拒绝时用 schtasks 创建当前用户签到任务。"""
        command = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(runner_path),
        ]
        args = [
            "schtasks.exe",
            "/Create",
            "/TN",
            task_name,
            "/TR",
            subprocess.list2cmdline(command),
            "/RU",
            current_user,
            "/RL",
            "LIMITED",
            "/IT",
            "/F",
        ]
        if trigger == "Logon":
            args += ["/SC", "ONLOGON"]
        else:
            try:
                parsed = datetime.strptime(start_str, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                return False, f"无效的签到任务时间: {start_str}"
            args += [
                "/SC",
                "ONCE",
                "/SD",
                parsed.strftime("%m/%d/%Y"),
                "/ST",
                parsed.strftime("%H:%M"),
            ]
        try:
            result = subprocess.run(
                args,
                cwd=str(self.install_root),
                capture_output=True,
                text=True,
                timeout=30,
                encoding=_windows_output_encoding(),
                errors="replace",
                creationflags=WINDOWS_NO_WINDOW,
            )
        except Exception as exc:
            return False, f"调用 schtasks 创建签到任务时出错: {exc}"
        if result.returncode == 0:
            mode = "登录触发" if trigger == "Logon" else "窗口触发"
            return (
                True,
                f"已通过 schtasks 创建{mode}签到任务 {task_name}"
                "（当前用户兼容模式，睡眠唤醒不可用）",
            )
        return False, f"schtasks 创建签到任务失败:\n{self._command_error(result)}"

    def _write_checkin_runner(self, *, wait: bool) -> Path:
        """写入自动签到任务的短启动脚本。"""
        launch_args = ["--checkin-wait"] if wait else ["--checkin-run"]
        if not getattr(sys, "frozen", False):
            launch_args = ["-m", "hdu_sniper", *launch_args]
        return self._write_windows_task_runner(
            launch_args=launch_args,
            runner_name="hdu-sniper-checkin-wait.ps1" if wait else "hdu-sniper-checkin.ps1",
        )

    def _remove_windows_checkin_tasks(self) -> tuple[bool, str]:
        messages: list[str] = []
        ok = True
        names = [CHECKIN_LOGON_TASK, *self._existing_checkin_task_names()]
        seen: set[str] = set()
        for task_name in names:
            if task_name in seen:
                continue
            if task_name != CHECKIN_LOGON_TASK and not task_name.startswith(
                CHECKIN_WINDOW_PREFIX
            ):
                continue
            seen.add(task_name)
            success, message = self._delete_windows_task(task_name)
            ok = ok and success
            messages.append(message)
        for runner_name in ("hdu-sniper-checkin.ps1", "hdu-sniper-checkin-wait.ps1"):
            try:
                (self.paths.state_dir / runner_name).unlink(missing_ok=True)
            except OSError:
                pass
        if not messages:
            messages.append("没有已注册的自动签到系统任务")
        return ok, "\n".join(messages)

    def _remove_windows_task(self) -> tuple[bool, str]:
        """移除 Windows 定时任务。"""
        return self._delete_windows_task(self.task_name)

    def _delete_windows_task(self, task_name: str) -> tuple[bool, str]:
        """删除指定的应用托管 Windows 任务。"""
        try:
            result = self._run_windows_powershell(
                "Unregister-ScheduledTask "
                f"-TaskName {self._powershell_quote(task_name)} -Confirm:$false"
            )

            if result.returncode == 0:
                self._remove_windows_task_runner()
                return True, f"已删除调度任务 {task_name}"
            # 任务不存在也算成功
            if self._task_is_missing(self._command_error(result)):
                self._remove_windows_task_runner()
                return True, f"调度任务 {task_name} 不存在（可能已被删除）"
            return False, f"删除失败:\n{self._command_error(result)}"
        except Exception as exc:
            return False, f"删除任务出错: {exc}"

    def _list_windows_tasks(self) -> list[ScheduledTask]:
        """读取本应用创建的全部 Windows 任务（每日、登录触发与窗口任务）。"""
        script = f"""
$ErrorActionPreference = 'Stop'
function Format-TaskTime($value) {{
    if ($null -eq $value) {{ return $null }}
    $parsed = $null
    try {{ $parsed = [datetime]$value }} catch {{ return $null }}
    if ($parsed -eq [datetime]::MinValue) {{ return $null }}
    return $parsed.ToString('yyyy-MM-dd HH:mm:ss')
}}
$tasks = @(Get-ScheduledTask -TaskName '{TASK_MARKER}-*')
$items = @($tasks | ForEach-Object {{
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath
    [pscustomobject]@{{
        name = $_.TaskName
        status = [string]$_.State
        next_run = Format-TaskTime $info.NextRunTime
        last_run = Format-TaskTime $info.LastRunTime
        last_result = [string]$info.LastTaskResult
    }}
}})
if ($items.Count -eq 0) {{
    Write-Output '[]'
    exit 0
}}
ConvertTo-Json -InputObject $items -Compress
"""
        try:
            result = self._run_windows_powershell(script)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"读取 Windows 任务计划程序时出错: {exc}") from exc

        if result.returncode != 0:
            stderr = result.stderr if isinstance(result.stderr, str) else ""
            stdout = result.stdout if isinstance(result.stdout, str) else ""
            error = (stderr or stdout).strip()
            if not error or self._task_is_missing(error):
                return []
            raise RuntimeError(f"无法读取 Windows 任务计划程序: {error}")

        try:
            fields = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Windows 任务计划程序返回了无效的任务详情") from exc
        if isinstance(fields, dict):
            fields = [fields]
        if not isinstance(fields, list):
            raise RuntimeError("Windows 任务计划程序返回了无效的任务详情")

        tasks: list[ScheduledTask] = []
        for field in fields:
            if not isinstance(field, dict):
                continue
            tasks.append(
                ScheduledTask(
                    name=str(field.get("name") or ""),
                    status=self._optional_string(field.get("status")),
                    next_run=self._optional_string(field.get("next_run")),
                    last_run=self._optional_string(field.get("last_run")),
                    last_result=self._optional_string(field.get("last_result")),
                )
            )
        return tasks

    def _read_windows_task(self, task_name: str) -> ScheduledTask | None:
        """通过 ScheduledTasks 模块读取单个任务的结构化明细。"""
        task_name_literal = self._powershell_quote(task_name)
        script = f"""
try {{
    $task = Get-ScheduledTask -TaskName {task_name_literal}
    $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath
    function Format-TaskTime($value) {{
        if ($null -eq $value) {{ return $null }}
        $parsed = $null
        try {{ $parsed = [datetime]$value }} catch {{ return $null }}
        if ($parsed -eq [datetime]::MinValue) {{ return $null }}
        return $parsed.ToString('yyyy-MM-dd HH:mm:ss')
    }}
    [pscustomobject]@{{
        name = $task.TaskName
        status = [string]$task.State
        next_run = Format-TaskTime $info.NextRunTime
        last_run = Format-TaskTime $info.LastRunTime
        last_result = [string]$info.LastTaskResult
    }} | ConvertTo-Json -Compress
}} catch {{
    [Console]::Error.Write($_.Exception.Message)
    exit 2
}}
"""
        try:
            result = self._run_windows_powershell(script)

            if result.returncode != 0:
                stderr = result.stderr if isinstance(result.stderr, str) else ""
                stdout = result.stdout if isinstance(result.stdout, str) else ""
                error = (stderr or stdout).strip()
                if not error or self._task_is_missing(error):
                    return None
                raise RuntimeError(f"无法读取 Windows 任务计划程序: {error}")

            try:
                fields = json.loads(result.stdout)
            except json.JSONDecodeError as exc:
                raise RuntimeError("Windows 任务计划程序返回了无效的任务详情") from exc
            if not isinstance(fields, dict):
                raise RuntimeError("Windows 任务计划程序返回了无效的任务详情")
            return ScheduledTask(
                name=str(fields.get("name") or task_name),
                status=self._optional_string(fields.get("status")),
                next_run=self._optional_string(fields.get("next_run")),
                last_run=self._optional_string(fields.get("last_run")),
                last_result=self._optional_string(fields.get("last_result")),
            )
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"读取 Windows 任务计划程序时出错: {exc}") from exc

    @staticmethod
    def _run_windows_powershell(script: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); "
                "$OutputEncoding = [Console]::OutputEncoding; "
                "$ErrorActionPreference = 'Stop'; " + script,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=WINDOWS_NO_WINDOW,
        )

    @staticmethod
    def _powershell_quote(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    @staticmethod
    def _current_windows_user() -> str | None:
        """返回 schtasks 可用的当前交互用户标识，不回退到 SYSTEM。

        优先读取进程令牌中的用户名（`USERNAME` 环境变量在受限/代理环境下
        可能与实际令牌用户不一致），失败时再回退到环境变量。
        """
        if os.name == "nt":
            try:
                buffer = ctypes.create_unicode_buffer(256)
                size = ctypes.c_ulong(256)
                if ctypes.windll.advapi32.GetUserNameW(buffer, ctypes.byref(size)):
                    username = buffer.value.strip()
                    if username:
                        return username
            except Exception:
                pass
        username = os.environ.get("USERNAME", "").strip()
        if not username:
            return None
        domain = os.environ.get("USERDOMAIN", "").strip()
        return f"{domain}\\{username}" if domain else username

    @staticmethod
    def _is_windows_task_access_denied(message: str) -> bool:
        """识别 Windows 任务计划程序的常见权限错误。"""
        normalized = message.lower()
        return any(
            token in normalized
            for token in (
                "access is denied",
                "access denied",
                "permission denied",
                "0x80070005",
                "0x80041003",
                "拒绝访问",
                "权限不足",
            )
        )

    @staticmethod
    def _optional_string(value: object) -> str | None:
        if value is None:
            return None
        return str(value)

    def _require_managed_task(self, task_name: str) -> None:
        if task_name == self.task_name:
            return
        if task_name == CHECKIN_LOGON_TASK or task_name.startswith(CHECKIN_WINDOW_PREFIX):
            return
        if task_name not in self.managed_task_names:
            raise ValueError(f"不允许操作非本应用创建的任务: {task_name}")

    @staticmethod
    def _task_is_missing(message: str) -> bool:
        normalized = message.lower()
        return any(
            token in normalized
            for token in (
                "does not exist",
                "cannot find",
                "not found",
                "no msft_scheduledtask",
                "找不到",
                "不存在",
            )
        )

    @staticmethod
    def _command_error(result: subprocess.CompletedProcess[str]) -> str:
        stderr = result.stderr if isinstance(result.stderr, str) else ""
        stdout = result.stdout if isinstance(result.stdout, str) else ""
        return (stderr or stdout).strip() or "任务计划程序未返回错误详情"

    def _find_pythonw(self) -> Path | None:
        """查找 pythonw.exe。"""
        # 1. 项目根目录
        local = self.install_root / "pythonw.exe"
        if local.exists():
            return local

        # 2. 虚拟环境
        venv_paths = [
            self.install_root / "venv" / "Scripts" / "pythonw.exe",
            self.install_root / ".venv" / "Scripts" / "pythonw.exe",
        ]
        for venv_path in venv_paths:
            if venv_path.exists():
                return venv_path

        # 3. PATH
        result = subprocess.run(
            ["where", "pythonw.exe"],
            capture_output=True,
            text=True,
            encoding=_windows_output_encoding(),
            errors="replace",
            creationflags=WINDOWS_NO_WINDOW,
        )
        if result.returncode == 0:
            first_line = result.stdout.strip().split("\n")[0]
            return Path(first_line)

        return None

    # Linux/macOS 实现

    def _configure_linux_cron(self, execute_time: str) -> tuple[bool, str]:
        """配置 Linux crontab。"""
        # 解析时间
        parts = execute_time.split(":")
        if len(parts) != 3:
            return False, "时间格式错误，应为 HH:mm:ss"

        hour, minute, second = parts

        # cron 不支持秒级精度，忽略秒
        cron_time = f"{minute} {hour} * * *"

        # 构造 cron 命令
        command = shlex.join([*self._launcher_command(), "--daemon"])
        home = os.environ.get(APP_HOME_ENV, "").strip()
        home_prefix = f"{APP_HOME_ENV}={shlex.quote(home)} " if home else ""
        cron_command = (
            f"{cron_time} {home_prefix}{command} >> {shlex.quote(str(self.paths.task_log))} 2>&1"
            f" # {TASK_MARKER}"
        )
        self.paths.log_dir.mkdir(parents=True, exist_ok=True)

        # 读取现有 crontab
        try:
            result = subprocess.run(
                ["crontab", "-l"],
                capture_output=True,
                text=True,
            )
            existing = result.stdout if result.returncode == 0 else ""
        except Exception:
            existing = ""

        # 移除旧任务
        lines = [line for line in existing.split("\n") if TASK_MARKER not in line]

        # 添加新任务
        lines.append(cron_command)

        new_crontab = "\n".join(lines) + "\n"

        # 写入 crontab
        try:
            process = subprocess.Popen(
                ["crontab", "-"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            stdout, stderr = process.communicate(input=new_crontab)

            if process.returncode == 0:
                return (
                    True,
                    f"定时任务配置成功！\n每天 {hour}:{minute} 自动执行\n\n注意: cron 不支持秒级精度，已忽略秒数",
                )
            return False, f"配置失败:\n{stderr}"
        except Exception as e:
            return False, f"配置 crontab 出错: {e}"

    def _remove_linux_cron(self) -> tuple[bool, str]:
        """移除 Linux crontab 任务。"""
        try:
            # 读取现有 crontab
            result = subprocess.run(
                ["crontab", "-l"],
                capture_output=True,
                text=True,
            )

            if result.returncode != 0:
                return True, "没有配置定时任务"

            existing = result.stdout
            # 移除相关任务
            lines = [line for line in existing.split("\n") if TASK_MARKER not in line]

            new_crontab = "\n".join(lines) + "\n"

            # 写入 crontab
            process = subprocess.Popen(
                ["crontab", "-"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            stdout, stderr = process.communicate(input=new_crontab)

            if process.returncode == 0:
                return True, "定时任务已移除"
            return False, f"移除失败:\n{stderr}"
        except Exception as e:
            return False, f"移除任务出错: {e}"

    def _sync_posix_checkin_tasks(self, bookings: list[dict]) -> tuple[bool, str]:
        ok, message = self._configure_posix_checkin_cron()
        messages = [message]
        planned = self._plan_checkin_tasks(bookings)
        for _task_name, start_str in planned:
            success, item_message = self._schedule_posix_checkin_once(start_str)
            ok = ok and success
            messages.append(item_message)
        if not planned:
            messages.append("当前没有需要创建窗口任务的待签到预约")
        return ok, "\n".join(messages)

    def _configure_posix_checkin_cron(self) -> tuple[bool, str]:
        """配置 @reboot 登录触发签到（Linux/macOS crontab）。"""
        command = shlex.join([*self._launcher_command(), "--checkin-run"])
        home = os.environ.get(APP_HOME_ENV, "").strip()
        home_prefix = f"{APP_HOME_ENV}={shlex.quote(home)} " if home else ""
        cron_command = (
            f"@reboot {home_prefix}{command} >> {shlex.quote(str(self.paths.task_log))} 2>&1"
            f" # {CHECKIN_MARKER}"
        )
        try:
            result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
            existing = result.stdout if result.returncode == 0 else ""
        except Exception:
            existing = ""
        lines = [line for line in existing.split("\n") if CHECKIN_MARKER not in line]
        lines.append(cron_command)
        new_crontab = "\n".join(lines) + "\n"
        try:
            process = subprocess.Popen(
                ["crontab", "-"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            stdout, stderr = process.communicate(input=new_crontab)
            if process.returncode == 0:
                return True, "已配置开机登录自动签到（@reboot）"
            return False, f"配置开机签到失败:\n{stderr}"
        except Exception as exc:
            return False, f"配置开机签到失败: {exc}"

    def _remove_posix_checkin_cron(self) -> tuple[bool, str]:
        """移除 crontab 中的开机签到行。"""
        try:
            result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
            if result.returncode != 0:
                return True, "没有配置开机自动签到"
            existing = result.stdout
        except Exception as exc:
            return False, f"读取 crontab 失败: {exc}"
        lines = [line for line in existing.split("\n") if CHECKIN_MARKER not in line]
        new_crontab = "\n".join(lines) + "\n"
        try:
            process = subprocess.Popen(
                ["crontab", "-"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            stdout, stderr = process.communicate(input=new_crontab)
            if process.returncode == 0:
                return True, "已移除开机自动签到"
            return False, f"移除开机签到失败:\n{stderr}"
        except Exception as exc:
            return False, f"移除开机签到失败: {exc}"

    def _schedule_posix_checkin_once(self, start_str: str) -> tuple[bool, str]:
        """通过 at 为单个预约创建一次性窗口签到任务（尽力而为）。"""
        command = shlex.join([*self._launcher_command(), "--checkin-wait"])
        home = os.environ.get(APP_HOME_ENV, "").strip()
        home_prefix = f"{APP_HOME_ENV}={shlex.quote(home)} " if home else ""
        command_line = (
            f"{home_prefix}{command} >> {shlex.quote(str(self.paths.task_log))} 2>&1"
        )
        try:
            parsed = datetime.strptime(start_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return False, f"无效的签到任务时间: {start_str}"
        if self.system == "Darwin":
            time_expr = f"{parsed.strftime('%H:%M')} {parsed.strftime('%m/%d/%y')}"
        else:
            time_expr = f"{parsed.strftime('%H:%M')} {parsed.strftime('%m/%d/%Y')}"
        try:
            result = subprocess.run(
                ["at", time_expr],
                input=command_line + "\n",
                capture_output=True,
                text=True,
                timeout=15,
            )
        except FileNotFoundError:
            return False, "系统未安装 at 命令，无法创建一次性窗口签到任务（开机签到仍可用）"
        except Exception as exc:
            return False, f"调用 at 失败: {exc}"
        if result.returncode == 0:
            return True, f"已通过 at 创建窗口签到任务 {time_expr}"
        return False, f"at 创建签到任务失败:\n{result.stderr or result.stdout}"

    def _get_linux_cron_status(self) -> TaskStatus:
        """获取 Linux cron 任务状态。"""
        try:
            result = subprocess.run(
                ["crontab", "-l"],
                capture_output=True,
                text=True,
            )

            if result.returncode != 0:
                return TaskStatus(exists=False)

            crontab = result.stdout
            # 查找相关任务
            for line in crontab.split("\n"):
                if TASK_MARKER in line and "--daemon" in line:
                    # 提取时间
                    parts = line.split()
                    if len(parts) >= 5:
                        minute, hour = parts[0], parts[1]
                        execute_time = f"{hour}:{minute}:00"
                        return TaskStatus(
                            exists=True,
                            execute_time=execute_time,
                        )

            return TaskStatus(exists=False)
        except Exception:
            return TaskStatus(exists=False)
