import { describe, expect, test } from "vitest";
import { formatWeekdays } from "../src/shared/types";

describe("formatWeekdays", () => {
  test("merges all seven days into 每天", () => {
    expect(formatWeekdays([1, 2, 3, 4, 5, 6, 7])).toBe("每天");
  });

  test("merges Saturday and Sunday into 周末", () => {
    expect(formatWeekdays([6, 7])).toBe("周末");
    // 顺序无关
    expect(formatWeekdays([7, 6])).toBe("周末");
  });

  test("merges Monday to Friday into 工作日", () => {
    expect(formatWeekdays([1, 2, 3, 4, 5])).toBe("工作日");
    // 乱序与重复同样成立
    expect(formatWeekdays([5, 3, 1, 4, 2, 1])).toBe("工作日");
  });

  test("lists other combinations in weekday order", () => {
    expect(formatWeekdays([3, 1])).toBe("周一、周三");
    expect(formatWeekdays([6, 1])).toBe("周一、周六");
    expect(formatWeekdays([1])).toBe("周一");
  });

  test("dedupes and sorts before deciding", () => {
    expect(formatWeekdays([7, 6, 6, 7])).toBe("周末");
    expect(formatWeekdays([2, 1, 2])).toBe("周一、周二");
  });

  test("handles empty and out-of-range input", () => {
    expect(formatWeekdays([])).toBe("未选择");
    expect(formatWeekdays(null)).toBe("未选择");
    expect(formatWeekdays(undefined)).toBe("未选择");
    // 越界的值被忽略，不会拼出错误标签
    expect(formatWeekdays([0, 8, 9])).toBe("未选择");
    expect(formatWeekdays([1, 9])).toBe("周一");
  });

  test("does not merge a strict subset of weekdays", () => {
    // 周一到周四不是“工作日”，应逐项列出
    expect(formatWeekdays([1, 2, 3, 4])).toBe("周一、周二、周三、周四");
  });
});
