import { createCipheriv } from "node:crypto";
import { CookieJar } from "./cookies";
import { db } from "./db";
import { LibraryClient } from "./library";
import type { SessionStatus } from "../shared/types";

const LOGIN_ENTRY = "https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin";
const SSO_BASE = "https://sso.hdu.edu.cn";
const SSO_LOGIN_PAGE = `${SSO_BASE}/login?service=${encodeURIComponent(LOGIN_ENTRY)}`;
const SSO_CSRF_SCRIPT = `${SSO_BASE}/public/utils/loginNew.js`;
const SSO_CSRF_KEY = "FzgxPikIetYDlXZM4lRG9taclVDa99lB";
const SSO_CSRF_VALUE = "7964f321f00366a3a287a133dd307ed0";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

// SSO's QR scan endpoint long-polls until the code is scanned. Bound the wait so the
// local status endpoint returns promptly instead of hanging (which made the Tauri
// webview fetch time out and surface "无法连接本地后台服务").
const QR_SCAN_TIMEOUT_MS = 2500;
// QR 轮询单次会话的最大轮询时长（秒）：超时后服务端判定该码已失效，客户端应换新码。
const QR_POLL_SESSION_TTL_S = 90;
// 局域网或本地后端出现瞬时网络抖动时，服务端允许短时重试，避免把一次抖动误判成“二维码异常”。
const QR_STATUS_RETRIES = 2;

type SsoResponseBody = { code?: number; message?: string; data?: unknown; dataErrorMessage?: string };
type QrLoginStatusResult = {
  status: "waiting" | "confirmed" | "expired" | "error";
  ttlSeconds: number;
  message?: string;
  session?: SessionStatus;
};

// SSO 二维码轮询循环：未扫码时服务端在长轮询窗口内只返回“wait”；
// 若手机已扫码并确认，则返回一个授权 token。扫码与确认之间的中间态被 SSO 折叠，
// 因此对客户端而言状态只有“未完成(等待/已扫待确认)”与“已确认”两种可观察结果。
// 后端用“本轮内是否等满一个长轮询周期且仍未变化”来区分：
//   - 尚未扫到 → 返回 waiting（客户端静默保持当前二维码）
//   - 轮询周期已过（SSO 侧该码大概率已失效）→ 返回 expired（客户端应换新码）
// 已确认则直接完成登录并返回 confirmed。
const QR_POLL_ROUND_MS = 30_000;

function encryptPassword(keyBase64: string, password: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const remainder = Buffer.byteLength(password) % 16;
  const padding = 16 - remainder;
  const padded = Buffer.concat([Buffer.from(password), Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

export class AuthService {
  private credentials: { studentId: string; password: string } | undefined;
  private csrf: { key: string; value: string } = { key: SSO_CSRF_KEY, value: SSO_CSRF_VALUE };
  readonly client: LibraryClient;

  constructor() {
    const row = db.query("SELECT cookies, uid, name, student_id, password FROM session WHERE id = 1").get() as { cookies?: string; uid?: string; name?: string; student_id?: string; password?: string } | null;
    if (row?.student_id && row.password) this.credentials = { studentId: row.student_id, password: row.password };
    const jar = new CookieJar(row?.cookies ? JSON.parse(row.cookies) : []);
    this.client = new LibraryClient({
      jar,
      onJarChange: async (next) => {
        db.query("INSERT INTO session(id,cookies,uid,name,updated_at) VALUES(1,?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET cookies=excluded.cookies,updated_at=excluded.updated_at")
          .run(JSON.stringify(next.all), this.client.uid, this.client.name, new Date().toISOString());
      },
      onAuthExpired: async () => this.refresh(),
    });
    this.client.uid = row?.uid || "";
    this.client.name = row?.name || "";
  }

  get authenticated(): boolean { return Boolean(this.client.uid); }
  status(): SessionStatus { return { authenticated: this.authenticated, uid: this.client.uid || undefined, name: this.client.name || undefined, refreshing: false }; }

  private async followRedirects(url: string, init: RequestInit = {}): Promise<Response> {
    let currentUrl = url;
    let currentInit: RequestInit = { ...init, redirect: "manual" };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const requestHeaders = new Headers(currentInit.headers);
      const cookie = this.client.jar.headerFor(currentUrl);
      if (cookie) requestHeaders.set("Cookie", cookie);
      const response = await fetch(currentUrl, { ...currentInit, headers: requestHeaders, redirect: "manual" });
      if (this.client.jar.merge(response.headers, currentUrl)) {
        await this.client["options"]?.onJarChange?.(this.client.jar);
      }
      const location = response.headers.get("location");
      if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
      currentUrl = new URL(location, currentUrl).toString();
      currentInit = response.status === 303 || (response.status === 302 && currentInit.method === "POST")
        ? { method: "GET" }
        : currentInit;
    }
    throw new Error("SSO 重定向次数过多");
  }

  async restore(): Promise<boolean> {
    if (await this.client.validate()) return true;
    if (this.credentials) return this.refresh();
    return false;
  }

  async login(studentId: string, password: string): Promise<{ success: boolean; message: string }> {
    if (!studentId.trim() || !password) return { success: false, message: "请输入学号和密码" };
    this.credentials = { studentId, password };
    // The HTTP SSO flow is intentionally isolated here so the session client
    // can refresh without ever replaying side-effecting booking requests.
    try {
      const response = await this.followRedirects(LOGIN_ENTRY, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) return { success: false, message: `登录入口不可用: ${response.status}` };
      const html = await response.text();
      const key = html.match(/id=["']login-croypto["'][^>]*>([^<]+)</i)?.[1]?.trim()
        || html.match(/id=["']login-croypto["'][^>]*value=["']([^"']+)/i)?.[1];
      const execution = html.match(/id=["']login-page-flowkey["'][^>]*>([^<]+)</i)?.[1]?.trim()
        || html.match(/name=["']execution["'][^>]*value=["']([^"']+)/i)?.[1];
      const action = html.match(/<form[^>]+id=["']normalLoginForm["'][^>]+action=["']([^"']+)/i)?.[1] || "/login";
      if (!key || !execution) return { success: false, message: "SSO 页面缺少登录参数" };
      const form = new URLSearchParams({
        username: studentId,
        type: "UsernamePassword",
        _eventId: "submit",
        execution,
        croypto: key,
        password: encryptPassword(key, password),
        captcha_payload: encryptPassword(key, "{}"),
      });
      const loginResponse = await this.followRedirects(new URL(action, response.url).toString(), {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      if (loginResponse.url.includes("sso.hdu.edu.cn")) {
        return { success: false, message: "SSO 登录失败，请核对凭据或稍后重试" };
      }
      await this.client.validate();
      if (!this.client.uid) return { success: false, message: "Cookie 无效或登录态未生效" };
      await db.query("INSERT INTO session(id,cookies,uid,name,student_id,password,updated_at) VALUES(1,?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET cookies=excluded.cookies,uid=excluded.uid,name=excluded.name,student_id=excluded.student_id,password=excluded.password,updated_at=excluded.updated_at")
        .run(JSON.stringify(this.client.jar.all), this.client.uid, this.client.name, studentId, password, new Date().toISOString());
      return { success: true, message: `认证成功${this.client.name ? `：${this.client.name}` : ""}` };
    } catch (error) {
      return { success: false, message: `登录请求失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async loadCsrf(): Promise<void> {
    try {
      const response = await fetch(SSO_CSRF_SCRIPT, {
        headers: { Accept: "application/javascript, text/javascript, */*", "User-Agent": USER_AGENT },
      });
      if (!response.ok) return;
      const script = await response.text();
      const key = script.match(/Csrf-Key['"]?\s*,\s*['"]([^'"]+)['"]/)?.[1];
      const value = script.match(/Csrf-Value['"]?\s*,\s*['"]([^'"]+)['"]/)?.[1];
      if (key && value) this.csrf = { key, value };
    } catch { /* 使用随发布脚本一致的默认值 */ }
  }

  private ssoHeaders(referer: string): HeadersInit {
    return {
      Accept: "application/json, text/plain, */*",
      "User-Agent": USER_AGENT,
      Origin: SSO_BASE,
      Referer: referer,
      "Csrf-Key": this.csrf.key,
      "Csrf-Value": this.csrf.value,
    };
  }

  private async ensureSsoPage(): Promise<string> {
    const response = await this.followRedirects(SSO_LOGIN_PAGE, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`SSO 页面不可用: ${response.status}`);
    await response.text();
    await this.loadCsrf();
    return response.url;
  }

  private async readSsoJson(response: Response): Promise<SsoResponseBody> {
    const body = await response.json() as SsoResponseBody;
    // SSO 用 408/wait 表示“已完成一个长轮询周期且码未变化”，
    // 保留该语义，调用方据此判定该码已失效（而非“仍在等待”）。
    if (body.code !== 200) throw new Error(String(body.message || "SSO 接口返回异常"));
    return body;
  }

  async createQrLogin(): Promise<{ uuid: string; image: string; ttlSeconds: number }> {
    const referer = await this.ensureSsoPage();
    const response = await this.followRedirects(`${SSO_BASE}/api/protected/qrlogin/loginid?${Date.now()}`, {
      headers: this.ssoHeaders(referer),
    });
    if (!response.ok) throw new Error(`二维码 ID 请求失败: ${response.status}`);
    const body = await this.readSsoJson(response);
    const uuid = typeof body.data === "string" && body.data ? body.data : "";
    if (!uuid) throw new Error("二维码 ID 无效");

    const imageResponse = await this.followRedirects(`${SSO_BASE}/api/public/qrlogin/qrgen/${encodeURIComponent(uuid)}/dingDingQr?t=${Date.now()}`, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": USER_AGENT,
        Referer: referer,
      },
    });
    if (!imageResponse.ok) throw new Error(`二维码生成失败: ${imageResponse.status}`);
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    if (!buffer.length) throw new Error("二维码内容为空");
    // SSO 未返回二维码有效期，但长轮询周期为 30s，到期返回 wait 后 SSO 侧会作废旧码。
    // 据此给客户端一个合理的安全窗口，并预留提前刷新时间。
    return {
      uuid,
      image: `data:image/png;base64,${buffer.toString("base64")}`,
      ttlSeconds: QR_POLL_SESSION_TTL_S,
    };
  }

  private async completeQrLogin(token: string): Promise<void> {
    if (!token) throw new Error("扫码授权令牌为空");
    const form = new URLSearchParams({ [token]: "login" });
    const response = await this.followRedirects(SSO_LOGIN_PAGE, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: SSO_BASE,
        Referer: SSO_LOGIN_PAGE,
      },
      body: form,
    });
    if (response.url.includes(SSO_BASE) && !response.url.includes("huitu.zhishulib.com")) {
      throw new Error("扫码登录未完成，请重新扫码");
    }
    await this.client.validate();
    if (!this.client.uid) throw new Error("扫码登录后 Cookie 无效");

    const row = db.query("SELECT student_id, password FROM session WHERE id = 1").get() as { student_id?: string; password?: string } | null;
    await db.query("INSERT INTO session(id,cookies,uid,name,student_id,password,updated_at) VALUES(1,?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET cookies=excluded.cookies,uid=excluded.uid,name=excluded.name,student_id=excluded.student_id,password=excluded.password,updated_at=excluded.updated_at")
      .run(
        JSON.stringify(this.client.jar.all),
        this.client.uid,
        this.client.name,
        row?.student_id || "",
        row?.password || "",
        new Date().toISOString(),
      );
  }

  async pollQrLogin(uuid: string): Promise<QrLoginStatusResult> {
    if (!uuid) return { status: "error", message: "二维码 ID 缺失", ttlSeconds: QR_POLL_SESSION_TTL_S };
    const sessionBudget = Date.now() + QR_POLL_SESSION_TTL_S * 1000;
    try {
      // 单个二维码的总轮询预算：超时后即使 SSO 尚未明确报错，也判定该码已失效。
      while (Date.now() < sessionBudget) {
        const remaining = sessionBudget - Date.now();
        const round = Math.min(QR_POLL_ROUND_MS, Math.max(QR_SCAN_TIMEOUT_MS, remaining));
        const result = await this.pollQrRound(uuid, round);
        if (result) return result;
      }
      return { status: "expired", message: "二维码已过期，请刷新", ttlSeconds: QR_POLL_SESSION_TTL_S };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("expired") || message.includes("过期")) {
        return { status: "expired", message: "二维码已过期，请刷新", ttlSeconds: QR_POLL_SESSION_TTL_S };
      }
      return { status: "error", message, ttlSeconds: QR_POLL_SESSION_TTL_S };
    }
  }

  /**
   * 单轮长轮询：最多等 roundMs 毫秒。SSO 在未扫码时会在约 30s 后返回 wait，
   * 我们用 QR_SCAN_TIMEOUT_MS 截断避免本地请求挂太久，并区分：
   *  - 截断（AbortError）→ 仍未变化，返回 null（外层继续等）
   *  - 返回 wait / 408 → SSO 已完成一个长轮询周期，判定该码失效 → expired
   *  - 返回授权 token → 完成登录 → confirmed
   */
  private async pollQrRound(uuid: string, roundMs: number): Promise<QrLoginStatusResult | null> {
    const referer = await this.ensureSsoPage();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), roundMs);
    let lastError: Error | undefined;
    try {
      for (let attempt = 0; attempt <= QR_STATUS_RETRIES; attempt += 1) {
        try {
          const response = await this.followRedirects(`${SSO_BASE}/api/protected/qrlogin/scan/${encodeURIComponent(uuid)}?${Date.now()}`, {
            headers: this.ssoHeaders(referer),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`扫码状态请求失败: ${response.status}`);
          const body = await this.readSsoJson(response);
          // 返回授权 token：扫码已确认，完成登录。
          if (typeof body.data === "string" && body.data) {
            await this.completeQrLogin(body.data);
            return { status: "confirmed", session: this.status(), ttlSeconds: QR_POLL_SESSION_TTL_S };
          }
          // 显式 wait：SSO 已完成一个长轮询周期且码未变，判定失效，客户端应换新码。
          return { status: "expired", message: "二维码已过期，请刷新", ttlSeconds: QR_POLL_SESSION_TTL_S };
        } catch (error) {
          if (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))) {
            return null; // 本轮未变化，继续等待
          }
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < QR_STATUS_RETRIES) continue;
        }
      }
      throw lastError || new Error("扫码状态请求失败");
    } finally {
      clearTimeout(timer);
    }
  }

  logout(): void {
    this.client.uid = "";
    this.client.name = "";
    this.client.jar.clear();
    db.query("UPDATE session SET uid = '', name = '', cookies = '[]', updated_at = ?1 WHERE id = 1")
      .run(new Date().toISOString());
  }

  async refresh(): Promise<boolean> {
    if (!this.credentials) return false;
    const result = await this.login(this.credentials.studentId, this.credentials.password);
    return result.success;
  }
}
