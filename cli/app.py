"""终端交互式应用：菜单循环与各操作 handler。"""

from __future__ import annotations

import sys

from cli.menu import confirm, multi_select_menu, select_menu
from cli.prompts import (
    clear_screen,
    format_countdown,
    input_float,
    input_int,
    parse_execute_time,
)
from cli.views import plan_labels, print_banner, print_plan_table
from core.client import HduLibraryError
from core.room_browser import RoomBrowser
from core.sniper import BookingPlan
from services.auth import AuthService
from services.booking import BookingService
from services.runtime import build_runtime


class InteractiveApp:
    """交互式菜单应用：UI 编排 + 委托 services / core 完成实际工作。"""

    def __init__(self) -> None:
        self.settings, self.client, self.plans, self.notifier = build_runtime()
        self.auth = AuthService(self.client, self.settings)
        self.rooms = RoomBrowser(self.client)
        self.booking = BookingService(self.settings, self.client, self.plans, self.notifier)

    # ------------------------------------------------------------------
    # 认证
    # ------------------------------------------------------------------
    def _authenticate(self) -> None:
        if self.auth.try_cache():
            return

        print("\n未找到有效登录信息，请粘贴 Cookie 字符串完成认证。")
        cookie = input("Cookie: ").strip()
        if not cookie:
            print("未输入 Cookie，跳过认证。")
            return

        print("正在验证 Cookie（联网请求，最多等待 {} 秒）...".format(self.client.timeout))
        ok, msg = self.auth.authenticate_with_cookie(cookie)
        print(msg)
        if ok:
            self.auth.save_cache(cookie)

    # ------------------------------------------------------------------
    # 主循环
    # ------------------------------------------------------------------
    def run(self) -> None:
        clear_screen()
        print_banner(self.plans)
        self._authenticate()

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

    # ------------------------------------------------------------------
    # 1 — 方案列表
    # ------------------------------------------------------------------
    def handle_list_plans(self) -> None:
        plans = self.plans.load_all()
        if not plans:
            print("\n暂无预约方案，请先创建。")
            return
        print_plan_table(plans)

    # ------------------------------------------------------------------
    # 2 — 创建方案
    # ------------------------------------------------------------------
    def handle_create_plan(self) -> None:
        print("\n== 创建预约方案 ==\n")
        room_types = self.rooms.list_room_types()
        if not room_types:
            print("无可用房间类型。")
            return
        idx = select_menu("选择房间类型：", [r["name"] for r in room_types])
        selected = room_types[idx]

        floors = self.rooms.list_floors(selected["query"])
        if not floors:
            print("该房间当前无可用楼层。")
            return

        floor_labels = [f"ID {f.floor_id or '?'}: {f.room_name} ({f.seat_count} 座)" for f in floors]
        floor_idx = select_menu("选择楼层：", floor_labels)
        floor = floors[floor_idx]

        seat_num = input("输入座位号: ").strip()
        start_hour = input_int("开始小时 (0-23)", 0, 23, default=13)
        duration_hours = input_int("使用时长 (小时)", 1, 15, default=9)
        book_days = input_int("天数偏移 (0=今天,1=明天,2=后天...)", 0, 7, default=1)
        # 预约人仅用于本地方案列表展示，实际预约始终使用 Cookie 认证出的账号（服务器要求）。
        booker = self.client.name or self.client.uid

        room_type = RoomBrowser.resolve_room_type(selected["name"])
        if room_type is None:
            print(f"\n无法识别房间类型编号: '{selected['name']}'，将使用 1（自习室）。")
            room_type = 1

        plan = BookingPlan(
            room_type=room_type,
            floor_id=int(floor.floor_id),
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

    # ------------------------------------------------------------------
    # 3 — 批量修改时间
    # ------------------------------------------------------------------
    def handle_modify_time(self) -> None:
        plans = self.plans.load_all()
        if not plans:
            print("\n暂无方案。")
            return
        indices = multi_select_menu("选择要修改的方案：", plan_labels(plans))
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

    # ------------------------------------------------------------------
    # 4 — 删除方案
    # ------------------------------------------------------------------
    def handle_delete_plan(self) -> None:
        plans = self.plans.load_all()
        if not plans:
            print("\n暂无方案。")
            return
        indices = multi_select_menu("选择要删除的方案：", plan_labels(plans))
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
        print_plan_table(plans)
        print(f"\n将对 {len(plans)} 个方案依次尝试预约")
        if not confirm("确认开始？"):
            return

        def on_progress(result) -> None:
            icon = "OK" if result.success else "X"
            print(f"  [{icon}] [{result.plan.to_plan_code()}] {result.message}")

        results = self.booking.book_now(plans, on_progress=on_progress)
        if any(r.success for r in results):
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
        print_plan_table(plans)
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

        print("\n等待中... (按 Ctrl+C 取消)\n")

        def on_countdown(remaining: int) -> None:
            sys.stdout.write(f"\r倒计时: {format_countdown(remaining)}  ")
            sys.stdout.flush()

        def on_progress(result) -> None:
            icon = "OK" if result.success else "X"
            print(f"\n  [{icon}] [{result.plan.to_plan_code()}] {result.message}")

        try:
            results = self.booking.book_scheduled(
                plans,
                execute_at,
                on_countdown=on_countdown,
                on_progress=on_progress,
                max_trials=int(max_trials),
                retry_delay=retry_delay,
                window_wait_seconds=window_wait_seconds,
                window_poll_interval=window_poll_interval,
            )
            sys.stdout.write("\n")
            if any(r.success for r in results):
                print("定时预约成功！")
            else:
                print("定时预约失败")
        except KeyboardInterrupt:
            print("\n\n定时预约已取消")

    # ------------------------------------------------------------------
    # 7 — 浏览房间与座位
    # ------------------------------------------------------------------
    def handle_browse_rooms(self) -> None:
        room_types = self.rooms.list_room_types()
        if not room_types:
            print("\n无可用房间类型。")
            return

        print("\n== 房间与座位浏览 ==\n")
        for room in room_types:
            print(f"[{room['name']}]")
            try:
                floors = self.rooms.list_floors(room["query"])
            except HduLibraryError as exc:
                print(f"  查询失败: {exc}")
                continue
            for f in floors:
                seat_nums = f.seat_titles
                preview = ", ".join(seat_nums[:10])
                if len(seat_nums) > 10:
                    preview += f" ... (+{len(seat_nums) - 10})"
                print(f"  - {f.room_name} (ID {f.floor_id or '?'}): [{preview}]")
            print()

    # ------------------------------------------------------------------
    # 0 — 退出
    # ------------------------------------------------------------------
    def handle_exit(self) -> bool:
        return False
