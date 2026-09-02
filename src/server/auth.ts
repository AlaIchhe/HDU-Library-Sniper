import { createCipheriv } from "node:crypto";
import { CookieJar } from "./cookies";
import { db } from "./db";
import { LibraryClient } from "./library";

const LOGIN_ENTRY = "https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

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
  status() { return { authenticated: this.authenticated, uid: this.client.uid || undefined, name: this.client.name || undefined, refreshing: false }; }

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
