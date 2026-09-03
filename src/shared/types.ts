export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type PlanKind = "single" | "group";

export type BookingPlan = {
  id: string;
  kind: "single";
  roomType: string;
  roomQuery: string;
  floorId: number;
  floorName?: string;
  seatNum: string;
  fallbackSeats: string[];
  startHour: number;
  durationHours: number;
  weekdays: Weekday[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BookingGroup = {
  id: string;
  kind: "group";
  name: string;
  memberPlanIds: string[];
  members?: BookingPlan[];
  weekdays: Weekday[];
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
  state: "pending" | "check_in" | "in_use" | "away" | string;
  statusLabel: string;
  canCancel: boolean;
  canCheckIn: boolean;
  canSignOut: boolean;
  canLeave: boolean;
  canRenew: boolean;
};

export type SessionStatus = {
  authenticated: boolean;
  uid?: string;
  name?: string;
  refreshing: boolean;
  lastError?: string;
};

export type RuntimeStatus = {
  scheduler: "running" | "stopped";
  state: "idle" | "running" | "auth_required" | "error";
  lastRunAt?: string;
  lastMessage?: string;
  bookingScheduler?: { installed: boolean; nextAt?: string; lastRunAt?: string; lastMessage?: string };
  checkInPolling?: { active: boolean; nextPollAt?: string; lastPollAt?: string };
};

export type NextExecutionTarget = {
  kind: "booking" | "check-in" | "none";
  label: string;
  at?: string;
  planId?: string;
  bookingId?: string;
};

export type RoomTypeOption = { id: string; name: string; query: string };
export type FloorOption = { id: number; name: string; seatCount: number; seatTitles: string[] };
export type BookingRange = {
  minBeginTime: number;
  maxEndTime: number;
  minDuration: number;
  maxDuration: number;
};
export type DurationOptions = {
  roomQuery: string;
  startHour: number;
  options: number[];
  source: "server-probe";
  notice?: string;
};
export type CheckInStatus = {
  enabled: boolean;
  consentVersion: string;
  consentedAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastMessage?: string;
};

export type AuditEvent = {
  id: number;
  event: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export const weekdayLabels: Record<Weekday, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};

export type ApiError = { detail?: string };

export type QrLoginStart = {
  uuid: string;
  image: string;
  /** 二维码可安全扫描的时间窗口（秒）。SSO 在该窗口结束后会作废旧码，
   *  客户端应在此窗口到期前换一张新二维码，避免对已失效的码空转轮询。 */
  ttlSeconds: number;
};

export type QrLoginStatus = {
  status: "waiting" | "confirmed" | "expired" | "error";
  message?: string;
  session?: SessionStatus;
};
