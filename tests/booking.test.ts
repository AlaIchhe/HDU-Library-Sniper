import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BookingPlan } from "../src/shared/types";
import type { LibraryClient } from "../src/server/library";
import { BookingExecutor, pacing } from "../src/server/booking";
import { nextBackoffMs } from "../src/server/backoff";
import { RequestTimeoutError } from "../src/server/library";

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

const floorPayload = [
  {
    seatMap: {
      info: { id: 3 },
      POIs: [
        { title: "101", id: "seat-1" },
        { title: "102", id: "seat-2" },
      ],
    },
  },
];

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

describe("exponential backoff", () => {
  test("doubles the delay and caps it", () => {
    expect(nextBackoffMs(1100, 1100, 30_000)).toBe(2_200);
    expect(nextBackoffMs(4_400, 1100, 30_000)).toBe(8_800);
    expect(nextBackoffMs(30_000, 1100, 30_000)).toBe(30_000);
    expect(nextBackoffMs(60_000, 60_000, 900_000)).toBe(120_000);
    expect(nextBackoffMs(480_000, 60_000, 900_000)).toBe(900_000);
  });
});

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
    // 每次提交前都必须重新查询座位，否则服务端会拒绝“订座流程异常”。
    expect(client.floors).toHaveBeenCalledTimes(3);
  });

  test("runBurst() stops immediately when the account is rate-limited for 10 minutes", async () => {
    const client = fakeClient();
    client.bookSeat.mockResolvedValue({ CODE: "1", MESSAGE: "请求过于频繁，请10分钟后再试" });
    const pauses: number[] = [];
    const executor = new BookingExecutor(client, async (ms) => {
      pauses.push(ms);
    });

    const result = await executor.runBurst(false, { intervalMs: 1_000, timeoutMs: 60_000 });

    expect(result.success).toBe(false);
    expect(result.members[0]?.blocked).toBe(true);
    expect(result.message).toContain("10 分钟");
    // 封禁是账号级的，继续重试只会延长封禁。
    expect(client.bookSeat).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
  });

  test("runBurst() waits out a mobile throttle before retrying", async () => {
    const client = fakeClient();
    client.bookSeat
      .mockResolvedValueOnce({ CODE: "1", MESSAGE: "请求太频繁了，请稍后再试" })
      .mockResolvedValue({ CODE: "ok", DATA: { result: "success" } });
    const pauses: number[] = [];
    const executor = new BookingExecutor(client, async (ms) => {
      pauses.push(ms);
    });

    const result = await executor.runBurst(false, { intervalMs: 1_000, timeoutMs: 60_000 });

    expect(result.success).toBe(true);
    expect(pauses[0]).toBe(15_000);
  });

  test("runBurst() gives up after the timeout when the window never opens", async () => {
    const client = fakeClient();
    client.bookSeat.mockResolvedValue({ CODE: "error", MESSAGE: "未到预约时间" });
    const executor = new BookingExecutor(client, noopPause);

    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 0 });
    expect(result.success).toBe(false);
    expect(client.bookSeat).toHaveBeenCalledTimes(1);
  });

  test("run() reports an unverified result when the booking list is unavailable", async () => {
    const client = fakeClient();
    client.bookSeat.mockResolvedValue({ CODE: "1", MESSAGE: "已有预约，请勿重复预约！" });
    client.bookings.mockRejectedValue(new Error("network down"));
    const executor = new BookingExecutor(client, noopPause);

    const result = await executor.run();

    expect(result.success).toBe(false);
    expect(result.members[0]?.terminal).toBeFalsy();
    expect(result.members[0]?.unverified).toBe(true);
  });

  test("run() treats a timeout with an unavailable booking list as unverified", async () => {
    const client = fakeClient();
    client.bookSeat.mockRejectedValue(new RequestTimeoutError("请求超时"));
    client.bookings.mockRejectedValue(new Error("network down"));
    const executor = new BookingExecutor(client, noopPause);

    const result = await executor.run();

    expect(result.members[0]?.success).toBe(false);
    expect(result.members[0]?.unverified).toBe(true);
  });

  test("run() retries the booking list before giving up on it", async () => {
    const client = fakeClient();
    client.bookings.mockRejectedValueOnce(new Error("transient")).mockResolvedValue([]);
    const executor = new BookingExecutor(client, noopPause);

    const result = await executor.run();

    expect(result.success).toBe(true);
    expect(client.bookSeat).toHaveBeenCalledTimes(1);
  });

  test("runBurst() falls back to the prelock booking snapshot when the live list fails", async () => {
    const client = fakeClient();
    const target = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    target.setDate(target.getDate() + 1); // 自习室提前一天
    const beginSeconds = Math.floor(
      new Date(`${target.toISOString().slice(0, 10)}T08:00:00+08:00`).getTime() / 1000,
    );
    client.bookings
      .mockResolvedValueOnce([{ time: beginSeconds }])
      .mockRejectedValue(new Error("network down"));
    const executor = new BookingExecutor(client, noopPause);

    await executor.lockBurst({ timeoutMs: 100 });
    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 100 });

    expect(result.success).toBe(true);
    expect(client.bookSeat).not.toHaveBeenCalled();
  });

  test("runBurst() stops retrying a member whose result stays unverified", async () => {
    const client = fakeClient();
    client.bookSeat.mockResolvedValue({ CODE: "1", MESSAGE: "已有预约，请勿重复预约！" });
    client.bookings.mockRejectedValue(new Error("network down"));
    const executor = new BookingExecutor(client, noopPause);

    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 60_000 });

    expect(result.members[0]?.unverified).toBe(true);
    expect(result.members[0]?.terminal).toBe(true);
    expect(client.bookSeat).toHaveBeenCalledTimes(3);
  });

  test("runBurst() backs off exponentially on any failed attempt", async () => {
    const client = fakeClient();
    client.bookSeat
      .mockResolvedValueOnce({ CODE: "1", MESSAGE: "操作过于频繁，请稍后再试" })
      .mockResolvedValue({ CODE: "ok", DATA: { result: "success" } });
    const pauses: number[] = [];
    const executor = new BookingExecutor(client, async (ms) => {
      pauses.push(ms);
    });

    const result = await executor.runBurst(false, { intervalMs: 1_000, timeoutMs: 5_000 });

    expect(result.success).toBe(true);
    expect(pauses[0]).toBe(2_000);
  });

  test("runBurst() keeps booking other members after one member reaches a terminal conflict", async () => {
    const first = { ...planFixture(), id: "p1", seatNum: "101", startHour: 8, durationHours: 2 };
    const second = { ...planFixture(), id: "p2", seatNum: "102", startHour: 10, durationHours: 2 };
    mocks.plans = [
      {
        id: "group-1",
        kind: "group",
        name: "组合",
        memberPlanIds: ["p1", "p2"],
        members: [first, second],
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        enabled: true,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ];

    const client = fakeClient();
    let secondFailures = 1;
    client.bookSeat.mockImplementation(async (seatId: string) => {
      if (seatId === "seat-1") return { CODE: "1", MESSAGE: "已有预约，请勿重复预约！" };
      if (secondFailures-- > 0) return { CODE: "error", MESSAGE: "未到预约时间" };
      return { CODE: "ok", DATA: { result: "success" } };
    });
    const executor = new BookingExecutor(client, noopPause);

    const result = await executor.runBurst(false, { intervalMs: 0, timeoutMs: 5_000 });

    expect(result.success).toBe(false);
    expect(result.members[0]?.terminal).toBe(true);
    expect(result.members[1]?.success).toBe(true);
    // 终态成员不再重复提交，但同组的另一个成员仍会被继续重试并预约成功。
    expect(client.bookSeat.mock.calls.filter(([seatId]) => seatId === "seat-1")).toHaveLength(1);
    expect(client.bookSeat.mock.calls.filter(([seatId]) => seatId === "seat-2")).toHaveLength(2);
  });
});
