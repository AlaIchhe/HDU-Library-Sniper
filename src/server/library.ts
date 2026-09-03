import { createHash } from "node:crypto";
import { CookieJar } from "./cookies";

const BASE = "https://hdu.huitu.zhishulib.com";
const URLS = {
  baseInfo: `${BASE}/User/Center/baseInfo`,
  rooms: `${BASE}/Space/Category/list`,
  seats: `${BASE}/Seat/Index/searchSeats`,
  bookings: `${BASE}/Seat/Index/myBookingList?fromType=web`,
  book: `${BASE}/Seat/Index/bookSeats`,
  cancel: `${BASE}/Seat/Index/cancelBooking`,
  checkIn: `${BASE}/Seat/Index/checkIn`,
  comeBack: `${BASE}/Seat/Index/comeBack`,
  leave: `${BASE}/Seat/Index/leave`,
  signOut: `${BASE}/Seat/Index/signOut`,
};

export class AuthenticationExpiredError extends Error {}
export class HduLibraryError extends Error {}
export class RequestTimeoutError extends HduLibraryError {}

export function apiToken(seatId: string, uid: string, beginTime: number, duration: number, apiTime = Math.floor(Date.now() / 1000)): string {
  const source = `post&/Seat/Index/bookSeats?LAB_JSON=1&api_time${apiTime}&beginTime${beginTime}&duration${duration}&is_recommend1&seatBookers[0]${uid}&seats[0]${seatId}`;
  return btoa(createHash("md5").update(source).digest("hex"));
}

// 楼层（含 seatMap.info.id / POIs）在返回树中的嵌套层级不固定，
// 这里递归收集所有符合条件的节点，避免因层级或索引变化导致楼层显示为空。
function collectFloorNodes(node: unknown, out: unknown[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectFloorNodes(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const map = record.seatMap as Record<string, unknown> | undefined;
  const info = map?.info as Record<string, unknown> | undefined;
  if (map && info && Number.isInteger(Number(info.id)) && Number(info.id) > 0) {
    out.push(record);
    return;
  }
  for (const value of Object.values(record)) collectFloorNodes(value, out);
}

const headers = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
  Origin: BASE,
  Referer: `${BASE}/`,
  "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
};

export type LibraryClientOptions = {
  jar?: CookieJar;
  onJarChange?: (jar: CookieJar) => Promise<void> | void;
  onAuthExpired?: () => Promise<boolean>;
};

export class LibraryClient {
  readonly jar: CookieJar;
  uid = "";
  name = "";
  private refreshPromise: Promise<boolean> | undefined;

  constructor(readonly options: LibraryClientOptions = {}) {
    this.jar = options.jar || new CookieJar();
  }

  private async request(path: string, init: RequestInit = {}, retry = true): Promise<Record<string, unknown>> {
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
    const requestHeaders = new Headers(headers);
    const cookie = this.jar.headerFor(url);
    if (cookie) requestHeaders.set("Cookie", cookie);
    if (init.headers) new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers: requestHeaders, signal: init.signal || AbortSignal.timeout(30_000) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new RequestTimeoutError("请求超时");
      throw new HduLibraryError(`请求失败: ${String(error)}`);
    }
    if (this.jar.merge(response.headers, url)) await this.options.onJarChange?.(this.jar);
    if (!response.ok) throw new HduLibraryError(`请求失败: HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      const preview = (await response.text()).replace(/\s+/g, " ").slice(0, 160);
      throw new HduLibraryError(`慧图返回非 JSON 响应: ${preview}`);
    }
    const body = await response.json() as Record<string, unknown>;
    // 慧图在登录失效/未登录时返回 com.Redirect 重定向 JSON，而不是 is_login=false。
    // 将其识别为登录态失效，触发重登而不是静默返回空数据。
    if (String((body as Record<string, unknown>).ui_type || "") === "com.Redirect") {
      if (retry && await this.refreshAuth()) return this.request(path, init, false);
      throw new AuthenticationExpiredError("图书馆登录状态已失效");
    }
    const loginData = (body.DATA || body.data) as Record<string, unknown> | undefined;
    if (loginData?.is_login === false) {
      if (retry && await this.refreshAuth()) return this.request(path, init, false);
      throw new AuthenticationExpiredError("图书馆登录状态已失效");
    }
    return body;
  }

  private async refreshAuth(): Promise<boolean> {
    if (!this.options.onAuthExpired) return false;
    this.refreshPromise ||= this.options.onAuthExpired().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  async validate(): Promise<boolean> {
    try {
      const body = await this.request("/User/Center/baseInfo?LAB_JSON=0", {}, false);
      const data = body.DATA as Record<string, unknown> | undefined;
      if (data?.is_login && String(data.uid || "").match(/^\d+$/)) {
        this.uid = String(data.uid);
        this.name = String((data.user_info as Record<string, unknown> | undefined)?.name || "");
        return true;
      }
    } catch { /* caller decides whether to reauthenticate */ }
    return false;
  }

  async roomTypes(): Promise<Array<{ name: string; query: string }>> {
    const body = await this.request("/Space/Category/list?LAB_JSON=1");
    const content = body.content as Record<string, unknown> | undefined;
    const children = Array.isArray(content?.children) ? (content!.children as unknown[]) : [];
    let items: unknown[] = [];
    const preferred = children[1] as Record<string, unknown> | undefined;
    if (Array.isArray(preferred?.defaultItems) && preferred.defaultItems.length) {
      items = preferred.defaultItems as unknown[];
    } else {
      for (const child of children) {
        const defaults = (child as Record<string, unknown>)?.defaultItems;
        if (Array.isArray(defaults) && defaults.length) { items = defaults; break; }
      }
    }
    return items.map((item) => {
      const value = item as Record<string, unknown>;
      const link = value.link as Record<string, unknown> | string | undefined;
      const url = typeof link === "string" ? link : String((link as Record<string, unknown>)?.url || "");
      return { name: String(value.name || ""), query: decodeURIComponent(url.split("?")[1] || "") };
    });
  }

  async bookingRange(roomQuery: string): Promise<{ minBeginTime: number; maxEndTime: number; minDuration: number; maxDuration: number }> {
    const detail = await this.request(`/Seat/Index/searchSeats?${roomQuery}&LAB_JSON=1`);
    const data = (detail.data || detail.DATA || {}) as Record<string, unknown>;
    const range = data.range as Record<string, unknown> | undefined;
    return {
      minBeginTime: Number(range?.minBeginTime ?? 0),
      maxEndTime: Number(range?.maxEndTime ?? 0),
      minDuration: Number(range?.min_duration ?? 1),
      maxDuration: Number(range?.max_duration ?? 0),
    };
  }

  async floors(roomQuery: string, lookupTime = new Date(), durationHours = 1): Promise<unknown[]> {
    const category = await this.lookupCategory(roomQuery);
    const payload = new URLSearchParams({
      beginTime: String(Math.floor(lookupTime.getTime() / 1000)),
      duration: String(durationHours * 3600),
      num: "1",
      "space_category[category_id]": String(category.category_id),
      "space_category[content_id]": String(category.content_id),
    });
    const map = await this.request("/Seat/Index/searchSeats?LAB_JSON=1", { method: "POST", body: payload });
    const floors: unknown[] = [];
    collectFloorNodes(map, floors);
    if (!floors.length) {
      // 兜底：沿用原始固定的层级路径，防止递归收集因返回结构差异而漏掉。
      const legacy = ((((map?.allContent as Record<string, unknown>)?.children as unknown[])?.[2] as Record<string, unknown>)?.children as Record<string, unknown>)?.children as unknown[] || [];
      floors.push(...legacy);
    }
    return floors;
  }

  private async lookupCategory(roomQuery: string): Promise<{ category_id: string; content_id: string }> {
    try {
      const detail = await this.request(`/Seat/Index/searchSeats?${roomQuery}&LAB_JSON=1`);
      const data = detail.data as Record<string, unknown> | undefined;
      const category = data?.space_category as Record<string, unknown> | undefined;
      if (category) {
        return {
          category_id: String(category.category_id ?? ""),
          content_id: String(category.content_id ?? ""),
        };
      }
    } catch { /* 回退到查询字符串解析 */ }
    const categoryId = roomQuery.match(/space_category\[category_id\]=([^&]+)/)?.[1];
    const contentId = roomQuery.match(/space_category\[content_id\]=([^&]+)/)?.[1];
    if (!categoryId) throw new HduLibraryError("无法解析空间分类");
    return { category_id: categoryId, content_id: contentId || "" };
  }

  async bookings(): Promise<Record<string, unknown>[]> {
    const body = await this.request("/Seat/Index/myBookingList?fromType=web&LAB_JSON=1");
    const items = (body.content as Record<string, unknown>)?.defaultItems;
    if (!Array.isArray(items)) throw new HduLibraryError("预约列表解析失败");
    return items as Record<string, unknown>[];
  }

  async bookSeat(seatId: string, beginTime: Date, durationHours: number): Promise<Record<string, unknown>> {
    if (!this.uid) throw new AuthenticationExpiredError("缺少用户 UID");
    const begin = Math.floor(beginTime.getTime() / 1000);
    const duration = durationHours * 3600;
    const apiTime = Math.floor(Date.now() / 1000);
    const payload = new URLSearchParams({
      beginTime: String(begin),
      duration: String(duration),
      is_recommend: "1",
      api_time: String(apiTime),
      "seats[0]": seatId,
      "seatBookers[0]": this.uid,
    });
    // 慧图接口需要 LAB_JSON=1 才会返回 JSON，否则返回 XHTML 登录/通用页。
    // apiToken() 的签名串按 `?LAB_JSON=1` 计算，这里必须保持一致。
    return this.request("/Seat/Index/bookSeats?LAB_JSON=1", {
      method: "POST",
      headers: { "Api-Token": apiToken(seatId, this.uid, begin, duration, apiTime) },
      body: payload,
    });
  }

  async action(kind: "cancel" | "checkIn" | "comeBack" | "leave" | "signOut", bookingId: string): Promise<Record<string, unknown>> {
    const body = await this.request(`${URLS[kind].replace(BASE, "")}?bookingId=${encodeURIComponent(bookingId)}`, { method: "POST" });
    const data = body.DATA as Record<string, unknown> | undefined;
    if (String(body.CODE).toLowerCase() !== "ok" || String(data?.result).toLowerCase() !== "success") {
      throw new HduLibraryError(String(body.MESSAGE || "操作失败"));
    }
    return body;
  }
}
