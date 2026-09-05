import type { BookingRange, DurationOptions, FloorOption, RoomTypeOption } from "../shared/types";
import { bookingDayOffsetFor } from "./config";
import { AuthService } from "./auth";
import { HduLibraryError } from "./library";

type RawFloor = Record<string, unknown>;

export function floorToOption(value: unknown): FloorOption | undefined {
  const item = value as RawFloor;
  const map = item.seatMap as RawFloor | undefined;
  const id = Number((map?.info as RawFloor | undefined)?.id);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const seatTitles = ((map?.POIs as RawFloor[] | undefined) || [])
    .map((seat) => String(seat.title || "").trim())
    .filter(Boolean);
  const uniqueSeatTitles = [...new Set(seatTitles)].sort();
  return {
    id,
    name: String(item.roomName || `楼层 ${id}`),
    seatCount: uniqueSeatTitles.length,
    seatTitles: uniqueSeatTitles,
  };
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
  const maxOffset = bookingDayOffsetFor(roomType);
  const lookup = new Date(now);
  lookup.setDate(lookup.getDate() + maxOffset);
  lookup.setHours(8, 0, 0, 0);
  const options = (await auth.client.floors(roomQuery, lookup, 1))
    .map(floorToOption)
    .filter((option): option is FloorOption => Boolean(option));
  if (!options.length) throw new HduLibraryError("该房间类型当前没有可预约楼层（可能尚未开放预约，请尝试其他房间类型）");
  return { options, range };
}

export async function durations(auth: AuthService, roomQuery: string, startHour: number, roomType?: string): Promise<DurationOptions> {
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) throw new HduLibraryError("开始时间无效");
  const range = await auth.client.bookingRange(roomQuery);
  const options: number[] = [];
  for (let hours = range.minDuration; hours <= range.maxDuration; hours += 1) options.push(hours);
  const value: DurationOptions = {
    roomQuery,
    startHour,
    options,
  };
  return value;
}
