import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let home: string;
let closeDb: (() => void) | undefined;

beforeAll(() => {
  home = join(mkdtempSync(join(tmpdir(), "hdu-sniper-test-")), "home");
  process.env.HDU_SNIPER_HOME = home;
});

afterAll(() => {
  closeDb?.();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

type FakeResponse = Record<string, unknown>;

function makeClient(handler: (path: string) => unknown) {
  const calls: string[] = [];
  const client = {
    uid: "304174",
    async floors() {
      calls.push("floors");
      return [{
        seatMap: {
          info: { id: "1559" },
          POIs: [{ id: "63001", title: "130" }],
        },
      }];
    },
    async bookings() {
      calls.push("bookings");
      return handler("bookings") as FakeResponse[];
    },
    async bookSeat() {
      calls.push("bookSeats");
      return handler("bookSeats") as FakeResponse;
    },
  };
  return { client, calls };
}

function seedPlan(db: import("bun:sqlite").Database): void {
  db.query(
    "INSERT INTO plans(id,kind,room_type,room_query,floor_id,floor_name,seat_num,fallback_seats,start_hour,duration_hours,weekdays,enabled,created_at,updated_at) "
    + "VALUES('plan-1','single','自习室','q',1559,'六楼','130','[]',7,15,'[1,2,3,4,5,6,7]',1,'now','now')",
  ).run();
}

describe("BookingExecutor burst", () => {
  test("duplicate-conflict failure is terminal, audited once with reason", async () => {
    const { db } = await import("../src/server/db");
    closeDb = () => db.close();
    seedPlan(db as unknown as import("bun:sqlite").Database);

    const { BookingExecutor } = await import("../src/server/booking");
    const { client, calls } = makeClient((path) => {
      if (path === "bookSeats") return { CODE: "1", MESSAGE: "已有预约，请勿重复预约！" };
      return [];
    });
    const executor = new BookingExecutor(client as never, async () => {});

    const result = await executor.runBurst();

    // 冲突是终态：只尝试一次 bookSeats，不再盲目重试
    expect(calls.filter((call) => call === "bookSeats")).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.members[0]?.terminal).toBe(true);
    expect(result.message).toContain("存在时间冲突的预约");

    // burst 只产生一条 booking_run_finished 审计，且带原因
    const events = db.query("SELECT event, payload FROM audit WHERE event LIKE 'booking_%' ORDER BY id").all() as Array<{ event: string; payload: string }>;
    const runFinished = events.filter((event) => event.event === "booking_run_finished");
    expect(runFinished).toHaveLength(1);
    expect(JSON.parse(runFinished[0].payload).message).toContain("存在时间冲突的预约");
    const memberEvents = events.filter((event) => event.event === "booking_member_finished");
    expect(JSON.parse(memberEvents[0].payload).message).toBeTruthy();
  });

  test("server-side accepted booking is confirmed via booking list (idempotent)", async () => {
    const { db } = await import("../src/server/db");
    db.query("DELETE FROM audit").run();

    const { BookingExecutor } = await import("../src/server/booking");
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    now.setDate(now.getDate() + 2); // 默认房型提前两天开放预约
    const targetBegin = Math.floor(new Date(`${now.toISOString().slice(0, 10)}T07:00:00+08:00`).getTime() / 1000);
    const { client } = makeClient((path) => {
      if (path === "bookSeats") return { CODE: "1", MESSAGE: "已有预约，请勿重复预约！" };
      if (path === "bookings") return [{ time: String(targetBegin), seatNum: "130", id: "1" }];
      return [];
    });
    const executor = new BookingExecutor(client as never, async () => {});

    const result = await executor.runBurst();

    expect(result.success).toBe(true);
    expect(result.members[0]?.message).toContain("已有预约");
  });
});
