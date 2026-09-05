import { describe, expect, test } from "vitest";
import type { AuthService } from "../src/server/auth";
import { floorToOption, durations, floors } from "../src/server/catalog";

function fakeAuth(raw: unknown[]): AuthService {
  return {
    client: {
      floors: async () => raw,
      bookingRange: async () => ({ minBeginTime: 7, maxEndTime: 22, minDuration: 1, maxDuration: 15 }),
    },
  } as unknown as AuthService;
}

describe("catalog adapters", () => {
  test("parses the exact Huitu floor node", async () => {
    const option = floorToOption({ roomName: "四楼", seatMap: { info: { id: "1558" }, POIs: [{ title: "298" }, { title: "298" }, { title: "299" }] } });
    expect(option).toEqual({ id: 1558, name: "四楼", seatCount: 2, seatTitles: ["298", "299"] });
  });

  test("returns duration options from the server booking range", async () => {
    const auth = {
      client: {
        bookingRange: async () => ({ minBeginTime: 7, maxEndTime: 22, minDuration: 1, maxDuration: 3 }),
      },
    } as unknown as AuthService;
    const result = await durations(auth, "room=query", 9);
    expect(result).toEqual({ roomQuery: "room=query", startHour: 9, options: [1, 2, 3] });
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
    // 楼层清单与具体时间无关，目标日期只需要查询一次。
    expect(lookups).toHaveLength(1);
    expect(lookups.every((lookup) => lookup.getHours() === 8)).toBe(true);
  });
});
