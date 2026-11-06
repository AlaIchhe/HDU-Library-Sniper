import type { BookingPlan, PlanListItem, Weekday } from "../shared/types";
import { bookingDayOffset, bookingDayOffsetFor, timezone } from "./config";
import { nextBackoffMs } from "./backoff";
import { writeAudit } from "./db";
import { tryAcquireJobLock } from "./lock";
import { AuthenticationExpiredError, LibraryClient, RequestTimeoutError } from "./library";
import { listPlanItems } from "./plans";

export type BookingMemberResult = {
  planId: string;
  seatNum?: string;
  success: boolean;
  message: string;
  /** 终态：重试也不会改变结果（如存在时间冲突的预约）。burst 停止重试该成员，但不影响同组其它成员。 */
  terminal?: boolean;
  /** 预约可能已被受理，但预约列表不可用，暂时无法确认；不能当作失败重试，也不能当作成功。 */
  unverified?: boolean;
  /** 账号被馆方限流（10 分钟级）；整个 burst 必须立刻停止，不能继续重试。 */
  blocked?: boolean;
  /** 服务端要求的下一次尝试间隔（毫秒），用于短时限流/流程异常。 */
  retryAfterMs?: number;
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
  /** 馆方锁是否已建立；false 表示只是提前解析出的座位，20:00 直接尝试预约。 */
  locked: boolean;
};

export type BookingLockResult = {
  planId?: string;
  kind?: "single" | "group";
  success: boolean;
  message: string;
  locks: BookingLock[];
  terminal?: boolean;
};

// 馆方对 bookSeats 的手机端配额约 3 秒一次：间隔不足时先返回“请求太频繁了，请稍后再试”，
// 继续触发会升级成 10 分钟账号级封禁（“请求过于频繁，请10分钟后再试”）。
// 因此两次“查询座位 + 提交预约”之间至少间隔 4 秒，且每次提交前都要重新查询座位。
const burstRequestIntervalMs = 4_000;
const burstTimeoutMs = 10 * 60_000;
// 抢座失败后的退避上限：任何一轮有失败就翻倍，最多等 5 分钟。
const burstMaxBackoffMs = 5 * 60_000;
const prelockTimeoutMs = 90_000;
// 手机端短时限流（“请求太频繁了”）的等待时间。
const throttleBackoffMs = 15_000;
// 馆方 10 分钟封禁；命中后整轮 burst 直接结束，等待期内不再发任何预约请求。
const accountBanMs = 10 * 60_000;



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

// 桌面端会把后台 stdout 落盘到 server.log；测试环境不打，避免刷屏。
function bookingLog(message: string): void {
  if (process.env.NODE_ENV === "test") return;
  console.log(`[booking] ${message}`);
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

const bookingListRetries = 2;
const bookingListRetryDelayMs = 400;

type BookingLookup =
  | { status: "found"; item: Record<string, unknown> }
  | { status: "absent" }
  | { status: "unknown" };

async function readBookings(client: LibraryClient): Promise<Record<string, unknown>[]> {
  return paced(() => client.bookings());
}

// 幂等依据：馆方预约列表里已存在同一开始时间的预约时，不再重复提交。
// 列表接口失败时返回 undefined，绝不能伪装成“没有预约”。
async function bookedBeginTimes(client: LibraryClient): Promise<Set<number> | undefined> {
  for (let attempt = 0; attempt < bookingListRetries; attempt += 1) {
    try {
      const items = await readBookings(client);
      return new Set(items.map((item) => Number(item.time || 0)));
    } catch (error) {
      if (error instanceof AuthenticationExpiredError) throw error;
      if (attempt + 1 < bookingListRetries) await sleep(bookingListRetryDelayMs);
    }
  }
  return undefined;
}

// 预约结果确认：优先查实时列表；列表不可用时只能拿“已有的预约快照”当正证据，
// 否则返回 unknown —— 既不能判定成功，也不能判定没有预约。
async function confirmBookingForBegin(client: LibraryClient, begin: Date, snapshot?: Set<number>): Promise<BookingLookup> {
  const target = Math.floor(begin.getTime() / 1000);
  for (let attempt = 0; attempt < bookingListRetries; attempt += 1) {
    try {
      const items = await readBookings(client);
      const item = items.find((entry) => Number(entry.time || 0) === target);
      return item ? { status: "found", item } : { status: "absent" };
    } catch (error) {
      if (error instanceof AuthenticationExpiredError) throw error;
      if (attempt + 1 < bookingListRetries) await sleep(bookingListRetryDelayMs);
    }
  }
  if (snapshot?.has(target)) return { status: "found", item: { time: target } };
  return { status: "unknown" };
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

type BookingFailure = "ban" | "throttle" | "flow";

// 馆方返回的三种“非座位原因”失败，必须区别对待：
//  - ban：账号级 10 分钟封禁，整轮 burst 立刻停止；
//  - throttle：手机端短时限流，等 15 秒再试；
//  - flow：没有先查询座位，重新查询后再提交。
function classifyBookingFailure(message: string): BookingFailure | undefined {
  if (/请求过于频繁|非手机端请求过于频繁/.test(message)) return "ban";
  if (/请求太频繁了/.test(message)) return "throttle";
  if (/订座流程异常/.test(message)) return "flow";
  return undefined;
}

function seatIdFromFloors(floors: unknown[], plan: BookingPlan, seatNum: string): string | undefined {
  const floor = floors.find((item) => {
    const map = (item as Record<string, unknown>).seatMap as Record<string, unknown> | undefined;
    return String(((map?.info as Record<string, unknown> | undefined)?.id || "")) === String(plan.floorId);
  }) as Record<string, unknown> | undefined;
  const seats = ((floor?.seatMap as Record<string, unknown> | undefined)?.POIs as Record<string, unknown>[] | undefined) || [];
  const seat = seats.find((item) => String(item.title || "").trim() === seatNum);
  return seat?.id ? String(seat.id) : undefined;
}

type BookingAttempt =
  | { kind: "submitted"; seatId: string; response: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "query-failed"; message: string }
  | { kind: "request-failed"; error: unknown }
  | { kind: "dry-run" };

// 服务端要求“先查询座位，再提交预约”。查询与提交放进同一个节拍单元：
// 既满足流程校验，又由 pacing 保证两次 bookSeats 之间至少相隔 burstRequestIntervalMs。
async function querySeatsAndBook(
  client: LibraryClient,
  plan: BookingPlan,
  begin: Date,
  seatNum: string,
  seatId: string | undefined,
  dryRun: boolean,
): Promise<BookingAttempt> {
  return paced(async () => {
    let floors: unknown[];
    try {
      floors = await client.floors(plan.roomQuery, begin, plan.durationHours);
    } catch (error) {
      return { kind: "query-failed", message: String(error) };
    }
    const resolved = seatId ?? seatIdFromFloors(floors, plan, seatNum);
    if (!resolved) return { kind: "missing" };
    if (dryRun) return { kind: "dry-run" };
    try {
      const response = await client.bookSeat(resolved, begin, plan.durationHours);
      return { kind: "submitted", seatId: resolved, response };
    } catch (error) {
      return { kind: "request-failed", error };
    }
  });
}

async function finalizeBooking(
  client: LibraryClient,
  plan: BookingPlan,
  begin: Date,
  seatNum: string,
  response: Record<string, unknown>,
  snapshot?: Set<number>,
): Promise<BookingMemberResult> {
  if (bookingSucceeded(response)) return { planId: plan.id, seatNum, success: true, message: "预约成功" };
  const message = responseMessage(response) || "预约失败";
  const failure = classifyBookingFailure(message);
  if (failure === "ban") {
    return { planId: plan.id, seatNum, success: false, terminal: true, blocked: true, message: `账号已被馆方限流，需等待 ${accountBanMs / 60_000} 分钟：${message}` };
  }
  if (failure === "throttle") return { planId: plan.id, seatNum, success: false, retryAfterMs: throttleBackoffMs, message };
  if (failure === "flow") return { planId: plan.id, seatNum, success: false, retryAfterMs: burstRequestIntervalMs, message };
  // 服务器已受理但响应被判定失败时，先做幂等确认，避免重复提交和误报。
  const confirmation = await confirmBookingForBegin(client, begin, snapshot);
  if (confirmation.status === "found") {
    return { planId: plan.id, seatNum: String(confirmation.item.seatNum || seatNum), success: true, message: "预约已生效（以预约列表为准）" };
  }
  if (confirmation.status === "unknown") {
    return { planId: plan.id, seatNum, success: false, unverified: true, message: `预约结果未确认（预约列表暂不可用）：${message}` };
  }
  if (isDuplicateMessage(message)) {
    return { planId: plan.id, seatNum, success: false, terminal: true, message: `存在时间冲突的预约，请先取消后再试：${message}` };
  }
  return { planId: plan.id, seatNum, success: false, message };
}

async function bookingRequestFailure(
  client: LibraryClient,
  plan: BookingPlan,
  begin: Date,
  seatNum: string,
  error: unknown,
  snapshot?: Set<number>,
): Promise<BookingMemberResult> {
  if (error instanceof AuthenticationExpiredError) throw error;
  if (error instanceof RequestTimeoutError) {
    // 读/连超时 ≠ 预约失败，服务器可能已受理。以预约列表做幂等确认。
    const confirmation = await confirmBookingForBegin(client, begin, snapshot);
    if (confirmation.status === "found") {
      return { planId: plan.id, seatNum: String(confirmation.item.seatNum || seatNum), success: true, message: "预约已生效（响应超时，以预约列表为准）" };
    }
    if (confirmation.status === "unknown") {
      return { planId: plan.id, seatNum, success: false, unverified: true, message: "请求超时，且预约列表暂不可用，结果未确认" };
    }
    // 超时的写请求可能已被受理，但列表还没显示；这一轮不再换座位重复提交。
    return { planId: plan.id, seatNum, success: false, unverified: true, message: "请求超时，预约列表尚未显示该预约，结果未确认" };
  }
  return { planId: plan.id, seatNum, success: false, message: String(error) };
}

async function executePlan(
  client: LibraryClient,
  plan: BookingPlan,
  begin: Date,
  dryRun: boolean,
  preferred?: BookingLock,
  skipSeatNum?: string,
  snapshot?: Set<number>,
): Promise<BookingMemberResult> {
  // 预锁座位也必须先查询座位：服务端会校验“查询 → 提交”的流程。
  const candidates = preferred
    ? [preferred.seatNum]
    : [plan.seatNum, ...plan.fallbackSeats].filter((seatNum) => seatNum !== skipSeatNum);
  let lastResult: BookingMemberResult | undefined;
  let lastMessage = "未找到可用座位";
  for (const seatNum of candidates) {
    const attempt = await querySeatsAndBook(
      client,
      plan,
      begin,
      seatNum,
      preferred?.seatNum === seatNum ? preferred.seatId : undefined,
      dryRun,
    );
    if (attempt.kind === "dry-run") {
      return { planId: plan.id, seatNum, success: true, message: "预演成功，未提交预约请求" };
    }
    if (attempt.kind === "missing") {
      lastMessage = `找不到座位 ${seatNum}`;
      continue;
    }
    if (attempt.kind === "query-failed") {
      lastMessage = `房间或座位查询失败: ${attempt.message}`;
      continue;
    }
    const result = attempt.kind === "request-failed"
      ? await bookingRequestFailure(client, plan, begin, seatNum, attempt.error, snapshot)
      : await finalizeBooking(client, plan, begin, seatNum, attempt.response, snapshot);
    // 结果未确认时绝不能再换座位重复提交，否则同一时段可能被下两单。
    if (result.success || result.terminal || result.unverified) return result;
    lastResult = result;
    lastMessage = result.message;
  }
  return lastResult ?? { planId: plan.id, success: false, message: lastMessage };
}

type MemberLockState = {
  plan: BookingPlan;
  begin: Date;
  beginSeconds: number;
  seatId?: string;
  seatNum?: string;
  locked: boolean;
  terminalMessage?: string;
  lastMessage?: string;
  /** 账号被限流：立即停止对后续成员的预锁。 */
  blocked?: boolean;
};

// 预锁单个成员。座位图只解析一次：即使馆方拒绝锁座（未开放、被别人锁住等），
// 解析出的座位 ID 也留到 20:00 直接提交，省掉开放瞬间的两次座位图查询。
async function lockMemberOnce(client: LibraryClient, state: MemberLockState): Promise<void> {
  if (!state.seatId) {
    const seat = await resolvePrimarySeat(client, state.plan, state.begin);
    state.seatId = seat.seatId;
    state.seatNum = seat.seatNum;
  }
  const response = await paced(() => client.lockSeat(state.seatId!, state.begin, state.plan.durationHours));
  if (lockSucceeded(response)) {
    state.locked = true;
    state.lastMessage = "座位预锁成功";
    return;
  }
  const message = responseMessage(response) || "预锁失败";
  state.lastMessage = message;
  // 时间冲突是终态：连预锁都不允许，正式预约也不会成功。
  if (isDuplicateMessage(message)) state.terminalMessage = message;
  // 账号被限流时立即收手，避免预锁把 20:00 的正式预约额度一起打没。
  if (classifyBookingFailure(message) === "ban") state.blocked = true;
}

export class BookingExecutor {
  /** 当前预约日的预锁；19:59 建立后由 20:00 的预约 burst 消费。 */
  private lockedSeats: BookingLock[] = [];
  /** 正式预约开始后置位，让仍在进行的预锁立刻退出。 */
  private prelockAborted = false;
  /** 最近一次成功读取到的预约开始时间；列表接口失败时用它兜底，避免误判为“没有预约”。 */
  private bookedSnapshot: Set<number> | undefined;

  constructor(private readonly client: LibraryClient, private readonly pause: (ms: number) => Promise<void> = sleep) {}

  /** 20:00 正式预约开始时调用：让仍在进行的预锁尽快退出，避免和抢座争请求。 */
  abortPrelock(): void {
    this.prelockAborted = true;
  }

  // 单次尝试：手动触发或 burst 中的一次执行。幂等——预约列表里已有的时段直接跳过。
  // finished 保存此前尝试里已判定终态的成员，避免同一冲突反复提交。
  private async runAttempt(dryRun: boolean, finished: Map<string, BookingMemberResult>, skipBookedCheck = false): Promise<BookingRunResult> {
    const release = tryAcquireJobLock("booking");
    if (!release) return { success: false, message: "已有任务正在运行", members: [] };
    try {
      const enabled = listPlanItems().find((item) => item.enabled);
      if (!enabled) return { success: false, message: "没有启用的预约方案", members: [] };
      // 开窗瞬间不要先花一个请求间隔查一遍预约列表：刚在 19:59 预锁时查过，
      // 这一轮里不可能凭空出现“我们自己的”预约；重复提交由服务端报错 +
      // 预约列表确认兜底。
      let begins: Set<number>;
      if (dryRun) {
        begins = new Set();
      } else if (skipBookedCheck) {
        // 开窗第一轮不查列表，但可以用 19:59 预锁时的快照跳过已预约时段。
        begins = this.bookedSnapshot ?? new Set();
      } else {
        const live = await bookedBeginTimes(this.client);
        if (live) this.bookedSnapshot = live;
        begins = live ?? this.bookedSnapshot ?? new Set();
      }
      const results: BookingMemberResult[] = [];
      for (const plan of planMembers(enabled)) {
        const settled = finished.get(plan.id);
        if (settled) {
          results.push(settled);
          continue;
        }
        const begin = memberBegin(plan);
        if (!begin) continue;
        const beginSeconds = Math.floor(begin.getTime() / 1000);
        let result: BookingMemberResult;
        if (begins.has(beginSeconds)) {
          result = { planId: plan.id, success: true, message: "该时段已有预约，跳过重复提交" };
        } else {
          const preferred = this.lockedSeats.find((lock) => lock.planId === plan.id && lock.beginSeconds === beginSeconds);
          result = await executePlan(this.client, plan, begin, dryRun, preferred, undefined, this.bookedSnapshot);
          if (preferred && !result.success && !result.terminal && !result.unverified) {
            // 预锁座位失效（被占、锁过期、馆方调整）时不再死磕同一座位：
            // 丢掉提示，立刻按主座位 + 备选座位重试。未确认结果不做二次提交。
            this.lockedSeats = this.lockedSeats.filter((lock) => lock !== preferred);
            result = await executePlan(this.client, plan, begin, dryRun, undefined, preferred.seatNum, this.bookedSnapshot);
          }
        }
        // 本时段已确认有预约（跳过或约成功），记进快照供后续列表失败时使用。
        if (result.success) (this.bookedSnapshot ??= new Set<number>()).add(beginSeconds);
        results.push(result);
        writeAudit("booking_member_finished", { planId: plan.id, success: result.success, seatNum: result.seatNum, message: result.message });
        bookingLog(`member ${plan.id} seat=${result.seatNum || "-"} success=${result.success}${result.terminal ? " terminal" : ""} message=${result.message}`);
      }
      const success = results.length > 0 && results.every((result) => result.success);
      const message = dryRun ? "预约预演完成，未提交预约请求" : success ? "预约任务完成" : `预约失败：${results.map((result) => result.message).join("；")}`;
      return { planId: enabled.id, kind: enabled.kind, success, message, members: results };
    } finally {
      release();
    }
  }

  // 单次执行：手动触发或 burst 中的一次尝试。
  async run(dryRun = false, options: { audit?: boolean } = {}): Promise<BookingRunResult> {
    this.abortPrelock();
    const result = await this.runAttempt(dryRun, new Map());
    if (options.audit !== false) {
      writeAudit("booking_run_finished", { planId: result.planId, kind: result.kind, success: result.success, members: result.members.length, message: result.message, results: result.members });
    }
    if (result.success) this.lockedSeats = [];
    return result;
  }

  // 整点抢座：持续按节奏重试，直到全部成功、没有可重试的成员或超时。
  async runBurst(dryRun = false, options: { intervalMs?: number; timeoutMs?: number } = {}): Promise<BookingRunResult> {
    const intervalMs = options.intervalMs ?? burstRequestIntervalMs;
    const startedAt = Date.now();
    const deadline = startedAt + (options.timeoutMs ?? burstTimeoutMs);
    this.abortPrelock();
    // 某个成员进入终态（如时间冲突）只停止它自己的重试，同组其它成员继续抢。
    const finished = new Map<string, BookingMemberResult>();
    // 结果一直无法确认时最多再试 3 轮，避免对同一时段无限重复提交。
    const unverified = new Map<string, number>();
    // 被限流时逐步退避，避免持续触发馆方风控。
    let backoff = intervalMs;
    let firstAttempt = true;
    for (;;) {
      const result = await this.runAttempt(dryRun, finished, firstAttempt && this.lockedSeats.length > 0);
      firstAttempt = false;
      // 账号被馆方限流（10 分钟级）：整轮 burst 立刻结束，继续请求只会延长封禁。
      const blocked = result.members.find((member) => member.blocked);
      if (blocked) {
        writeAudit("booking_run_finished", { planId: result.planId, kind: result.kind, success: false, members: result.members.length, message: blocked.message, results: result.members });
        bookingLog(`burst blocked: ${blocked.message}`);
        return { ...result, success: false, message: blocked.message };
      }
      for (const member of result.members) {
        if (member.terminal) {
          finished.set(member.planId, member);
        } else if (member.unverified) {
          const attempts = (unverified.get(member.planId) ?? 0) + 1;
          unverified.set(member.planId, attempts);
          if (attempts >= 3) finished.set(member.planId, { ...member, terminal: true, message: `${member.message}（多次未能确认，停止重试）` });
        }
      }
      // 成员为空通常意味着任务锁正被占用（如手动执行），继续重试；
      // 终态成员不算待办，但它们不会挡住同组其它成员。
      const pending = result.members.length === 0 || result.members.some((member) => !member.success && !member.terminal);
      if (result.success || !pending || Date.now() >= deadline) {
        // burst 只产生一条结果审计，避免逐次重试刷屏通知；成员明细一并留档。
        writeAudit("booking_run_finished", { planId: result.planId, kind: result.kind, success: result.success, members: result.members.length, message: result.message, results: result.members });
        bookingLog(`burst finished success=${result.success} message=${result.message}`);
        if (result.success) this.lockedSeats = [];
        return result;
      }
      // 只要这一轮还有失败（包括部分成员失败、任务锁占用、结果未确认），
      // 就继续按指数退避；服务端给出明确等待时间时以它为准。
      const retryAfter = Math.max(0, ...result.members.map((member) => member.retryAfterMs ?? 0));
      backoff = Math.max(retryAfter, nextBackoffMs(backoff, intervalMs, burstMaxBackoffMs));
      bookingLog(`failed, retrying in ${backoff}ms`);
      // 最后一次等待不要睡过头，避免 burst 拖到 deadline 之后很久。
      await this.pause(Math.min(backoff, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * 预锁是尽力而为的可选优化，不是预约的必经步骤：
   *  - 只查一次已预约，每个成员只尝试一次锁座；
   *  - 不重试、不等待窗口、不刷请求，避免占用 20:00 正式预约的风控额度；
   *  - 失败时保留座位提示，正式预约按普通路径照常进行。
   */
  async lockBurst(options: { timeoutMs?: number; deadlineAt?: Date } = {}): Promise<BookingLockResult> {
    const enabled = listPlanItems().find((item) => item.enabled);
    if (!enabled) return { success: false, message: "没有启用的预约方案", locks: [] };
    const deadline = options.deadlineAt?.getTime() ?? Date.now() + (options.timeoutMs ?? prelockTimeoutMs);
    const members = planMembers(enabled).filter((plan) => memberBegin(plan));
    if (members.length === 0) {
      this.lockedSeats = [];
      const empty: BookingLockResult = { planId: enabled.id, kind: enabled.kind, success: false, message: "没有符合星期的预约成员", locks: [] };
      writeAudit("booking_prelock_finished", { planId: empty.planId, kind: empty.kind, success: false, locks: 0, message: empty.message });
      return empty;
    }

    this.prelockAborted = false;
    const fetched = await bookedBeginTimes(this.client);
    if (fetched) this.bookedSnapshot = fetched;
    const booked = fetched ?? this.bookedSnapshot ?? new Set<number>();
    const states: MemberLockState[] = members.map((plan) => {
      const begin = memberBegin(plan)!;
      return { plan, begin, beginSeconds: Math.floor(begin.getTime() / 1000), locked: false };
    });
    for (const state of states) {
      // 20:00 一到（runBurst 会调用 abortPrelock）立刻让路，绝不让预锁拖住正式预约。
      if (this.prelockAborted || Date.now() >= deadline) break;
      if (booked.has(state.beginSeconds)) continue;
      try {
        await lockMemberOnce(this.client, state);
      } catch (error) {
        if (error instanceof AuthenticationExpiredError) throw error;
        state.lastMessage = String(error);
      }
      if (state.blocked) break;
    }

    // 锁失败的成员也保留座位提示（locked=false）：正式预约会先试这个座位，
    // 不行再走主座位 + 备选座位，所以预锁失败不影响预约本身。
    const locks: BookingLock[] = states
      .filter((state) => state.seatId)
      .map((state) => ({
        planId: state.plan.id,
        seatId: state.seatId!,
        seatNum: state.seatNum || "",
        beginSeconds: state.beginSeconds,
        durationHours: state.plan.durationHours,
        locked: state.locked,
      }));
    const ready = states.every((state) => state.locked || booked.has(state.beginSeconds));
    const terminalMessage = states.find((state) => state.terminalMessage)?.terminalMessage;
    const failureMessage = states.find((state) => !state.locked && !booked.has(state.beginSeconds) && state.lastMessage)?.lastMessage;
    const lockedCount = locks.filter((lock) => lock.locked).length;
    const message = ready
      ? "座位预锁成功，等待预约窗口开放"
      : terminalMessage
        ? `存在时间冲突的预约，请先取消后再试：${terminalMessage}`
        : `预锁未完成（不影响 20:00 预约）${lockedCount}/${states.length} 个座位${failureMessage ? `：${failureMessage}` : ""}`;
    // 被正式预约抢占后不要回写：否则可能在 burst 成功清空后又塞进过期的座位提示。
    if (!this.prelockAborted) this.lockedSeats = locks;
    const result: BookingLockResult = { planId: enabled.id, kind: enabled.kind, success: ready, message, locks, terminal: Boolean(terminalMessage) };
    writeAudit("booking_prelock_finished", { planId: result.planId, kind: result.kind, success: result.success, locks: lockedCount, message: result.message });
    return result;
  }
}
