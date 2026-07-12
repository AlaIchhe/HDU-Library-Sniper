"""Flet 跨平台界面：桌面窗口与 Docker Web 共用同一套控件树。"""

from __future__ import annotations

import asyncio
import contextlib
import os
from datetime import datetime
from functools import lru_cache

import flet as ft

from application import ApplicationEvent, EventKind, JobState, SniperApplication, build_application
from core.client import ROOM_TYPE_MAP
from utils.time_utils import parse_execute_time


@lru_cache(maxsize=1)
def get_application() -> SniperApplication:
    """返回进程级应用实例，确保多个 Web 会话共享任务互斥和状态。"""
    return build_application()


class SniperFletView:
    """单个 Flet Page 的展示适配器。"""

    def __init__(self, page: ft.Page, application: SniperApplication) -> None:
        self.page = page
        self.application = application
        self.selected_plan_ids: set[str] = set()
        self.room_types: dict[str, dict] = {}
        self.floors: dict[str, object] = {}

        self._configure_page()
        self._build_controls()
        self.unsubscribe = self.application.subscribe(self._on_application_event)
        self.page.on_disconnect = lambda _event: self.unsubscribe()
        self.page.on_close = lambda _event: self.unsubscribe()
        self.page.on_resize = self._resize
        self._render_shell()
        self._load_initial_state()

    def _configure_page(self) -> None:
        self.page.title = "HDU Library Sniper"
        self.page.padding = 0
        self.page.bgcolor = ft.Colors.GREY_50
        self.page.theme_mode = ft.ThemeMode.LIGHT
        self.page.theme = ft.Theme(
            color_scheme_seed=ft.Colors.TEAL,
            visual_density=ft.VisualDensity.COMFORTABLE,
        )

    def _build_controls(self) -> None:
        credentials = self.application.saved_credentials()
        self.global_status = ft.Text("就绪", size=13, color=ft.Colors.BLUE_GREY_900)

        self.student_id = ft.TextField(
            label="学号",
            value=credentials.student_id if credentials else "",
            prefix_icon=ft.Icons.PERSON,
            col={"sm": 12, "md": 6},
        )
        self.password = ft.TextField(
            label="数字杭电密码",
            password=True,
            can_reveal_password=True,
            prefix_icon=ft.Icons.LOCK,
            col={"sm": 12, "md": 6},
            on_submit=self._login,
        )
        self.login_button = ft.FilledButton(
            "登录",
            icon=ft.Icons.LOGIN,
            on_click=self._login,
        )
        self.auth_state = ft.Text("尚未认证", color=ft.Colors.AMBER_700, weight=ft.FontWeight.W_600)
        self.auth_log = ft.TextField(
            value="",
            multiline=True,
            read_only=True,
            min_lines=5,
            max_lines=8,
            label="认证记录",
        )

        self.plan_list = ft.ListView(spacing=6, expand=True)
        self.plan_summary = ft.Text("暂无方案", color=ft.Colors.BLUE_GREY_900)
        self.delete_button = ft.Button(
            "删除",
            icon=ft.Icons.DELETE,
            color=ft.Colors.RED_600,
            on_click=self._delete_selected_plans,
            disabled=True,
        )
        self.refresh_plans_button = ft.IconButton(
            ft.Icons.REFRESH,
            tooltip="刷新方案",
            on_click=lambda _event: self._refresh_plans(),
        )
        self.room_type = ft.Dropdown(
            label="房间类型",
            options=[],
            on_select=self._load_floors,
            col={"sm": 12, "md": 6},
        )
        self.floor = ft.Dropdown(
            label="楼层",
            options=[],
            on_select=self._update_seat_hint,
            disabled=True,
            col={"sm": 12, "md": 6},
        )
        self.seat_num = ft.TextField(label="座位号", col={"sm": 12, "md": 3})
        self.start_hour = ft.TextField(label="开始小时", value="8", col={"sm": 4, "md": 3})
        self.duration_hours = ft.TextField(label="使用时长", value="4", col={"sm": 4, "md": 3})
        self.book_days = ft.TextField(label="提前天数", value="1", col={"sm": 4, "md": 3})
        self.seat_hint = ft.Text("选择房间和楼层后显示可用座位", size=12)
        self.create_plan_button = ft.FilledButton(
            "创建方案",
            icon=ft.Icons.ADD,
            on_click=self._create_plan,
        )
        self.modify_button = ft.Button(
            "更新所选时间",
            icon=ft.Icons.EDIT,
            on_click=self._modify_selected_plans,
            disabled=True,
        )

        self.execute_time = ft.TextField(
            label="执行时间（留空立即执行）",
            hint_text="HH:MM 或 HH:MM:SS",
            width=280,
        )
        self.start_booking_button = ft.FilledButton(
            "开始抢座",
            icon=ft.Icons.PLAY_ARROW,
            on_click=self._start_booking,
        )
        self.cancel_booking_button = ft.Button(
            "取消",
            icon=ft.Icons.STOP,
            color=ft.Colors.RED_600,
            on_click=self._cancel_booking,
            disabled=True,
        )
        self.job_state = ft.Text("空闲", size=18, weight=ft.FontWeight.W_600)
        self.countdown = ft.Text("", size=28, color=ft.Colors.TEAL_700, visible=False)
        self.booking_log = ft.ListView(spacing=4, auto_scroll=True, expand=True)

        self.schedule_time = ft.TextField(label="每天执行时间", value="23:59:55", width=220)
        self.wake_to_run = ft.Switch(label="唤醒计算机", value=True)
        self.scheduler_status = ft.Text("正在读取调度状态")
        self.scheduler_log = ft.ListView(spacing=4, auto_scroll=True, expand=True)

        self.views = [
            self._auth_view(),
            self._plans_view(),
            self._booking_view(),
            self._scheduler_view(),
        ]
        self.view_host = ft.Container(content=self.views[0], padding=24, expand=True)

    def _section_title(self, title: str, subtitle: str) -> ft.Column:
        return ft.Column(
            [
                ft.Text(title, size=24, weight=ft.FontWeight.W_700, color=ft.Colors.BLUE_GREY_900),
                ft.Text(subtitle, size=13, color=ft.Colors.GREY_700),
            ],
            spacing=2,
        )

    def _surface(self, content: ft.Control, *, col=12, height: int | None = None) -> ft.Container:
        return ft.Container(
            content=content,
            padding=18,
            bgcolor=ft.Colors.WHITE,
            border=ft.Border.all(1, ft.Colors.GREY_200),
            border_radius=6,
            col=col,
            height=height,
        )

    def _auth_view(self) -> ft.Column:
        return ft.Column(
            [
                self._section_title("认证", "管理登录态和自动续登凭据"),
                self._surface(
                    ft.Column(
                        [
                            ft.Row([ft.Icon(ft.Icons.LOCK), self.auth_state], spacing=8),
                            ft.ResponsiveRow([self.student_id, self.password]),
                            ft.Row([self.login_button]),
                        ],
                        spacing=16,
                    ),
                ),
                self.auth_log,
            ],
            spacing=18,
            scroll=ft.ScrollMode.AUTO,
            expand=True,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

    def _plans_view(self) -> ft.Column:
        self.plan_panel = self._surface(
            ft.Column(
                [
                    ft.Row(
                        [self.plan_summary, self.refresh_plans_button, self.delete_button],
                        alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                    ),
                    ft.Divider(height=1),
                    self.plan_list,
                ],
                expand=True,
            ),
            col={"sm": 12, "lg": 7},
            height=520,
        )
        editor = self._surface(
            ft.Column(
                [
                    ft.Text("新建或批量调整", size=17, weight=ft.FontWeight.W_600),
                    ft.ResponsiveRow([self.room_type, self.floor]),
                    ft.ResponsiveRow(
                        [self.seat_num, self.start_hour, self.duration_hours, self.book_days],
                    ),
                    self.seat_hint,
                    ft.Row([self.create_plan_button, self.modify_button], wrap=True),
                ],
                spacing=14,
            ),
            col={"sm": 12, "lg": 5},
        )
        return ft.Column(
            [
                self._section_title("方案", "维护候选座位及执行优先级"),
                ft.ResponsiveRow([self.plan_panel, editor], spacing=14, run_spacing=14),
            ],
            spacing=18,
            scroll=ft.ScrollMode.AUTO,
            expand=True,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

    def _booking_view(self) -> ft.Column:
        return ft.Column(
            [
                self._section_title("执行", "立即运行或等待指定时刻开始"),
                self._surface(
                    ft.Column(
                        [
                            ft.Row(
                                [ft.Icon(ft.Icons.EVENT_SEAT, size=30), self.job_state],
                                spacing=10,
                            ),
                            self.countdown,
                            ft.Row(
                                [
                                    self.execute_time,
                                    self.start_booking_button,
                                    self.cancel_booking_button,
                                ],
                                wrap=True,
                            ),
                        ],
                        spacing=16,
                    ),
                ),
                self._surface(self.booking_log, height=360),
            ],
            spacing=18,
            expand=True,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

    def _scheduler_view(self) -> ft.Column:
        return ft.Column(
            [
                self._section_title("调度", "配置操作系统级每日自动任务"),
                self._surface(
                    ft.Column(
                        [
                            self.scheduler_status,
                            ft.Row([self.schedule_time, self.wake_to_run], wrap=True),
                            ft.Row(
                                [
                                    ft.FilledButton(
                                        "保存调度",
                                        icon=ft.Icons.SAVE,
                                        on_click=self._configure_scheduler,
                                    ),
                                    ft.Button(
                                        "刷新",
                                        icon=ft.Icons.REFRESH,
                                        on_click=self._refresh_scheduler,
                                    ),
                                    ft.Button(
                                        "测试执行",
                                        icon=ft.Icons.PLAY_ARROW,
                                        on_click=self._test_scheduler,
                                    ),
                                    ft.Button(
                                        "移除",
                                        icon=ft.Icons.DELETE,
                                        color=ft.Colors.RED_600,
                                        on_click=self._remove_scheduler,
                                    ),
                                ],
                                wrap=True,
                            ),
                        ],
                        spacing=16,
                    ),
                ),
                self._surface(self.scheduler_log, height=300),
            ],
            spacing=18,
            expand=True,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

    def _render_shell(self) -> None:
        self.navigation_rail = ft.NavigationRail(
            selected_index=0,
            label_type=ft.NavigationRailLabelType.ALL,
            min_width=76,
            min_extended_width=180,
            destinations=[
                ft.NavigationRailDestination(ft.Icons.LOCK, label="认证"),
                ft.NavigationRailDestination(ft.Icons.CHAIR, label="方案"),
                ft.NavigationRailDestination(ft.Icons.PLAY_ARROW, label="执行"),
                ft.NavigationRailDestination(ft.Icons.SCHEDULE, label="调度"),
            ],
            on_change=self._navigate,
        )
        self.bottom_navigation = ft.NavigationBar(
            selected_index=0,
            destinations=[
                ft.NavigationBarDestination(ft.Icons.LOCK, label="认证"),
                ft.NavigationBarDestination(ft.Icons.CHAIR, label="方案"),
                ft.NavigationBarDestination(ft.Icons.PLAY_ARROW, label="执行"),
                ft.NavigationBarDestination(ft.Icons.SCHEDULE, label="调度"),
            ],
            on_change=self._navigate,
            visible=False,
        )
        self.navigation_divider = ft.VerticalDivider(width=1)
        header = ft.Container(
            ft.Row(
                [
                    ft.Text("HDU Library Sniper", size=18, weight=ft.FontWeight.W_700),
                    self.global_status,
                ],
                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
            ),
            padding=ft.Padding.symmetric(horizontal=22, vertical=14),
            bgcolor=ft.Colors.WHITE,
            border=ft.Border(bottom=ft.BorderSide(1, ft.Colors.GREY_200)),
        )
        self.content_row = ft.Row(
            [self.navigation_rail, self.navigation_divider, self.view_host],
            expand=True,
        )
        body = ft.Column(
            [header, self.content_row, self.bottom_navigation],
            spacing=0,
            expand=True,
        )
        self.page.add(body)
        self._apply_responsive_layout()

    def _load_initial_state(self) -> None:
        if self.application.try_cached_authentication():
            self.auth_state.value = "已认证"
            self.auth_state.color = ft.Colors.GREEN_700
            self.auth_log.value = "已恢复缓存登录态"
        elif self.student_id.value:
            self.auth_log.value = "检测到已保存凭据，请输入密码后登录"
        self._refresh_plans()
        self.page.run_task(self._load_room_types)
        self.page.run_task(self._refresh_scheduler)
        self.page.update()

    def _navigate(self, event) -> None:
        selected_index = event.control.selected_index
        self.navigation_rail.selected_index = selected_index
        self.bottom_navigation.selected_index = selected_index
        self.view_host.content = self.views[selected_index]
        self.page.update()

    def _resize(self, event) -> None:
        self._apply_responsive_layout(width=event.width, update=True)

    def _apply_responsive_layout(
        self,
        *,
        width: float | None = None,
        update: bool = False,
    ) -> None:
        page_width = width if width is not None else self.page.width
        compact = bool(page_width and page_width < 700)
        self.navigation_rail.visible = not compact
        self.navigation_divider.visible = not compact
        self.bottom_navigation.visible = compact
        self.view_host.padding = 16 if compact else 24
        self.plan_panel.height = 320 if compact else 520
        if update:
            self.page.update()

    def _show_message(self, message: str, *, error: bool = False) -> None:
        self.page.show_dialog(
            ft.SnackBar(
                message,
                bgcolor=ft.Colors.RED_600 if error else ft.Colors.BLUE_GREY_900,
                show_close_icon=True,
            ),
        )

    def _append_line(self, target: ft.ListView, message: str, *, error: bool = False) -> None:
        target.controls.append(
            ft.Text(
                message,
                size=13,
                color=ft.Colors.RED_600 if error else ft.Colors.BLUE_GREY_900,
                selectable=True,
            ),
        )
        if len(target.controls) > 300:
            del target.controls[:50]

    async def _login(self, _event) -> None:
        student_id = (self.student_id.value or "").strip()
        password = (self.password.value or "").strip()
        if not student_id or not password:
            self._show_message("请输入学号和密码", error=True)
            return
        self.login_button.disabled = True
        self.auth_log.value = f"正在登录 {student_id}..."
        self.page.update()
        success, message = await asyncio.to_thread(
            self.application.authenticate,
            student_id,
            password,
        )
        self.login_button.disabled = False
        self.password.value = ""
        self.auth_log.value = message
        self.auth_state.value = "已认证" if success else "认证失败"
        self.auth_state.color = ft.Colors.GREEN_700 if success else ft.Colors.RED_600
        self._show_message(message, error=not success)
        self.page.update()

    async def _load_room_types(self) -> None:
        try:
            room_types = await asyncio.to_thread(self.application.list_room_types)
        except Exception as exc:
            self._show_message(f"房间类型加载失败: {exc}", error=True)
            return
        self.room_types = {str(item.get("query", "")): item for item in room_types}
        self.room_type.options = [
            ft.DropdownOption(key=query, text=str(item.get("name") or query))
            for query, item in self.room_types.items()
            if query
        ]
        self.page.update()

    async def _load_floors(self, _event) -> None:
        room_query = self.room_type.value or ""
        if not room_query:
            return
        self.floor.disabled = True
        self.floor.options = []
        self.seat_hint.value = "正在加载楼层和座位..."
        self.page.update()
        try:
            floors = await asyncio.to_thread(self.application.list_floors, room_query)
        except Exception as exc:
            self.seat_hint.value = f"加载失败: {exc}"
            self._show_message(self.seat_hint.value, error=True)
            self.page.update()
            return
        self.floors = {str(item.floor_id): item for item in floors}
        self.floor.options = [
            ft.DropdownOption(
                key=str(item.floor_id),
                text=f"{item.room_name} · {item.seat_count} 座",
            )
            for item in floors
        ]
        self.floor.disabled = not bool(floors)
        self.seat_hint.value = "选择楼层后显示座位范围"
        self.page.update()

    def _update_seat_hint(self, _event) -> None:
        floor = self.floors.get(self.floor.value or "")
        if floor is None:
            return
        seats = floor.seat_titles
        preview = "、".join(seats[:24])
        suffix = f" 等 {len(seats)} 个座位" if len(seats) > 24 else ""
        self.seat_hint.value = f"可用座位：{preview}{suffix}" if seats else "当前楼层没有座位数据"
        self.page.update()

    def _refresh_plans(self) -> None:
        plans = self.application.list_plans()
        self.selected_plan_ids.intersection_update(
            plan.plan_id for plan in plans if plan.plan_id is not None
        )
        self.plan_list.controls.clear()
        enabled_count = sum(plan.enabled for plan in plans)
        self.plan_summary.value = f"{len(plans)} 个方案 · {enabled_count} 个启用"
        for plan in plans:
            plan_id = plan.plan_id or ""
            checkbox = ft.Checkbox(value=plan_id in self.selected_plan_ids)

            def select_plan(event, selected_id=plan_id) -> None:
                if event.control.value:
                    self.selected_plan_ids.add(selected_id)
                else:
                    self.selected_plan_ids.discard(selected_id)
                self._sync_plan_actions()

            checkbox.on_change = select_plan
            status = "启用" if plan.enabled else "停用"
            room_name = ROOM_TYPE_MAP.get(str(plan.room_type), f"类型 {plan.room_type}")
            self.plan_list.controls.append(
                ft.Container(
                    ft.Row(
                        [
                            checkbox,
                            ft.Column(
                                [
                                    ft.Text(
                                        f"{room_name} · {plan.seat_num} 座",
                                        weight=ft.FontWeight.W_600,
                                    ),
                                    ft.Text(
                                        f"{plan.start_hour:02d}:00 起 · {plan.duration_hours} 小时 · 提前 {plan.book_days} 天",
                                        size=12,
                                        color=ft.Colors.GREY_700,
                                    ),
                                ],
                                spacing=2,
                                expand=True,
                            ),
                            ft.Text(
                                status,
                                color=ft.Colors.GREEN_700 if plan.enabled else ft.Colors.GREY_700,
                            ),
                        ],
                    ),
                    padding=10,
                    border=ft.Border(bottom=ft.BorderSide(1, ft.Colors.GREY_200)),
                ),
            )
        if not plans:
            self.plan_list.controls.append(ft.Text("暂无预约方案", color=ft.Colors.GREY_700))
        self._sync_plan_actions(update=False)
        with contextlib.suppress(RuntimeError):
            self.page.update()

    def _sync_plan_actions(self, *, update: bool = True) -> None:
        disabled = not bool(self.selected_plan_ids)
        self.delete_button.disabled = disabled
        self.modify_button.disabled = disabled
        if update:
            self.page.update()

    async def _create_plan(self, _event) -> None:
        room_query = self.room_type.value or ""
        room = self.room_types.get(room_query)
        if not room or not self.floor.value or not (self.seat_num.value or "").strip():
            self._show_message("请选择房间、楼层并填写座位号", error=True)
            return
        try:
            plan, errors, fell_back = await asyncio.to_thread(
                self.application.create_plan,
                room_type_name=str(room.get("name", "")),
                room_query=room_query,
                floor_id=int(self.floor.value),
                seat_num=(self.seat_num.value or "").strip(),
                start_hour=int(self.start_hour.value or "0"),
                duration_hours=int(self.duration_hours.value or "0"),
                book_days=int(self.book_days.value or "0"),
            )
        except (TypeError, ValueError) as exc:
            self._show_message(f"方案字段无效: {exc}", error=True)
            return
        if errors:
            self._show_message("；".join(errors), error=True)
            return
        self.seat_num.value = ""
        self._refresh_plans()
        message = f"方案 {plan.plan_id} 已创建"
        if fell_back:
            message += "，房间类型已回退为自习室"
        self._show_message(message)

    async def _delete_selected_plans(self, _event) -> None:
        removed = await asyncio.to_thread(
            self.application.delete_plans,
            list(self.selected_plan_ids),
        )
        self.selected_plan_ids.clear()
        self._refresh_plans()
        self._show_message(f"已删除 {removed} 个方案")

    async def _modify_selected_plans(self, _event) -> None:
        try:
            values = {
                "start_hour": int(self.start_hour.value or "0"),
                "duration_hours": int(self.duration_hours.value or "0"),
                "book_days": int(self.book_days.value or "0"),
            }
        except ValueError:
            self._show_message("时间字段必须是整数", error=True)
            return
        modified = await asyncio.to_thread(
            self.application.modify_plan_times,
            list(self.selected_plan_ids),
            **values,
        )
        self._refresh_plans()
        self._show_message(f"已更新 {modified} 个方案")

    async def _start_booking(self, _event) -> None:
        execute_at: datetime | None = None
        if (self.execute_time.value or "").strip():
            try:
                execute_at = parse_execute_time((self.execute_time.value or "").strip())
            except ValueError as exc:
                self._show_message(f"执行时间无效: {exc}", error=True)
                return
        self.booking_log.controls.clear()
        self.start_booking_button.disabled = True
        self.cancel_booking_button.disabled = False
        self.page.update()
        try:
            await asyncio.to_thread(self.application.run_booking, execute_at)
        except Exception as exc:
            self._show_message(str(exc), error=True)
        finally:
            self.start_booking_button.disabled = False
            self.cancel_booking_button.disabled = True
            self.page.update()

    def _cancel_booking(self, _event) -> None:
        if self.application.cancel_booking():
            self._append_line(self.booking_log, "正在取消任务")
        else:
            self._show_message("当前没有可取消的任务", error=True)
        self.page.update()

    async def _refresh_scheduler(self, _event=None) -> None:
        status = await asyncio.to_thread(self.application.scheduler_status)
        if status.exists:
            details = ["定时任务已配置"]
            if status.execute_time:
                details.append(f"每天 {status.execute_time}")
            if status.next_run:
                details.append(f"下次运行 {status.next_run}")
            self.scheduler_status.value = " · ".join(details)
            self.scheduler_status.color = ft.Colors.GREEN_700
        else:
            self.scheduler_status.value = "尚未配置系统定时任务"
            self.scheduler_status.color = ft.Colors.AMBER_700
        self.page.update()

    async def _configure_scheduler(self, _event) -> None:
        if not self.application.list_enabled_plans():
            self._show_message("请先创建并启用至少一个方案", error=True)
            return
        success, message = await asyncio.to_thread(
            self.application.configure_scheduler,
            (self.schedule_time.value or "").strip(),
            bool(self.wake_to_run.value),
        )
        self._append_line(self.scheduler_log, message, error=not success)
        self._show_message(message, error=not success)
        await self._refresh_scheduler()

    async def _remove_scheduler(self, _event) -> None:
        success, message = await asyncio.to_thread(self.application.remove_scheduler)
        self._append_line(self.scheduler_log, message, error=not success)
        self._show_message(message, error=not success)
        await self._refresh_scheduler()

    async def _test_scheduler(self, _event) -> None:
        success, message = await asyncio.to_thread(self.application.test_scheduler)
        self._append_line(self.scheduler_log, message, error=not success)
        self._show_message(message[:240], error=not success)
        self.page.update()

    def _on_application_event(self, event: ApplicationEvent) -> None:
        state_names = {
            JobState.IDLE: "空闲",
            JobState.AUTHENTICATING: "认证中",
            JobState.WAITING: "等待执行",
            JobState.RUNNING: "执行中",
            JobState.CANCELLING: "取消中",
            JobState.SUCCEEDED: "预约成功",
            JobState.FAILED: "执行失败",
            JobState.CANCELLED: "已取消",
        }
        self.global_status.value = state_names[event.state]
        self.job_state.value = state_names[event.state]
        self.job_state.color = (
            ft.Colors.GREEN_700
            if event.state == JobState.SUCCEEDED
            else ft.Colors.RED_600
            if event.state == JobState.FAILED
            else ft.Colors.BLUE_GREY_900
        )
        if event.kind == EventKind.COUNTDOWN:
            remaining = int(event.payload.get("remaining", 0))
            hours, remainder = divmod(remaining, 3600)
            minutes, seconds = divmod(remainder, 60)
            self.countdown.value = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
            self.countdown.visible = True
        elif event.kind == EventKind.PROGRESS:
            marker = "成功" if event.payload.get("success") else "失败"
            self._append_line(
                self.booking_log,
                f"[{marker}] {event.payload.get('seat_num', '?')} 座 · {event.message}",
                error=not bool(event.payload.get("success")),
            )
        elif event.kind == EventKind.RESULT:
            self.countdown.visible = False
            self._append_line(
                self.booking_log, event.message, error=not event.payload.get("success")
            )
        elif event.kind == EventKind.ERROR:
            self._append_line(self.booking_log, event.message, error=True)
        with contextlib.suppress(RuntimeError):
            self.page.update()


def flet_main(page: ft.Page) -> None:
    SniperFletView(page, get_application())


def run_flet_app(*, web: bool = False) -> None:
    """启动桌面 Flet 客户端或 Docker Web 服务。"""
    if web:
        import uvicorn

        host = os.environ.get("FLET_SERVER_IP", "0.0.0.0")
        port = int(os.environ.get("FLET_SERVER_PORT", "8000"))
        uvicorn.run("interfaces.api:app", host=host, port=port)
    else:
        ft.run(flet_main, view=ft.AppView.FLET_APP)
