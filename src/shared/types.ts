export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type AuditEvent = { id: number; event: string; payload: Record<string, unknown>; createdAt: string };
export type PlanKind = "single" | "group";
export type NextTargetKind = "booking" | "check-in" | "none";

export type BookingPlan = {
  id: string;
  kind: "single";
  roomType: string;
  roomQuery: string;
  floorId: number;
  floorName: string;
  seatNum: string;
  fallbackSeats: Array<string>;
  startHour: number;
  durationHours: number;
  weekdays: Array<1 | 2 | 3 | 4 | 5 | 6 | 7>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BookingGroup = {
  id: string;
  kind: "group";
  name: string;
  memberPlanIds: Array<string>;
  members?: Array<BookingPlan>;
  weekdays: Array<1 | 2 | 3 | 4 | 5 | 6 | 7>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PlanListItem = BookingPlan | BookingGroup;

export type Booking = {
  bookingId: string;
  roomName: string;
  seatNum: string;
  startText: string;
  durationText: string;
  status: string;
  state: string;
  statusLabel: string;
  canCancel: boolean;
  canCheckIn: boolean;
  canSignOut: boolean;
  canLeave: boolean;
  canRenew: boolean;
};

export type BookingRange = {
  minBeginTime: number;
  maxEndTime: number;
  minDuration: number;
  maxDuration: number;
};

export type CheckInPolling = { active: boolean; nextPollAt?: string; lastPollAt?: string };

export type CheckInStatus = {
  enabled: boolean;
  consentVersion: string;
  consentedAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastMessage?: string;
};

export type DurationOptions = { roomQuery: string; startHour: number; options: Array<number> };
export type FloorOption = { id: number; name: string; seatCount: number; seatTitles: Array<string> };
export type RoomTypeOption = { id: string; name: string; query: string };

export type NextExecutionTarget = {
  kind: NextTargetKind;
  label: string;
  at?: string;
  planId?: string;
  bookingId?: string;
};

export type RuntimeStatus = {
  scheduler: string;
  state: string;
  lastRunAt?: string;
  lastMessage?: string;
  checkInPolling?: CheckInPolling;
};

export type SessionStatus = {
  authenticated: boolean;
  uid?: string;
  name?: string;
  refreshing: boolean;
  lastError?: string;
};

export type QrLoginStart = { uuid: string; image: string; ttlSeconds: number };
export type QrLoginStatus = { status: string; message?: string; session?: SessionStatus };

export const weekdayLabels: Record<Weekday, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};
