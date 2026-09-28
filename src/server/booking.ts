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
  /** 终态：重试也不会改变结果（如存在时间冲突的预约），burst 应立即停止。 */
  terminal?: boolean;
};

export type BookingRunResult = {
  planId?: string;
  kind?: "single" | "group";
  success: boolean;
  message: string;
  members: BookingMemberResult[];
};

export type BookingLock = {
  planId: string;
  seatId: string;
  seatNum: string;
  beginSeconds: number;
  durationHours: number;
};

export type BookingLockResult = {
  planId?: string;
  kind?: "single" | "group";
  success: boolean;
  message: string;
  locks: BookingLock[];
  terminal?: boolean;
};

// 抢座节奏：整点发起后若被拒（典型是服务器时钟尚未切到新窗口），按 1.1s 的请求间隔
// 不间断重试，直到成功、发现已有预约或超时。间隔同时用于避免高频请求触发馆方风控。
const burstRequestIntervalMs = 1100;
const burstTimeoutMs = 10 * 60_000;
const prelockTimeoutMs = 90_000;

// 预约路径发出的所有馆方请求共享一个节拍器：任意两次请求的实际间隔不低于 intervalMs。
export const pacing = {
  intervalMs: burstRequestIntervalMs,
  // Vitest may reuse the module instance across files; clear the shared request slot between suites.
  reset() { nextRequestSlot = 0; },
};
let nextRequestSlot = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const wait = Math.max(0, nextRequestSlot - now);
  nextRequestSlot = Math.max(now, nextRequestSlot) + pacing.intervalMs;
  if (wait > 0) await sleep(wait);
  return fn();
}

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
  // 慧图前端对预约/预锁结果的处理：CODE=ok 时读 DATA.msg；CODE 非 ok 时读顶层 MESSAGE。
  return String(data?.msg || response.MESSAGE || "");
}

function bookingSucceeded(response: Record<string, unknown>): boolean {
  const data = response.DATA as Record<string, unknown> | undefined;
  if (String(response.CODE).toLowerCase() !== "ok") return false;
  if (String(data?.result).toLowerCase() === "success") return true;
  // 部分成功响应（如服务端调整后的结果）只带 DATA.msg，没有 result 字段。
  return String(data?.msg || "").includes("成功");
}

function lockSucceeded(response: Record<string, unknown>): boolean {
  if (String(response.CODE).toLowerCase() !== "ok") return false;
  // 前端用 DATA.time 启动 15 分钟倒计时；缺时间说明锁状态不可靠。
  return Number((response.DATA as Record<string, unknown> | undefined)?.time || 0) > 0;
}

function isDuplicateMessage(message: string): boolean {
  return /已有预约|请勿重复|重复预约/.test(message);
}

function planMembers(enabled: PlanListItem): BookingPlan[] {
  return enabled.kind === "group" ? (enabled.members || []).slice().sort((a, b) => a.startHour - b.startHour) : [enabled];
}

function memberBegin(plan: BookingPlan): Date | undefined {
  const target = targetDate(bookingDayOffsetFor(plan.roomType));
  if (!plan.weekdays.includes(weekday(target))) return undefined;
  return new Date(`${target.toISOString().slice(0, 10)}T${String(plan.startHour).padStart(2, "0")}:00:00+08:00`);
}

// 幂等依据：馆方预约列表里已存在同一开始时间的预约时，不再重复提交。
async function existingBookingForBegin(client: LibraryClient, begin: Date): Promise<Record<string, unknown> | undefined> {
  try {
    const items = await paced(() => client.bookings());
    const target = Math.floor(begin.getTime() / 1000);
    return items.find((item) => Number(item.time || 0) === target);
  } catch {
    return undefined;
  }
}

async function bookedBeginTimes(client: LibraryClient): Promise<Set<number>> {
  try {
    const items = await paced(() => client.bookings());
    return new Set(items.map((item) => Number(item.time || 0)));
  } catch {
    return new Set();
  }
}

async function releaseLocks(client: LibraryClient): Promise<void> {
  try {
    await paced(() => client.unlockAllSeats());
  } catch (error) {
    if (error instanceof AuthenticationExpiredError) throw error;
    // 释放失败不能掩盖原始 lockSeats 失败；下一次尝试仍会再次释放。
  }
}

type ResolvedSeat = { seatId: string; seatNum: string };

// 预锁优先只锁主座位。主座位只是“未开放”等原因被拒时应原座位重试，
// 不能在开放前退到 fallback，否则 20:00 反而会订到非首选座位。
async function resolvePrimarySeat(client: LibraryClient, plan: BookingPlan, begin: Date): Promise<ResolvedSeat> {
  const floors = await paced(() => client.floors(plan.roomQuery, begin, plan.durationHours));
  const floor = floors.find((item) => {
    const map = (item as Record<string, unknown>).seatMap as Record<string, unknown> | undefined;
    return String(((map?.info as Record<string, unknown> | undefined)?.id || "")) === String(plan.floorId);
  }) as Record<string, unknown> | undefined;
  const seats = ((floor?.seatMap as Record<string, unknown> | undefined)?.POIs as Record<string, unknown>[] | undefined) || [];
  for (const seatNum of [plan.seatNum, ...plan.fallbackSeats]) {
    const seat = seats.find((item) => String(item.title || "").trim() === seatNum);
    if (seat?.id) return { seatId: String(seat.id), seatNum };
    // 只有主座位在座位图里不存在时才考虑 fallback；一旦锁定失败仍回到外层重试主座位。
    if (seatNum === plan.seatNum) continue;
  }
  throw new Error("未找到可预锁座位");
}

async function bookSeatWithConfirmation(
  client: LibraryClient,
  plan: BookingPlan,
  begin: Date,
  seatId: string,
  seatNum: string,
): Promise<BookingMemberResult> {
  try {
    const response = await paced(() => client.bookSeat(seatId, begin, plan.durationHours));
    if (bookingSucceeded(response)) return { planId: plan.id, seatNum, success: true, message: "预约成功" };
    const message = responseMessage(response) || "预约失败";
    // 服务器已受理但响应被判定失败时，先做幂等确认，避免重复提交和误报。
    const confirmed = await existingBookingForBegin(client, begin);
    if (confirmed) {
      return { planId: plan.id, seatNum: String(confirmed.seatNum || seatNum), success: true, message: "预约已生效（以预约列表为准）" };
    }
    if (isDuplicateMessage(message)) {
      return { planId: plan.id, seatNum, success: false, terminal: true, message: `存在时间冲突的预约，请先取消后再试：${message}` };
    }
    return { planId: plan.id, seatNum, success: false, message };
  } catch (error) {
    if (error instanceof AuthenticationExpiredError) throw error;
    if (error instanceof RequestTimeoutError) {
      // 读/连超时 ≠ 预约失败，服务器可能已受理。以预约列表做幂等确认。
      const confirmed = await existingBookingForBegin(client, begin);
      if (confirmed) {
        return { planId: plan.id, seatNum: String(confirmed.seatNum || seatNum), success: true, message: "预约已生效（响应超时，以预约列表为准）" };
      }
      return { planId: plan.id, seatNum, success: false, message: "请求超时，未自动重试" };
    }
    return { planId: plan.id, seatNum, success: false, message: String(error) };
  }
}

async function executePlan(
  client: LibraryClient,
  plan: BookingPlan,
  begin: Date,
  dryRun: boolean,
  preferred?: BookingLock,
): Promise<BookingMemberResult> {
  // 已预锁座位必须绕过开放瞬间的座位图查询，直接用预锁时的座位 ID 转正式预约。
  if (preferred) {
    if (dryRun) return { planId: plan.id, seatNum: preferred.seatNum, success: true, message: "预演成功，未提交预约请求" };
    return bookSeatWithConfirmation(client, plan, begin, preferred.seatId, preferred.seatNum);
  }

  let floors: unknown[];
  try {
    floors = await paced(() => client.floors(plan.roomQuery, begin, plan.durationHours));
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
    const result = await bookSeatWithConfirmation(client, plan, begin, String(seat.id), seatNum);
    if (result.success || result.terminal) return result;
    lastMessage = result.message;
  }
  return { planId: plan.id, success: false, message: lastMessage };
}

async function lockAllMembersOnce(
  client: LibraryClient,
  enabled: PlanListItem,
  members: BookingPlan[],
  booked: Set<number>,
): Promise<BookingLockResult> {
  const locks: BookingLock[] = [];
  try {
    for (const plan of members) {
      const begin = memberBegin(plan);
      if (!begin) continue;
      const beginSeconds = Math.floor(begin.getTime() / 1000);
      if (booked.has(beginSeconds)) continue;

      const seat = await resolvePrimarySeat(client, plan, begin);
      const response = await paced(() => client.lockSeat(seat.seatId, begin, plan.durationHours));
      if (!lockSucceeded(response)) {
        const message = responseMessage(response) || "预锁失败";
        await releaseLocks(client);
        return {
          planId: enabled.id,
          kind: enabled.kind,
          success: false,
          terminal: isDuplicateMessage(message),
          message: isDuplicateMessage(message) ? `存在时间冲突的预约，请先取消后再试：${message}` : message,
          locks: [],
        };
      }
      locks.push({ planId: plan.id, seatId: seat.seatId, seatNum: seat.seatNum, beginSeconds, durationHours: plan.durationHours });
    }
    return {
      planId: enabled.id,
      kind: enabled.kind,
      success: true,
      message: "座位预锁成功，等待预约窗口开放",
      locks,
    };
  } catch (error) {
    // 超时/网络错误时锁可能已在服务端建立，即使本地还没记录成功也要清理。
    await releaseLocks(client);
    if (error instanceof AuthenticationExpiredError) throw error;
    if (error instanceof RequestTimeoutError) {
      return { planId: enabled.id, kind: enabled.kind, success: false, message: "预锁请求超时", locks: [] };
    }
    return { planId: enabled.id, kind: enabled.kind, success: false, message: String(error), locks: [] };
  }
}

export class BookingExecutor {
  /** 当前预约日的预锁；19:59 建立后由 20:00 的预约 burst 消费。 */
  private lockedSeats: BookingLock[] = [];

  constructor(private readonly client: LibraryClient, private readonly pause: (ms: number) => Promise<void> = sleep) {}

  // 单次执行：手动触发或 burst 中的一次尝试。幂等——预约列表里已有的时段直接跳过。
  async run(dryRun = false, options: { audit?: boolean } = {}): Promise<BookingRunResult> {
    const release = tryAcquireJobLock("booking");
    if (!release) return { success: false, message: "已有任务正在运行", members: [] };
    try {
      const enabled = listPlanItems().find((item) => item.enabled);
      if (!enabled) return { success: false, message: "没有启用的预约方案", members: [] };
      const begins = dryRun ? new Set<number>() : await bookedBeginTimes(this.client);
      const results: BookingMemberResult[] = [];
      for (const plan of planMembers(enabled)) {
        const begin = memberBegin(plan);
        if (!begin) continue;
        let result: BookingMemberResult;
        if (begins.has(Math.floor(begin.getTime() / 1000))) {
          result = { planId: plan.id, success: true, message: "该时段已有预约，跳过重复提交" };
        } else {
          const beginSeconds = Math.floor(begin.getTime() / 1000);
          const preferred = this.lockedSeats.find((lock) => lock.planId === plan.id && lock.beginSeconds === beginSeconds);
          result = await executePlan(this.client, plan, begin, dryRun, preferred);
        }
        results.push(result);
        writeAudit("booking_member_finished", { planId: plan.id, success: result.success, seatNum: result.seatNum, message: result.message });
      }
      const success = results.length > 0 && results.every((result) => result.success);
      const message = dryRun ? "预约预演完成，未提交预约请求" : success ? "预约任务完成" : `预约失败：${results.map((result) => result.message).join("；")}`;
      const result: BookingRunResult = { planId: enabled.id, kind: enabled.kind, success, message, members: results };
      if (options?.audit !== false) {
        writeAudit("booking_run_finished", { planId: enabled.id, kind: enabled.kind, success, members: results.length, message });
      }
      if (success) this.lockedSeats = [];
      return result;
    } finally {
      release();
    }
  }

  // 整点抢座：持续按节奏重试到成功、发现已有预约或超时。
  async runBurst(dryRun = false, options: { intervalMs?: number; timeoutMs?: number } = {}): Promise<BookingRunResult> {
    const intervalMs = options.intervalMs ?? burstRequestIntervalMs;
    const deadline = Date.now() + (options.timeoutMs ?? burstTimeoutMs);
    for (;;) {
      const result = await this.run(dryRun, { audit: false });
      const terminal = result.members.some((member) => member.terminal);
      if (result.success || terminal || Date.now() >= deadline) {
        // burst 只产生一条结果审计，避免逐次重试刷屏通知。
        writeAudit("booking_run_finished", { planId: result.planId, kind: result.kind, success: result.success, members: result.members.length, message: result.message });
        if (result.success || terminal) this.lockedSeats = [];
        return result;
      }
      await this.pause(intervalMs);
    }
  }

  // 预锁窗口：19:59 开始，成功后保持锁；20:00 的 runBurst 会用同一座位直接转正式预约。
  async lockBurst(options: { intervalMs?: number; timeoutMs?: number; deadlineAt?: Date } = {}): Promise<BookingLockResult> {
    const enabled = listPlanItems().find((item) => item.enabled);
    if (!enabled) return { success: false, message: "没有启用的预约方案", locks: [] };
    const intervalMs = options.intervalMs ?? burstRequestIntervalMs;
    const deadline = options.deadlineAt?.getTime() ?? Date.now() + (options.timeoutMs ?? prelockTimeoutMs);
    let last: BookingLockResult | undefined;

    for (;;) {
      const members = planMembers(enabled).filter((plan) => memberBegin(plan));
      if (members.length === 0) {
        last = { planId: enabled.id, kind: enabled.kind, success: false, message: "没有符合星期的预约成员", locks: [] };
        break;
      }
      const booked = await bookedBeginTimes(this.client);
      last = await lockAllMembersOnce(this.client, enabled, members, booked);
      const deadlineReached = Date.now() >= deadline;
      if (last.success || last.terminal || deadlineReached) break;
      const remaining = deadline - Date.now();
      if (remaining <= intervalMs) break;
      await this.pause(Math.min(intervalMs, remaining));
    }

    if (!last) last = { planId: enabled.id, kind: enabled.kind, success: false, message: "预锁未执行", locks: [] };
    this.lockedSeats = last.success ? last.locks : [];
    writeAudit("booking_prelock_finished", {
      planId: last.planId,
      kind: last.kind,
      success: last.success,
      locks: last.locks.length,
      message: last.message,
    });
    return last;
  }
}
