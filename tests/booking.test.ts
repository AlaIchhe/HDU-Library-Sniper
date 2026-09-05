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
  bookingDayOffsetFor: (roomType?: string) => (roomType && /自习/.test(roomType) ? 1 : 2),
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
    fallbackSeats: [],
    startHour: 8,
    durationHours: 12,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    enabled: true,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

const floorPayload = [{ seatMap: { info: { id: 3 }, POIs: [{ title: "101", id: "seat-1" }] } }];

function fakeClient() {
  return {
    bookings: vi.fn(async () => [] as Record<string, unknown>[]),
    floors: vi.fn(async () => floorPayload),
    bookSeat: vi.fn(async () => ({ CODE: "ok", DATA: { result: "success" } })),
  } as unknown as LibraryClient & {
    bookings: ReturnType<typeof vi.fn>;
    floors: ReturnType<typeof vi.fn>;
    bookSeat: ReturnType<typeof vi.fn>;
  };
}

describe("BookingExecutor idempotency", () => {
  beforeEach(() => {
    pacing.intervalMs = 0;
    mocks.plans = [planFixture()];
  });

  test("run() skips re-submitting a slot that is already booked", async () => {
    const client = fakeClient();
    const executor = new BookingExecutor(client, noopPause);

    const first = await executor.run();
    expect(first.success).toBe(true);
    expect(client.bookSeat).toHaveBeenCalledTimes(1);
    const beginSeconds = Math.floor((client.bookSeat.mock.calls[0]![1] as Date).getTime() / 1000);

    client.bookings.mockResolvedValue([{ time: beginSeconds }]);
    const second = await executor.run();
    expect(second.success).toBe(true);
    expect(second.members[0]!.message).toContain("已有预约");
    expect(client.bookSeat).toHaveBeenCalledTimes(1);
  });

  test("runBurst() retries rejected attempts until the booking succeeds", async () => {
    const client = fakeClient();
    client.bookSeat
      .mockResolvedValueOnce({ CODE: "error", MESSAGE: "未到预约时间" })
      .mockResolvedValueOnce({ CODE: "error", MESSAGE: "未到预约时间" })
      .mockResolvedValue({ CODE: "ok", DATA: { result: "success" } });
    const executor = new BookingExecutor(client, noopPause);

    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 5_000 });
    expect(result.success).toBe(true);
    expect(client.bookSeat).toHaveBeenCalledTimes(3);
  });

  test("runBurst() gives up after the timeout when the window never opens", async () => {
    const client = fakeClient();
    client.bookSeat.mockResolvedValue({ CODE: "error", MESSAGE: "未到预约时间" });
    const executor = new BookingExecutor(client, noopPause);

    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 0 });
    expect(result.success).toBe(false);
    expect(client.bookSeat).toHaveBeenCalledTimes(1);
  });
});
