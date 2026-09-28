import { describe, expect, test } from "vitest";
import { bookingAnchorDelaySeconds, bookingDayOffset, bookingDayOffsetFor, bookingPrelockDelaySeconds } from "../src/server/config";

describe("booking day offset", () => {
  test("living-area rooms are reservable one day ahead", () => {
    expect(bookingDayOffsetFor("生活区")).toBe(1);
    expect(bookingDayOffsetFor("生活区（南楼）")).toBe(1);
  });

  test("other room types use the default two-day offset", () => {
    expect(bookingDayOffsetFor("自习室")).toBe(bookingDayOffset);
    expect(bookingDayOffsetFor("宋韵云图（自习室）")).toBe(2);
    expect(bookingDayOffsetFor("研讨室")).toBe(2);
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

describe("booking prelock delay", () => {
  test("starts 60 seconds before the booking anchor", () => {
    expect(bookingPrelockDelaySeconds(0)).toBe(20 * 3600 - 60);
    expect(bookingPrelockDelaySeconds(19 * 3600 + 58 * 60)).toBe(60);
  });

  test("locks immediately when started inside the prelock window", () => {
    expect(bookingPrelockDelaySeconds(19 * 3600 + 59 * 60)).toBe(0);
    expect(bookingPrelockDelaySeconds(19 * 3600 + 59 * 60 + 59)).toBe(0);
  });

  test("waits for the next day after the booking anchor", () => {
    expect(bookingPrelockDelaySeconds(20 * 3600)).toBe(24 * 3600 - 60);
    expect(bookingPrelockDelaySeconds(21 * 3600)).toBe(23 * 3600 - 60);
  });
});
