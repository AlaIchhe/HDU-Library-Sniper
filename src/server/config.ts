import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const appHome = process.env.HDU_SNIPER_HOME || join(homedir(), ".hdu-library-sniper");
export const dataDir = join(appHome, "data");
mkdirSync(dataDir, { recursive: true });
export const databasePath = join(dataDir, "hdu-sniper.sqlite");
export const port = Number(process.env.HDU_WEB_PORT || 8000);
export const timezone = "Asia/Shanghai";
export const bookingDayOffset = 2;

// 仅生活区提前一天开放预约，其余房型（含自习室）提前两天。
export function bookingDayOffsetFor(roomType?: string): number {
  return roomType && /生活区/.test(roomType) ? 1 : bookingDayOffset;
}

// 馆方在每天 20:00（Asia/Shanghai）开放新一日的预约窗口，抢座锚定这个整点。
const bookingAnchorSeconds = 20 * 3600;

// 当天 20:00 未到则等到 20:00；已过（含整点瞬间）则等明天的 20:00。
export function bookingAnchorDelaySeconds(secondsOfDay: number): number {
  let delay = bookingAnchorSeconds - secondsOfDay;
  if (delay <= 0) delay += 24 * 3600;
  return delay;
}

// 上海时区的「当日秒数」——20:00 锚点的换算、签到窗口判断都以此为准，
// 不受容器 TZ 影响。
export function shanghaiSecondsOfDay(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return value("hour") * 3600 + value("minute") * 60 + value("second");
}

// 下一次 20:00 抢座锚点：后台真正发请求的时刻。
// 它是「执行时刻」，与 bookingDayOffsetFor 的「预约目标日」不是一回事，
// 混用会把展示出来的下一次动作整整推后 1~2 天。
export function nextBookingAnchor(now: Date = new Date()): Date {
  return new Date(now.getTime() + bookingAnchorDelaySeconds(shanghaiSecondsOfDay(now)) * 1000);
}

// 预约开放前先预锁的提前量。窗口必须远小于馆方 15 分钟释放时间。
export const bookingPrelockLeadSeconds = 60;

// 返回距离下一次预锁的秒数：预约前进入窗口则立即预锁，已过预约锚点则等明天。
export function bookingPrelockDelaySeconds(
  secondsOfDay: number,
  leadSeconds = bookingPrelockLeadSeconds,
): number {
  const anchorDelay = bookingAnchorDelaySeconds(secondsOfDay);
  const anchorAt = secondsOfDay + anchorDelay;
  return Math.max(0, anchorAt - leadSeconds - secondsOfDay);
}
