import type { Page } from "@playwright/test";
import {
  API_ROUTES,
  type ActionResponse,
  type Booking,
  type BookingPlan,
  type BookingsListResponse,
  type CheckInStatus,
  type DurationOptions,
  type FloorsResponse,
  type NextExecutionTarget,
  type PanelAuthStatusResponse,
  type PlanResponse,
  type PlanSlotInput,
  type PlansListResponse,
  type RoomTypesResponse,
  type RuntimeStatus,
  type SessionStatus,
  type SuccessResponse,
  type TogglePlanResponse,
} from "../../src/shared/api.generated";

type MockAppState = {
  plans?: BookingPlan[];
  bookings?: Booking[];
  disabledOnEnable?: Record<string, string[]>;
  failFloors?: boolean;
};

export function makePlan(id: string, seatNum: string, enabled: boolean, name = "自习室"): BookingPlan {
  return {
    id,
    name,
    slots: [
      {
        id: `${id}-s1`,
        roomType: "自习室",
        roomQuery: "q=76",
        floorId: 4,
        floorName: "四楼",
        seatNum,
        fallbackSeats: [],
        startHour: 8,
        durationHours: 4,
      },
    ],
    weekdays: [1, 2, 3, 4, 5],
    enabled,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export async function mockAuthenticatedApp(page: Page, initial: MockAppState = {}) {
  let plans: BookingPlan[] = [...(initial.plans ?? [])];
  let bookings: Booking[] = [...(initial.bookings ?? [])];
  let createdPlanSeq = 0;

  await page.route("**/api/**", async (route) => route.fulfill({ json: {} }));
  await page.route(`**${API_ROUTES.panelAuthStatus.pattern}`, async (route) =>
    route.fulfill({
      json: { required: false, authenticated: true } satisfies PanelAuthStatusResponse,
    }),
  );
  await page.route(`**${API_ROUTES.events.pattern}`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: "retry: 60000\n: connected\n\n",
    }),
  );
  await page.route(`**${API_ROUTES.sessionStatus.pattern}`, async (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        uid: "304174",
        name: "23320116",
        refreshing: false,
      } satisfies SessionStatus,
    }),
  );
  await page.route(`**${API_ROUTES.runtimeStatus.pattern}`, async (route) =>
    route.fulfill({
      json: { scheduler: "running", state: "idle" } satisfies RuntimeStatus,
    }),
  );
  await page.route(`**${API_ROUTES.runtimeNextTarget.pattern}`, async (route) =>
    route.fulfill({
      json: { kind: "none", label: "暂无计划" } satisfies NextExecutionTarget,
    }),
  );
  await page.route(`**${API_ROUTES.checkinStatus.pattern}`, async (route) =>
    route.fulfill({
      json: { enabled: false, consentVersion: "1" } satisfies CheckInStatus,
    }),
  );
  await page.route(`**${API_ROUTES.bookingsCurrent.pattern}`, async (route) =>
    route.fulfill({ json: { bookings } satisfies BookingsListResponse }),
  );
  await page.route("**/api/bookings/*/*", async (route) => {
    const [, , , id, action] = new URL(route.request().url()).pathname.split("/");
    if (action === "checkin") {
      bookings = bookings.map((b) =>
        b.bookingId === id
          ? { ...b, status: "1", state: "in_use", statusLabel: "使用中", canCheckIn: false }
          : b,
      );
    }
    await route.fulfill({ json: { success: true, message: "操作成功" } satisfies ActionResponse });
  });
  await page.route(`**${API_ROUTES.plansList.pattern}`, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { plans } satisfies PlansListResponse });
    }
    const body = route.request().postDataJSON() as { name?: string; slots?: PlanSlotInput[] };
    createdPlanSeq += 1;
    const id = `p-new-${createdPlanSeq}`;
    const slots = (body.slots ?? []).map((s, idx) => ({
      id: s.id || `${id}-s${idx + 1}`,
      roomType: s.roomType,
      roomQuery: s.roomQuery,
      floorId: s.floorId,
      floorName: s.floorName ?? "三楼",
      seatNum: s.seatNum,
      fallbackSeats: s.fallbackSeats ?? [],
      startHour: s.startHour,
      durationHours: s.durationHours,
    }));
    const created: BookingPlan = {
      id,
      name: body.name || slots[0]?.roomType || "阅览室",
      slots,
      weekdays: [1, 2, 3, 4, 5],
      enabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    plans = [...plans, created];
    return route.fulfill({ json: { plan: created } satisfies PlanResponse });
  });
  await page.route("**/api/plans/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    if (route.request().method() === "DELETE") {
      plans = plans.filter((p) => p.id !== id);
      return route.fulfill({ json: { success: true } satisfies SuccessResponse });
    }
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { name?: string; slots?: PlanSlotInput[] };
      let updated: BookingPlan | undefined;
      plans = plans.map((p) => {
        if (p.id !== id) return p;
        updated = {
          ...p,
          name: body.name ?? p.name,
          slots: body.slots
            ? body.slots.map((s, idx) => ({
                id: s.id || `${id}-s${idx + 1}`,
                roomType: s.roomType,
                roomQuery: s.roomQuery,
                floorId: s.floorId,
                floorName: s.floorName ?? "",
                seatNum: s.seatNum,
                fallbackSeats: s.fallbackSeats ?? [],
                startHour: s.startHour,
                durationHours: s.durationHours,
              }))
            : p.slots,
        };
        return updated;
      });
      return route.fulfill({
        json: {
          plan: updated ?? makePlan(id, "101", false),
        } satisfies PlanResponse,
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/plans/*/*", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const id = parts[3] ?? "";
    const enabled = parts[4] === "enable";
    const disabledPlanIds = enabled ? (initial.disabledOnEnable?.[id] ?? []) : [];
    plans = plans.map((p) => {
      if (p.id === id) return { ...p, enabled };
      if (disabledPlanIds.includes(p.id)) return { ...p, enabled: false };
      return p;
    });
    const plan = plans.find((p) => p.id === id) ?? plans[0];
    return route.fulfill({ json: { plan, disabledPlanIds } satisfies TogglePlanResponse });
  });
  await page.route(`**${API_ROUTES.catalogRoomTypes.pattern}`, async (route) =>
    route.fulfill({
      json: {
        options: [
          { id: "q=76", name: "阅览室", query: "q=76" },
          { id: "q=77", name: "自习室", query: "q=77" },
        ],
      } satisfies RoomTypesResponse,
    }),
  );
  await page.route(`**${API_ROUTES.catalogFloors.pattern}**`, async (route) => {
    if (initial.failFloors) {
      return route.fulfill({ status: 502, json: { detail: "该房间类型当前没有可预约楼层" } });
    }
    return route.fulfill({
      json: {
        options: [{ id: 3, name: "三楼", seatCount: 60, seatTitles: ["301"] }],
        range: { minBeginTime: 8, maxEndTime: 22, minDuration: 1, maxDuration: 8 },
      } satisfies FloorsResponse,
    });
  });
  await page.route(`**${API_ROUTES.catalogDurations.pattern}**`, async (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: {
        roomQuery: url.searchParams.get("roomQuery") ?? "q=76",
        startHour: Number(url.searchParams.get("startHour") ?? 8),
        options: [1, 2, 3, 4],
      } satisfies DurationOptions,
    });
  });
}
