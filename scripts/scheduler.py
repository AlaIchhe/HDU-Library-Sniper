"""HDU-Library-Sniper 纯 Python 每日调度器 + 守护进程管理。

专为"被关在一个已经运行的容器里"的受限环境设计:无 root、无 cron、无 tmux、
可能连 bash/setsid/nohup 都没有。只依赖 Python 标准库。

工作模型:
  - 每天 TARGET_TIME(默认 19:59:59 Asia/Shanghai)运行一次 main.py --run-now。
  - start 用 os.fork()+os.setsid() 脱离控制终端(不依赖 setsid/nohup 二进制),
    断开 SSH/exec 会话后继续跑。
  - 容器重启后进程会丢失;install-guard 在 ~/.bashrc / ~/.profile 写自愈守卫,
    下次拿到交互 shell 时自动拉起(无 root 下这是唯一的自愈途径)。

命令:
  python scripts/scheduler.py run            前台运行(容器 PID 1 / 调试)
  python scripts/scheduler.py start          后台守护启动(脱离终端)
  python scripts/scheduler.py stop           停止守护(按 PID 文件发 SIGTERM)
  python scripts/scheduler.py status         查看是否在跑
  python scripts/scheduler.py install-guard  在 ~/.bashrc / ~/.profile 写自愈守卫
  python scripts/scheduler.py                同 run

环境变量:
  SNIPER_DAILY_AT   触发时刻 HH:MM:SS 或 HH:MM(默认 19:59:59)
  TZ                时区名(默认 Asia/Shanghai;无 tzdata 时回退 UTC+8)
  SNIPER_SCHED_LOG  日志文件(默认 <APP_DIR>/logs/scheduler.log)
  SNIPER_RUN_DIR    PID 文件目录(默认 ~/.libsniper)
"""
from __future__ import annotations

import logging
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, time as dtime, timedelta, timezone

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, APP_DIR)

TZ_NAME = os.environ.get("TZ", "Asia/Shanghai")
TARGET = os.environ.get("SNIPER_DAILY_AT", "19:59:59")
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(APP_DIR, "logs"))
LOG_FILE = os.environ.get("SNIPER_SCHED_LOG", os.path.join(LOG_DIR, "scheduler.log"))
RUN_DIR = os.environ.get("SNIPER_RUN_DIR", os.path.join(os.path.expanduser("~"), ".libsniper"))
PIDFILE = os.path.join(RUN_DIR, "scheduler.pid")

GUARD_BEGIN = "# >>> libsniper scheduler guard >>>"
GUARD_END = "# <<< libsniper scheduler end <<<"

# 时区:zoneinfo(需 tzdata)失败则回退固定 UTC+8(CST 无夏令时,固定偏移即可)
try:
    from zoneinfo import ZoneInfo

    TZ = ZoneInfo(TZ_NAME)
except Exception:
    TZ = timezone(timedelta(hours=8))


def _setup_logging() -> None:
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] [sched] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
    )


def parse_target(s: str) -> dtime:
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(s, fmt).time()
        except ValueError:
            continue
    raise ValueError(f"SNIPER_DAILY_AT 格式非法: {s}(需 HH:MM:SS 或 HH:MM)")


TARGET_T = parse_target(TARGET)


def next_run(now: datetime) -> datetime:
    """返回 > now 的下一个目标时刻(带时区)。"""
    local = now.astimezone(TZ)
    candidate = local.replace(
        hour=TARGET_T.hour, minute=TARGET_T.minute, second=TARGET_T.second, microsecond=0
    )
    if candidate <= local:
        candidate += timedelta(days=1)
    return candidate


def run_once() -> int:
    """跑一次 main.py --run-now,返回退出码。用 subprocess 隔离,与 cron/loop 模型一致。"""
    try:
        proc = subprocess.run([sys.executable, "main.py", "--run-now"], cwd=APP_DIR, check=False)
        return proc.returncode
    except Exception as e:  # noqa: BLE001
        logging.getLogger("sched").exception("运行 main.py 抛异常: %s", e)
        return 99


# ── PID 文件管理(代替 pgrep,精简镜像里可能没有 pgrep) ──────
def _read_pid():
    try:
        with open(PIDFILE) as f:
            return int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return None


def _alive(pid):
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return False
    return True


def _write_pid():
    os.makedirs(RUN_DIR, exist_ok=True)
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))


def _clear_pid():
    try:
        with open(PIDFILE) as f:
            if f.read().strip() != str(os.getpid()):
                return  # 不是自己的 pid 文件,不删
        os.remove(PIDFILE)
    except FileNotFoundError:
        pass
    except OSError:
        pass


# ── 前台运行(容器 PID 1 / 调试 / 被 start 拉起的守护子进程) ──
def run() -> int:
    _setup_logging()
    log = logging.getLogger("sched")
    _write_pid()
    log.info("===== scheduler 启动 =====")
    log.info("APP_DIR=%s  TZ=%s  TARGET=%s  LOG=%s  PID=%s", APP_DIR, TZ_NAME, TARGET, LOG_FILE, os.getpid())

    stopping = False

    def _stop(signum, _frame):
        nonlocal stopping
        stopping = True
        log.info("收到信号 %s,本轮结束后退出", signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _stop)
        except (ValueError, OSError):
            pass

    codes = {0: "成功", 1: "全部尝试失败", 2: "登录态失效(cookie)", 3: "无启用方案"}

    try:
        while not stopping:
            now = datetime.now(TZ)
            target = next_run(now)
            wait = (target - now).total_seconds()
            log.info("下次运行: %s(等待 %.0fs)", target.strftime("%Y-%m-%d %H:%M:%S %Z"), wait)

            end = time.monotonic() + wait
            while not stopping and time.monotonic() < end:
                time.sleep(min(3600, max(0.0, end - time.monotonic())))
            if stopping:
                break

            log.info("----- 触发运行 -----")
            ret = run_once()
            log.info(">>> 退出码 %d(%s)", ret, codes.get(ret, f"异常({ret})"))

            for _ in range(60):
                if stopping:
                    break
                time.sleep(1)
    finally:
        _clear_pid()
        log.info("scheduler 退出")
    return 0


# ── 后台守护启动:double-fork + setsid,纯 Python 不依赖外部二进制 ──
def start() -> int:
    pid = _read_pid()
    if _alive(pid):
        print(f"已在运行(pid {pid})")
        return 0
    # 清理过期 pid 文件
    try:
        os.remove(PIDFILE)
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

    # 第一次 fork
    try:
        first = os.fork()
    except OSError as e:
        print(f"fork 失败: {e}")
        return 1
    if first != 0:
        # 父进程:等子进程写 pid 文件后确认
        time.sleep(1.0)
        pid = _read_pid()
        if _alive(pid):
            print(f"已启动(pid {pid}),日志: {LOG_FILE}")
            return 0
        print("启动失败,请查看日志:", LOG_FILE)
        return 1

    # 第一次子进程:新建会话,脱离控制终端
    os.setsid()
    try:
        second = os.fork()
    except OSError:
        os._exit(1)
    if second != 0:
        os._exit(0)

    # 第二次子进程(守护):重定向 stdio 到日志/devnull,再 exec 前台 run
    os.chdir("/")
    os.umask(0)
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open(os.devnull, os.O_RDWR)
    logfd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(devnull, 0)
    os.dup2(logfd, 1)
    os.dup2(logfd, 2)
    os.close(devnull)
    os.close(logfd)
    os.execv(sys.executable, [sys.executable, os.path.abspath(__file__), "run"])


def stop() -> int:
    pid = _read_pid()
    if not _alive(pid):
        print("未运行")
        try:
            os.remove(PIDFILE)
        except FileNotFoundError:
            pass
        return 0
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    for _ in range(50):
        time.sleep(0.1)
        if not _alive(pid):
            break
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        os.remove(PIDFILE)
    except FileNotFoundError:
        pass
    print("已停止")
    return 0


def status() -> int:
    pid = _read_pid()
    if _alive(pid):
        print(f"运行中(pid {pid}),日志: {LOG_FILE}")
        return 0
    print("未运行")
    return 1


def install_guard() -> int:
    """在 ~/.bashrc 与 ~/.profile 写自愈守卫(幂等)。容器重启后首次交互登录即重启调度器。"""
    self = os.path.abspath(__file__)
    block = f"\n{GUARD_BEGIN}\npython \"{self}\" start >/dev/null 2>&1\n{GUARD_END}\n"
    # 优先用 HOME 环境变量(expanduser 在 Windows 上不认 HOME,会让测试/容器场景误写)
    home = os.environ.get("HOME") or os.path.expanduser("~")
    written = []
    for name in (".bashrc", ".profile"):
        path = os.path.join(home, name)
        try:
            content = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
        except OSError:
            content = ""
        # 删除旧块(幂等):先从内存内容里移除,再整文件重写,避免追加导致重复
        content = re.sub(
            re.escape(GUARD_BEGIN) + r".*?" + re.escape(GUARD_END) + r"\n?",
            "",
            content,
            flags=re.S,
        )
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content + block)
            written.append(path)
        except OSError as e:
            print(f"无法写入 {path}: {e}")
    print("自愈守卫已写入:", ", ".join(written))
    print("重启容器后,首次交互登录会自动重启调度器。")
    return 0


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd in ("run", "foreground"):
        return run()
    if cmd == "start":
        return start()
    if cmd == "stop":
        return stop()
    if cmd == "status":
        return status()
    if cmd in ("install-guard", "install_guard"):
        return install_guard()
    if cmd in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    print(f"未知命令: {cmd}\n用 --help 查看用法")
    return 2


if __name__ == "__main__":
    sys.exit(main())
