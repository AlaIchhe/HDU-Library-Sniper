import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

let home: string;
let closeDb: (() => void) | undefined;

beforeAll(() => {
  home = join(mkdtempSync(join(tmpdir(), "hdu-sniper-next-target-")), "home");
  process.env.HDU_SNIPER_HOME = home;
});

afterAll(() => {
  closeDb?.();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

afterEach(() => {
  vi.useRealTimers();
});

function pendingBooking(startIso: string) {
  return {
    id: "b-1",
    status: "0",
    time: Math.floor(new Date(startIso).getTime() / 1000),
    limitSignAgo: 1800,
    limitSignBack: 1800,
  };
}

async function nextTarget(options: { autoCheckIn: boolean; bookings?: Record<string, unknown>[] }) {
  const { db } = await import("../src/server/db");
  closeDb = () => db.close();
  db.query(
    "INSERT OR IGNORE INTO plans(id,kind,room_type,room_query,floor_id,floor_name,seat_num,fallback_seats,start_hour,duration_hours,weekdays,enabled,created_at,updated_at) " +
      "VALUES('plan-1','single','自习室','q',1559,'六楼','130','[]',7,15,'[1,2,3,4,5,6,7]',1,'2026-11-01','2026-11-01')",
  ).run();
  db.query("INSERT OR REPLACE INTO meta(key, value) VALUES('auto_checkin_enabled', ?1)").run(
    options.autoCheckIn ? "1" : "0",
  );

  const { createApi } = await import("../src/server/api");
  const { Scheduler } = await import("../src/server/scheduler");
  const auth = {
    authenticated: true,
    restore: async () => true,
    status: () => ({}),
    client: { bookings: async () => options.bookings ?? [] },
  };
  const scheduler = new Scheduler(auth as never, {} as never);
  if (options.bookings?.length) scheduler.observeBookings(options.bookings);
  const api = createApi(auth as never, scheduler);
  const response = await api(new Request("http://127.0.0.1:8000/api/runtime/next-target"));
  return (await response.json()) as Record<string, unknown>;
}

describe("next runtime target", () => {
  test("reports tonight's 20:00 anchor, not the day offset target date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T14:48:00+08:00"));

    const body = await nextTarget({ autoCheckIn: false });
    expect(body).toMatchObject({ kind: "booking", label: "预约", at: "2026/11/6 20:00:00" });
  });

  test("keeps the booking anchor ahead of the check-in moment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T14:48:00+08:00"));

    const body = await nextTarget({
      autoCheckIn: true,
      bookings: [pendingBooking("2026-11-07T07:00:00+08:00")],
    });
    // 今晚 20:00 抢座在先；07:00 那单的签到时点是 07:01。
    expect(body).toMatchObject({ kind: "booking", at: "2026/11/6 20:00:00" });
  });

  test("rolls to tomorrow 20:00 after the anchor and lets the check-in win", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T20:30:00+08:00"));

    const body = await nextTarget({
      autoCheckIn: true,
      bookings: [pendingBooking("2026-11-07T07:00:00+08:00")],
    });
    expect(body).toMatchObject({ kind: "check-in", at: "2026/11/7 07:01:00" });
  });
});
