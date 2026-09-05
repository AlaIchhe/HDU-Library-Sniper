import type { BookingPlan, PlanListItem, Weekday } from "../shared/types";
import { bookingDayOffset, bookingDayOffsetFor, timezone } from "./config";
import { writeAudit } from "./db";
import { tryAcquireJobLock } from "./lock";
import { AuthenticationExpiredError, LibraryClient, RequestTimeoutError } from "./library";
import { listPlanItems } from "./plans";

export type BookingMemberResult = {
  planId: string;
  seatNum?: string;
  success: boolean;
  message: string;
};

export type BookingRunResult = {
  planId?: string;
  kind?: "single" | "group";
  success: boolean;
  message: string;
  members: BookingMemberResult[];
};

function targetDate(offset = bookingDayOffset, now = new Date()): Date {
  const result = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  result.setDate(result.getDate() + offset);
  return result;
}

function weekday(date: Date): Weekday {
  const day = date.getDay();
  return (day === 0 ? 7 : day) as Weekday;
}

function responseMessage(response: Record<string, unknown>): string {
  const data = response.DATA as Record<string, unknown> | undefined;
  // 慧图前端对预约结果的处理：CODE=ok 时读 DATA.msg；CODE 非 ok 时读顶层 MESSAGE。
  return String(data?.msg || response.MESSAGE || "");
}

function bookingSucceeded(response: Record<string, unknown>): boolean {
  const data = response.DATA as Record<string, unknown> | undefined;
  return String(response.CODE).toLowerCase() === "ok" && String(data?.result).toLowerCase() === "success";
}

async function executePlan(client: LibraryClient, plan: BookingPlan, begin: Date, dryRun: boolean): Promise<BookingMemberResult> {
  let floors: unknown[];
  try {
    floors = await client.floors(plan.roomQuery, begin, plan.durationHours);
  } catch (error) {
    return { planId: plan.id, success: false, message: `房间或座位查询失败: ${String(error)}` };
  }
  const floor = floors.find((item) => {
    const map = (item as Record<string, unknown>).seatMap as Record<string, unknown> | undefined;
    return String(((map?.info as Record<string, unknown> | undefined)?.id || "")) === String(plan.floorId);
  }) as Record<string, unknown> | undefined;
  const seats = ((floor?.seatMap as Record<string, unknown> | undefined)?.POIs as Record<string, unknown>[] | undefined) || [];
  const candidates = [plan.seatNum, ...plan.fallbackSeats];
  let lastMessage = "未找到可用座位";
  for (const seatNum of candidates) {
    const seat = seats.find((item) => String(item.title || "").trim() === seatNum);
    if (!seat?.id) { lastMessage = `找不到座位 ${seatNum}`; continue; }
    if (dryRun) return { planId: plan.id, seatNum, success: true, message: "预演成功，未提交预约请求" };
    try {
      const response = await client.bookSeat(String(seat.id), begin, plan.durationHours);
      if (bookingSucceeded(response)) return { planId: plan.id, seatNum, success: true, message: "预约成功" };
      lastMessage = responseMessage(response) || "预约失败";
    } catch (error) {
      if (error instanceof AuthenticationExpiredError) throw error;
      if (error instanceof RequestTimeoutError) {
        return { planId: plan.id, seatNum, success: false, message: "请求超时，未自动重试" };
      }
      lastMessage = String(error);
    }
  }
  return { planId: plan.id, success: false, message: lastMessage };
}

export class BookingExecutor {
  constructor(private readonly client: LibraryClient) {}

  async run(dryRun = false): Promise<BookingRunResult> {
    const release = tryAcquireJobLock("booking");
    if (!release) return { success: false, message: "已有任务正在运行", members: [] };
    try {
      const enabled = listPlanItems().find((item) => item.enabled);
      if (!enabled) return { success: false, message: "没有启用的预约方案", members: [] };
      const members = enabled.kind === "group"
        ? (enabled.members || []).slice().sort((a, b) => a.startHour - b.startHour)
        : [enabled];
      const results: BookingMemberResult[] = [];
      for (const plan of members) {
        const target = targetDate(bookingDayOffsetFor(plan.roomType));
        if (!plan.weekdays.includes(weekday(target))) continue;
        const begin = new Date(`${target.toISOString().slice(0, 10)}T${String(plan.startHour).padStart(2, "0")}:00:00+08:00`);
        const result = await executePlan(this.client, plan, begin, dryRun);
        results.push(result);
        writeAudit("booking_member_finished", { planId: plan.id, success: result.success, seatNum: result.seatNum });
      }
      const success = results.length > 0 && results.every((result) => result.success);
      const result: BookingRunResult = { planId: enabled.id, kind: enabled.kind, success, message: dryRun ? "预约预演完成，未提交预约请求" : success ? "预约任务完成" : "预约任务部分失败或未完成", members: results };
      writeAudit("booking_run_finished", { planId: enabled.id, kind: enabled.kind, success, members: results.length });
      return result;
    } finally {
      release();
    }
  }
}
