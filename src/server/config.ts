import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const appHome = process.env.HDU_SNIPER_HOME || join(homedir(), ".hdu-library-sniper");
export const dataDir = join(appHome, "data");
mkdirSync(dataDir, { recursive: true });
export const databasePath = join(dataDir, "hdu-sniper.sqlite");
export const port = Number(process.env.HDU_WEB_PORT || 8000);
export const timezone = "Asia/Shanghai";
export const bookingDayOffset = 2;

// 自习室等一般只能提前一天预约，其他类型房间提前两天开放。
export function bookingDayOffsetFor(roomType?: string): number {
  return roomType && /自习/.test(roomType) ? 1 : bookingDayOffset;
}
