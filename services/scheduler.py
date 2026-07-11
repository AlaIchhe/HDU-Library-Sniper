"""定时任务管理服务。"""

from __future__ import annotations

import os
import platform
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class TaskStatus:
    """定时任务状态。"""

    exists: bool
    execute_time: str | None = None
    wake_to_run: bool | None = None
    next_run: str | None = None


class SchedulerService:
    """定时任务管理服务。"""

    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.system = platform.system()
        self.task_name = "HDU-Library-Sniper-Daily"

    def configure_task(self, execute_time: str, wake_to_run: bool = True) -> tuple[bool, str]:
        """配置定时任务。

        Args:
            execute_time: 执行时间（HH:mm:ss）
            wake_to_run: 是否唤醒计算机（仅 Windows）

        Returns:
            (成功?, 消息)
        """
        if self.system == "Windows":
            return self._configure_windows_task(execute_time, wake_to_run)
        if self.system == "Linux" or self.system == "Darwin":
            return self._configure_linux_cron(execute_time)
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

    def test_execution(self) -> tuple[bool, str]:
        """测试执行一次后台任务。

        Returns:
            (成功?, 输出/错误消息)
        """
        # 查找 pythonw.exe (Windows) 或 python3 (Linux)
        if self.system == "Windows":
            python_exe = self._find_pythonw()
            if not python_exe:
                return False, "未找到 pythonw.exe，请确保已安装 Python"
        else:
            python_exe = "python3"

        main_py = self.project_root / "main.py"
        if not main_py.exists():
            return False, f"未找到 main.py: {main_py}"

        # 执行测试
        try:
            result = subprocess.run(
                [str(python_exe), str(main_py), "--daemon"],
                cwd=str(self.project_root),
                capture_output=True,
                text=True,
                timeout=60,
                encoding="utf-8",
                errors="replace",
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
        ps_script = self.project_root / "scripts" / "AutoSchedule.ps1"
        if not ps_script.exists():
            return False, f"未找到 AutoSchedule.ps1: {ps_script}"

        # 设置环境变量
        env = os.environ.copy()
        env["SNIPER_WORKDIR"] = str(self.project_root)
        env["SNIPER_DAILY_AT"] = execute_time
        env["SNIPER_TASK_NAME"] = self.task_name
        env["SNIPER_WAKE_TO_RUN"] = "1" if wake_to_run else "0"

        # 执行 PowerShell 脚本
        try:
            result = subprocess.run(
                ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", str(ps_script)],
                cwd=str(self.project_root),
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
                encoding="utf-8",
                errors="replace",
            )

            if result.returncode == 0:
                return True, f"定时任务配置成功！\n每天 {execute_time} 自动执行"
            return False, f"配置失败:\n{result.stderr}"
        except subprocess.TimeoutExpired:
            return False, "PowerShell 脚本执行超时"
        except Exception as e:
            return False, f"执行 PowerShell 脚本出错: {e}"

    def _remove_windows_task(self) -> tuple[bool, str]:
        """移除 Windows 定时任务。"""
        try:
            result = subprocess.run(
                ["schtasks", "/Delete", "/TN", self.task_name, "/F"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

            if result.returncode == 0:
                return True, "定时任务已移除"
            # 任务不存在也算成功
            if "找不到" in result.stderr or "does not exist" in result.stderr.lower():
                return True, "定时任务不存在（可能已被移除）"
            return False, f"移除失败:\n{result.stderr}"
        except Exception as e:
            return False, f"移除任务出错: {e}"

    def _get_windows_task_status(self) -> TaskStatus:
        """获取 Windows 任务状态。"""
        try:
            result = subprocess.run(
                ["schtasks", "/Query", "/TN", self.task_name, "/FO", "LIST", "/V"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

            if result.returncode != 0:
                return TaskStatus(exists=False)

            # 解析输出
            output = result.stdout
            execute_time = None
            next_run = None

            for line in output.split("\n"):
                if "任务将运行" in line or "Next Run Time" in line:
                    next_run = line.split(":", 1)[-1].strip()
                elif "开始时间" in line or "Start Time" in line:
                    execute_time = line.split(":", 1)[-1].strip()

            return TaskStatus(
                exists=True,
                execute_time=execute_time,
                next_run=next_run,
            )
        except Exception:
            return TaskStatus(exists=False)

    def _find_pythonw(self) -> Path | None:
        """查找 pythonw.exe。"""
        # 1. 项目根目录
        local = self.project_root / "pythonw.exe"
        if local.exists():
            return local

        # 2. 虚拟环境
        venv_paths = [
            self.project_root / "venv" / "Scripts" / "pythonw.exe",
            self.project_root / ".venv" / "Scripts" / "pythonw.exe",
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
        python_exe = "python3"
        main_py = self.project_root / "main.py"
        cron_command = (
            f"{cron_time} {python_exe} {main_py} --daemon >> {self.project_root}/logs/task.log 2>&1"
        )

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
        lines = [
            line
            for line in existing.split("\n")
            if "HDU-Library-Sniper" not in line and main_py.name not in line
        ]

        # 添加新任务
        lines.append("# HDU-Library-Sniper Daily Task")
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
            main_py = self.project_root / "main.py"

            # 移除相关任务
            lines = [
                line
                for line in existing.split("\n")
                if "HDU-Library-Sniper" not in line and main_py.name not in line
            ]

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
            main_py = self.project_root / "main.py"

            # 查找相关任务
            for line in crontab.split("\n"):
                if main_py.name in line and "--daemon" in line:
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
