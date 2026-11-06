import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

let home: string;
let closeDb: (() => void) | undefined;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  home = join(mkdtempSync(join(tmpdir(), "hdu-sniper-test-")), "home");
  process.env.HDU_SNIPER_HOME = home;
});

afterAll(() => {
  closeDb?.();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("extractOpenid", () => {
  test("accepts a bare openid and a full wechat link", async () => {
    const { extractOpenid } = await import("../src/server/auth");
    expect(extractOpenid("okOhQt-6kvozwqD9JhY_A4_8nXEQ")).toBe("okOhQt-6kvozwqD9JhY_A4_8nXEQ");
    expect(extractOpenid("https://hdu.huitu.zhishulib.com/content/index/startUp/openid/okOhQt-6kvozwqD9JhY_A4_8nXEQ/#!/User/Center/myAppoint?tab=0"))
      .toBe("okOhQt-6kvozwqD9JhY_A4_8nXEQ");
    expect(extractOpenid("bad value!")).toBe("");
    expect(extractOpenid("")).toBe("");
  });
});

describe("AuthService.loginWithOpenid", () => {
  test("exchanges openid cookies, validates and persists the session", async () => {
    const { db } = await import("../src/server/db");
    closeDb = () => db.close();
    db.query("INSERT INTO session(id,uid,name,student_id,password,cookies,updated_at) VALUES(1,'old','旧用户','stu001','secret','[]','now')").run();
    const calls: string[] = [];
    // happy-dom 的 Headers 会丢弃 set-cookie，这里用最小响应对象模拟真实 fetch。
    const redirectWithCookies = (cookies: string[]): Response => ({
      status: 302,
      ok: false,
      url: "",
      headers: {
        getSetCookie: () => cookies,
        get: (name: string) => (name.toLowerCase() === "location" ? "https://hdu.huitu.zhishulib.com/" : null),
      },
      text: async () => "",
      json: async () => ({}),
    }) as unknown as Response;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/content/index/startUp/openid/")) {
        return redirectWithCookies(["auth=token-value; Path=/; HttpOnly", "uid=abc; Path=/"]);
      }
      if (url.endsWith("/User/Center/baseInfo")) {
        return Response.json({ CODE: "ok", DATA: { is_login: true, uid: "172171", user_info: { name: "openid-user" } } });
      }
      return new Response("<html>ok</html>", { status: 200 });
    }) as typeof fetch;

    const { AuthService } = await import("../src/server/auth");
    const auth = new AuthService();
    const result = await auth.loginWithOpenid("https://hdu.huitu.zhishulib.com/content/index/startUp/openid/okOhQt-6kvozwqD9JhY_A4_8nXEQ/");

    expect(result.success).toBe(true);
    expect(auth.status().uid).toBe("172171");
    expect(calls[0]).toContain("/content/index/startUp/openid/okOhQt-6kvozwqD9JhY_A4_8nXEQ/");
    const row = db.query("SELECT uid, name, student_id, password, cookies FROM session WHERE id = 1").get() as Record<string, string>;
    expect(row.uid).toBe("172171");
    expect(row.name).toBe("openid-user");
    expect(row.student_id).toBe("");
    expect(row.password).toBe("");
    expect(JSON.parse(row.cookies).map((cookie: { name: string }) => cookie.name)).toContain("auth");
  });

  test("failed validation restores the previous session", async () => {
    const { db } = await import("../src/server/db");
    const previousCookies = [{ name: "PHPSESSID", value: "old", domain: "hdu.huitu.zhishulib.com", path: "/", expiresAt: null, secure: false, httpOnly: false }];
    db.query("UPDATE session SET uid='old', name='旧用户', student_id='stu001', password='secret', cookies=?1 WHERE id=1")
      .run(JSON.stringify(previousCookies));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/content/index/startUp/openid/")) {
        return {
          status: 302,
          ok: false,
          url: "",
          headers: {
            getSetCookie: () => ["auth=new-token; Path=/"],
            get: (name: string) => (name.toLowerCase() === "location" ? "https://hdu.huitu.zhishulib.com/" : null),
          },
          text: async () => "",
          json: async () => ({}),
        } as unknown as Response;
      }
      if (url.endsWith("/User/Center/baseInfo")) {
        return Response.json({ CODE: "ok", DATA: { is_login: false } });
      }
      return new Response("<html>ok</html>", { status: 200 });
    }) as unknown as typeof fetch;

    const { AuthService } = await import("../src/server/auth");
    const auth = new AuthService();
    const result = await auth.loginWithOpenid("okOhQt-6kvozwqD9JhY_A4_8nXEQ");

    expect(result.success).toBe(false);
    expect(auth.status().uid).toBe("old");
    const row = db.query("SELECT uid, cookies FROM session WHERE id = 1").get() as Record<string, string>;
    expect(row.uid).toBe("old");
    expect(JSON.parse(row.cookies).map((cookie: { name: string }) => cookie.name)).toEqual(["PHPSESSID"]);
  });

  test("invalid openid is rejected without touching the existing session", async () => {
    const { db } = await import("../src/server/db");
    const { AuthService } = await import("../src/server/auth");
    db.query("UPDATE session SET uid='old', name='旧用户', student_id='stu001', password='secret' WHERE id=1").run();
    globalThis.fetch = (async () => { throw new Error("network should not be called"); }) as unknown as typeof fetch;
    const auth = new AuthService();
    const result = await auth.loginWithOpenid("not a valid openid");
    expect(result.success).toBe(false);
    const row = db.query("SELECT uid, student_id, password FROM session WHERE id = 1").get() as Record<string, string>;
    expect(row.uid).toBe("old");
    expect(row.student_id).toBe("stu001");
  });
});
