import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BookingPlan } from "../src/shared/types";
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

function planFixture(): BookingPlan {
  return {
    id: "p1",
    kind: "single",
    roomType: "自习室",
    roomQuery: "space_category[category_id]=1&space_category[content_id]=91",
    floorId: 3,
    seatNum: "101",
    fallbackSeats: ["102"],
    startHour: 8,
    durationHours: 12,
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
    unlockAllSeats: vi.fn(async () => {
      calls.push({ action: "unlock" });
      return { CODE: "ok" } as unknown as Record<string, unknown>;
    }),
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
    mocks.plans = [planFixture()];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("releases all seats after a failed lock and retries the same primary seat", async () => {
    const { client, calls } = fakeClient();
    client.lockSeat
      .mockResolvedValueOnce({ CODE: "1", MESSAGE: "座位已被锁定" } as unknown as Record<string, unknown>)
      .mockResolvedValueOnce({ CODE: "ok", DATA: { time: 1 } } as unknown as Record<string, unknown>);
    const executor = new BookingExecutor(client as unknown as LibraryClient, noopPause);

    const result = await executor.lockBurst({ intervalMs: 0, timeoutMs: 100 });

    expect(result.success).toBe(true);
    expect(client.lockSeat.mock.calls.map((call) => call[0])).toEqual(["lock-101", "lock-101"]);
    expect(calls.filter((call) => call.action === "unlock")).toHaveLength(1);
  });

  test("keeps a successful lock and books the same seat at the anchor without a floor lookup", async () => {
    const { client, calls } = fakeClient();
    const executor = new BookingExecutor(client as unknown as LibraryClient, noopPause);

    const locked = await executor.lockBurst({ intervalMs: 0, timeoutMs: 100 });
    expect(locked.success).toBe(true);
    expect(locked.locks[0]).toMatchObject({ seatId: "lock-101", seatNum: "101" });
    expect(calls.some((call) => call.action === "unlock")).toBe(false);

    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 100 });
    expect(result.success).toBe(true);
    expect(calls.filter((call) => call.action === "book")).toEqual([{ action: "book", seatId: "lock-101" }]);
    expect(client.floors).toHaveBeenCalledTimes(1);
  });
});
