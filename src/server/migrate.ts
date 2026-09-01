import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta, savePlan, setMeta } from "./db";
import { appHome } from "./config";
import type { BookingPlan, Weekday } from "../shared/types";

export function migrateLegacyPlans(filePath = process.env.HDU_LEGACY_PLANS || join(appHome, "..", "config", "plans.yaml")): number {
  if (getMeta("legacy_plans_migrated") === "1" || !existsSync(filePath)) return 0;
  const text = readFileSync(filePath, "utf8");
  const migrated: BookingPlan[] = [];
  const records = text.split(/\n(?=- )/).filter(Boolean);
  for (const record of records) {
    const value = (key: string) => record.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.replace(/^['"]|['"]$/g, "").trim();
    const now = new Date().toISOString();
    if (!value("seat_num")) continue;
    migrated.push({
      id: value("plan_id") || crypto.randomUUID(),
      kind: "single",
      roomType: value("room_type") || "自习室",
      roomQuery: value("room_query") || "space_category[category_id]=1&space_category[content_id]=1",
      floorId: Number(value("floor_id") || 1),
      floorName: "",
      seatNum: value("seat_num") || "",
      fallbackSeats: [],
      startHour: Number(value("start_hour") || 8),
      durationHours: Number(value("duration_hours") || 1),
      weekdays: [1, 2, 3, 4, 5, 6, 7] as Weekday[],
      enabled: value("status") !== "disabled",
      createdAt: value("created_at") || now,
      updatedAt: now,
    });
  }
  migrated.forEach(savePlan);
  setMeta("legacy_plans_migrated", "1");
  return migrated.length;
}
