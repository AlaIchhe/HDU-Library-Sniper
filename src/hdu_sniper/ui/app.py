"""Flet 跨平台界面：桌面窗口与 Docker Web 共用同一套控件树。"""

from __future__ import annotations

import asyncio
import contextlib
import sys
from datetime import datetime
from pathlib import Path

import flet as ft

from hdu_sniper.app import SniperApp
from hdu_sniper.booking.time import CST
from hdu_sniper.events import ApplicationEvent, EventKind, JobState
from hdu_sniper.library import responses
from hdu_sniper.library.client import ROOM_TYPE_MAP
from hdu_sniper.runtime import get_app
from hdu_sniper.scheduler import ScheduledTask


FONT_FAMILY = "SF Pro Text"
FONT_FALLBACK = "MiSans"
ACTIVE_FONT_FAMILY = FONT_FAMILY if sys.platform == "darwin" else FONT_FALLBACK
FONT_ASSET = "fonts/MiSansVF.ttf"

# user:developer-apple-com — Apple Developer Documentation semantic palette.
BACKGROUND = "#ffffff"
SURFACE = "#f5f5f5"
FOREGROUND = "#000000"
MUTED = "#8c8c8c"
BORDER = "#dbdbdb"
ACCENT = "#2997ff"
ACCENT_SECONDARY = "#0071e3"
RADIUS = 8


def resolve_assets_dir() -> str:
    """返回开发、Web 和 PyInstaller 冻结环境共用的资源目录。"""
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        return str(bundle_root / "assets")
    project_assets = Path(__file__).resolve().parents[3] / "assets"
    if (project_assets / FONT_ASSET).is_file():
        return str(project_assets)
    return str(Path(__file__).resolve().parents[1] / "assets")


class SniperFletView:
    """单个 Flet Page 的展示适配器。"""

    def __init__(self, page: ft.Page, application: SniperApp) -> None:
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
        self.page.bgcolor = BACKGROUND
        self.page.theme_mode = ft.ThemeMode.LIGHT
        self.page.window.min_width = 360
        self.page.fonts = {FONT_FALLBACK: FONT_ASSET}
        self.page.theme = ft.Theme(
            font_family=ACTIVE_FONT_FAMILY,
            use_material3=True,
            scaffold_bgcolor=BACKGROUND,
            canvas_color=BACKGROUND,
            card_bgcolor=SURFACE,
            divider_color=BORDER,
            disabled_color=MUTED,
            unselected_control_color=MUTED,
            hint_color=MUTED,
            focus_color=ACCENT,
            hover_color=SURFACE,
            color_scheme=ft.ColorScheme(
                primary=ACCENT_SECONDARY,
                on_primary=BACKGROUND,
                primary_container=SURFACE,
                on_primary_container=FOREGROUND,
                secondary=ACCENT,
                on_secondary=BACKGROUND,
                secondary_container=SURFACE,
                on_secondary_container=FOREGROUND,
                surface=BACKGROUND,
                on_surface=FOREGROUND,
                on_surface_variant=MUTED,
                outline=BORDER,
                outline_variant=BORDER,
                error=FOREGROUND,
                on_error=BACKGROUND,
            ),
            filled_button_theme=ft.ButtonStyle(
                bgcolor=ACCENT_SECONDARY,
                color=BACKGROUND,
                icon_color=BACKGROUND,
                elevation=1,
                padding=ft.Padding.symmetric(horizontal=18, vertical=12),
                shape=ft.RoundedRectangleBorder(radius=RADIUS),
                text_style=ft.TextStyle(color=BACKGROUND, weight=ft.FontWeight.W_600),
            ),
            outlined_button_theme=ft.ButtonStyle(
                bgcolor=BACKGROUND,
                color=ACCENT_SECONDARY,
                elevation=0,
                padding=ft.Padding.symmetric(horizontal=16, vertical=12),
                side=ft.BorderSide(1, BORDER),
                shape=ft.RoundedRectangleBorder(radius=RADIUS),
            ),
            text_button_theme=ft.ButtonStyle(
                color=ACCENT_SECONDARY,
                padding=ft.Padding.symmetric(horizontal=12, vertical=12),
                shape=ft.RoundedRectangleBorder(radius=RADIUS),
            ),
            visual_density=ft.VisualDensity.COMFORTABLE,
        )

    def _build_controls(self) -> None:
        credentials = self.application.saved_credentials()
        self.global_status = ft.Text("就绪", size=13, color=MUTED)

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
            color=BACKGROUND,
            bgcolor=ACCENT_SECONDARY,
            icon_color=BACKGROUND,
            on_click=self._login,
        )
        self.back_to_app_button = ft.Button(
            "返回应用",
            icon=ft.Icons.ARROW_BACK,
            on_click=self._return_to_app,
            visible=False,
        )
        self.reauthenticate_button = ft.Button(
            "重新认证",
            icon=ft.Icons.MANAGE_ACCOUNTS,
            on_click=self._open_reauthentication,
            visible=False,
        )
        self.auth_state = ft.Text("尚未认证", color=MUTED, weight=ft.FontWeight.W_500)
        self.auth_log = ft.TextField(
            value="",
            multiline=True,
            read_only=True,
            min_lines=5,
            max_lines=8,
            label="认证记录",
        )

        self.plan_list = ft.ListView(spacing=6, expand=True)
        self.plan_summary = ft.Text("暂无方案", color=FOREGROUND)
        self.delete_button = ft.Button(
            "删除",
            icon=ft.Icons.DELETE,
            color=FOREGROUND,
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
        self.start_hour = ft.TextField(label="后天开始小时", value="8", col={"sm": 6, "md": 4})
        self.duration_hours = ft.TextField(label="使用时长", value="4", col={"sm": 6, "md": 4})
        self.seat_hint = ft.Text("选择房间和楼层后显示可用座位", size=12)
        self.create_plan_button = ft.FilledButton(
            "创建方案",
            icon=ft.Icons.ADD,
            color=BACKGROUND,
            bgcolor=ACCENT_SECONDARY,
            icon_color=BACKGROUND,
            on_click=self._create_plan,
        )
        self.modify_button = ft.Button(
            "更新所选时间",
            icon=ft.Icons.EDIT,
            on_click=self._modify_selected_plans,
            disabled=True,
        )

        self.scheduler_health = ft.Text(
            "正在检查每日调度状态",
            size=13,
            color=MUTED,
        )
        self.repair_scheduler_button = ft.Button(
            "检查并修复",
            icon=ft.Icons.BUILD,
            on_click=self._repair_scheduler,
        )
        self.schedule_summary = ft.Text("正在读取已创建的调度...", color=FOREGROUND)
        self.refresh_schedules_button = ft.IconButton(
            ft.Icons.REFRESH,
            tooltip="刷新调度列表",
            on_click=self._refresh_scheduled_tasks,
        )
        self.schedule_list = ft.Column(spacing=8)

        self.booking_summary = ft.Text("进入页面后读取预约记录", color=FOREGROUND)
        self.refresh_bookings_button = ft.IconButton(
            ft.Icons.REFRESH,
            tooltip="刷新预约记录",
            on_click=self._refresh_bookings,
        )
        self.booking_list = ft.Column(spacing=8)

        for control in (
            self.student_id,
            self.password,
            self.auth_log,
            self.room_type,
            self.floor,
            self.seat_num,
            self.start_hour,
            self.duration_hours,
        ):
            control.bgcolor = BACKGROUND
            control.filled = True
            control.border_color = BORDER
            control.focused_border_color = ACCENT_SECONDARY
            control.border_radius = RADIUS
            control.content_padding = ft.Padding.symmetric(horizontal=16, vertical=14)
            control.text_size = 15
            control.label_style = ft.TextStyle(color=MUTED, size=13)
        for control in (
            self.student_id,
            self.password,
            self.auth_log,
            self.seat_num,
            self.start_hour,
            self.duration_hours,
        ):
            control.cursor_color = ACCENT_SECONDARY

        self.auth_view = self._auth_view()
        self.business_views = [
            self._plans_view(),
            self._bookings_view(),
            self._schedules_view(),
        ]
        self.content_frame = ft.Container(content=self.auth_view, width=1080)
        self.view_host = ft.Container(
            content=self.content_frame,
            padding=ft.Padding.symmetric(horizontal=32, vertical=32),
            bgcolor=BACKGROUND,
            alignment=ft.Alignment.TOP_CENTER,
            expand=True,
        )

    def _section_title(self, title: str, subtitle: str) -> ft.Column:
        return ft.Column(
            [
                ft.Text(title, size=28, weight=ft.FontWeight.W_600, color=FOREGROUND),
                ft.Text(subtitle, size=14, color=MUTED),
            ],
            spacing=8,
        )

    def _surface(self, content: ft.Control, *, col=12, height: int | None = None) -> ft.Container:
        return ft.Container(
            content=content,
            padding=24,
            bgcolor=SURFACE,
            border=ft.Border.all(1, BORDER),
            border_radius=RADIUS,
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
                            ft.Row([self.login_button, self.back_to_app_button]),
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
                        wrap=True,
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
                    ft.ResponsiveRow([self.seat_num, self.start_hour, self.duration_hours]),
                    self.seat_hint,
                    ft.Row([self.create_plan_button, self.modify_button], wrap=True),
                ],
                spacing=14,
            ),
            col={"sm": 12, "lg": 5},
        )
        return ft.Column(
            [
                self._section_title("方案", "所有方案固定预约后天；座位来自三日布局合并"),
                ft.ResponsiveRow([self.plan_panel, editor], spacing=14, run_spacing=14),
            ],
            spacing=18,
            scroll=ft.ScrollMode.AUTO,
            expand=True,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

    def _schedules_view(self) -> ft.Column:
        return ft.Column(
            [
                self._section_title(
                    "调度",
                    "查看和管理本应用创建的 Windows 任务计划，不会显示或操作其他任务",
                ),
                self._surface(
                    ft.Row(
                        [
                            ft.Icon(ft.Icons.SCHEDULE, color=ACCENT_SECONDARY),
                            ft.Column(
                                [
                                    ft.Text("每日 20:00 自动调度", weight=ft.FontWeight.W_500),
                                    self.scheduler_health,
                                ],
                                spacing=2,
                                expand=True,
                            ),
                            self.repair_scheduler_button,
                        ],
                    ),
                ),
                self._surface(
                    ft.Column(
                        [
                            ft.Row(
                                [self.schedule_summary, self.refresh_schedules_button],
                                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                            ),
                            ft.Divider(height=1),
                            self.schedule_list,
                        ],
                    )
                ),
            ],
            spacing=18,
            expand=True,
            scroll=ft.ScrollMode.AUTO,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

    def _bookings_view(self) -> ft.Column:
        return ft.Column(
            [
                self._section_title(
                    "我的预约",
                    "查看座位预约记录；仅“待签到”的预约可取消",
                ),
                self._surface(
                    ft.Column(
                        [
                            ft.Row(
                                [self.booking_summary, self.refresh_bookings_button],
                                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                            ),
                            ft.Divider(height=1),
                            self.booking_list,
                        ],
                    )
                ),
            ],
            spacing=18,
            expand=True,
            scroll=ft.ScrollMode.AUTO,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        )

    def _render_shell(self) -> None:
        self.navigation_rail = ft.NavigationRail(
            selected_index=0,
            label_type=ft.NavigationRailLabelType.ALL,
            min_width=84,
            min_extended_width=200,
            bgcolor=SURFACE,
            indicator_color=BACKGROUND,
            indicator_shape=ft.RoundedRectangleBorder(radius=RADIUS),
            destinations=[
                ft.NavigationRailDestination(ft.Icons.CHAIR, label="方案"),
                ft.NavigationRailDestination(ft.Icons.EVENT_SEAT, label="我的预约"),
                ft.NavigationRailDestination(ft.Icons.SCHEDULE, label="调度"),
            ],
            on_change=self._navigate,
        )
        self.bottom_navigation = ft.NavigationBar(
            selected_index=0,
            bgcolor=SURFACE,
            indicator_color=BACKGROUND,
            elevation=0,
            destinations=[
                ft.NavigationBarDestination(ft.Icons.CHAIR, label="方案"),
                ft.NavigationBarDestination(ft.Icons.EVENT_SEAT, label="我的预约"),
                ft.NavigationBarDestination(ft.Icons.SCHEDULE, label="调度"),
            ],
            on_change=self._navigate,
            visible=False,
        )
        self.navigation_divider = ft.VerticalDivider(width=1)
        header = ft.Container(
            ft.Row(
                [
                    ft.Column(
                        [
                            ft.Text("HDU Library Sniper", size=18, weight=ft.FontWeight.W_600),
                            ft.Text("图书馆座位预约", size=12, color=MUTED),
                        ],
                        spacing=2,
                    ),
                    ft.Row([self.global_status, self.reauthenticate_button], spacing=8),
                ],
                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                wrap=True,
                run_spacing=8,
            ),
            padding=ft.Padding.symmetric(horizontal=24, vertical=12),
            bgcolor=BACKGROUND,
            border=ft.Border(bottom=ft.BorderSide(1, BORDER)),
        )
        self.content_row = ft.Row(
            [self.navigation_rail, self.navigation_divider, self.view_host],
            expand=True,
            spacing=0,
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
            self.auth_state.color = ACCENT_SECONDARY
            self.auth_log.value = "已恢复缓存登录态"
            self._show_business_shell(load_data=True, update=False)
        elif self.student_id.value:
            self.auth_log.value = "检测到已保存凭据，请输入密码后登录"
            self._show_authentication(update=False)
        else:
            self._show_authentication(update=False)
        self.page.update()

    def _navigate(self, event) -> None:
        if not self.application.authenticated:
            self._show_authentication()
            return
        selected_index = event.control.selected_index
        self.navigation_rail.selected_index = selected_index
        self.bottom_navigation.selected_index = selected_index
        self.content_frame.content = self.business_views[selected_index]
        if selected_index == 1:
            self.page.run_task(self._refresh_bookings)
        elif selected_index == 2:
            self.page.run_task(self._refresh_scheduler_status)
            self.page.run_task(self._refresh_scheduled_tasks)
        self.page.update()

    def _open_reauthentication(self, _event) -> None:
        self.auth_log.value = "可以重新输入凭据完成认证；当前登录态在认证成功前保持不变。"
        self._show_authentication()

    def _return_to_app(self, _event) -> None:
        if self.application.authenticated:
            self._show_business_shell(load_data=False)

    def _show_authentication(self, *, update: bool = True) -> None:
        self.content_frame.content = self.auth_view
        self.navigation_rail.visible = False
        self.navigation_divider.visible = False
        self.bottom_navigation.visible = False
        self.reauthenticate_button.visible = False
        self.back_to_app_button.visible = self.application.authenticated
        if update:
            self.page.update()

    def _show_business_shell(self, *, load_data: bool, update: bool = True) -> None:
        if not self.application.authenticated:
            self._show_authentication(update=update)
            return
        self.navigation_rail.selected_index = 0
        self.bottom_navigation.selected_index = 0
        self.content_frame.content = self.business_views[0]
        self.reauthenticate_button.visible = True
        self.back_to_app_button.visible = False
        self._apply_responsive_layout(update=False)
        if load_data:
            self._refresh_plans()
            self.page.run_task(self._load_room_types)
            self.page.run_task(self._refresh_scheduler_status)
            self.page.run_task(self._refresh_scheduled_tasks)
        if update:
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
        business_visible = (
            self.application.authenticated and self.content_frame.content is not self.auth_view
        )
        self.navigation_rail.visible = business_visible and not compact
        self.navigation_divider.visible = business_visible and not compact
        self.bottom_navigation.visible = business_visible and compact
        self.view_host.padding = (
            ft.Padding.symmetric(horizontal=16, vertical=24)
            if compact
            else ft.Padding.symmetric(horizontal=32, vertical=32)
        )
        if compact and page_width:
            self.content_frame.width = 328 if page_width <= 500 else page_width - 32
        else:
            self.content_frame.width = 1080
        self.content_frame.expand = False
        self.plan_panel.height = 320 if compact else 520
        if update:
            self.page.update()

    def _show_message(self, message: str, *, error: bool = False) -> None:
        self.page.show_dialog(
            ft.SnackBar(
                message,
                bgcolor=FOREGROUND if error else ACCENT_SECONDARY,
                show_close_icon=True,
            ),
        )

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
        self.auth_state.color = ACCENT_SECONDARY if success else FOREGROUND
        self._show_message(message, error=not success)
        if success:
            self._show_business_shell(load_data=True)
        else:
            self._show_authentication()

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
                                        weight=ft.FontWeight.W_500,
                                    ),
                                    ft.Text(
                                        f"后天 {plan.start_hour:02d}:00 起 · {plan.duration_hours} 小时",
                                        size=12,
                                        color=MUTED,
                                    ),
                                ],
                                spacing=2,
                                expand=True,
                            ),
                            ft.Text(
                                status,
                                color=ACCENT_SECONDARY if plan.enabled else MUTED,
                            ),
                        ],
                    ),
                    padding=10,
                    border=ft.Border(bottom=ft.BorderSide(1, BORDER)),
                ),
            )
        if not plans:
            self.plan_list.controls.append(ft.Text("暂无预约方案", color=MUTED))
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
            plan, errors, fell_back, scheduler = await asyncio.to_thread(
                self.application.create_plan,
                room_type_name=str(room.get("name", "")),
                room_query=room_query,
                floor_id=int(self.floor.value),
                seat_num=(self.seat_num.value or "").strip(),
                start_hour=int(self.start_hour.value or "0"),
                duration_hours=int(self.duration_hours.value or "0"),
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
        if scheduler and scheduler.success:
            scheduler_message = (
                "每日 20:00 自动调度已经存在并已确认可用。"
                if scheduler.already_existed
                else "每日 20:00 自动调度已创建，系统将自动预约后天座位。"
            )
            self._show_plan_creation_dialog(
                "方案和自动调度已就绪",
                f"{message}\n\n{scheduler_message}",
            )
        else:
            failure = scheduler.message if scheduler else "未执行调度配置"
            self._show_plan_creation_dialog(
                "方案已创建，但自动调度未生效",
                f"{message}\n\n调度创建失败：{failure}\n请前往调度页面检查并修复。",
                error=True,
            )
        await self._refresh_scheduler_status()
        await self._refresh_scheduled_tasks()

    def _show_plan_creation_dialog(
        self,
        title: str,
        message: str,
        *,
        error: bool = False,
    ) -> None:
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(
                    ft.Icons.ERROR_OUTLINE if error else ft.Icons.EVENT_AVAILABLE,
                    color=FOREGROUND if error else ACCENT_SECONDARY,
                ),
                title=ft.Text(title),
                content=ft.Text(message, selectable=True),
                actions=[
                    ft.FilledButton(
                        "知道了",
                        color=BACKGROUND,
                        bgcolor=ACCENT_SECONDARY,
                        on_click=lambda _event: self.page.pop_dialog(),
                    )
                ],
            )
        )

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

    async def _refresh_scheduler_status(self) -> None:
        try:
            status = await asyncio.to_thread(self.application.scheduler_status)
        except Exception as exc:
            self.scheduler_health.value = f"状态检查失败：{exc}"
            self.scheduler_health.color = FOREGROUND
        else:
            if status.exists:
                details = ["系统任务已启用"]
                if status.next_run:
                    details.append(f"下次运行：{status.next_run}")
                self.scheduler_health.value = " · ".join(details)
                self.scheduler_health.color = ACCENT_SECONDARY
            else:
                self.scheduler_health.value = "系统任务尚未生效，请检查并修复"
                self.scheduler_health.color = MUTED
        self.page.update()

    async def _refresh_bookings(self, _event=None) -> None:
        self.refresh_bookings_button.disabled = True
        self.booking_summary.value = "正在读取预约记录..."
        self.page.update()
        try:
            bookings = await asyncio.to_thread(self.application.list_bookings)
        except Exception as exc:
            self.booking_list.controls.clear()
            self.booking_summary.value = f"读取预约记录失败：{exc}"
            self.booking_summary.color = FOREGROUND
        else:
            self._render_bookings(bookings)
        finally:
            self.refresh_bookings_button.disabled = False
            with contextlib.suppress(RuntimeError):
                self.page.update()

    def _render_bookings(self, bookings: list[dict]) -> None:
        self.booking_list.controls.clear()
        self.booking_summary.value = f"共 {len(bookings)} 条预约记录"
        self.booking_summary.color = FOREGROUND
        if not bookings:
            self.booking_list.controls.append(ft.Text("暂无预约记录", color=MUTED))
            return

        status_labels = {
            "0": "待签到",
            "1": "使用中",
            "2": "暂离中",
            "3": "已结束",
            "4": "已取消",
            "5": "未签到结束",
            "6": "暂离未归结束",
            "7": "系统签退结束",
            "8": "预约待确认",
            "9": "已拒绝",
        }
        for item in bookings:
            booking_id = responses.booking_id(item)
            status = responses.booking_status(item)
            room_name = str(item.get("roomName") or "未知房间")
            seat_num = str(item.get("seatNum") or "-")
            try:
                start_time = datetime.fromtimestamp(
                    responses.booking_begin_ts(item), tz=CST
                ).strftime("%Y-%m-%d %H:%M")
            except (TypeError, ValueError, OSError):
                start_time = "未知时间"
            try:
                duration_hours = int(item.get("duration") or 0) / 3600
                duration_text = f"{duration_hours:g} 小时" if duration_hours else "时长未知"
            except (TypeError, ValueError):
                duration_text = "时长未知"
            status_label = status_labels.get(status) or f"状态 {status or '未知'}"
            details = f"座位 {seat_num} · {start_time} · {duration_text} · {status_label}"
            actions: list[ft.Control] = []
            if status == "0" and booking_id:
                actions.append(
                    ft.Button(
                        "取消预约",
                        icon=ft.Icons.CANCEL_OUTLINED,
                        color=FOREGROUND,
                        data={
                            "id": booking_id,
                            "summary": f"{room_name} · 座位 {seat_num} · {start_time}",
                        },
                        on_click=self._confirm_cancel_remote_booking,
                    )
                )
            self.booking_list.controls.append(
                ft.Container(
                    ft.Row(
                        [
                            ft.Column(
                                [
                                    ft.Text(room_name, weight=ft.FontWeight.W_500),
                                    ft.Text(details, size=12, color=MUTED),
                                ],
                                spacing=4,
                                expand=True,
                            ),
                            *actions,
                        ],
                    ),
                    padding=12,
                    border=ft.Border(bottom=ft.BorderSide(1, BORDER)),
                )
            )

    def _confirm_cancel_remote_booking(self, event) -> None:
        booking = event.control.data
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.WARNING_AMBER_ROUNDED, color=FOREGROUND),
                title=ft.Text("取消预约？"),
                content=ft.Text(f"将取消：{booking['summary']}。此操作无法撤销。"),
                actions=[
                    ft.Button("再想想", on_click=lambda _event: self.page.pop_dialog()),
                    ft.FilledButton(
                        "确认取消",
                        icon=ft.Icons.CANCEL_OUTLINED,
                        color=BACKGROUND,
                        bgcolor=FOREGROUND,
                        icon_color=BACKGROUND,
                        data=booking["id"],
                        on_click=self._cancel_remote_booking,
                    ),
                ],
            )
        )

    async def _cancel_remote_booking(self, event) -> None:
        booking_id = str(event.control.data)
        self.page.pop_dialog()
        try:
            success, message = await asyncio.to_thread(
                self.application.cancel_remote_booking, booking_id
            )
        except Exception as exc:
            self._show_message(f"取消预约失败：{exc}", error=True)
        else:
            self._show_message(message, error=not success)
        await self._refresh_bookings()

    async def _repair_scheduler(self, _event) -> None:
        self.repair_scheduler_button.disabled = True
        self.scheduler_health.value = "正在确保系统每日任务..."
        self.page.update()
        try:
            success, message = await asyncio.to_thread(self.application.repair_daily_scheduler)
            self._show_message(message, error=not success)
        except Exception as exc:
            self._show_message(f"调度修复失败：{exc}", error=True)
        finally:
            self.repair_scheduler_button.disabled = False
            await self._refresh_scheduler_status()
            await self._refresh_scheduled_tasks()

    async def _refresh_scheduled_tasks(self, _event=None) -> None:
        self.refresh_schedules_button.disabled = True
        self.schedule_summary.value = "正在读取已创建的调度..."
        self.page.update()
        try:
            tasks = await asyncio.to_thread(self.application.list_scheduled_tasks)
        except Exception as exc:
            self.schedule_list.controls.clear()
            self.schedule_summary.value = f"读取调度失败：{exc}"
            self.schedule_summary.color = FOREGROUND
        else:
            self._render_scheduled_tasks(tasks)
        finally:
            self.refresh_schedules_button.disabled = False
            with contextlib.suppress(RuntimeError):
                self.page.update()

    def _render_scheduled_tasks(self, tasks: list[ScheduledTask]) -> None:
        self.schedule_list.controls.clear()
        self.schedule_summary.value = f"已创建 {len(tasks)} 个调度"
        self.schedule_summary.color = FOREGROUND
        if not tasks:
            self.schedule_list.controls.append(
                ft.Text("暂无已创建的调度", color=MUTED)
            )
            return

        for task in tasks:
            details = [f"状态：{task.status or '未知'}"]
            if task.next_run:
                details.append(f"下次运行：{task.next_run}")
            if task.last_run:
                details.append(f"上次运行：{task.last_run}")
            if task.last_result:
                details.append(f"上次结果：{task.last_result}")
            self.schedule_list.controls.append(
                ft.Container(
                    ft.Row(
                        [
                            ft.Column(
                                [
                                    ft.Text(task.name, weight=ft.FontWeight.W_500),
                                    ft.Text(" · ".join(details), size=12, color=MUTED),
                                ],
                                spacing=4,
                                expand=True,
                            ),
                            ft.Button(
                                "立即执行",
                                icon=ft.Icons.PLAY_ARROW,
                                data=task.name,
                                on_click=self._confirm_run_scheduled_task,
                            ),
                            ft.Button(
                                "删除",
                                icon=ft.Icons.DELETE,
                                color=FOREGROUND,
                                data=task.name,
                                on_click=self._confirm_delete_scheduled_task,
                            ),
                        ],
                    ),
                    padding=12,
                    border=ft.Border(bottom=ft.BorderSide(1, BORDER)),
                )
            )

    def _confirm_run_scheduled_task(self, event) -> None:
        task_name = str(event.control.data)
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.PLAY_CIRCLE_OUTLINE, color=ACCENT_SECONDARY),
                title=ft.Text("立即执行调度？"),
                content=ft.Text(
                    f"{task_name} 将由 Windows 任务计划程序立即启动，可能会执行预约。",
                ),
                actions=[
                    ft.Button("取消", on_click=lambda _event: self.page.pop_dialog()),
                    ft.FilledButton(
                        "立即执行",
                        icon=ft.Icons.PLAY_ARROW,
                        color=BACKGROUND,
                        bgcolor=ACCENT_SECONDARY,
                        icon_color=BACKGROUND,
                        data=task_name,
                        on_click=self._run_scheduled_task,
                    ),
                ],
            )
        )

    async def _run_scheduled_task(self, event) -> None:
        task_name = str(event.control.data)
        self.page.pop_dialog()
        success, message = await asyncio.to_thread(self.application.run_scheduled_task, task_name)
        self._show_message(message, error=not success)
        await self._refresh_scheduled_tasks()

    def _confirm_delete_scheduled_task(self, event) -> None:
        task_name = str(event.control.data)
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.WARNING_AMBER_ROUNDED, color=FOREGROUND),
                title=ft.Text("删除调度？"),
                content=ft.Text(
                    f"删除 {task_name} 后将不再自动执行预约，后续可通过“检查并修复”重新创建。",
                ),
                actions=[
                    ft.Button("取消", on_click=lambda _event: self.page.pop_dialog()),
                    ft.FilledButton(
                        "删除",
                        icon=ft.Icons.DELETE,
                        color=BACKGROUND,
                        bgcolor=FOREGROUND,
                        icon_color=BACKGROUND,
                        data=task_name,
                        on_click=self._delete_scheduled_task,
                    ),
                ],
            )
        )

    async def _delete_scheduled_task(self, event) -> None:
        task_name = str(event.control.data)
        self.page.pop_dialog()
        success, message = await asyncio.to_thread(
            self.application.delete_scheduled_task, task_name
        )
        self._show_message(message, error=not success)
        await self._refresh_scheduled_tasks()
        await self._refresh_scheduler_status()

    def _on_application_event(self, event: ApplicationEvent) -> None:
        state_names = {
            JobState.IDLE: "空闲",
            JobState.AUTHENTICATING: "认证中",
            JobState.RUNNING: "执行中",
            JobState.CANCELLING: "取消中",
            JobState.SUCCEEDED: "预约成功",
            JobState.FAILED: "执行失败",
            JobState.CANCELLED: "已取消",
        }
        self.global_status.value = state_names[event.state]
        if event.kind == EventKind.AUTH_REQUIRED:
            self.auth_state.value = "认证已失效"
            self.auth_state.color = FOREGROUND
            self.auth_log.value = event.message
            self._show_authentication(update=False)
        with contextlib.suppress(RuntimeError):
            self.page.update()


def flet_main(page: ft.Page) -> None:
    SniperFletView(page, get_app())


def run_flet_app() -> None:
    """启动桌面 Flet 客户端。"""
    ft.run(
        flet_main,
        view=ft.AppView.FLET_APP,
        assets_dir=resolve_assets_dir(),
    )
