import type { BookingRange, DurationOptions, FloorOption, RoomTypeOption } from "../shared/types";
import { bookingDayOffsetFor } from "./config";
import { AuthService } from "./auth";
import { HduLibraryError } from "./library";

type RawFloor = Record<string, unknown>;
const durationCache = new Map<string, { expires: number; value: DurationOptions }>();

function floorsToOptions(raw: unknown[]): FloorOption[] {
  const merged = new Map<number, FloorOption>();
  for (const value of raw) {
    const item = value as RawFloor;
    const map = item.seatMap as RawFloor | undefined;
    const info = map?.info as RawFloor | undefined;
    const id = Number(info?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const titles = ((map?.POIs as RawFloor[] | undefined) || [])
      .map((seat) => String(seat.title || "").trim()).filter(Boolean);
    const previous = merged.get(id);
    merged.set(id, {
      id,
      name: String(item.roomName || previous?.name || `楼层 ${id}`),
      seatCount: new Set([...(previous?.seatTitles || []), ...titles]).size,
      seatTitles: [...new Set([...(previous?.seatTitles || []), ...titles])].sort(),
    });
  }
  return [...merged.values()].sort((a, b) => a.id - b.id);
}

export async function roomTypes(auth: AuthService): Promise<RoomTypeOption[]> {
  return (await auth.client.roomTypes()).map((item) => ({
    id: item.query,
    name: item.name,
    query: item.query,
  }));
}

export async function floors(auth: AuthService, roomQuery: string, roomType?: string): Promise<{ options: FloorOption[]; range: BookingRange }> {
  if (!roomQuery.trim()) throw new HduLibraryError("缺少房间查询参数");
  const range = await auth.client.bookingRange(roomQuery);
  const now = new Date();
  const all: unknown[] = [];
  const failures: string[] = [];
  const maxOffset = bookingDayOffsetFor(roomType);
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const lookup = new Date(now);
    lookup.setDate(lookup.getDate() + offset);
    // 图书馆只在开放时段（约 07:00-21:00）返回座位/楼层；直接用"当前时刻"
    // 在非开放时段（如凌晨）会查不到楼层。楼层清单与具体时间无关，这里固定用
    // 08:00 作为代表时段查询，未来日期即使当天 08:00 已过也不会受影响。
    lookup.setHours(8, 0, 0, 0);
    try {
      all.push(...await auth.client.floors(roomQuery, lookup, 1));
    } catch (error) {
      failures.push(`${offset}日: ${String(error)}`);
    }
  }
  const options = floorsToOptions(all);
  if (!options.length) throw new HduLibraryError(`楼层查询失败${failures.length ? `：${failures.join("；")}` : ""}`);
  return { options, range };
}

export async function durations(auth: AuthService, roomQuery: string, startHour: number, roomType?: string): Promise<DurationOptions> {
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) throw new HduLibraryError("开始时间无效");
  const key = `${roomQuery}|${roomType || ""}|${startHour}`;
  const cached = durationCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const target = new Date();
  target.setDate(target.getDate() + bookingDayOffsetFor(roomType));
  target.setHours(startHour, 0, 0, 0);
  const options: number[] = [];
  for (let hours = 1; hours <= 12; hours += 1) {
    try {
      const raw = await auth.client.floors(roomQuery, target, hours);
      if (raw.length) options.push(hours);
    } catch (error) {
      const message = String(error);
      if (/登录|失效|认证/i.test(message)) throw error;
    }
  }
  const value: DurationOptions = {
    roomQuery,
    startHour,
    options,
    source: "server-probe",
    notice: options.length ? undefined : "该开始时间暂无服务端可用时长",
  };
  durationCache.set(key, { expires: Date.now() + 60_000, value });
  return value;
}
