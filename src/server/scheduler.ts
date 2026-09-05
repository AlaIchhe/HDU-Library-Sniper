import type { RuntimeStatus } from "../shared/types";
import { AuthService } from "./auth";
import { getMeta, setMeta, writeAudit } from "./db";
import { bookingAnchorDelaySeconds, timezone } from "./config";
import { tryAcquireJobLock } from "./lock";
import { BookingExecutor } from "./booking";
import { AuthenticationExpiredError } from "./library";
import { listPlanItems } from "./plans";

const checkInStartMinutes = 7 * 60 + 30;
const checkInEndMinutes = 19 * 60 + 30;
const checkInIntervalMs = 15 * 60_000;

export class Scheduler {
  private timer: Timer | undefined;
  private bookingTimer: Timer | undefined;
  private nextPollAt: string | undefined;
  private running = false;
  private statusValue: RuntimeStatus = {
    scheduler: "stopped",
    state: "idle",
    checkInPolling: { active: false },
  };

  constructor(private readonly auth: AuthService, private readonly booking: BookingExecutor) {}

  status(): RuntimeStatus {
    return {
      ...this.statusValue,
      checkInPolling: { active: Boolean(this.timer), nextPollAt: this.nextPollAt },
    };
  }
  readonly consentVersion = "2026-08-02.1";
  get autoCheckInEnabled(): boolean { return getMeta("auto_checkin_enabled") === "1"; }
  get consentedAt(): string | undefined { return getMeta("auto_checkin_consented_at"); }
  setAutoCheckIn(enabled: boolean, agreed = false): void {
    setMeta("auto_checkin_enabled", enabled ? "1" : "0");
    if (enabled && agreed) setMeta("auto_checkin_consented_at", new Date().toISOString());
  }

  start(): void {
    if (this.timer) return;
    this.statusValue.scheduler = "running";
    this.scheduleNextPoll();
    this.scheduleBookingAnchor();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.nextPollAt = undefined;
    if (this.bookingTimer) clearTimeout(this.bookingTimer);
    this.bookingTimer = undefined;
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
      return { success: result.success, message: result.message };
    } finally {
      this.running = false;
      if (this.statusValue.state === "running") this.statusValue.state = "idle";
    }
  }

  private shanghaiSecondsOfDay(): number {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    return value("hour") * 3600 + value("minute") * 60 + value("second");
  }

  private scheduleBookingAnchor(): void {
    if (this.bookingTimer) return;
    const delay = bookingAnchorDelaySeconds(this.shanghaiSecondsOfDay());
    this.bookingTimer = setTimeout(() => {
      this.bookingTimer = undefined;
      void this.bookingAnchorTick().finally(() => this.scheduleBookingAnchor());
    }, delay * 1000);
  }

  private async bookingAnchorTick(): Promise<void> {
    if (!listPlanItems().some((item) => item.enabled)) return;
    this.statusValue.state = "running";
    try {
      if (!(await this.auth.restore())) {
        this.statusValue.state = "auth_required";
        return;
      }
      const result = await this.booking.runBurst();
      this.statusValue.lastRunAt = new Date().toISOString();
      this.statusValue.lastMessage = result.message;
    } catch (error) {
      if (error instanceof AuthenticationExpiredError && (await this.auth.restore())) {
        const result = await this.booking.runBurst();
        this.statusValue.lastRunAt = new Date().toISOString();
        this.statusValue.lastMessage = result.message;
      } else {
        this.statusValue.lastMessage = String(error);
        writeAudit("booking_burst_failed", { error: String(error) });
      }
    } finally {
      if (this.statusValue.state === "running") this.statusValue.state = "idle";
    }
  }

  private localMinutes(): number {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    return Number(parts.find((part) => part.type === "hour")?.value || 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value || 0);
  }

  private scheduleNextPoll(): void {
    if (!this.timer && this.statusValue.scheduler !== "running") return;
    const now = new Date();
    const next = new Date(now.getTime() + checkInIntervalMs);
    next.setSeconds(0, 0);
    const minutes = next.getMinutes();
    next.setMinutes(Math.ceil(minutes / 15) * 15);
    this.nextPollAt = next.toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.checkInTick().finally(() => this.scheduleNextPoll());
    }, Math.max(1_000, next.getTime() - now.getTime()));
  }

  private async checkInTick(): Promise<void> {
    const minutes = this.localMinutes();
    if (!this.autoCheckInEnabled || minutes < checkInStartMinutes || minutes > checkInEndMinutes) return;
    const release = tryAcquireJobLock("check-in");
    if (!release) return;
    try {
      if (!(await this.auth.restore())) {
        this.statusValue.state = "auth_required";
        return;
      }
      const bookings = await this.auth.client.bookings();
      for (const booking of bookings) {
        const begin = Number(booking.time || 0);
        const current = Number(booking.nowTime || Math.floor(Date.now() / 1000));
        const available = String(booking.status || "") === "0" &&
          current >= begin - Number(booking.limitSignAgo || 0) &&
          current <= begin + Number(booking.limitSignBack || 0);
        if (!available || !booking.id) continue;
        await this.auth.client.action("checkIn", String(booking.id));
        writeAudit("checkin_succeeded", { bookingId: String(booking.id) });
      }
    } catch (error) {
      this.statusValue.lastMessage = String(error);
      writeAudit("checkin_failed", { error: String(error) });
    } finally {
      release();
    }
  }
}
