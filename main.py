"""HDU 图书馆抢座工具 — 终端交互入口。"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, time as dt_time, timedelta

from config.setting import load_settings
from core.client import CookieError, HduLibraryError, LibraryClient
from core.sniper import BookingPlan, Notifier, PlanRepository, PlanStatus, Sniper
from utils.time_sync import get_seat_lookup_time, now_cst

if os.name == "nt":
    # Windows 控制台默认代码页是 GBK，强制切到 UTF-8 避免中文乱码。
    # 注意：pythonw.exe 在无控制台环境（如任务计划程序以 SYSTEM 运行）下，
    # sys.stdout/stderr/stdin 为 None，直接调用 reconfigure 会抛 AttributeError，
    # 进程在导入阶段即崩溃退出（退出码 1，且因无 stderr 不会留下任何日志）。
    # 故先判空，仅在存在真实流时才重配置编码。
    if sys.stdout is not None:
        os.system("chcp 65001 > nul")
        sys.stdout.reconfigure(encoding="utf-8")
    if sys.stderr is not None:
        sys.stderr.reconfigure(encoding="utf-8")
    if sys.stdin is not None:
        sys.stdin.reconfigure(encoding="utf-8")


def clear_screen() -> None:
    subprocess.run(["cmd", "/c", "cls"] if os.name == "nt" else ["clear"], check=False, shell=False)


def input_int(prompt: str, lo: int, hi: int, default: int | None = None) -> int:
    hint = f" [{default}]" if default is not None else ""
    while True:
        raw = input(f"{prompt}{hint}: ").strip()
        if not raw and default is not None:
            return default
        try:
            n = int(raw)
            if lo <= n <= hi:
                return n
            print(f"  请输入 {lo}-{hi} 之间的数字")
        except ValueError:
            print("  请输入有效数字")


def input_float(prompt: str, default: float, is_int: bool = False) -> float:
    """留空则返回 default；否则要求输入正数（>0）。"""
    while True:
        raw = input(f"{prompt}: ").strip()
        if not raw:
            return default
        try:
            value = float(raw)
            if value <= 0:
                print("  请输入大于 0 的数字")
                continue
            return int(value) if is_int else value
        except ValueError:
            print("  请输入有效数字")


def parse_execute_time(text: str) -> datetime | None:
    text = text.strip()
    if not text:
        return None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(text, fmt).time()
            break
        except ValueError:
            parsed = None
    else:
        raise ValueError("时间格式应为 HH:MM 或 HH:MM:SS")
    now = now_cst()
    target = now.replace(hour=parsed.hour, minute=parsed.minute, second=parsed.second, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


def format_countdown(seconds: int) -> str:
    if seconds >= 3600:
        h, rem = divmod(seconds, 3600)
        m, s = divmod(rem, 60)
        return f"{h:02d}:{m:02d}:{s:02d}"
    m, s = divmod(seconds, 60)
    return f"{m:02d}:{s:02d}"


def _interactive_tty() -> bool:
    """是否可以使用方向键交互（Windows + 真实终端）。"""
    return os.name == "nt" and sys.stdin.isatty() and sys.stdout.isatty()


def select_menu(title: str, options: list[str], default: int = 0) -> int:
    """方向键 ↑/↓ 选择，Enter 确认，返回选中项索引。

    非交互式环境（管道输入、非 Windows 等）自动回退为数字输入。
    """
    if not options:
        raise ValueError("选项列表不能为空")
    if not _interactive_tty():
        return _select_menu_fallback(title, options, default)

    import msvcrt

    idx = default % len(options)
    lines_printed = 0

    def render(first: bool = False) -> None:
        nonlocal lines_printed
        if not first:
            sys.stdout.write(f"\x1b[{lines_printed}A")
        rows = [title, ""]
        for i, opt in enumerate(options):
            cursor = "> " if i == idx else "  "
            rows.append(f"{cursor}{opt}")
        rows.append("")
        rows.append("(方向键 ↑/↓ 选择，Enter 确认)")
        for row in rows:
            sys.stdout.write("\x1b[2K" + row + "\n")
        sys.stdout.flush()
        lines_printed = len(rows)

    render(first=True)
    while True:
        key = msvcrt.getch()
        if key in (b"\xe0", b"\x00"):
            key2 = msvcrt.getch()
            if key2 == b"H":
                idx = (idx - 1) % len(options)
                render()
            elif key2 == b"P":
                idx = (idx + 1) % len(options)
                render()
        elif key in (b"\r", b"\n"):
            return idx
        elif key == b"\x03":
            raise KeyboardInterrupt


def _select_menu_fallback(title: str, options: list[str], default: int = 0) -> int:
    print(title)
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {opt}")
    return input_int(f"选择 [1-{len(options)}]", 1, len(options), default=default + 1) - 1


def multi_select_menu(title: str, options: list[str]) -> list[int]:
    """方向键 ↑/↓ 移动，空格勾选/取消，A 全选/取消全选，Enter 确认。返回选中项索引列表。"""
    if not options:
        return []
    if not _interactive_tty():
        return _multi_select_fallback(title, options)

    import msvcrt

    idx = 0
    selected: set[int] = set()
    lines_printed = 0

    def render(first: bool = False) -> None:
        nonlocal lines_printed
        if not first:
            sys.stdout.write(f"\x1b[{lines_printed}A")
        rows = [title, ""]
        for i, opt in enumerate(options):
            cursor = "> " if i == idx else "  "
            box = "[x]" if i in selected else "[ ]"
            rows.append(f"{cursor}{box} {opt}")
        rows.append("")
        rows.append("(↑/↓ 移动，空格 勾选/取消，A 全选/取消全选，Enter 确认)")
        for row in rows:
            sys.stdout.write("\x1b[2K" + row + "\n")
        sys.stdout.flush()
        lines_printed = len(rows)

    render(first=True)
    while True:
        key = msvcrt.getch()
        if key in (b"\xe0", b"\x00"):
            key2 = msvcrt.getch()
            if key2 == b"H":
                idx = (idx - 1) % len(options)
                render()
            elif key2 == b"P":
                idx = (idx + 1) % len(options)
                render()
        elif key == b" ":
            if idx in selected:
                selected.discard(idx)
            else:
                selected.add(idx)
            render()
        elif key in (b"a", b"A"):
            selected = set() if len(selected) == len(options) else set(range(len(options)))
            render()
        elif key in (b"\r", b"\n"):
            return sorted(selected)
        elif key == b"\x03":
            raise KeyboardInterrupt


def _multi_select_fallback(title: str, options: list[str]) -> list[int]:
    print(title)
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {opt}")
    sel = input("输入序号（多个用逗号分隔，all=全部，留空=取消）: ").strip()
    if not sel:
        return []
    if sel.lower() == "all":
        return list(range(len(options)))
    try:
        indices = [int(x.strip()) - 1 for x in sel.split(",")]
    except ValueError:
        return []
    return sorted({i for i in indices if 0 <= i < len(options)})


def confirm(prompt: str, default: bool = True) -> bool:
    """方向键选择 是/否，回车确认。"""
    idx = select_menu(prompt, ["是", "否"], default=0 if default else 1)
    return idx == 0


class App:
    def __init__(self) -> None:
        self.settings = load_settings()
        self.client = LibraryClient()
        self.plans = PlanRepository(self.settings.plans_file)
        self.notifier = Notifier(self.settings.log_file, self.settings.wechat_webhook)

    # ------------------------------------------------------------------
    # 认证
    # ------------------------------------------------------------------
    def _authenticate_from_cache(self) -> bool:
        """仅尝试用已缓存的 Cookie 认证，不做任何交互式输入。供非交互模式使用。"""
        cache_path = self.settings.session_cache
        try:
            self.client.load_cookie_cache(cache_path)
            if self.client.validate_cookie():
                self.client.resolve_uid()
                return True
        except (CookieError, HduLibraryError):
            pass
        return False

    def authenticate(self) -> None:
        if self._authenticate_from_cache():
            return

        print("\n未找到有效登录信息，请粘贴 Cookie 字符串完成认证。")
        cookie = input("Cookie: ").strip()
        if not cookie:
            print("未输入 Cookie，跳过认证。")
            return

        try:
            self.client.set_cookie_header(cookie)
        except CookieError as exc:
            print(f"Cookie 格式无效: {exc}")
            return

        print("正在验证 Cookie（联网请求，最多等待 {} 秒）...".format(self.client.timeout))
        try:
            valid = self.client.validate_cookie()
        except HduLibraryError as exc:
            print(f"Cookie 校验请求失败: {exc}")
            return

        if not valid:
            print("Cookie 无效或已过期，认证失败。")
            return

        try:
            self.client.resolve_uid()
        except HduLibraryError as exc:
            print(f"用户信息识别失败: {exc}")
            return

        print(f"认证成功：{self.client.name or '(未知姓名)'} (UID: {self.client.uid})")
        cache_path = self.settings.session_cache
        try:
            os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
            with open(cache_path, "w", encoding="utf-8") as f:
                f.write(cookie)
        except OSError:
            pass

    # ------------------------------------------------------------------
    # 主循环
    # ------------------------------------------------------------------
    def run(self) -> None:
        clear_screen()
        self.print_banner()
        self.authenticate()

        menu_items = [
            ("查看方案列表", self.handle_list_plans),
            ("创建预约方案", self.handle_create_plan),
            ("批量修改时间", self.handle_modify_time),
            ("删除方案", self.handle_delete_plan),
            ("立即抢座", self.handle_book_now),
            ("定时预约", self.handle_book_scheduled),
            ("浏览房间与座位", self.handle_browse_rooms),
            ("退出", self.handle_exit),
        ]

        while True:
            idx = select_menu("请选择操作：", [label for label, _ in menu_items])
            _, handler = menu_items[idx]
            try:
                if handler() is False:
                    break
            except KeyboardInterrupt:
                print("\n\n操作已取消")
            except Exception as exc:
                print(f"\n[错误] {exc}")

            input("\n按 Enter 继续...")
            clear_screen()

        print("\n再见！\n")

    def print_banner(self) -> None:
        print("=" * 52)
        print("   HDU 图书馆抢座工具 (HDU-Library-Sniper)")
        print("=" * 52)
        print(f"   当前方案数: {len(self.plans.load_all())} (启用: {len(self.plans.list_enabled())})")

    # ------------------------------------------------------------------
    # 1 — 方案列表
    # ------------------------------------------------------------------
    def handle_list_plans(self) -> None:
        plans = self.plans.load_all()
        if not plans:
            print("\n暂无预约方案，请先创建。")
            return
        self.print_plan_table(plans)

    @staticmethod
    def print_plan_table(plans: list[BookingPlan]) -> None:
        print(f"\n{'#':<3} {'ID':<12} {'房间':<6} {'楼层':<6} {'座位':<6} {'开始':<6} {'时长':<6} {'状态':<6}")
        print("-" * 60)
        for i, p in enumerate(plans, 1):
            status = "启用" if p.status == PlanStatus.ENABLED else "禁用"
            print(
                f"{i:<3} {p.plan_id or '-':<12} {p.room_type:<6} {p.floor_id:<6} "
                f"{p.seat_num:<6} {p.start_hour:02d}:00{'':<1} {p.duration_hours}h{'':<4} {status:<6}"
            )

    # ------------------------------------------------------------------
    # 2 — 创建方案
    # ------------------------------------------------------------------
    def handle_create_plan(self) -> None:
        print("\n== 创建预约方案 ==\n")
        room_types = self.client.get_room_types()
        if not room_types:
            print("无可用房间类型。")
            return
        idx = select_menu("选择房间类型：", [r["name"] for r in room_types])
        selected = room_types[idx]

        detail = self.client.get_room_detail(selected["query"])
        cat_id = detail["space_category"]["category_id"]
        con_id = detail["space_category"]["content_id"]
        lookup_time = get_seat_lookup_time()
        floors = self.client.get_seat_map(cat_id, con_id, lookup_time, 1)
        if not floors:
            print("该房间当前无可用楼层。")
            return

        floor_labels = []
        for f in floors:
            info = f.get("seatMap", {}).get("info", {})
            seat_count = len(f.get("seatMap", {}).get("POIs", []))
            floor_labels.append(f"ID {info.get('id', '?')}: {f.get('roomName', '?')} ({seat_count} 座)")
        floor_idx = select_menu("选择楼层：", floor_labels)
        floor_info = floors[floor_idx].get("seatMap", {}).get("info", {})
        floor_id = str(floor_info.get("id", ""))

        seat_num = input("输入座位号: ").strip()
        start_hour = input_int("开始小时 (0-23)", 0, 23, default=13)
        duration_hours = input_int("使用时长 (小时)", 1, 15, default=9)
        book_days = input_int("天数偏移 (0=今天,1=明天,2=后天...)", 0, 7, default=1)
        # 预约人仅用于本地方案列表展示，实际预约始终使用 Cookie 认证出的账号（服务器要求）。
        booker = self.client.name or self.client.uid

        room_type = self.resolve_room_type(selected["name"])
        if room_type is None:
            print(f"\n无法识别房间类型编号: '{selected['name']}'，将使用 1（自习室）。")
            room_type = 1

        plan = BookingPlan(
            room_type=room_type,
            floor_id=int(floor_id),
            seat_num=seat_num,
            start_hour=start_hour,
            duration_hours=duration_hours,
            booker_name=booker,
            book_days=book_days,
            room_query=selected["query"],
        )
        errors = plan.validate()
        if errors:
            print("\n方案校验失败:")
            for e in errors:
                print(f"  - {e}")
            return

        self.plans.add(plan)
        print(f"\n方案已创建 (ID: {plan.plan_id})")

    @staticmethod
    def resolve_room_type(name: str) -> int | None:
        from core.client import ROOM_TYPE_MAP

        for num, label in ROOM_TYPE_MAP.items():
            if label in name:
                return int(num)
        return None

    # ------------------------------------------------------------------
    # 3 — 批量修改时间
    # ------------------------------------------------------------------
    def handle_modify_time(self) -> None:
        plans = self.plans.load_all()
        if not plans:
            print("\n暂无方案。")
            return
        indices = multi_select_menu("选择要修改的方案：", self._plan_labels(plans))
        ids = [plans[i].plan_id for i in indices if plans[i].plan_id]
        if not ids:
            print("未选中任何方案")
            return

        print("\n输入新值（留空保持原值）:")
        sh = input("  开始小时 (0-23): ").strip()
        dh = input("  使用时长 (小时): ").strip()
        bd = input("  天数偏移: ").strip()

        kwargs = {}
        if sh:
            kwargs["start_hour"] = int(sh)
        if dh:
            kwargs["duration_hours"] = int(dh)
        if bd:
            kwargs["book_days"] = int(bd)

        if kwargs:
            modified = self.plans.batch_set_time(ids, **kwargs)
            print(f"已修改 {modified} 个方案")
        else:
            print("未做任何修改")

    @staticmethod
    def _plan_labels(plans: list[BookingPlan]) -> list[str]:
        labels = []
        for p in plans:
            status = "启用" if p.status == PlanStatus.ENABLED else "禁用"
            labels.append(
                f"{p.plan_id or '-'}  房间{p.room_type} 楼层{p.floor_id} {p.seat_num}座 "
                f"{p.start_hour:02d}:00 {p.duration_hours}h [{status}]"
            )
        return labels

    # ------------------------------------------------------------------
    # 4 — 删除方案
    # ------------------------------------------------------------------
    def handle_delete_plan(self) -> None:
        plans = self.plans.load_all()
        if not plans:
            print("\n暂无方案。")
            return
        indices = multi_select_menu("选择要删除的方案：", self._plan_labels(plans))
        ids = [plans[i].plan_id for i in indices if plans[i].plan_id]
        if ids:
            count = self.plans.remove_many(ids)
            print(f"已删除 {count} 个方案")
        else:
            print("未选中任何方案")

    # ------------------------------------------------------------------
    # 5 — 立即抢座
    # ------------------------------------------------------------------
    def handle_book_now(self) -> None:
        plans = self.plans.list_enabled()
        if not plans:
            print("\n没有启用的方案。")
            return
        self.print_plan_table(plans)
        print(f"\n将对 {len(plans)} 个方案依次尝试预约")
        if not confirm("确认开始？"):
            return

        sniper = Sniper(
            self.client,
            self.notifier,
            max_trials=self.settings.max_trials,
            retry_delay=self.settings.retry_delay,
            dry_run=self.settings.dry_run,
            window_wait_seconds=self.settings.window_wait_seconds,
            window_poll_interval=self.settings.window_poll_interval,
        )

        def on_progress(result) -> None:
            icon = "OK" if result.success else "X"
            print(f"  [{icon}] [{result.plan.to_plan_code()}] {result.message}")

        results = sniper.book_all(plans, on_progress=on_progress)
        succeeded = [r for r in results if r.success]
        if succeeded:
            print(f"\n预约成功！共尝试 {len(results)} 次")
        else:
            print(f"\n预约失败。共尝试 {len(results)} 次")

    # ------------------------------------------------------------------
    # 6 — 定时预约
    # ------------------------------------------------------------------
    def handle_book_scheduled(self) -> None:
        plans = self.plans.list_enabled()
        if not plans:
            print("\n没有启用的方案。")
            return
        self.print_plan_table(plans)
        time_str = input("\n目标执行时间 (HH:MM 或 HH:MM:SS): ").strip()
        try:
            execute_at = parse_execute_time(time_str)
        except ValueError as exc:
            print(f"时间格式错误: {exc}")
            return
        if execute_at is None:
            print("请输入有效时间")
            return

        print(f"\n将在 {execute_at.strftime('%Y-%m-%d %H:%M:%S')} 开始执行")

        print("\n重试参数（留空使用 config.yaml 默认值，仅本次生效）：")
        max_trials = input_float(
            f"  最大重试次数 [{self.settings.max_trials}]", self.settings.max_trials, is_int=True
        )
        retry_delay = input_float(
            f"  重试基础延迟/秒 [{self.settings.retry_delay}]", self.settings.retry_delay
        )
        window_wait_seconds = input_float(
            f"  预约窗口等待超时/秒 [{self.settings.window_wait_seconds}]",
            self.settings.window_wait_seconds,
        )
        window_poll_interval = input_float(
            f"  预约窗口轮询间隔/秒 [{self.settings.window_poll_interval}]",
            self.settings.window_poll_interval,
        )

        if not confirm("确认？"):
            return

        sniper = Sniper(
            self.client,
            self.notifier,
            max_trials=int(max_trials),
            retry_delay=retry_delay,
            dry_run=self.settings.dry_run,
            window_wait_seconds=window_wait_seconds,
            window_poll_interval=window_poll_interval,
        )
        print("\n等待中... (按 Ctrl+C 取消)\n")

        def on_countdown(remaining: int) -> None:
            sys.stdout.write(f"\r倒计时: {format_countdown(remaining)}  ")
            sys.stdout.flush()

        def on_progress(result) -> None:
            icon = "OK" if result.success else "X"
            print(f"\n  [{icon}] [{result.plan.to_plan_code()}] {result.message}")

        try:
            results = sniper.book_at(plans, execute_at, on_countdown=on_countdown, on_progress=on_progress)
            sys.stdout.write("\n")
            if any(r.success for r in results):
                print("定时预约成功！")
            else:
                print("定时预约失败")
        except KeyboardInterrupt:
            sniper.cancelled = True
            print("\n\n定时预约已取消")

    # ------------------------------------------------------------------
    # 7 — 浏览房间与座位
    # ------------------------------------------------------------------
    def handle_browse_rooms(self) -> None:
        room_types = self.client.get_room_types()
        if not room_types:
            print("\n无可用房间类型。")
            return

        print("\n== 房间与座位浏览 ==\n")
        for room in room_types:
            print(f"[{room['name']}]")
            try:
                detail = self.client.get_room_detail(room["query"])
                cat_id = detail["space_category"]["category_id"]
                con_id = detail["space_category"]["content_id"]
                lookup_time = get_seat_lookup_time()
                floors = self.client.get_seat_map(cat_id, con_id, lookup_time, 1)
            except HduLibraryError as exc:
                print(f"  查询失败: {exc}")
                continue
            for f in floors:
                info = f.get("seatMap", {}).get("info", {})
                seats = f.get("seatMap", {}).get("POIs", [])
                seat_nums = sorted(s.get("title", "") for s in seats if s.get("title"))
                preview = ", ".join(seat_nums[:10])
                if len(seat_nums) > 10:
                    preview += f" ... (+{len(seat_nums) - 10})"
                print(f"  - {f.get('roomName', '?')} (ID {info.get('id', '?')}): [{preview}]")
            print()

    # ------------------------------------------------------------------
    # 0 — 退出
    # ------------------------------------------------------------------
    def handle_exit(self) -> bool:
        return False

    # ------------------------------------------------------------------
    # 非交互模式：供 Windows 任务计划程序等外部调度器调用
    # ------------------------------------------------------------------
    def run_once(self) -> int:
        """认证 + 立即抢座一次，全程无需键盘输入，返回退出码。

        专为外部调度器（如 Windows 任务计划程序）设计：每天定时拉起本进程
        跑一次即退出，不需要程序自己常驻。日志/结果通过 Notifier 写入
        config.yaml 里配置的 log_file，方便事后排查。
        """
        if not self._authenticate_from_cache():
            self.notifier.send(
                "抢座任务无法启动",
                f"Cookie 缓存缺失或已过期（{self.settings.session_cache}），"
                f"请先用交互模式重新登录一次以刷新缓存。",
                success=False,
            )
            return 2

        plans = self.plans.list_enabled()
        if not plans:
            self.notifier.send("抢座任务无可用方案", "没有启用的预约方案，任务跳过。", success=False)
            return 3

        sniper = Sniper(
            self.client,
            self.notifier,
            max_trials=self.settings.max_trials,
            retry_delay=self.settings.retry_delay,
            dry_run=self.settings.dry_run,
            window_wait_seconds=self.settings.window_wait_seconds,
            window_poll_interval=self.settings.window_poll_interval,
        )

        def on_progress(result) -> None:
            icon = "OK" if result.success else "X"
            print(f"[{icon}] [{result.plan.to_plan_code()}] {result.message}")

        results = sniper.book_all(plans, on_progress=on_progress)
        return 0 if any(r.success for r in results) else 1


def main() -> None:
    if "--run-now" in sys.argv[1:]:
        # 非交互模式：不打印菜单、不等待任何键盘输入，跑完立即退出。
        # 退出码：0=成功 1=全部尝试失败 2=认证失败 3=无启用方案，方便任务计划程序按结果判断。
        sys.exit(App().run_once())
    App().run()


if __name__ == "__main__":
    main()
