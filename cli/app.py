"""终端交互式应用：菜单循环与各操作 handler。"""

from __future__ import annotations

import sys

from cli.menu import confirm, multi_select_menu, select_menu
from cli.prompts import (
    clear_screen,
    format_countdown,
    input_float,
    input_int,
    prompt_credentials,
)
from utils.time_utils import parse_execute_time
from cli.views import format_progress_line, plan_labels, print_banner, print_plan_table
from config.settings import Credentials, load_credentials, save_credentials
from services import (
    AuthService,
    BookingService,
    BrowserAuthService,
    HduLibraryError,
    PlanService,
    build_runtime,
)


class InteractiveApp:
    """交互式菜单应用：UI 编排 + 委托 services 完成实际工作。

    只依赖 services 单一入口（运行时装配 / 认证 / 抢座 / 方案编排），
    不直连 core——方案管理与浏览编排收口在 PlanService，抢座编排收口在
    BookingService，本类只做菜单与输入输出。
    """

    def __init__(self) -> None:
        settings, client, plans, notifier = build_runtime()
        self.settings = settings
        self.auth = AuthService(client, settings)
        self.browser_auth = BrowserAuthService(client, settings)
        self.booking = BookingService(settings, client, plans, notifier)
        # 复用 BookingService 已构造的 RoomBrowser，避免重复实例化。
        self.plan_service = PlanService(client, plans, self.booking.room_browser)
        # 已保存的学号+密码凭据（data/credentials.yaml，已 gitignore）；为空则首次登录时询问。
        self.credentials = load_credentials(settings.credentials_file)

    # ------------------------------------------------------------------
    # 认证
    # ------------------------------------------------------------------
    def _prompt_and_save_credentials(self) -> Credentials | None:
        """交互式询问学号+密码并保存到 data/credentials.yaml（供非交互 --run-now 自愈复用）。"""
        default_sid = self.credentials.student_id if self.credentials else ""
        sid, pwd = prompt_credentials(default_student_id=default_sid)
        creds = Credentials(student_id=sid, password=pwd)
        try:
            save_credentials(self.settings.credentials_file, creds)
            print(f"凭据已保存到 {self.settings.credentials_file}（已 gitignore，供定时任务复用）")
        except OSError as exc:
            print(f"凭据保存失败（不影响本次登录）：{exc}")
        self.credentials = creds
        return creds

    def _authenticate(self) -> None:
        if self.auth.try_cache():
            return

        # 缓存无效 → 用已保存凭据静默登录；没有凭据则交互式询问并保存。
        creds = self.credentials or self._prompt_and_save_credentials()
        if not creds:
            return
        ok, msg = self.browser_auth.login_with_credentials(creds.student_id, creds.password)
        print(msg)

    # ------------------------------------------------------------------
    # 主循环
    # ------------------------------------------------------------------
    def run(self) -> None:
        clear_screen()
        print_banner(
            len(self.plan_service.list_plans()),
            len(self.plan_service.list_enabled()),
        )
        self._authenticate()

        menu_items = [
            ("查看方案列表", self.handle_list_plans),
            ("创建预约方案", self.handle_create_plan),
            ("批量修改时间", self.handle_modify_time),
            ("删除方案", self.handle_delete_plan),
            ("立即抢座", self.handle_book_now),
            ("定时预约", self.handle_book_scheduled),
            ("浏览房间与座位", self.handle_browse_rooms),
            ("重新登录", self.handle_relogin),
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
        plans = self.plan_service.list_plans()
        if not plans:
            print("\n暂无预约方案，请先创建。")
            return
        print_plan_table(plans)

    # ------------------------------------------------------------------
    # 2 — 创建方案
    # ------------------------------------------------------------------
    def handle_create_plan(self) -> None:
        print("\n== 创建预约方案 ==\n")
        room_types = self.plan_service.list_room_types()
        if not room_types:
            print("无可用房间类型。")
            return
        idx = select_menu("选择房间类型：", [r["name"] for r in room_types])
        selected = room_types[idx]

        floors = self.plan_service.list_floors(selected["query"])
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

        # 构造 / 校验 / 持久化由 PlanService 编排；booker 取认证账号（服务器要求）。
        plan, errors, fell_back = self.plan_service.create_plan(
            room_type_name=selected["name"],
            room_query=selected["query"],
            floor_id=int(floor.floor_id),
            seat_num=seat_num,
            start_hour=start_hour,
            duration_hours=duration_hours,
            book_days=book_days,
        )
        if fell_back:
            print(f"\n无法识别房间类型编号: '{selected['name']}'，将使用 1（自习室）。")
        if errors:
            print("\n方案校验失败:")
            for e in errors:
                print(f"  - {e}")
            return
        print(f"\n方案已创建 (ID: {plan.plan_id})")

    # ------------------------------------------------------------------
    # 3 — 批量修改时间
    # ------------------------------------------------------------------
    def handle_modify_time(self) -> None:
        plans = self.plan_service.list_plans()
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
            modified = self.plan_service.modify_time(ids, **kwargs)
            print(f"已修改 {modified} 个方案")
        else:
            print("未做任何修改")

    # ------------------------------------------------------------------
    # 4 — 删除方案
    # ------------------------------------------------------------------
    def handle_delete_plan(self) -> None:
        plans = self.plan_service.list_plans()
        if not plans:
            print("\n暂无方案。")
            return
        indices = multi_select_menu("选择要删除的方案：", plan_labels(plans))
        ids = [plans[i].plan_id for i in indices if plans[i].plan_id]
        if ids:
            count = self.plan_service.delete_plans(ids)
            print(f"已删除 {count} 个方案")
        else:
            print("未选中任何方案")

    # ------------------------------------------------------------------
    # 5 — 立即抢座
    # ------------------------------------------------------------------
    def handle_book_now(self) -> None:
        plans = self.plan_service.list_enabled()
        if not plans:
            print("\n没有启用的方案。")
            return
        print_plan_table(plans)
        print(f"\n将对 {len(plans)} 个方案依次尝试预约")
        if not confirm("确认开始？"):
            return

        def on_progress(result) -> None:
            print(format_progress_line(result, indent="  "))

        results = self.booking.book_now(plans, on_progress=on_progress)
        if any(r.success for r in results):
            print(f"\n预约成功！共尝试 {len(results)} 次")
        else:
            print(f"\n预约失败。共尝试 {len(results)} 次")

    # ------------------------------------------------------------------
    # 6 — 定时预约
    # ------------------------------------------------------------------
    def handle_book_scheduled(self) -> None:
        plans = self.plan_service.list_enabled()
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
            print("\n" + format_progress_line(result, indent="  "))

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
        room_types = self.plan_service.list_room_types()
        if not room_types:
            print("\n无可用房间类型。")
            return

        print("\n== 房间与座位浏览 ==\n")
        for room in room_types:
            print(f"[{room['name']}]")
            try:
                floors = self.plan_service.list_floors(room["query"])
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
    # 8 — 重新登录
    # ------------------------------------------------------------------
    def handle_relogin(self) -> None:
        """重新输入学号+密码登录（密码改了 / 想刷新登录态时用）。"""
        creds = self._prompt_and_save_credentials()
        if not creds:
            return
        ok, msg = self.browser_auth.login_with_credentials(creds.student_id, creds.password)
        print(msg)

    # ------------------------------------------------------------------
    # 0 — 退出
    # ------------------------------------------------------------------
    def handle_exit(self) -> bool:
        return False
