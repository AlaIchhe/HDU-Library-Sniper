"""定时任务管理服务。"""

from __future__ import annotations

import json
import os
import platform
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from hdu_sniper.paths import APP_HOME_ENV, AppPaths


TASK_MARKER = "HDU-Library-Sniper"
DAILY_RUN_TIME = "20:00:00"
WINDOWS_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


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

    def configure_task(self, wake_to_run: bool = True) -> tuple[bool, str]:
        """配置固定为每天 20:00 的系统任务。"""
        if self.system == "Windows":
            return self._configure_windows_task(DAILY_RUN_TIME, wake_to_run)
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

    def get_task_status(self) -> TaskStatus:
        """获取定时任务状态。

        Returns:
            任务状态
        """
        if self.system == "Windows":
            return self._get_windows_task_status()
        if self.system in ("Linux", "Darwin"):
            return self._get_linux_cron_status()
        return TaskStatus(exists=False)

    def list_tasks(self) -> list[ScheduledTask]:
        """读取由本应用创建的调度任务，而不暴露其他系统任务。"""
        if self.system == "Windows":
            return self._list_windows_tasks()
        if self.system in ("Linux", "Darwin"):
            status = self._get_linux_cron_status()
            if not status.exists:
                return []
            return [
                ScheduledTask(
                    name=self.task_name,
                    next_run=status.next_run,
                )
            ]
        return []

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
                encoding="utf-8",
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

    def _configure_windows_task(self, execute_time: str, wake_to_run: bool) -> tuple[bool, str]:
        """使用 AutoSchedule.ps1 配置 Windows 任务。"""
        ps_script = self.resource_root / "scripts" / "AutoSchedule.ps1"
        if not ps_script.exists():
            return False, f"未找到 AutoSchedule.ps1: {ps_script}"

        # 设置环境变量
        env = os.environ.copy()
        env["SNIPER_WORKDIR"] = str(self.install_root)
        env["SNIPER_TASK_LOG"] = str(self.paths.task_log)
        env["PYTHON_EXE"] = self._launcher_command()[0]
        env["SNIPER_DAILY_AT"] = execute_time
        env["SNIPER_TASK_NAME"] = self.task_name
        env["SNIPER_WAKE_TO_RUN"] = "1" if wake_to_run else "0"
        env["SNIPER_FROZEN"] = "1" if getattr(sys, "frozen", False) else "0"

        # 执行 PowerShell 脚本
        try:
            result = subprocess.run(
                ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", str(ps_script)],
                cwd=str(self.install_root),
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
                encoding="utf-8",
                errors="replace",
                creationflags=WINDOWS_NO_WINDOW,
            )

            if result.returncode == 0:
                return True, f"定时任务配置成功！\n每天 {execute_time} 自动执行"
            error = self._command_error(result)
            if self._is_windows_task_access_denied(error):
                return self._configure_windows_task_with_schtasks(execute_time)
            return False, f"配置失败:\n{error}"
        except subprocess.TimeoutExpired:
            return False, "PowerShell 脚本执行超时"
        except Exception as e:
            return False, f"执行 PowerShell 脚本出错: {e}"

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
                encoding="utf-8",
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

    def _write_windows_task_runner(self) -> Path:
        """写入 schtasks 兼容回退使用的短启动脚本。"""
        runner_path = self._windows_task_runner_path()
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
        if getattr(sys, "frozen", False):
            lines.append(f"& {launcher} --run-now *>> $logFile")
        else:
            lines.append(f"& {launcher} -m hdu_sniper --run-now *>> $logFile")
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

    def _get_windows_task_status(self) -> TaskStatus:
        """获取 Windows 任务状态。"""
        tasks = self._list_windows_tasks()
        if not tasks:
            return TaskStatus(exists=False)
        task = tasks[0]
        return TaskStatus(
            exists=True,
            next_run=task.next_run,
        )

    def _list_windows_tasks(self) -> list[ScheduledTask]:
        """按名称逐个读取应用创建的 Windows 任务，避免枚举无关系统任务。"""
        tasks: list[ScheduledTask] = []
        for task_name in self.managed_task_names:
            task = self._read_windows_task(task_name)
            if task is not None:
                tasks.append(task)
        return tasks

    def _read_windows_task(self, task_name: str) -> ScheduledTask | None:
        """通过 ScheduledTasks 模块读取单个任务的结构化明细。"""
        task_name_literal = self._powershell_quote(task_name)
        script = f"""
try {{
    $task = Get-ScheduledTask -TaskName {task_name_literal}
    $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath
    function Format-TaskTime([datetime]$value) {{
        if ($value -eq [datetime]::MinValue) {{ return $null }}
        return $value.ToString('yyyy-MM-dd HH:mm:ss')
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
                "$ErrorActionPreference = 'Stop'; "
                + script,
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
        """返回 schtasks 可用的当前交互用户标识，不回退到 SYSTEM。"""
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
            encoding="utf-8",
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
