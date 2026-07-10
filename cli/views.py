"""方案表格与横幅渲染、进度行格式化（纯输出，无业务逻辑）。"""

from __future__ import annotations

from core.sniper import BookingPlan, BookingResult, PlanRepository, PlanStatus


def print_banner(plans: PlanRepository) -> None:
    print("=" * 52)
    print("   HDU 图书馆抢座工具 (HDU-Library-Sniper)")
    print("=" * 52)
    print(f"   当前方案数: {len(plans.load_all())} (启用: {len(plans.list_enabled())})")


def print_plan_table(plans: list[BookingPlan]) -> None:
    print(f"\n{'#':<3} {'ID':<12} {'房间':<6} {'楼层':<6} {'座位':<6} {'开始':<6} {'时长':<6} {'状态':<6}")
    print("-" * 60)
    for i, p in enumerate(plans, 1):
        status = "启用" if p.status == PlanStatus.ENABLED else "禁用"
        print(
            f"{i:<3} {p.plan_id or '-':<12} {p.room_type:<6} {p.floor_id:<6} "
            f"{p.seat_num:<6} {p.start_hour:02d}:00{'':<1} {p.duration_hours}h{'':<4} {status:<6}"
        )


def plan_labels(plans: list[BookingPlan]) -> list[str]:
    labels = []
    for p in plans:
        status = "启用" if p.status == PlanStatus.ENABLED else "禁用"
        labels.append(
            f"{p.plan_id or '-'}  房间{p.room_type} 楼层{p.floor_id} {p.seat_num}座 "
            f"{p.start_hour:02d}:00 {p.duration_hours}h [{status}]"
        )
    return labels


def format_progress_line(result: BookingResult, indent: str = "  ") -> str:
    """格式化单次预约尝试的进度行（立即 / 定时 / 非交互三处共用）。

    与历史内联格式逐字一致：``{indent}[OK|X] [plan_code] message``。
    """
    icon = "OK" if result.success else "X"
    return f"{indent}[{icon}] [{result.plan.to_plan_code()}] {result.message}"
