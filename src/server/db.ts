import { Database } from "bun:sqlite";
import type { BookingPlan, Weekday } from "../shared/types";
import { databasePath } from "./config";

export const db = new Database(databasePath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'single',
    name TEXT,
    room_type TEXT NOT NULL,
    room_query TEXT NOT NULL,
    floor_id INTEGER NOT NULL,
    floor_name TEXT NOT NULL DEFAULT '',
    seat_num TEXT NOT NULL,
    fallback_seats TEXT NOT NULL DEFAULT '[]',
    start_hour INTEGER NOT NULL,
    duration_hours INTEGER NOT NULL,
    weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    uid TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    cookies TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (group_id, plan_id),
    FOREIGN KEY (group_id) REFERENCES plans(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
  );
`);
for (const statement of [
  "ALTER TABLE plans ADD COLUMN kind TEXT NOT NULL DEFAULT 'single'",
  "ALTER TABLE plans ADD COLUMN name TEXT",
]) {
  try { db.exec(statement); } catch { /* column already exists */ }
}

const rowToPlan = (row: Record<string, unknown>): BookingPlan => ({
  id: String(row.id),
  kind: "single",
  roomType: String(row.room_type),
  roomQuery: String(row.room_query),
  floorId: Number(row.floor_id),
  floorName: String(row.floor_name || ""),
  seatNum: String(row.seat_num),
  fallbackSeats: JSON.parse(String(row.fallback_seats || "[]")),
  startHour: Number(row.start_hour),
  durationHours: Number(row.duration_hours),
  weekdays: JSON.parse(String(row.weekdays || "[1,2,3,4,5,6,7]")) as Weekday[],
  enabled: Boolean(row.enabled),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export function listPlans(): BookingPlan[] {
  return db.query("SELECT * FROM plans WHERE kind = 'single' ORDER BY created_at ASC").all().map((row) => rowToPlan(row as Record<string, unknown>));
}

export function getPlan(id: string): BookingPlan | undefined {
  const row = db.query("SELECT * FROM plans WHERE id = ?1 AND kind = 'single'").get(id);
  return row ? rowToPlan(row as Record<string, unknown>) : undefined;
}

export function savePlan(plan: BookingPlan): BookingPlan {
  db.query(`
    INSERT INTO plans (id, kind, room_type, room_query, floor_id, floor_name, seat_num, fallback_seats,
      start_hour, duration_hours, weekdays, enabled, created_at, updated_at)
    VALUES (?1, 'single', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    ON CONFLICT(id) DO UPDATE SET kind='single', room_type=excluded.room_type, room_query=excluded.room_query,
      floor_id=excluded.floor_id, floor_name=excluded.floor_name, seat_num=excluded.seat_num,
      fallback_seats=excluded.fallback_seats, start_hour=excluded.start_hour,
      duration_hours=excluded.duration_hours, weekdays=excluded.weekdays, enabled=excluded.enabled,
      updated_at=excluded.updated_at
  `).run(
    plan.id, plan.roomType, plan.roomQuery, plan.floorId, plan.floorName || "", plan.seatNum,
    JSON.stringify(plan.fallbackSeats), plan.startHour, plan.durationHours,
    JSON.stringify(plan.weekdays), plan.enabled ? 1 : 0, plan.createdAt, plan.updatedAt,
  );
  return plan;
}

export function listGroups(): Array<Record<string, unknown>> {
  return db.query("SELECT * FROM plans WHERE kind = 'group' ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
}

export function getGroupMembers(groupId: string): string[] {
  return (db.query("SELECT plan_id FROM group_members WHERE group_id = ?1 ORDER BY position ASC").all(groupId) as Array<{ plan_id: string }>).map((row) => row.plan_id);
}

export function saveGroup(group: { id: string; name: string; memberPlanIds: string[]; weekdays: Weekday[]; enabled: boolean; createdAt: string; updatedAt: string }): void {
  const transaction = db.transaction(() => {
    db.query(`INSERT INTO plans (id, kind, name, room_type, room_query, floor_id, seat_num, weekdays, enabled, created_at, updated_at)
      VALUES (?1, 'group', ?2, '', '', 0, '', ?3, ?4, ?5, ?6)
      ON CONFLICT(id) DO UPDATE SET kind='group', name=excluded.name, weekdays=excluded.weekdays,
      enabled=excluded.enabled, updated_at=excluded.updated_at`).run(
      group.id, group.name, JSON.stringify(group.weekdays), group.enabled ? 1 : 0, group.createdAt, group.updatedAt,
    );
    db.query("DELETE FROM group_members WHERE group_id = ?1").run(group.id);
    group.memberPlanIds.forEach((planId, position) => db.query(
      "INSERT INTO group_members(group_id,plan_id,position) VALUES(?1,?2,?3)",
    ).run(group.id, planId, position));
  });
  transaction();
}

export function deleteGroup(id: string): boolean {
  return db.query("DELETE FROM plans WHERE id = ?1 AND kind = 'group'").run(id).changes > 0;
}

export function referencedPlanIds(id: string): string[] {
  return (db.query("SELECT group_id FROM group_members WHERE plan_id = ?1").all(id) as Array<{ group_id: string }>).map((row) => row.group_id);
}

export function setOnlyEnabled(id: string, enabled: boolean): string[] {
  const transaction = db.transaction(() => {
    const disabled = (db.query("SELECT id FROM plans WHERE enabled = 1 AND id <> ?1").all(id) as Array<{ id: string }>).map((row) => row.id);
    if (enabled) db.query("UPDATE plans SET enabled = 0 WHERE id <> ?1").run(id);
    db.query("UPDATE plans SET enabled = ?1 WHERE id = ?2").run(enabled ? 1 : 0, id);
    return disabled;
  });
  return transaction();
}

export function deletePlan(id: string): boolean {
  return db.query("DELETE FROM plans WHERE id = ?1 AND kind = 'single'").run(id).changes > 0;
}

export function setMeta(key: string, value: string): void {
  db.query("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getMeta(key: string): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?1").get(key) as { value?: string } | null;
  return row?.value;
}

export function writeAudit(event: string, payload: Record<string, unknown>): void {
  db.query("INSERT INTO audit(event,payload,created_at) VALUES(?1,?2,?3)").run(
    event, JSON.stringify(payload), new Date().toISOString(),
  );
}

export type AuditRecord = {
  id: number;
  event: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function listAudit(limit = 20): AuditRecord[] {
  const rows = db.query(
    "SELECT id, event, payload, created_at FROM audit ORDER BY created_at DESC, id DESC LIMIT ?1",
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    event: String(row.event),
    payload: JSON.parse(String(row.payload || "{}")) as Record<string, unknown>,
    createdAt: String(row.created_at),
  }));
}
