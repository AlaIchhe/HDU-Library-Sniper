"""Flet 跨平台界面：桌面窗口与 Docker Web 共用同一套控件树。"""

from __future__ import annotations

import asyncio
import contextlib
import queue
import sys
from pathlib import Path

import flet as ft

from hdu_sniper import __version__
from hdu_sniper.application import SniperAppProtocol
from hdu_sniper.dto import (
    BookingView,
    DownloadProgress,
    FloorView,
    PlanView,
    RoomTypeView,
    ScheduledTaskView,
    SchedulePolicyView,
    UpdateCancelled,
    UpdateChecksumError,
    UpdateInfo,
)
from hdu_sniper.events import ApplicationEvent, EventKind


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


def _format_bytes(size: int) -> str:
    units = ("B", "KB", "MB", "GB")
    value = float(size)
    for unit in units:
        if value < 1024:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


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

    def __init__(self, page: ft.Page, application: SniperAppProtocol) -> None:
        self.page = page
        self.application = application
        self.selected_plan_ids: set[str] = set()
        self.room_types: dict[str, RoomTypeView] = {}
        self.floors: dict[str, FloorView] = {}
        self.available_update: UpdateInfo | None = None
        self._update_check_started = False
        self._update_download_task = None
        self._update_progress_queue: queue.Queue[DownloadProgress] = queue.Queue()
        self._update_cancel_requested = False
        self._update_progress_bar = ft.ProgressBar(
            value=0,
            color=ACCENT_SECONDARY,
            bgcolor=BORDER,
        )
        self._update_status = ft.Text("正在连接下载地址...", size=13)
        self._update_cancel_button = ft.Button("取消", on_click=self._cancel_update_download)
        self._update_dialog = None

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
        self.fallback_seats = ft.TextField(
            label="备选座位（逗号分隔）",
            hint_text="例如 002,003",
            col={"sm": 12, "md": 9},
        )
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
        self.checkin_status_text = ft.Text(
            "未启用",
            size=15,
            weight=ft.FontWeight.W_600,
            color=FOREGROUND,
        )
        self.checkin_agreed_text = ft.Text(
            "默认关闭；启用需阅读并同意风险协议。",
            size=12,
            color=MUTED,
        )
        self.enable_checkin_button = ft.FilledButton(
            "启用自动签到",
            icon=ft.Icons.SHIELD,
            color=BACKGROUND,
            bgcolor=ACCENT_SECONDARY,
            icon_color=BACKGROUND,
            on_click=self._open_checkin_consent_dialog,
        )
        self.disable_checkin_button = ft.Button(
            "关闭自动签到",
            icon=ft.Icons.POWER_SETTINGS_NEW,
            on_click=self._disable_auto_check_in,
            disabled=True,
        )
        self.schedule_policy_icon = ft.Icon(ft.Icons.EVENT_AVAILABLE, color=ACCENT_SECONDARY)
        self.schedule_policy_title = ft.Text("自动预约已启用", size=16, weight=ft.FontWeight.W_600)
        self.schedule_rule_value = ft.Text("—", size=15, weight=ft.FontWeight.W_600)
        self.schedule_next_run = ft.Text("正在读取预约日期...", size=15, weight=ft.FontWeight.W_600)
        self.schedule_policy_note = ft.Text("", size=12, color=MUTED)
        self.edit_policy_button = ft.Button(
            "编辑运行日期",
            icon=ft.Icons.EDIT_CALENDAR,
            on_click=self._open_policy_dialog,
        )
        self.pause_policy_button = ft.Button(
            "暂停自动预约",
            icon=ft.Icons.PAUSE_CIRCLE_OUTLINE,
            on_click=self._toggle_pause_policy,
        )
        self._policy_dialog: ft.AlertDialog | None = None
        self._policy_dialog_summary: ft.Text | None = None
        self._policy_dialog_hint: ft.Text | None = None
        self._policy_day_checks: dict[int, ft.Checkbox] = {}

        self.booking_summary = ft.Text("进入页面后读取预约记录", color=FOREGROUND)
        self.refresh_bookings_button = ft.IconButton(
            ft.Icons.REFRESH,
            tooltip="刷新预约记录",
            on_click=self._refresh_bookings,
        )
        self.booking_list = ft.Column(spacing=8)
        self.auto_check_in_button = ft.FilledButton(
            "自动签到",
            icon=ft.Icons.LOGIN,
            color=BACKGROUND,
            bgcolor=ACCENT_SECONDARY,
            icon_color=BACKGROUND,
            on_click=self._auto_check_in,
        )
        self.test_check_in_button = ft.Button(
            "签到测试",
            icon=ft.Icons.BUILD,
            on_click=self._test_check_in,
        )

        for control in (
            self.student_id,
            self.password,
            self.auth_log,
            self.room_type,
            self.floor,
            self.seat_num,
            self.fallback_seats,
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
            self.fallback_seats,
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
                    ft.ResponsiveRow([self.seat_num, self.fallback_seats]),
                    ft.ResponsiveRow([self.start_hour, self.duration_hours]),
                    ft.Text("主座位失败后按填写顺序自动尝试备选座位", size=12, color=MUTED),
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
                    "按预约日期控制自动抢座；系统会在预约日前两天 20:00 执行",
                ),
                self._surface(
                    ft.Row(
                        [
                            self.schedule_policy_icon,
                            ft.Column(
                                [
                                    self.schedule_policy_title,
                                    ft.Row(
                                        [
                                            ft.Text("当前规则", size=14, color=MUTED),
                                            self.schedule_rule_value,
                                        ],
                                        spacing=8,
                                    ),
                                    self.schedule_next_run,
                                    self.schedule_policy_note,
                                ],
                                spacing=6,
                                expand=True,
                            ),
                            ft.Column(
                                [
                                    self.edit_policy_button,
                                    self.pause_policy_button,
                                    self.repair_scheduler_button,
                                ],
                                spacing=8,
                            ),
                        ],
                        spacing=16,
                        vertical_alignment=ft.CrossAxisAlignment.START,
                    ),
                ),
                self._surface(
                    ft.Column(
                        [
                            ft.Row(
                                [
                                    ft.Icon(ft.Icons.SHIELD, color=ACCENT_SECONDARY),
                                    ft.Column(
                                        [
                                            ft.Text(
                                                "自动签到（可选功能）",
                                                size=16,
                                                weight=ft.FontWeight.W_600,
                                            ),
                                            ft.Row(
                                                [
                                                    ft.Text("当前状态", size=14, color=MUTED),
                                                    self.checkin_status_text,
                                                ],
                                                spacing=8,
                                            ),
                                            self.checkin_agreed_text,
                                        ],
                                        spacing=6,
                                        expand=True,
                                    ),
                                    ft.Column(
                                        [
                                            self.enable_checkin_button,
                                            self.disable_checkin_button,
                                        ],
                                        spacing=8,
                                    ),
                                ],
                                spacing=16,
                                vertical_alignment=ft.CrossAxisAlignment.START,
                            ),
                        ],
                        spacing=8,
                    )
                ),
                self._surface(
                    ft.Column(
                        [
                            ft.Text("系统任务详情", size=16, weight=ft.FontWeight.W_600),
                            ft.Row(
                                [self.schedule_summary, self.refresh_schedules_button],
                                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                            ),
                            ft.Divider(height=1),
                            self.schedule_list,
                        ],
                        spacing=8,
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
                    "查看预约记录并执行取消、签到、暂离或续座",
                ),
                self._surface(
                    ft.Column(
                        [
                            ft.Row(
                                [
                                    self.booking_summary,
                                    ft.Row(
                                        [
                                            self.test_check_in_button,
                                            self.auto_check_in_button,
                                            self.refresh_bookings_button,
                                        ],
                                        wrap=True,
                                    ),
                                ],
                                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                                wrap=True,
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
        self.update_button = ft.IconButton(
            ft.Icons.SYSTEM_UPDATE_ALT,
            tooltip="发现新版本",
            icon_color=ACCENT_SECONDARY,
            visible=False,
            on_click=self._show_update_dialog,
        )
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
                    ft.Row(
                        [self.update_button, self.reauthenticate_button],
                        spacing=8,
                    ),
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
            self.page.run_task(self._refresh_schedule_policy)
            self.page.run_task(self._refresh_scheduled_tasks)
            self.page.run_task(self._refresh_check_in_status)
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
            self.page.run_task(self._refresh_schedule_policy)
            self.page.run_task(self._refresh_scheduled_tasks)
            self.page.run_task(self._refresh_check_in_status)
        self._schedule_update_check()
        if update:
            self.page.update()

    def _schedule_update_check(self) -> None:
        if self._update_check_started:
            return
        self._update_check_started = True
        self.page.run_task(self._check_for_updates)

    async def _check_for_updates(self) -> None:
        try:
            update = await asyncio.to_thread(self.application.check_for_update)
        except Exception:
            # 更新检查是可选功能，离线时不能影响登录、预约和调度。
            return
        if update is None:
            return

        self.available_update = update
        self.update_button.visible = True
        self.update_button.tooltip = f"发现新版本 v{update.version}"
        with contextlib.suppress(RuntimeError):
            self.page.update()

    def _show_update_dialog(self, _event) -> None:
        update = self.available_update
        if update is None or self._update_download_task is not None:
            return

        notes = update.notes.strip() if update.notes else ""
        if len(notes) > 1200:
            notes = f"{notes[:1200].rstrip()}..."
        content = ft.Column(
            [
                ft.Text(f"当前版本：{__version__}"),
                ft.Text(f"最新版本：{update.version}"),
                (
                    ft.Text(notes, color=MUTED)
                    if notes
                    else ft.Text("该版本没有附加说明。", color=MUTED)
                ),
            ],
            tight=True,
            spacing=8,
        )
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.SYSTEM_UPDATE_ALT, color=ACCENT_SECONDARY),
                title=ft.Text("发现新版本"),
                content=content,
                actions=self._update_dialog_actions(update),
            )
        )

    def _update_dialog_actions(self, update: UpdateInfo) -> list[ft.Control]:
        actions = [ft.Button("稍后再说", on_click=lambda _event: self.page.pop_dialog())]
        if update.download_url:
            actions.append(
                ft.FilledButton(
                    "下载更新",
                    icon=ft.Icons.DOWNLOAD,
                    color=BACKGROUND,
                    bgcolor=ACCENT_SECONDARY,
                    icon_color=BACKGROUND,
                    on_click=self._start_update_download,
                )
            )
        else:
            actions.append(
                ft.FilledButton(
                    "打开发布页",
                    icon=ft.Icons.OPEN_IN_NEW,
                    color=BACKGROUND,
                    bgcolor=ACCENT_SECONDARY,
                    icon_color=BACKGROUND,
                    on_click=self._open_update_download,
                )
            )
        return actions

    async def _start_update_download(self, _event) -> None:
        update = self.available_update
        if update is None or self._update_download_task is not None:
            return
        if self.page.web or not self.application.update_install_supported(update):
            await self._open_update_download(_event)
            return

        self._update_cancel_requested = False
        self._update_progress_queue = queue.Queue()
        self._update_progress_bar.value = 0
        self._update_status.value = "正在连接下载地址..."
        self._update_cancel_button.text = "取消"
        self._update_cancel_button.disabled = False
        self._update_cancel_button.on_click = self._cancel_update_download
        self.update_button.disabled = True
        self._update_dialog = ft.AlertDialog(
            modal=True,
            icon=ft.Icon(ft.Icons.DOWNLOAD, color=ACCENT_SECONDARY),
            title=ft.Text("正在下载更新"),
            content=ft.Column(
                [
                    ft.Text(f"新版本：{update.version}"),
                    self._update_progress_bar,
                    self._update_status,
                ],
                tight=True,
                spacing=10,
            ),
            actions=[self._update_cancel_button],
        )
        self.page.pop_dialog()
        self.page.show_dialog(self._update_dialog)
        self.page.update()
        self._update_download_task = self.page.run_task(self._perform_update_download, update)

    async def _perform_update_download(self, update: UpdateInfo) -> None:
        poller = asyncio.create_task(self._poll_update_progress())
        try:
            installer = await asyncio.to_thread(
                self.application.download_update,
                update,
                progress=self._queue_update_progress,
                cancel=lambda: self._update_cancel_requested,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._show_update_failure(exc)
            return
        finally:
            poller.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await poller
            self._update_download_task = None

        self._drain_update_progress()
        self._update_progress_bar.value = 1
        self._update_status.value = "校验完成，正在启动安装程序..."
        with contextlib.suppress(RuntimeError):
            self.page.update()
        await asyncio.sleep(0.4)
        try:
            self.application.launch_installer(installer)
        except Exception as exc:
            self._show_update_failure(f"安装包已保存，但自动启动失败：{exc}")
            return
        await self.page.window.close()

    async def _poll_update_progress(self) -> None:
        while True:
            self._drain_update_progress()
            await asyncio.sleep(0.1)

    def _queue_update_progress(self, progress: DownloadProgress) -> None:
        self._update_progress_queue.put(progress)

    def _drain_update_progress(self) -> None:
        changed = False
        while True:
            try:
                progress = self._update_progress_queue.get_nowait()
            except queue.Empty:
                break
            self._update_progress_bar.value = progress.percent
            total = _format_bytes(progress.total) if progress.total else "未知大小"
            self._update_status.value = (
                f"正在下载 {_format_bytes(progress.downloaded)} / {total}"
            )
            changed = True
        if changed:
            with contextlib.suppress(RuntimeError):
                self.page.update()

    def _cancel_update_download(self, _event) -> None:
        self._update_cancel_requested = True
        self._update_cancel_button.disabled = True
        self._update_status.value = "正在取消..."
        with contextlib.suppress(RuntimeError):
            self.page.update()

    def _show_update_failure(self, error: Exception | str) -> None:
        if isinstance(error, UpdateCancelled):
            message = "下载已取消"
        elif isinstance(error, UpdateChecksumError):
            message = "更新失败：安装包校验未通过，已停止安装"
        else:
            message = f"更新失败：{error}"
        self._update_status.value = message
        self._update_progress_bar.value = 0
        self._update_cancel_button.text = "关闭"
        self._update_cancel_button.disabled = False
        self._update_cancel_button.on_click = lambda _event: self.page.pop_dialog()
        self.update_button.disabled = False
        self._update_download_task = None
        with contextlib.suppress(RuntimeError):
            self.page.update()

    async def _open_update_download(self, _event) -> None:
        update = self.available_update
        if update is None:
            return
        self.page.pop_dialog()
        await ft.UrlLauncher().launch_url(update.download_url or update.release_url)

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
        self.room_types = {item.query: item for item in room_types}
        self.room_type.options = [
            ft.DropdownOption(key=item.query, text=item.name)
            for item in self.room_types.values()
            if item.query
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
        self.floors = {item.floor_id: item for item in floors}
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
        plans: list[PlanView] = self.application.list_plans()
        self.selected_plan_ids.intersection_update(
            plan.plan_id for plan in plans if plan.plan_id is not None
        )
        self.plan_list.controls.clear()
        self.plan_summary.value = f"{len(plans)} 个方案"
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
            self.plan_list.controls.append(
                ft.Container(
                    ft.Row(
                        [
                            checkbox,
                            ft.Column(
                                [
                                    ft.Text(
                                        f"{plan.room_name} · {plan.seat_num} 座",
                                        weight=ft.FontWeight.W_500,
                                    ),
                                    ft.Text(
                                        f"后天 {plan.start_hour:02d}:00 起 · {plan.duration_hours} 小时"
                                        + (
                                            f" · 备选：{', '.join(plan.fallback_seats)}"
                                            if plan.fallback_seats
                                            else ""
                                        ),
                                        size=12,
                                        color=MUTED,
                                    ),
                                ],
                                spacing=2,
                                expand=True,
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
                room_type_name=room.name,
                room_query=room_query,
                floor_id=int(self.floor.value),
                seat_num=(self.seat_num.value or "").strip(),
                fallback_seats=(self.fallback_seats.value or "").strip(),
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
        self.fallback_seats.value = ""
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
        await self._refresh_schedule_policy()
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

    async def _refresh_schedule_policy(self) -> None:
        try:
            policy = await asyncio.to_thread(self.application.schedule_policy)
            status = await asyncio.to_thread(self.application.scheduler_status)
        except Exception as exc:
            self.schedule_policy_title.value = "无法读取自动预约状态"
            self.schedule_next_run.value = f"读取失败：{exc}"
            with contextlib.suppress(RuntimeError):
                self.page.update()
            return
        self._render_schedule_policy(policy, bool(status.exists))
        with contextlib.suppress(RuntimeError):
            self.page.update()

    def _render_schedule_policy(self, policy: SchedulePolicyView, task_exists: bool) -> None:
        if policy.corrupt:
            self.schedule_policy_icon.name = ft.Icons.WARNING_AMBER_ROUNDED
            self.schedule_policy_icon.color = FOREGROUND
            self.schedule_policy_title.value = "自动预约已暂停"
            self.schedule_rule_value.value = "待修复"
            self.schedule_next_run.value = "日期配置已损坏，已暂停预约；请重新保存运行日期"
            self.schedule_policy_note.value = (
                f"系统任务：{'就绪' if task_exists else '需要修复'} · 上次运行：见任务详情"
            )
            self.pause_policy_button.text = "暂停自动预约"
            self.pause_policy_button.icon = ft.Icons.PAUSE_CIRCLE_OUTLINE
            return

        self.schedule_rule_value.value = policy.summary_label
        if policy.enabled:
            self.schedule_policy_icon.name = ft.Icons.EVENT_AVAILABLE
            self.schedule_policy_icon.color = ACCENT_SECONDARY
            self.schedule_policy_title.value = (
                "自动预约已启用" if task_exists else "系统任务需要修复"
            )
            self.pause_policy_button.text = "暂停自动预约"
            self.pause_policy_button.icon = ft.Icons.PAUSE_CIRCLE_OUTLINE
            task_text = f"系统任务：{'就绪' if task_exists else '需要修复'}"
            if policy.next_run_text is None:
                self.schedule_next_run.value = "90 天内没有符合规则的可预约日期"
                self.schedule_policy_note.value = task_text
            else:
                self.schedule_next_run.value = policy.next_run_text
                note_parts = [task_text]
                if policy.today_excluded:
                    note_parts.append("今天不在当前运行规则中")
                self.schedule_policy_note.value = " · ".join(note_parts)
        else:
            self.schedule_policy_icon.name = ft.Icons.PAUSE_CIRCLE_FILLED
            self.schedule_policy_icon.color = MUTED
            self.schedule_policy_title.value = "自动预约已暂停"
            self.schedule_next_run.value = "已暂停 · 不会发起预约"
            self.schedule_policy_note.value = (
                f"系统任务：{'就绪' if task_exists else '需要修复'} · 当前规则保留"
            )
            self.pause_policy_button.text = "恢复自动预约"
            self.pause_policy_button.icon = ft.Icons.PLAY_CIRCLE_OUTLINE

    def _policy_summary_label(self, checked: list[int]) -> str:
        return self.application.schedule_policy_preview(checked)

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

    def _render_bookings(self, bookings: list[BookingView]) -> None:
        bookings = [item for item in bookings if item.show_in_list]
        self.booking_list.controls.clear()
        self.booking_summary.value = f"共 {len(bookings)} 条预约记录"
        self.booking_summary.color = FOREGROUND
        if not bookings:
            self.booking_list.controls.append(ft.Text("暂无预约记录", color=MUTED))
            return

        for item in bookings:
            details = (
                f"座位 {item.seat_num} · {item.start_text} · {item.duration_text}"
                f" · {item.status_label}"
            )
            actions: list[ft.Control] = []
            if item.can_cancel:
                actions.append(
                    ft.Button(
                        "取消预约",
                        icon=ft.Icons.CANCEL_OUTLINED,
                        color=FOREGROUND,
                        data={"id": item.booking_id, "summary": item.summary},
                        on_click=self._confirm_cancel_remote_booking,
                    )
                )
                if item.can_check_in:
                    actions.append(
                        ft.Button(
                            "签到",
                            icon=ft.Icons.LOGIN,
                            data={"id": item.booking_id, "summary": item.summary},
                            on_click=self._confirm_check_in_booking,
                        )
                    )
            elif item.can_sign_out:
                actions.extend(
                    [
                        ft.Button(
                            "签退",
                            icon=ft.Icons.LOGOUT,
                            data={"id": item.booking_id, "summary": item.summary},
                            on_click=self._confirm_sign_out_booking,
                        ),
                        ft.Button(
                            "暂离",
                            icon=ft.Icons.PAUSE_CIRCLE_OUTLINE,
                            data={"id": item.booking_id, "summary": item.summary},
                            on_click=self._confirm_leave_booking,
                        ),
                    ]
                )
            elif item.can_renew:
                actions.append(
                    ft.Button(
                        "续座",
                        icon=ft.Icons.KEYBOARD_RETURN,
                        data=item.booking_id,
                        on_click=self._renew_booking,
                    )
                )
            self.booking_list.controls.append(
                ft.Container(
                    ft.Row(
                        [
                            ft.Column(
                                [
                                    ft.Text(item.room_name, weight=ft.FontWeight.W_500),
                                    ft.Text(details, size=12, color=MUTED),
                                ],
                                spacing=4,
                                expand=True,
                            ),
                            *actions,
                        ],
                        wrap=False,
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

    def _confirm_check_in_booking(self, event) -> None:
        booking = event.control.data
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.LOGIN, color=ACCENT_SECONDARY),
                title=ft.Text("确认签到？"),
                content=ft.Text(f"将为以下预约签到：{booking['summary']}。"),
                actions=[
                    ft.Button("暂不签到", on_click=lambda _event: self.page.pop_dialog()),
                    ft.FilledButton(
                        "确认签到",
                        icon=ft.Icons.LOGIN,
                        color=BACKGROUND,
                        bgcolor=ACCENT_SECONDARY,
                        icon_color=BACKGROUND,
                        data=booking["id"],
                        on_click=self._check_in_booking,
                    ),
                ],
            )
        )

    async def _check_in_booking(self, event) -> None:
        self.page.pop_dialog()
        await self._run_remote_booking_action(
            self.application.check_in_booking,
            str(event.control.data),
            "签到失败",
        )

    async def _come_back_booking(self, event) -> None:
        await self._run_remote_booking_action(
            self.application.come_back_booking,
            str(event.control.data),
            "返回座位失败",
        )

    async def _renew_booking(self, event) -> None:
        await self._run_remote_booking_action(
            self.application.renew_booking,
            str(event.control.data),
            "续座失败",
        )

    async def _test_check_in(self, _event) -> None:
        self.test_check_in_button.disabled = True
        self.page.update()
        try:
            results = await asyncio.to_thread(self.application.check_in_test)
        except Exception as exc:
            self._show_message(f"签到测试失败：{exc}", error=True)
        else:
            passed = sum(bool(item.get("success")) for item in results)
            self._show_message(f"签到测试完成：{passed}/{len(results)} 条预约通过")
        finally:
            self.test_check_in_button.disabled = False

    async def _auto_check_in(self, _event) -> None:
        self.auto_check_in_button.disabled = True
        self.page.update()
        try:
            results = await asyncio.to_thread(self.application.auto_check_in)
        except Exception as exc:
            self._show_message(f"自动签到失败：{exc}", error=True)
        else:
            if len(results) == 1 and not results[0].get("success"):
                self._show_message(str(results[0].get("message") or "自动签到失败"), error=True)
                return
            successes = sum(bool(item.get("success")) for item in results)
            self._show_message(f"自动签到完成：{successes}/{len(results)} 条成功")
            await self._refresh_bookings()
        finally:
            self.auto_check_in_button.disabled = False

    def _confirm_sign_out_booking(self, event) -> None:
        booking = event.control.data
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.LOGOUT, color=FOREGROUND),
                title=ft.Text("确认签退？"),
                content=ft.Text(f"将结束：{booking['summary']}。"),
                actions=[
                    ft.Button("暂不签退", on_click=lambda _event: self.page.pop_dialog()),
                    ft.FilledButton(
                        "确认签退",
                        icon=ft.Icons.LOGOUT,
                        color=BACKGROUND,
                        bgcolor=FOREGROUND,
                        icon_color=BACKGROUND,
                        data=booking["id"],
                        on_click=self._sign_out_booking,
                    ),
                ],
            )
        )

    def _confirm_leave_booking(self, event) -> None:
        booking = event.control.data
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.PAUSE_CIRCLE_OUTLINE, color=ACCENT_SECONDARY),
                title=ft.Text("确认暂离？"),
                content=ft.Text(f"将暂离：{booking['summary']}。"),
                actions=[
                    ft.Button("取消", on_click=lambda _event: self.page.pop_dialog()),
                    ft.FilledButton(
                        "确认暂离",
                        icon=ft.Icons.PAUSE_CIRCLE_OUTLINE,
                        color=BACKGROUND,
                        bgcolor=ACCENT_SECONDARY,
                        icon_color=BACKGROUND,
                        data=booking["id"],
                        on_click=self._leave_booking,
                    ),
                ],
            )
        )

    async def _sign_out_booking(self, event) -> None:
        self.page.pop_dialog()
        await self._run_remote_booking_action(
            self.application.sign_out_booking,
            str(event.control.data),
            "签退失败",
        )

    async def _leave_booking(self, event) -> None:
        self.page.pop_dialog()
        await self._run_remote_booking_action(
            self.application.leave_booking,
            str(event.control.data),
            "暂离失败",
        )

    async def _run_remote_booking_action(
        self, operation, booking_id: str, error_prefix: str
    ) -> None:
        try:
            success, message = await asyncio.to_thread(operation, booking_id)
        except Exception as exc:
            self._show_message(f"{error_prefix}：{exc}", error=True)
        else:
            self._show_message(message, error=not success)
        await self._refresh_bookings()

    async def _repair_scheduler(self, _event) -> None:
        self.repair_scheduler_button.disabled = True
        self.page.update()
        try:
            success, message = await asyncio.to_thread(self.application.repair_daily_scheduler)
            self._show_message(message, error=not success)
        except Exception as exc:
            self._show_message(f"调度修复失败：{exc}", error=True)
        finally:
            self.repair_scheduler_button.disabled = False
            await self._refresh_schedule_policy()
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

    async def _refresh_check_in_status(self, _event=None) -> None:
        try:
            status = await asyncio.to_thread(self.application.auto_check_in_status)
        except Exception as exc:
            self.checkin_status_text.value = "读取失败"
            self.checkin_agreed_text.value = str(exc)
            with contextlib.suppress(RuntimeError):
                self.page.update()
            return
        consent_valid = bool(status.get("consent_valid"))
        tasks_ready = bool(status.get("tasks_ready"))
        enabled = bool(status.get("enabled")) and consent_valid and tasks_ready
        self.checkin_status_text.value = "已启用（风险自担）" if enabled else "未启用"
        self.checkin_status_text.color = ACCENT_SECONDARY if enabled else FOREGROUND
        self.enable_checkin_button.disabled = enabled
        self.disable_checkin_button.disabled = not enabled
        if status.get("enabled") and consent_valid and not tasks_ready:
            self.checkin_agreed_text.value = "配置显示已启用，但未找到登录触发任务；请重新启用。"
        elif enabled:
            agreed_at = status.get("agreed_at") or "未知时间"
            self.checkin_agreed_text.value = (
                f"已同意风险协议（{agreed_at}）；登录触发与窗口开启时自动签到。"
            )
        else:
            self.checkin_agreed_text.value = "默认关闭；启用需阅读并同意风险协议。"
        with contextlib.suppress(RuntimeError):
            self.page.update()

    def _open_checkin_consent_dialog(self, _event) -> None:
        checkbox = ft.Checkbox(
            label="我已阅读并知悉封号风险，自愿承担全部后果，本系统概不负责",
            value=False,
            on_change=self._on_checkin_consent_change,
        )
        confirm = ft.FilledButton(
            "同意并启用",
            color=BACKGROUND,
            bgcolor=ACCENT_SECONDARY,
            icon_color=BACKGROUND,
            disabled=True,
            on_click=self._enable_auto_check_in,
        )
        self._checkin_consent_checkbox = checkbox
        self._checkin_consent_confirm_button = confirm
        self._checkin_consent_dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("启用自动签到（可选功能）"),
            content=ft.Column(
                [
                    ft.Text(self.application.check_in_agreement_text(), size=13),
                    ft.Divider(height=1),
                    checkbox,
                ],
                spacing=12,
                tight=True,
                scroll=ft.ScrollMode.AUTO,
            ),
            actions=[
                ft.Button("暂不启用", on_click=lambda _e: self.page.pop_dialog()),
                confirm,
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        self.page.show_dialog(self._checkin_consent_dialog)
        self.page.update()

    def _on_checkin_consent_change(self, event) -> None:
        if self._checkin_consent_confirm_button is not None:
            self._checkin_consent_confirm_button.disabled = not bool(event.control.value)
            self.page.update()

    async def _enable_auto_check_in(self, _event) -> None:
        if self._checkin_consent_dialog is not None:
            self.page.pop_dialog()
        try:
            success, message = await asyncio.to_thread(
                self.application.enable_auto_check_in
            )
        except Exception as exc:
            self._show_message(f"启用自动签到失败：{exc}", error=True)
        else:
            self._show_message(message, error=not success)
        await self._refresh_check_in_status()
        await self._refresh_scheduled_tasks()

    async def _disable_auto_check_in(self, _event) -> None:
        try:
            success, message = await asyncio.to_thread(
                self.application.disable_auto_check_in
            )
        except Exception as exc:
            self._show_message(f"关闭自动签到失败：{exc}", error=True)
        else:
            self._show_message(message, error=not success)
        await self._refresh_check_in_status()
        await self._refresh_scheduled_tasks()

    def _render_scheduled_tasks(self, tasks: list[ScheduledTaskView]) -> None:
        self.schedule_list.controls.clear()
        self.schedule_summary.value = f"已创建 {len(tasks)} 个调度"
        self.schedule_summary.color = FOREGROUND
        if not tasks:
            self.schedule_list.controls.append(ft.Text("暂无已创建的调度", color=MUTED))
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
                                on_click=self._confirm_run_override,
                            ),
                            ft.PopupMenuButton(
                                icon=ft.Icons.MORE_VERT,
                                items=[
                                    ft.PopupMenuItem(
                                        content=ft.Text("删除系统任务"),
                                        icon=ft.Icons.DELETE,
                                        data=task.name,
                                        on_click=self._confirm_delete_scheduled_task,
                                    ),
                                ],
                            ),
                        ],
                    ),
                    padding=12,
                    border=ft.Border(bottom=ft.BorderSide(1, BORDER)),
                )
            )

    async def _open_policy_dialog(self, _event) -> None:
        try:
            policy = await asyncio.to_thread(self.application.schedule_policy)
        except Exception as exc:
            self._show_message(f"读取日期规则失败：{exc}", error=True)
            return
        selected = (
            {option.value for option in policy.options}
            if policy.corrupt
            else set(policy.weekdays)
        )
        self._policy_day_checks = {}
        for option in policy.options:
            self._policy_day_checks[option.value] = ft.Checkbox(
                label=option.label,
                value=option.value in selected,
                on_change=self._on_policy_day_toggle,
            )
        summary = ft.Text(
            self._policy_summary_label(sorted(selected)),
            size=15,
            weight=ft.FontWeight.W_600,
        )
        hint = ft.Text(
            "至少选择一天；如需停止运行，请暂停自动预约。",
            size=12,
            color=FOREGROUND,
            visible=False,
        )
        self._policy_dialog_summary = summary
        self._policy_dialog_hint = hint
        self._policy_dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("编辑运行日期"),
            content=ft.Column(
                [
                    ft.Text(
                        "选择需要预约座位的星期；系统会提前两天于 20:00 执行。",
                        size=13,
                        color=MUTED,
                    ),
                    ft.Row(
                        [ft.Text("当前规则", size=13, color=MUTED), summary],
                        spacing=8,
                    ),
                    ft.Row(list(self._policy_day_checks.values()), wrap=True, spacing=8),
                    hint,
                ],
                spacing=12,
                width=520,
                scroll=ft.ScrollMode.AUTO,
            ),
            actions=[
                ft.Button("取消", on_click=lambda _event: self.page.pop_dialog()),
                ft.FilledButton(
                    "保存规则",
                    icon=ft.Icons.SAVE,
                    color=BACKGROUND,
                    bgcolor=ACCENT_SECONDARY,
                    icon_color=BACKGROUND,
                    on_click=self._save_policy_dialog,
                ),
            ],
        )
        self.page.show_dialog(self._policy_dialog)
        self.page.update()

    def _on_policy_day_toggle(self, _event) -> None:
        checked = [day for day, box in self._policy_day_checks.items() if box.value]
        self._policy_dialog_summary.value = self._policy_summary_label(checked)
        empty = not checked
        self._policy_dialog_hint.visible = empty
        self._policy_dialog.actions[1].disabled = empty
        self.page.update()

    async def _save_policy_dialog(self, _event) -> None:
        checked = sorted(day for day, box in self._policy_day_checks.items() if box.value)
        if not checked:
            self._policy_dialog_hint.visible = True
            self.page.update()
            return
        try:
            await asyncio.to_thread(self.application.save_schedule_policy, weekdays=checked)
        except Exception as exc:
            self._show_message(f"保存日期规则失败：{exc}", error=True)
            return
        self.page.pop_dialog()
        self._show_message("运行日期已保存")
        await self._refresh_schedule_policy()

    def _toggle_pause_policy(self, _event) -> None:
        if self.pause_policy_button.text == "恢复自动预约":
            self.page.run_task(self._resume_schedule_policy)
            return
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.PAUSE_CIRCLE_OUTLINE, color=ACCENT_SECONDARY),
                title=ft.Text("暂停自动预约？"),
                content=ft.Text(
                    "暂停后系统仍会每天检查，但不会发起预约。星期规则与系统任务都会保留。"
                ),
                actions=[
                    ft.Button("取消", on_click=lambda _event: self.page.pop_dialog()),
                    ft.FilledButton(
                        "确认暂停",
                        color=BACKGROUND,
                        bgcolor=ACCENT_SECONDARY,
                        icon_color=BACKGROUND,
                        on_click=self._confirm_pause_policy,
                    ),
                ],
            )
        )

    async def _confirm_pause_policy(self, _event) -> None:
        self.page.pop_dialog()
        try:
            await asyncio.to_thread(self.application.save_schedule_policy, enabled=False)
        except Exception as exc:
            self._show_message(f"暂停失败：{exc}", error=True)
            return
        self._show_message("自动预约已暂停")
        await self._refresh_schedule_policy()

    async def _resume_schedule_policy(self) -> None:
        try:
            await asyncio.to_thread(self.application.save_schedule_policy, enabled=True)
        except Exception as exc:
            self._show_message(f"恢复失败：{exc}", error=True)
            return
        self._show_message("自动预约已恢复")
        await self._refresh_schedule_policy()

    def _confirm_run_override(self, _event) -> None:
        try:
            count = self.application.enabled_plan_count()
        except Exception:
            count = 0
        self.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                icon=ft.Icon(ft.Icons.PLAY_CIRCLE_OUTLINE, color=ACCENT_SECONDARY),
                title=ft.Text("确认立即执行？"),
                content=ft.Column(
                    [
                        ft.Text(
                            f"目标预约日期：{self.application.booking_day_text()}（后天）"
                        ),
                        ft.Text(f"将执行的已启用方案：{count} 个"),
                        ft.Text(
                            "本次会绕过当前日期规则，不会修改已保存的配置。",
                            size=13,
                            color=MUTED,
                        ),
                    ],
                    spacing=8,
                ),
                actions=[
                    ft.Button("取消", on_click=lambda _event: self.page.pop_dialog()),
                    ft.FilledButton(
                        "确认立即执行",
                        icon=ft.Icons.PLAY_ARROW,
                        color=BACKGROUND,
                        bgcolor=ACCENT_SECONDARY,
                        icon_color=BACKGROUND,
                        on_click=self._run_override,
                    ),
                ],
            )
        )

    async def _run_override(self, _event) -> None:
        self.page.pop_dialog()
        try:
            exit_code = await asyncio.to_thread(self.application.run_booking_override)
        except Exception as exc:
            self._show_message(f"立即执行失败：{exc}", error=True)
        else:
            if exit_code == 0:
                self._show_message("立即执行完成（已绕过日期规则）")
            else:
                self._show_message(f"立即执行未完成（退出码 {exit_code}）", error=True)
        await self._refresh_schedule_policy()
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
        await self._refresh_schedule_policy()

    def _on_application_event(self, event: ApplicationEvent) -> None:
        if event.kind == EventKind.AUTH_REQUIRED:
            self.auth_state.value = "认证已失效"
            self.auth_state.color = FOREGROUND
            self.auth_log.value = event.message
            self._show_authentication(update=False)
        with contextlib.suppress(RuntimeError):
            self.page.update()


def flet_main(page: ft.Page, application: SniperAppProtocol) -> None:
    SniperFletView(page, application)


def run_flet_app(application: SniperAppProtocol) -> None:
    """启动桌面 Flet 客户端。"""
    ft.run(
        lambda page: flet_main(page, application),
        view=ft.AppView.FLET_APP,
        assets_dir=resolve_assets_dir(),
    )
