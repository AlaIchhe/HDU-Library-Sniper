import { describe, expect, test } from "vitest";
import { bookingDayOffset, bookingDayOffsetFor } from "../src/server/config";

describe("booking day offset", () => {
  test("self-study rooms are reservable one day ahead", () => {
    expect(bookingDayOffsetFor("自习室")).toBe(1);
    expect(bookingDayOffsetFor("普通自习室")).toBe(1);
    expect(bookingDayOffsetFor("宋韵云图（自习室）")).toBe(1);
  });

  test("other room types use the default two-day offset", () => {
    expect(bookingDayOffsetFor("研讨室")).toBe(bookingDayOffset);
    expect(bookingDayOffsetFor("电子阅览室")).toBe(2);
    expect(bookingDayOffsetFor()).toBe(2);
  });
});
