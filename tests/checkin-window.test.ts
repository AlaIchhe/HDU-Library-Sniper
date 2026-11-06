import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

let home: string;
let closeDb: (() => void) | undefined;

beforeAll(() => {
  home = join(mkdtempSync(join(tmpdir(), "hdu-sniper-checkin-")), "home");
  process.env.HDU_SNIPER_HOME = home;
});

afterAll(() => {
  closeDb?.();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

afterEach(() => {
  vi.useRealTimers();
});

function pendingBooking(startIso: string, id = "b-1") {
  return {
    id,
    status: "0",
    time: Math.floor(new Date(startIso).getTime() / 1000),
    limitSignAgo: 1800,
    limitSignBack: 1800,
  };
}

async function makeScheduler(bookings: () => Promise<Record<string, unknown>[]>) {
  const calls: string[] = [];
  const state: { failure?: string; fetched: number } = { fetched: 0 };
  const auth = {
    authenticated: true,
    restore: async () => true,
    client: {
      bookings: async () => {
        state.fetched += 1;
        return bookings();
      },
      action: async (kind: string, id: string) => {
        if (state.failure) throw new Error(state.failure);
        calls.push(`${kind}:${id}`);
        return {};
      },
    },
  };
  const { db } = await import("../src/server/db");
  closeDb = () => db.close();
  const { Scheduler } = await import("../src/server/scheduler");
  const scheduler = new Scheduler(auth as never, {} as never);
  const setEnabled = (enabled: boolean) => {
    db.query("INSERT OR REPLACE INTO meta(key, value) VALUES('auto_checkin_enabled', ?1)").run(
      enabled ? "1" : "0",
    );
  };
  const tick = () => (scheduler as unknown as { checkInTick(): Promise<void> }).checkInTick();
  return { scheduler, calls, state, setEnabled, tick, db };
}

describe("auto check-in scheduling", () => {
  test("waits until 开始+1 分钟 instead of the moment the window opens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T06:00:00+08:00"));

    const { scheduler, calls, setEnabled } = await makeScheduler(async () => []);
    setEnabled(true);
    scheduler.observeBookings([pendingBooking("2026-11-07T07:00:00+08:00")]);

    expect(scheduler.nextCheckIn()?.at).toBe(new Date("2026-11-07T07:01:00+08:00").getTime());

    // 06:30 窗口已开，但还没到签到时点：一个请求都不发。
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls).toEqual([]);

    // 07:01 唤醒：签到一次。
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(calls).toEqual(["checkIn:b-1"]);
    expect(scheduler.nextCheckIn()).toBeUndefined();
  });

  test("does not send anything while the switch is off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T06:00:00+08:00"));

    const { scheduler, calls, state, setEnabled } = await makeScheduler(async () => [
      pendingBooking("2026-11-07T07:00:00+08:00"),
    ]);
    setEnabled(false);
    await scheduler.syncCheckIns("test");
    scheduler.observeBookings([pendingBooking("2026-11-07T07:00:00+08:00")]);

    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(state.fetched).toBe(0);
    expect(calls).toEqual([]);
    expect(scheduler.nextCheckIn()).toBeUndefined();
  });

  test("sync rebuilds the pending list from one booking call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T06:00:00+08:00"));

    const { scheduler, state, setEnabled } = await makeScheduler(async () => [
      pendingBooking("2026-11-07T07:00:00+08:00"),
    ]);
    setEnabled(true);
    await scheduler.syncCheckIns("test");

    expect(state.fetched).toBe(1);
    expect(scheduler.nextCheckIn()?.bookingId).toBe("b-1");
  });

  test("an account ban parks the booking for 10 minutes instead of retrying at once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T06:00:00+08:00"));

    const { scheduler, state, setEnabled } = await makeScheduler(async () => []);
    setEnabled(true);
    state.failure = "请求过于频繁，请10分钟后再试";
    scheduler.observeBookings([pendingBooking("2026-11-07T07:00:00+08:00")]);

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    const next = scheduler.nextCheckIn();
    expect(next).toBeDefined();
    expect(next!.at).toBeGreaterThanOrEqual(new Date("2026-11-07T07:11:00+08:00").getTime() - 1_000);
  });

  test("short throttle retries after 15 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T06:00:00+08:00"));

    const { scheduler, state, setEnabled } = await makeScheduler(async () => []);
    setEnabled(true);
    state.failure = "请求太频繁了，请稍后再试";
    scheduler.observeBookings([pendingBooking("2026-11-07T07:00:00+08:00")]);

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    const next = scheduler.nextCheckIn();
    expect(next).toBeDefined();
    expect(next!.at - new Date("2026-11-07T07:01:00+08:00").getTime()).toBe(15_000);
  });

  test("a window that closes while the timer was late ends as checkin_missed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T06:00:00+08:00"));

    const { scheduler, calls, setEnabled, tick, db } = await makeScheduler(async () => []);
    setEnabled(true);
    scheduler.observeBookings([pendingBooking("2026-11-07T07:00:00+08:00")]);

    // 模拟机器休眠：定时器很晚才触发，这时窗口（07:30）已经关了。
    vi.setSystemTime(new Date("2026-11-07T07:45:00+08:00"));
    await tick();

    expect(calls).toEqual([]);
    expect(scheduler.nextCheckIn()).toBeUndefined();
    const rows = db.query("SELECT event FROM audit WHERE event = 'checkin_missed'").all();
    expect(rows.length).toBe(1);
  });

  test("a failed sync retries with backoff instead of giving up for the day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T06:00:00+08:00"));

    let attempts = 0;
    const { scheduler, setEnabled } = await makeScheduler(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("请求失败: 网络错误");
      return [pendingBooking("2026-11-07T07:00:00+08:00")];
    });
    setEnabled(true);

    await scheduler.syncCheckIns("start");
    expect(attempts).toBe(1);
    expect(scheduler.nextCheckIn()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(2);
    expect(scheduler.nextCheckIn()?.bookingId).toBe("b-1");
  });

  test("manual check-in removes the booking from the auto queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T06:00:00+08:00"));

    const { scheduler, calls, setEnabled } = await makeScheduler(async () => []);
    setEnabled(true);
    scheduler.observeBookings([pendingBooking("2026-11-07T07:00:00+08:00")]);
    scheduler.noteCheckedIn("b-1");

    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(calls).toEqual([]);
  });
});
