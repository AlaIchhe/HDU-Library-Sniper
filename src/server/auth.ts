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

type SsoResponseBody = { code?: number; message?: string; data?: unknown; dataErrorMessage?: string };

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
    if (body.code === 408 || body.data === "wait") return { ...body, code: 200, data: "" };
    if (body.code !== 200) throw new Error(String(body.message || "SSO 接口返回异常"));
    return body;
  }

  async createQrLogin(): Promise<{ uuid: string; image: string }> {
    const referer = await this.ensureSsoPage();
    const response = await this.followRedirects(`${SSO_BASE}/api/protected/qrlogin/loginid?${Date.now()}`, {
      headers: this.ssoHeaders(referer),
    });
    if (!response.ok) throw new Error(`二维码 ID 请求失败: ${response.status}`);
    const body = await this.readSsoJson(response);
    const uuid = typeof body.data === "string" && body.data ? body.data : "";
    if (!uuid) throw new Error("二维码 ID 无效");

    const imageResponse = await this.followRedirects(`${SSO_BASE}/api/public/qrlogin/qrgen/${encodeURIComponent(uuid)}/corpwechatQr?t=${Date.now()}`, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": USER_AGENT,
        Referer: referer,
      },
    });
    if (!imageResponse.ok) throw new Error(`二维码生成失败: ${imageResponse.status}`);
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    if (!buffer.length) throw new Error("二维码内容为空");
    return { uuid, image: `data:image/png;base64,${buffer.toString("base64")}` };
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

  async pollQrLogin(uuid: string): Promise<{ status: "waiting" | "confirmed" | "expired" | "error"; message?: string; session?: SessionStatus }> {
    if (!uuid) return { status: "error", message: "二维码 ID 缺失" };
    try {
      const referer = await this.ensureSsoPage();
      const response = await this.followRedirects(`${SSO_BASE}/api/protected/qrlogin/scan/${encodeURIComponent(uuid)}?${Date.now()}`, {
        headers: this.ssoHeaders(referer),
      });
      if (!response.ok) throw new Error(`扫码状态请求失败: ${response.status}`);
      const body = await this.readSsoJson(response);
      if (typeof body.data === "string" && body.data) {
        await this.completeQrLogin(body.data);
        return { status: "confirmed", session: this.status() };
      }
      return { status: "waiting" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("expired") || message.includes("过期")) return { status: "expired", message: "二维码已过期，请刷新" };
      return { status: "error", message };
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
