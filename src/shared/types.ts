export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type { AuditEvent } from "./generated/AuditEvent";
export type { Booking } from "./generated/Booking";
export type { BookingGroup } from "./generated/BookingGroup";
export type { BookingPlan } from "./generated/BookingPlan";
export type { BookingRange } from "./generated/BookingRange";
export type { CheckInPolling } from "./generated/CheckInPolling";
export type { CheckInStatus } from "./generated/CheckInStatus";
export type { DurationOptions } from "./generated/DurationOptions";
export type { FloorOption } from "./generated/FloorOption";
export type { NextExecutionTarget } from "./generated/NextExecutionTarget";
export type { NextTargetKind } from "./generated/NextTargetKind";
export type { PlanKind } from "./generated/PlanKind";
export type { PlanListItem } from "./generated/PlanListItem";
export type { QrLoginStart } from "./generated/QrLoginStart";
export type { QrLoginStatus } from "./generated/QrLoginStatus";
export type { RoomTypeOption } from "./generated/RoomTypeOption";
export type { RuntimeStatus } from "./generated/RuntimeStatus";
export type { SessionStatus } from "./generated/SessionStatus";

export const weekdayLabels: Record<Weekday, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};
