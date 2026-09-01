import { describe, expect, test } from "vitest";
import type { AuthService } from "../src/server/auth";
import { durations, floors } from "../src/server/catalog";

function fakeAuth(responses: unknown[]): AuthService {
  let index = 0;
  return {
    client: {
      floors: async () => responses[index++] as unknown[],
      bookingRange: async () => ({ minBeginTime: 7, maxEndTime: 22, minDuration: 1, maxDuration: 15 }),
    },
  } as unknown as AuthService;
}

describe("catalog adapters", () => {
  test("merges duplicate floors and seat titles across lookup days", async () => {
    const auth = fakeAuth([
      [{ roomName: "四楼", seatMap: { info: { id: "1558" }, POIs: [{ title: "298" }] } }],
      [{ roomName: "四楼", seatMap: { info: { id: "1558" }, POIs: [{ title: "299" }] } }],
      [{ roomName: "四楼", seatMap: { info: { id: "1558" }, POIs: [{ title: "298" }] } }],
    ]);
    const result = await floors(auth, "room=query");
    expect(result.options).toEqual([{ id: 1558, name: "四楼", seatCount: 2, seatTitles: ["298", "299"] }]);
    expect(result.range).toEqual({ minBeginTime: 7, maxEndTime: 22, minDuration: 1, maxDuration: 15 });
  });

  test("returns server-probed duration options and caches the same request", async () => {
    let calls = 0;
    const auth = { client: { floors: async () => { calls += 1; return [{}]; } } } as unknown as AuthService;
    const first = await durations(auth, "room=query", 9);
    const second = await durations(auth, "room=query", 9);
    expect(first.options).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(second).toEqual(first);
    expect(calls).toBe(12);
  });

  test("uses a fixed open-hour lookup time when listing floors", async () => {
    const lookups: Date[] = [];
    const auth = {
      client: {
        floors: async (_roomQuery: string, lookupTime: Date) => {
          lookups.push(lookupTime);
          return [{ roomName: "四楼", seatMap: { info: { id: "1558" }, POIs: [{ title: "298" }] } }];
        },
        bookingRange: async () => ({ minBeginTime: 7, maxEndTime: 22, minDuration: 1, maxDuration: 15 }),
      },
    } as unknown as AuthService;
    const result = await floors(auth, "room=query", "自习室");
    expect(result.options).toEqual([{ id: 1558, name: "四楼", seatCount: 1, seatTitles: ["298"] }]);
    // 自习室按 +1 天，最多查询今天和明天两天。
    expect(lookups).toHaveLength(2);
    expect(lookups.every((lookup) => lookup.getHours() === 8)).toBe(true);
  });
});
