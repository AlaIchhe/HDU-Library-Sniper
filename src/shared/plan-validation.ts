import type { BookingPlan, Weekday } from "./types";

const validWeekdays = (days: number[]): Weekday[] =>
  [...new Set(days)].filter((day): day is Weekday => Number.isInteger(day) && day >= 1 && day <= 7).sort((a, b) => a - b);

export function validatePlan(input: Partial<BookingPlan>): string[] {
  const errors: string[] = [];
  if (!input.roomType?.trim()) errors.push("房间类型不能为空");
  if (!input.roomQuery?.trim()) errors.push("房间查询参数不能为空");
  if (!Number.isInteger(input.floorId) || Number(input.floorId) <= 0) errors.push("楼层无效");
  if (!input.seatNum?.trim()) errors.push("座位号不能为空");
  if (!Number.isInteger(input.startHour) || Number(input.startHour) < 0 || Number(input.startHour) > 23) errors.push("开始时间无效");
  if (!Number.isInteger(input.durationHours) || Number(input.durationHours) <= 0) errors.push("时长无效");
  if (!validWeekdays(input.weekdays || []).length) errors.push("至少选择一个星期");
  return errors;
}

export { validWeekdays };
