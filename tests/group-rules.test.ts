import { describe, expect, test } from "vitest";
import type { BookingPlan, Weekday } from "../src/shared/types";

function plan(id: string, startHour: number, durationHours: number, weekdays: number[] = [1, 2, 3, 4, 5, 6, 7]): BookingPlan {
  return {
    id, kind: "single", roomType: "自习室", roomQuery: "room=query", floorId: 1, floorName: "四楼",
    seatNum: id, fallbackSeats: [], startHour, durationHours, weekdays: weekdays as Weekday[], enabled: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("group rules", () => {
  test("time ranges use half-open intervals", () => {
    const a = plan("a", 8, 2);
    const b = plan("b", 10, 2);
    expect(a.startHour + a.durationHours).toBe(b.startHour);
  });

  test("a group requires matching weekdays", () => {
    expect(JSON.stringify(plan("a", 8, 2).weekdays)).not.toBe(JSON.stringify(plan("b", 10, 2, [1, 2, 3]).weekdays));
  });
});
