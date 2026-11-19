export * from "./api.generated";
import type { Weekday } from "./api.generated";

export const weekdayLabels: Record<Weekday, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};

/** 周一至周五，用于“工作日”合并显示。 */
const WORKDAYS: Weekday[] = [1, 2, 3, 4, 5];
/** 周六与周日，用于“周末”合并显示。 */
const WEEKEND: Weekday[] = [6, 7];
const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

function sameSet(picked: Weekday[], expected: Weekday[]): boolean {
  if (picked.length !== expected.length) return false;
  const set = new Set(picked);
  return expected.every((day) => set.has(day));
}

/**
 * 把重复日期合并成人类可读的文本。
 *
 * - 选中全部七天 -> `每天`
 * - 只选中周六、周日 -> `周末`
 * - 只选中周一到周五 -> `工作日`
 * - 其余情况按周一到周日顺序列出，如 `周一、周三、周五`
 *
 * 输入会先去重并排序，因此后端返回的顺序不影响结果。
 */
export function formatWeekdays(weekdays: readonly number[] | null | undefined): string {
  const picked = [...new Set((weekdays ?? []).filter((day) => day >= 1 && day <= 7))].sort(
    (a, b) => a - b,
  ) as Weekday[];
  if (picked.length === 0) return "未选择";

  if (sameSet(picked, ALL_DAYS)) return "每天";
  if (sameSet(picked, WEEKEND)) return "周末";
  if (sameSet(picked, WORKDAYS)) return "工作日";

  return picked.map((day) => weekdayLabels[day]).join("、");
}
