import { createHash } from "node:crypto";
import { CookieJar } from "./cookies";

const BASE = "https://hdu.huitu.zhishulib.com";
const ACTION_ENDPOINTS = {
  cancel: "/Seat/Index/cancelBooking",
  checkIn: "/Seat/Index/checkIn",
  comeBack: "/Seat/Index/comeBack",
  checkOut: "/Seat/Index/checkOut",
};

export class AuthenticationExpiredError extends Error {}
export class HduLibraryError extends Error {}
export class RequestTimeoutError extends HduLibraryError {}

export function apiToken(seatId: string, uid: string, beginTime: number, duration: number, apiTime = Math.floor(Date.now() / 1000)): string {
  const source = `post&/Seat/Index/bookSeats?LAB_JSON=1&api_time${apiTime}&beginTime${beginTime}&duration${duration}&is_recommend1&seatBookers[0]${uid}&seats[0]${seatId}`;
  return btoa(createHash("md5").update(source).digest("hex"));
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
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      throw new HduLibraryError("慧图响应格式无效");
    }
    // 慧图未登录时返回 com.Redirect 到 CAS 登录页；这是登录态失效的真实契约。
    const href = String(body.href || "");
    if (body.ui_type === "com.Redirect" && href.includes("/User/Index/hduCASLogin")) {
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
      const body = await this.request("/User/Center/baseInfo", {}, false);
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
    const children = Array.isArray(content?.children) ? (content!.children as Record<string, unknown>[]) : [];
    const items = children[1]?.defaultItems;
    if (!Array.isArray(items)) throw new HduLibraryError("房间类型解析失败");
    return items.map((item) => {
      const value = item as Record<string, unknown>;
      const url = String((value.link as Record<string, unknown> | undefined)?.url || "");
      const query = url.split("?")[1] || "";
      if (!query) throw new HduLibraryError("房间类型链接解析失败");
      return { name: String(value.name || ""), query: decodeURIComponent(query) };
    });
  }

  async bookingRange(roomQuery: string): Promise<{ minBeginTime: number; maxEndTime: number; minDuration: number; maxDuration: number }> {
    const detail = await this.request(`/Seat/Index/searchSeats?${roomQuery}&LAB_JSON=1`);
    const data = detail.data as Record<string, unknown> | undefined;
    const range = data?.range as Record<string, unknown> | undefined;
    if (!range) throw new HduLibraryError("预约时间范围解析失败");
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
    const allContent = map.allContent as Record<string, unknown> | undefined;
    const container = ((allContent?.children as unknown[] | undefined)?.[2] as Record<string, unknown> | undefined);
    const floors = ((container?.children as Record<string, unknown> | undefined)?.children as unknown[] | undefined);
    if (!Array.isArray(floors)) throw new HduLibraryError("座位图解析失败");
    return floors;
  }

  private async lookupCategory(roomQuery: string): Promise<{ category_id: string; content_id: string }> {
    const detail = await this.request(`/Seat/Index/searchSeats?${roomQuery}&LAB_JSON=1`);
    const data = detail.data as Record<string, unknown> | undefined;
    const category = data?.space_category as Record<string, unknown> | undefined;
    if (!category?.category_id) throw new HduLibraryError("房间详情解析失败");
    return {
      category_id: String(category.category_id),
      content_id: String(category.content_id || ""),
    };
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
    // LAB_JSON=1 是慧图 xH 请求的默认契约，Api-Token 签名串也按该形式计算。
    return this.request("/Seat/Index/bookSeats?LAB_JSON=1", {
      method: "POST",
      headers: { "Api-Token": apiToken(seatId, this.uid, begin, duration, apiTime) },
      body: payload,
    });
  }

  private assertActionSuccess(body: Record<string, unknown>): void {
    const data = body.DATA as Record<string, unknown> | undefined;
    if (String(body.CODE).toLowerCase() !== "ok" || String(data?.result).toLowerCase() !== "success") {
      // 慧图前端契约：CODE != ok 读顶层 MESSAGE；CODE = ok 但 result != success 读 DATA.msg。
      throw new HduLibraryError(String(data?.msg || body.MESSAGE || "操作失败"));
    }
  }

  async action(kind: "cancel" | "checkIn" | "comeBack" | "leave" | "signOut", bookingId: string): Promise<Record<string, unknown>> {
    const encodedId = encodeURIComponent(bookingId);
    // 前端请求拦截器默认给所有 xH 请求追加 LAB_JSON=1。
    if (kind === "leave") {
      const latest = await this.request(
        `/Seat/Index/stepOutLatestComeBackTime?bookingId=${encodedId}&LAB_JSON=1`,
        { method: "POST" },
      );
      this.assertActionSuccess(latest);
      const latestData = latest.DATA as Record<string, unknown> | undefined;
      const comeBackTime = Number(latestData?.latest_come_back_time || 0);
      if (!Number.isFinite(comeBackTime) || comeBackTime <= 0) {
        throw new HduLibraryError("无法获取暂离返回时间");
      }

      // 前端由用户在弹出层中选择返回时间；本地后端无交互时选择服务端给出的最晚时间。
      const body = await this.request(
        `/Seat/Index/stepOut?bookingId=${encodedId}&LAB_JSON=1`,
        { method: "POST", body: new URLSearchParams({ comeBackTime: String(comeBackTime) }) },
      );
      this.assertActionSuccess(body);
      return body;
    }

    const endpoint = kind === "signOut" ? "checkOut" : kind;
    const body = await this.request(`${ACTION_ENDPOINTS[endpoint]}?bookingId=${encodedId}&LAB_JSON=1`, { method: "POST" });
    this.assertActionSuccess(body);
    return body;
  }
}
