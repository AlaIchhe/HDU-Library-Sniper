import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BookingPlan, PlanListItem } from "../src/shared/types";
import type { LibraryClient } from "../src/server/library";
import { BookingExecutor, pacing } from "../src/server/booking";

const mocks = vi.hoisted(() => ({
  plans: [] as unknown[],
}));

vi.mock("../src/server/plans", () => ({
  listPlanItems: () => mocks.plans,
}));
vi.mock("../src/server/db", () => ({
  writeAudit: () => {},
}));
vi.mock("../src/server/lock", () => ({
  tryAcquireJobLock: () => () => {},
}));
vi.mock("../src/server/config", () => ({
  bookingDayOffset: 2,
  bookingDayOffsetFor: () => 2,
  timezone: "Asia/Shanghai",
}));

const noopPause = async () => {};

function plan(id: string, startHour: number, seatNum: string, fallbackSeats: string[] = []): BookingPlan {
  return {
    id,
    kind: "single",
    roomType: "自习室",
    roomQuery: "space_category[category_id]=1&space_category[content_id]=91",
    floorId: 3,
    seatNum,
    fallbackSeats,
    startHour,
    durationHours: 2,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    enabled: true,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

function group(members: BookingPlan[]): PlanListItem {
  return {
    id: "group-1",
    kind: "group",
    name: "组合",
    memberPlanIds: members.map((member) => member.id),
    members,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    enabled: true,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

const floorPayload = [{
  seatMap: {
    info: { id: 3 },
    POIs: [
      { title: "101", id: "lock-101" },
      { title: "102", id: "lock-102" },
    ],
  },
}];

function fakeClient() {
  const calls: Array<{ action: string; seatId?: string }> = [];
  const client = {
    uid: "304174",
    bookings: vi.fn(async () => [] as Record<string, unknown>[]),
    floors: vi.fn(async () => floorPayload),
    lockSeat: vi.fn(async (seatId: string) => {
      calls.push({ action: "lock", seatId });
      return { CODE: "ok", DATA: { time: 1 } } as unknown as Record<string, unknown>;
    }),
    unlockAllSeats: vi.fn(async () => ({ CODE: "ok" }) as unknown as Record<string, unknown>),
    bookSeat: vi.fn(async (seatId: string) => {
      calls.push({ action: "book", seatId });
      return { CODE: "ok", DATA: { result: "success" } } as unknown as Record<string, unknown>;
    }),
  };
  return { client, calls };
}

describe("booking prelock", () => {
  beforeEach(() => {
    pacing.intervalMs = 0;
    pacing.reset();
    mocks.plans = [plan("p1", 8, "101", ["102"])];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("tries each member once and keeps the seat hint when a lock fails", async () => {
    mocks.plans = [group([plan("a", 8, "101"), plan("b", 10, "102")])];
    const { client } = fakeClient();
    client.lockSeat.mockImplementation(async (seatId: string) => {
      if (seatId === "lock-102") return { CODE: "1", MESSAGE: "座位已被锁定" } as unknown as Record<string, unknown>;
      return { CODE: "ok", DATA: { time: 1 } } as unknown as Record<string, unknown>;
    });
    const executor = new BookingExecutor(client as unknown as LibraryClient, noopPause);

    const result = await executor.lockBurst({ timeoutMs: 5_000 });

    // 预锁只是尽力而为：每人只试一次，101 成功、102 失败但保留座位提示。
    expect(client.lockSeat.mock.calls.map((call) => call[0])).toEqual(["lock-101", "lock-102"]);
    expect(result.success).toBe(false);
    expect(result.locks.map((lock) => [lock.seatNum, lock.locked])).toEqual([["101", true], ["102", false]]);
    expect(client.unlockAllSeats).not.toHaveBeenCalled();
    expect(client.bookings).toHaveBeenCalledTimes(1);
  });

  test("never retries prelocking when the library keeps rejecting", async () => {
    mocks.plans = [group([plan("a", 8, "101"), plan("b", 10, "102")])];
    const { client } = fakeClient();
    client.lockSeat.mockResolvedValue({ CODE: "1", MESSAGE: "座位已被锁定" } as unknown as Record<string, unknown>);
    const executor = new BookingExecutor(client as unknown as LibraryClient, noopPause);

    const result = await executor.lockBurst({ timeoutMs: 5_000 });

    expect(result.success).toBe(false);
    expect(client.lockSeat).toHaveBeenCalledTimes(2);
    expect(client.bookings).toHaveBeenCalledTimes(1);
    expect(result.locks).toHaveLength(2);
    expect(result.locks.every((lock) => lock.locked === false)).toBe(true);
  });

  test("stops prelocking as soon as the anchor starts", async () => {
    mocks.plans = [group([plan("a", 8, "101"), plan("b", 10, "102")])];
    const { client } = fakeClient();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => {};
    const firstLock = new Promise<void>((resolve) => { started = resolve; });
    client.lockSeat.mockImplementation(async () => {
      started();
      await gate;
      return { CODE: "ok", DATA: { time: 1 } } as unknown as Record<string, unknown>;
    });
    const executor = new BookingExecutor(client as unknown as LibraryClient, noopPause);

    const running = executor.lockBurst({ timeoutMs: 5_000 });
    await firstLock;
    executor.abortPrelock();
    release();
    const result = await running;

    // 第一个成员的请求结束后立刻让路，不再尝试第二个成员。
    expect(client.lockSeat).toHaveBeenCalledTimes(1);
    expect(result.locks).toHaveLength(1);
  });

  test("keeps the resolved seat as a hint when the library refuses to lock", async () => {
    mocks.plans = [plan("p1", 8, "101", ["102"])];
    const { client } = fakeClient();
    client.lockSeat.mockResolvedValue({ CODE: "1", MESSAGE: "座位尚未开放" } as unknown as Record<string, unknown>);
    const executor = new BookingExecutor(client as unknown as LibraryClient, noopPause);

    const locked = await executor.lockBurst({ timeoutMs: 5_000 });

    expect(locked.success).toBe(false);
    expect(locked.locks).toHaveLength(1);
    expect(locked.locks[0]).toMatchObject({ seatId: "lock-101", seatNum: "101", locked: false });

    // 20:00 直接用提前解析好的座位，不再查一次座位图。
    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 100 });

    expect(result.success).toBe(true);
    expect(client.bookSeat.mock.calls.map((call) => call[0])).toEqual(["lock-101"]);
    expect(client.floors).toHaveBeenCalledTimes(1);
  });

  test("keeps a successful lock and books the same seat at the anchor without a floor lookup", async () => {
    const { client, calls } = fakeClient();
    const executor = new BookingExecutor(client as unknown as LibraryClient, noopPause);

    const locked = await executor.lockBurst({ timeoutMs: 5_000 });
    expect(locked.success).toBe(true);
    expect(locked.locks[0]).toMatchObject({ seatId: "lock-101", seatNum: "101", locked: true });
    expect(calls.some((call) => call.action === "unlock")).toBe(false);

    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 100 });
    expect(result.success).toBe(true);
    expect(calls.filter((call) => call.action === "book")).toEqual([{ action: "book", seatId: "lock-101" }]);
    expect(client.floors).toHaveBeenCalledTimes(1);
  });

  test("falls back to the next seat when the locked seat is taken at the anchor", async () => {
    const { client, calls } = fakeClient();
    client.bookSeat.mockImplementation(async (seatId: string) => {
      calls.push({ action: "book", seatId });
      if (seatId === "lock-101") return { CODE: "1", MESSAGE: "座位已被预约" } as unknown as Record<string, unknown>;
      return { CODE: "ok", DATA: { result: "success" } } as unknown as Record<string, unknown>;
    });
    const executor = new BookingExecutor(client as unknown as LibraryClient, noopPause);

    await executor.lockBurst({ timeoutMs: 5_000 });
    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 100 });

    expect(result.success).toBe(true);
    expect(result.members[0]?.seatNum).toBe("102");
    // 锁定的 101 失败后立刻改走备选座位，不在同一座位上反复重试。
    expect(client.bookSeat.mock.calls.map((call) => call[0])).toEqual(["lock-101", "lock-102"]);
  });
});
