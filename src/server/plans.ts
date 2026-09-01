import { randomUUID } from "node:crypto";
import type { BookingPlan, Weekday } from "../shared/types";
import { deletePlan, getPlan, listPlans, savePlan } from "./db";
import { deleteGroup, getGroupMembers, listGroups, referencedPlanIds, saveGroup, setOnlyEnabled } from "./db";
import type { BookingGroup, PlanListItem } from "../shared/types";
import { validatePlan, validWeekdays } from "../shared/plan-validation";

export function createPlan(input: Partial<BookingPlan>): BookingPlan {
  const now = new Date().toISOString();
  const plan: BookingPlan = {
    id: input.id || randomUUID(),
    kind: "single",
    roomType: input.roomType?.trim() || "",
    roomQuery: input.roomQuery?.trim() || "",
    floorId: Number(input.floorId),
    floorName: input.floorName?.trim() || "",
    seatNum: input.seatNum?.trim() || "",
    fallbackSeats: [...new Set((input.fallbackSeats || []).map(String).map((value) => value.trim()).filter(Boolean))],
    startHour: Number(input.startHour),
    durationHours: Number(input.durationHours),
    weekdays: validWeekdays(input.weekdays || [1, 2, 3, 4, 5, 6, 7]),
    enabled: input.enabled ?? false,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
  const errors = validatePlan(plan);
  if (errors.length) throw new Error(errors.join("；"));
  return savePlan(plan);
}

export function updatePlan(id: string, input: Partial<BookingPlan>): BookingPlan {
  const current = getPlan(id);
  if (!current) throw new Error("方案不存在");
  const updated = { ...current, ...input, id, createdAt: current.createdAt };
  const groups = listGroups().filter((row) => getGroupMembers(String(row.id)).includes(id));
  for (const group of groups) {
    const members = getGroupMembers(String(group.id)).map((memberId) => memberId === id ? updated : getPlan(memberId)).filter((plan): plan is BookingPlan => Boolean(plan));
    validateGroup(String(group.name || "组合方案"), members.map((plan) => plan.id), members);
  }
  return createPlan(updated);
}

export function listPlanItems(): PlanListItem[] {
  const singles = listPlans();
  const byId = new Map(singles.map((plan) => [plan.id, plan]));
  const groups: BookingGroup[] = listGroups().map((row) => {
    const memberPlanIds = getGroupMembers(String(row.id));
    return {
      id: String(row.id),
      kind: "group",
      name: String(row.name || "组合方案"),
      memberPlanIds,
      members: memberPlanIds.map((id) => byId.get(id)).filter((plan): plan is BookingPlan => Boolean(plan)),
      weekdays: JSON.parse(String(row.weekdays || "[]")),
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  });
  return [...singles, ...groups];
}

export function getPlanItem(id: string): PlanListItem | undefined {
  return listPlanItems().find((item) => item.id === id);
}

export function enablePlanItem(id: string, enabled: boolean): { item: PlanListItem; disabledPlanIds: string[] } {
  const item = getPlanItem(id);
  if (!item) throw new Error("方案不存在");
  const disabledPlanIds = setOnlyEnabled(id, enabled);
  return { item: getPlanItem(id)!, disabledPlanIds };
}

export function validateGroup(name: string, memberPlanIds: string[], overridePlans?: BookingPlan[]): { name: string; memberPlanIds: string[]; plans: BookingPlan[]; weekdays: Weekday[] } {
  const singles = overridePlans || memberPlanIds.map((id) => getPlan(id));
  if (memberPlanIds.length < 2 || singles.some((plan) => !plan)) throw new Error("组合方案至少需要两个有效单条方案");
  if (new Set(memberPlanIds).size !== memberPlanIds.length) throw new Error("组合方案不能包含重复方案");
  const plans = singles as BookingPlan[];
  const weekdays = JSON.stringify(plans[0].weekdays);
  if (plans.some((plan) => JSON.stringify(plan.weekdays) !== weekdays)) throw new Error("组合内单条方案的重复日期必须一致");
  for (let left = 0; left < plans.length; left += 1) {
    for (let right = left + 1; right < plans.length; right += 1) {
      const a = plans[left]; const b = plans[right];
      if (a.startHour < b.startHour + b.durationHours && b.startHour < a.startHour + a.durationHours) {
        throw new Error(`方案 ${a.seatNum} 与 ${b.seatNum} 的预约时间冲突`);
      }
    }
  }
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("组合名称不能为空");
  return { name: normalizedName, memberPlanIds, plans, weekdays: plans[0].weekdays };
}

export function createGroup(name: string, memberPlanIds: string[]): BookingGroup {
  const validated = validateGroup(name, memberPlanIds);
  const now = new Date().toISOString();
  const group: BookingGroup = { id: randomUUID(), kind: "group", name: validated.name, memberPlanIds: validated.memberPlanIds, members: validated.plans, weekdays: validated.weekdays, enabled: false, createdAt: now, updatedAt: now };
  saveGroup(group);
  return group;
}

export function updateGroup(id: string, name: string, memberPlanIds: string[]): BookingGroup {
  const current = getPlanItem(id);
  if (!current || current.kind !== "group") throw new Error("组合方案不存在");
  const validated = validateGroup(name, memberPlanIds);
  const now = new Date().toISOString();
  saveGroup({ id, kind: "group", name: validated.name, memberPlanIds: validated.memberPlanIds, members: validated.plans, weekdays: validated.weekdays, enabled: current.enabled, createdAt: current.createdAt, updatedAt: now } as BookingGroup);
  return getPlanItem(id) as BookingGroup;
}

export { deletePlan, deleteGroup, getPlan, listPlans, referencedPlanIds };
export { validatePlan };
