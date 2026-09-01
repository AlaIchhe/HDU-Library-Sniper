import type { BookingPlan, PlanListItem, Weekday } from "../shared/types";
import { bookingDayOffset, bookingDayOffsetFor, timezone } from "./config";
import { writeAudit } from "./db";
import { tryAcquireJobLock } from "./lock";
import { AuthenticationExpiredError, HduLibraryError, LibraryClient, RequestTimeoutError } from "./library";
import { listPlanItems } from "./plans";

const maxTrials = 5;
const retryDelayMs = 1_000;
const windowWaitMs = 30_000;
const windowPollMs = 1_100;

export type BookingMemberResult = {
  planId: string;
  seatNum?: string;
  success: boolean;
  verified: boolean;
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
  return String(response.MESSAGE || data?.msg || "");
}

function classify(response: Record<string, unknown>): "success" | "window" | "duplicate" | "unavailable" | "rate-limit" | "invalid" | "unknown" {
  const message = responseMessage(response);
  if (String(response.CODE || "").toLowerCase() === "ok") return "success";
  if (message.includes("超出可预约座位时间范围")) return "window";
  if (message.includes("已有预约")) return "duplicate";
  if (message.includes("座位无法预约") || message.includes("座位不可用")) return "unavailable";
  if (String(response.CODE) === "1" || message.includes("请求太频繁")) return "rate-limit";
  if (message.includes("非法请求") || message.includes("过去时间") || message.includes("参数设置")) return "invalid";
  return "unknown";
}

async function verify(client: LibraryClient, plan: BookingPlan, begin: Date): Promise<boolean> {
  const expected = Math.floor(begin.getTime() / 1000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const bookings = await client.bookings();
      if (bookings.some((item) =>
        String(item.seatNum || "").trim() === plan.seatNum &&
        Math.abs(Number(item.time || 0) - expected) <= 1 &&
        Number(item.duration || 0) === plan.durationHours * 3600)) return true;
    } catch { /* best effort; caller treats this as unverified */ }
    if (attempt === 0) await Bun.sleep(1_000);
  }
  return false;
}

async function executePlan(client: LibraryClient, plan: BookingPlan, begin: Date, dryRun: boolean): Promise<BookingMemberResult> {
  let floors: unknown[];
  try {
    floors = await client.floors(plan.roomQuery, begin, plan.durationHours);
  } catch (error) {
    return { planId: plan.id, success: false, verified: false, message: `房间或座位查询失败: ${String(error)}` };
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
    if (dryRun) return { planId: plan.id, seatNum, success: true, verified: false, message: "预演成功，未提交预约请求" };
    let attempt = 0;
    const deadline = Date.now() + windowWaitMs;
    while (attempt < maxTrials) {
      try {
        const response = await client.bookSeat(String(seat.id), begin, plan.durationHours);
        const decision = classify(response);
        lastMessage = responseMessage(response) || decision;
        if (decision === "success") {
          const verified = await verify(client, { ...plan, seatNum }, begin);
          if (verified) return { planId: plan.id, seatNum, success: true, verified: true, message: "预约成功，已完成预约列表复核" };
          return { planId: plan.id, seatNum, success: false, verified: false, message: "接口返回成功，但预约列表未复核到匹配记录" };
        }
        if (decision === "duplicate" || decision === "unavailable") break;
        if (decision === "invalid") return { planId: plan.id, seatNum, success: false, verified: false, message: lastMessage };
        if (decision === "window") {
          if (Date.now() >= deadline) break;
          await Bun.sleep(windowPollMs);
          continue;
        }
        attempt += 1;
        if (attempt < maxTrials) await Bun.sleep(decision === "rate-limit" ? 1_100 : retryDelayMs * 2 ** (attempt - 1));
      } catch (error) {
        lastMessage = String(error);
        if (error instanceof AuthenticationExpiredError) throw error;
        if (error instanceof RequestTimeoutError) {
          if (await verify(client, { ...plan, seatNum }, begin)) return { planId: plan.id, seatNum, success: true, verified: true, message: "请求超时，但预约列表确认成功" };
          return { planId: plan.id, seatNum, success: false, verified: false, message: "请求超时且无法确认预约状态，停止重复提交" };
        }
        attempt += 1;
        if (attempt < maxTrials) await Bun.sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  return { planId: plan.id, success: false, verified: false, message: lastMessage };
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
        writeAudit("booking_member_finished", { planId: plan.id, success: result.success, verified: result.verified, seatNum: result.seatNum });
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
