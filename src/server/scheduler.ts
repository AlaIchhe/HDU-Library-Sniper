import type { RuntimeStatus } from "../shared/types";
import type { AuthService } from "./auth";
import { getMeta, setMeta, writeAudit } from "./db";
import { bookingAnchorDelaySeconds, bookingPrelockDelaySeconds, shanghaiSecondsOfDay } from "./config";
import { tryAcquireJobLock } from "./lock";
import { accountBanMs, type BookingExecutor } from "./booking";
import { AuthenticationExpiredError } from "./library";
import { listPlanItems } from "./plans";

// 签到时点：预约开始后 1 分钟。
//
// 馆方窗口是 [开始-limitSignAgo, 开始+limitSignBack]（实测各 30 分钟），但
// 太早签到会把 status 从 0 变成 1（使用中），用户在开始前就不能取消了
// （API 的 canCancel 只认 status === "0"）。开始后 1 分钟签到：
//  - 保住“开始前仍可取消”的自由；
//  - 距窗口关闭还有 29 分钟，失败重试余量充足。
const checkInSignOffsetMs = 60_000;
// 失败重试：30s → 1m → 2m → 4m → 8m 封顶。
const checkInRetryBaseMs = 30_000;
const checkInRetryMaxMs = 8 * 60_000;
// 单张预约在一个窗口内的尝试上限，防止病态重试。
const checkInMaxAttempts = 8;
// 手机端短时限流（“请求太频繁了”）的等待时间，与 booking.ts 的口径一致。
const checkInThrottleMs = 15_000;
// 登录态恢复不回来时，10 分钟后再试，不做分钟级重试。
const checkInAuthRetryMs = 10 * 60_000;
// 抢座作业锁被占用时的让路时间。
const checkInBusyRetryMs = 60_000;

type PendingCheckIn = {
  bookingId: string;
  /** 预约开始时间（epoch ms）。 */
  beginMs: number;
  /** 计划的签到时点（epoch ms）：开始 + 1 分钟。 */
  signAt: number;
  /** 窗口关闭时刻（epoch ms）：开始 + limitSignBack。 */
  deadlineMs: number;
  attempts: number;
  /** 下一次允许尝试的时刻（epoch ms）。 */
  nextAt: number;
};

function isAccountBan(message: string): boolean {
  return /请求过于频繁|非手机端请求过于频繁/.test(message);
}

function isThrottle(message: string): boolean {
  return /请求太频繁了/.test(message);
}

function isAlreadyCheckedIn(message: string): boolean {
  return /已签到|已经签到|重复签到/.test(message);
}

/**
 * 定时任务调度。
 *
 * 签到不做固定轮询：签到时点由馆方数据算得出来（开始 + 1 分钟），
 * 只需在那一刻醒来一次；没有待签到预约时这里完全不发请求。
 * 预约列表只在下列事件上重新同步：
 *   - 进程启动
 *   - 登录成功、打开自动签到开关
 *   - 20:00 抢座或手动执行成功
 *   - 前端读取「当前预约」时顺带回填（零额外请求）
 * 因此“用别的客户端建的预约”这种不可预测来源不在覆盖范围内——已确认接受。
 */
export class Scheduler {
  private bookingTimer: Timer | undefined;
  private bookingPrelockTimer: Timer | undefined;
  /** 签到唤醒定时器：只在存在待签到预约时存在。 */
  private checkInTimer: Timer | undefined;
  /** 同步失败后的重试定时器（拉列表失败/登录失效/作业锁被占）。 */
  private syncTimer: Timer | undefined;
  private syncRetryMs = 0;
  private nextWakeAt: string | undefined;
  private pending = new Map<string, PendingCheckIn>();
  private running = false;
  private statusValue: RuntimeStatus = {
    scheduler: "stopped",
    state: "idle",
    checkInPolling: { active: false },
  };

  constructor(
    private readonly auth: AuthService,
    private readonly booking: BookingExecutor,
  ) {}

  status(): RuntimeStatus {
    return {
      ...this.statusValue,
      checkInPolling: { active: Boolean(this.checkInTimer), nextPollAt: this.nextWakeAt },
    };
  }
  readonly consentVersion = "2026-08-02.1";
  get autoCheckInEnabled(): boolean {
    return getMeta("auto_checkin_enabled") === "1";
  }
  get consentedAt(): string | undefined {
    return getMeta("auto_checkin_consented_at");
  }

  /** 下一次签到动作（供 /api/runtime/next-target 展示，不再联网）。 */
  nextCheckIn(): { bookingId: string; at: number } | undefined {
    let best: PendingCheckIn | undefined;
    for (const item of this.pending.values()) {
      if (!best || item.nextAt < best.nextAt) best = item;
    }
    return best ? { bookingId: best.bookingId, at: best.nextAt } : undefined;
  }

  setAutoCheckIn(enabled: boolean, agreed = false): void {
    setMeta("auto_checkin_enabled", enabled ? "1" : "0");
    if (enabled && agreed) setMeta("auto_checkin_consented_at", new Date().toISOString());
    if (enabled) {
      void this.syncCheckIns("enable");
    } else {
      this.pending.clear();
      this.clearSyncTimer();
      this.clearCheckInTimer();
    }
  }

  start(): void {
    if (this.statusValue.scheduler === "running") return;
    this.statusValue.scheduler = "running";
    this.scheduleBookingAnchor();
    // 进程重启后内存里的待签到列表没了，做一次发现把它重建出来。
    void this.syncCheckIns("start");
  }

  stop(): void {
    this.clearSyncTimer();
    this.clearCheckInTimer();
    this.pending.clear();
    if (this.bookingTimer) clearTimeout(this.bookingTimer);
    this.bookingTimer = undefined;
    if (this.bookingPrelockTimer) clearTimeout(this.bookingPrelockTimer);
    this.bookingPrelockTimer = undefined;
    this.statusValue.scheduler = "stopped";
  }

  async runNow(): Promise<{ success: boolean; message: string }> {
    if (this.running) return { success: false, message: "已有任务正在运行" };
    this.running = true;
    this.statusValue.state = "running";
    try {
      const result = await this.booking.run();
      this.statusValue.lastRunAt = new Date().toISOString();
      this.statusValue.lastMessage = result.message;
      if (result.success) void this.syncCheckIns("manual-run");
      return { success: result.success, message: result.message };
    } finally {
      this.running = false;
      if (this.statusValue.state === "running") this.statusValue.state = "idle";
    }
  }

  // ---------------------------------------------------------------- 签到同步

  /**
   * 拉一次预约列表，重建待签到集合，并按结果安排唤醒。
   * 只在已知事件上调用（启动、登录、开关打开、抢座成功、手动执行）。
   */
  async syncCheckIns(reason: string): Promise<void> {
    if (!this.autoCheckInEnabled) {
      this.pending.clear();
      this.clearSyncTimer();
      this.clearCheckInTimer();
      return;
    }
    this.clearSyncTimer();
    const release = tryAcquireJobLock("check-in");
    if (!release) {
      this.scheduleSyncRetry(checkInBusyRetryMs, reason);
      return;
    }
    try {
      if (!this.auth.authenticated && !(await this.auth.restore())) {
        this.statusValue.state = "auth_required";
        this.scheduleSyncRetry(checkInAuthRetryMs, reason);
        return;
      }
      this.observeBookings(await this.auth.client.bookings());
      this.syncRetryMs = 0;
    } catch (error) {
      this.statusValue.lastMessage = String(error);
      writeAudit("checkin_sync_failed", { reason, error: String(error) });
      this.scheduleSyncRetry(checkInRetryBaseMs, reason);
    } finally {
      release();
    }
    this.scheduleCheckInWake();
  }

  /**
   * 同步失败后的有界重试：60s 起步翻倍，30 分钟封顶，成功后清零。
   * 没有它，一次启动期网络抖动就会让整个签到链路停到下次登录为止。
   */
  private scheduleSyncRetry(baseMs: number, reason: string): void {
    this.clearSyncTimer();
    if (!this.autoCheckInEnabled) return;
    this.syncRetryMs = Math.min(Math.max(this.syncRetryMs * 2, baseMs), 30 * 60_000);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.syncCheckIns(reason);
    }, this.syncRetryMs);
  }

  private clearSyncTimer(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
  }

  /**
   * 用一份预约列表刷新待签到集合（不联网）。
   * 前端读取「当前预约」时也走这里，顺手完成同步。
   */
  observeBookings(bookings: Record<string, unknown>[]): void {
    if (!this.autoCheckInEnabled) {
      this.pending.clear();
      this.clearCheckInTimer();
      return;
    }
    const now = Date.now();
    const seen = new Set<string>();
    for (const booking of bookings) {
      const bookingId = String(booking.id || "");
      const beginMs = Number(booking.time || 0) * 1000;
      const deadlineMs = beginMs + Number(booking.limitSignBack || 0) * 1000;
      if (!bookingId || !beginMs || deadlineMs <= now) continue;
      if (String(booking.status || "") !== "0") continue;
      seen.add(bookingId);
      const signAt = beginMs + checkInSignOffsetMs;
      // 已经过了签到时点（但还在窗口内）→ 立刻补签。
      const nextAt = Math.max(signAt, now + 500);
      const existing = this.pending.get(bookingId);
      if (existing) {
        existing.beginMs = beginMs;
        existing.signAt = signAt;
        existing.deadlineMs = deadlineMs;
        existing.nextAt = Math.min(existing.nextAt, nextAt);
        continue;
      }
      this.pending.set(bookingId, { bookingId, beginMs, signAt, deadlineMs, attempts: 0, nextAt });
    }
    // 列表里已经没有的（已签到 / 已取消 / 已结束）直接摘掉。
    for (const bookingId of [...this.pending.keys()]) {
      if (!seen.has(bookingId)) this.pending.delete(bookingId);
    }
    this.scheduleCheckInWake();
  }

  /** 手动签到成功：从待签到集合里摘掉，别再自动提交。 */
  noteCheckedIn(bookingId: string): void {
    if (!this.pending.delete(bookingId)) return;
    writeAudit("checkin_succeeded", { bookingId, source: "manual" });
    this.scheduleCheckInWake();
  }

  /** 预约被取消：同样摘掉。 */
  forget(bookingId: string): void {
    if (!this.pending.delete(bookingId)) return;
    this.scheduleCheckInWake();
  }

  private clearCheckInTimer(): void {
    if (this.checkInTimer) clearTimeout(this.checkInTimer);
    this.checkInTimer = undefined;
    this.nextWakeAt = undefined;
  }

  /**
   * 安排下一次唤醒：取所有待签到项 nextAt 的最小值。
   * 没有待签到项、或开关关着时，不挂定时器（零请求空转）。
   */
  private scheduleCheckInWake(): void {
    this.clearCheckInTimer();
    if (!this.autoCheckInEnabled) return;
    let next = Number.POSITIVE_INFINITY;
    for (const item of this.pending.values()) next = Math.min(next, item.nextAt);
    if (!Number.isFinite(next)) return;
    const delayMs = Math.max(250, next - Date.now());
    this.nextWakeAt = new Date(Date.now() + delayMs).toISOString();
    this.checkInTimer = setTimeout(() => {
      this.checkInTimer = undefined;
      void this.checkInTick();
    }, delayMs);
  }

  private async checkInTick(): Promise<void> {
    if (!this.autoCheckInEnabled) {
      this.pending.clear();
      this.clearCheckInTimer();
      return;
    }
    const now = Date.now();
    const due = [...this.pending.values()].filter((item) => item.nextAt <= now);
    if (!due.length) {
      this.scheduleCheckInWake();
      return;
    }

    // 已经错过窗口的先收尾，别让它继续触发热醒。
    for (const item of due) {
      if (now > item.deadlineMs) this.finishMissed(item, "已过签到窗口");
    }
    const actionable = due.filter((item) => this.pending.has(item.bookingId) && item.nextAt <= Date.now());
    if (!actionable.length) {
      this.scheduleCheckInWake();
      return;
    }

    const release = tryAcquireJobLock("check-in");
    if (!release) {
      for (const item of actionable) item.nextAt = Date.now() + checkInBusyRetryMs;
      this.scheduleCheckInWake();
      return;
    }
    try {
      if (!this.auth.authenticated && !(await this.auth.restore())) {
        this.statusValue.state = "auth_required";
        for (const item of actionable) item.nextAt = Date.now() + checkInAuthRetryMs;
        return;
      }
      for (const item of actionable) await this.checkInOne(item);
    } catch (error) {
      this.statusValue.lastMessage = String(error);
      writeAudit("checkin_failed", { error: String(error) });
      for (const item of actionable) {
        if (this.pending.has(item.bookingId)) item.nextAt = Date.now() + checkInRetryBaseMs;
      }
    } finally {
      release();
      this.scheduleCheckInWake();
    }
  }

  private async checkInOne(item: PendingCheckIn): Promise<void> {
    if (Date.now() > item.deadlineMs) {
      this.finishMissed(item, "已过签到窗口");
      return;
    }
    this.statusValue.state = "running";
    try {
      await this.auth.client.action("checkIn", item.bookingId);
      this.pending.delete(item.bookingId);
      this.statusValue.lastRunAt = new Date().toISOString();
      this.statusValue.lastMessage = `已自动签到：${item.bookingId}`;
      writeAudit("checkin_succeeded", { bookingId: item.bookingId });
    } catch (error) {
      if (error instanceof AuthenticationExpiredError) {
        // 会话失效：先试一次恢复；成功就 1 分钟后重试，失败按 10 分钟退避。
        let restored = false;
        try {
          restored = await this.auth.restore();
        } catch {
          restored = false;
        }
        item.nextAt = Date.now() + (restored ? 60_000 : checkInAuthRetryMs);
        this.statusValue.lastMessage = restored
          ? "登录状态已刷新，稍后重试签到"
          : "登录状态已失效，等待恢复后再签到";
        writeAudit("checkin_failed", {
          bookingId: item.bookingId,
          error: restored ? "登录状态已刷新，待重试" : "登录状态已失效",
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      item.attempts += 1;
      this.statusValue.lastMessage = message;

      // 超时/断线后的重复提交：馆方回“已签到”，按成功处理，绝不再打。
      if (isAlreadyCheckedIn(message)) {
        this.pending.delete(item.bookingId);
        writeAudit("checkin_succeeded", { bookingId: item.bookingId, message });
        return;
      }
      // 账号级封禁：整段停手，别用重试延长封禁。
      if (isAccountBan(message)) {
        const until = Date.now() + accountBanMs;
        item.nextAt = until;
        writeAudit("checkin_blocked", {
          bookingId: item.bookingId,
          until: new Date(until).toISOString(),
          error: message,
        });
        return;
      }
      // 短时限流：15 秒后再试。
      if (isThrottle(message)) {
        item.nextAt = Date.now() + checkInThrottleMs;
        writeAudit("checkin_failed", { bookingId: item.bookingId, attempts: item.attempts, error: message });
        return;
      }
      // 其它失败：有界退避，超过次数上限就收尾，不再为这一单反复打。
      if (item.attempts >= checkInMaxAttempts) {
        this.finishMissed(item, `签到失败：${message}（已尝试 ${item.attempts} 次）`);
        return;
      }
      const backoff = Math.min(checkInRetryBaseMs * 2 ** (item.attempts - 1), checkInRetryMaxMs);
      item.nextAt = Date.now() + backoff;
      writeAudit("checkin_failed", { bookingId: item.bookingId, attempts: item.attempts, error: message });
    } finally {
      if (this.statusValue.state === "running") this.statusValue.state = "idle";
    }
  }

  /** 终态：窗口关闭或重试用尽，写一次审计后就放手（用户仍可手动签到）。 */
  private finishMissed(item: PendingCheckIn, reason: string): void {
    this.pending.delete(item.bookingId);
    this.statusValue.lastMessage = `未签到：${reason}`;
    writeAudit("checkin_missed", {
      bookingId: item.bookingId,
      begin: new Date(item.beginMs).toISOString(),
      deadline: new Date(item.deadlineMs).toISOString(),
      attempts: item.attempts,
      reason,
    });
  }

  // ---------------------------------------------------------------- 抢座调度

  private scheduleBookingAnchor(): void {
    if (this.bookingTimer) return;
    const secondsOfDay = shanghaiSecondsOfDay();
    const anchorDelay = bookingAnchorDelaySeconds(secondsOfDay);
    const prelockDelay = bookingPrelockDelaySeconds(secondsOfDay);
    const anchorAt = Date.now() + anchorDelay * 1000;

    // 先建预锁，再在同一个锚点发起正式预约。锁的 15 分钟 TTL 远大于 60 秒窗口。
    this.bookingPrelockTimer = setTimeout(() => {
      this.bookingPrelockTimer = undefined;
      void this.bookingPrelockTick(new Date(anchorAt));
    }, Math.max(0, prelockDelay) * 1000);

    this.bookingTimer = setTimeout(() => {
      this.bookingTimer = undefined;
      void this.bookingAnchorTick().finally(() => this.scheduleBookingAnchor());
    }, anchorDelay * 1000);
  }

  private async bookingPrelockTick(anchorAt: Date): Promise<void> {
    if (!listPlanItems().some((item) => item.enabled)) return;
    // 离 20:00 太近时直接跳过预锁：它是可选的，不能和正式预约抢请求、抢时机。
    if (anchorAt.getTime() - Date.now() < 8_000) return;
    const deadline = new Date(Math.max(Date.now(), anchorAt.getTime() - 5_000));
    this.statusValue.state = "running";
    try {
      // 已登录时不再做一次多余的 validate 网络请求：19:59/20:00 的几十毫秒都
      // 直接影响抢座结果，会话失效由首个请求的 refresh/401 流程兜底。
      if (!this.auth.authenticated && !(await this.auth.restore())) {
        this.statusValue.state = "auth_required";
        return;
      }
      const result = await this.booking.lockBurst({ deadlineAt: deadline });
      this.statusValue.lastMessage = result.message;
    } catch (error) {
      // 预锁是可选的：失败就放弃、不重试、不影响 20:00 的正式预约。
      this.statusValue.lastMessage = `预锁已跳过：${String(error)}`;
      writeAudit("booking_prelock_failed", { error: String(error) });
    } finally {
      if (this.statusValue.state === "running") this.statusValue.state = "idle";
    }
  }

  private async bookingAnchorTick(): Promise<void> {
    if (!listPlanItems().some((item) => item.enabled)) return;
    this.statusValue.state = "running";
    try {
      if (!this.auth.authenticated && !(await this.auth.restore())) {
        this.statusValue.state = "auth_required";
        return;
      }
      const result = await this.booking.runBurst();
      this.statusValue.lastRunAt = new Date().toISOString();
      this.statusValue.lastMessage = result.message;
      // 抢座刚建出的预约：同步一次，把它的签到时刻排进来。
      if (result.success) void this.syncCheckIns("booking-burst");
    } catch (error) {
      if (error instanceof AuthenticationExpiredError && (await this.auth.restore())) {
        const result = await this.booking.runBurst();
        this.statusValue.lastRunAt = new Date().toISOString();
        this.statusValue.lastMessage = result.message;
        if (result.success) void this.syncCheckIns("booking-burst");
      } else {
        this.statusValue.lastMessage = String(error);
        writeAudit("booking_burst_failed", { error: String(error) });
      }
    } finally {
      if (this.statusValue.state === "running") this.statusValue.state = "idle";
    }
  }
}
