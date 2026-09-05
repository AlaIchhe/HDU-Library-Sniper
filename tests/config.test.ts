import { describe, expect, test } from "vitest";
import { bookingAnchorDelaySeconds, bookingDayOffset, bookingDayOffsetFor } from "../src/server/config";

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

describe("booking anchor delay", () => {
  test("waits until 20:00 later today when the anchor has not passed", () => {
    expect(bookingAnchorDelaySeconds(0)).toBe(20 * 3600);
    expect(bookingAnchorDelaySeconds(19 * 3600 + 59 * 60 + 59)).toBe(1);
  });

  test("waits for tomorrow 20:00 once the anchor moment has arrived", () => {
    expect(bookingAnchorDelaySeconds(20 * 3600)).toBe(24 * 3600);
    expect(bookingAnchorDelaySeconds(21 * 3600)).toBe(23 * 3600);
  });
});
