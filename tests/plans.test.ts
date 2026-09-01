import { describe, expect, test } from "vitest";
import { validatePlan } from "../src/shared/plan-validation";

describe("plan validation", () => {
  test("requires a valid recurring weekday", () => {
    expect(validatePlan({ roomType: "自习室", roomQuery: "x", floorId: 1, seatNum: "101", startHour: 8, durationHours: 1, weekdays: [] })).toContain("至少选择一个星期");
    expect(validatePlan({ roomType: "自习室", roomQuery: "x", floorId: 1, seatNum: "101", startHour: 8, durationHours: 1, weekdays: [1] })).toEqual([]);
  });
});
