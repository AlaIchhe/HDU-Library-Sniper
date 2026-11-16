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
