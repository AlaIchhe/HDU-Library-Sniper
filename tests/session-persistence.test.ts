import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let home: string;
let closeDb: (() => void) | undefined;

beforeAll(() => {
  home = join(mkdtempSync(join(tmpdir(), "hdu-sniper-test-")), "home");
  process.env.HDU_SNIPER_HOME = home;
});

afterAll(() => {
  closeDb?.();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

describe("session credential persistence", () => {
  test("migrates session table and stores credentials", async () => {
    const { db } = await import("../src/server/db");
    closeDb = () => db.close();
    const columns = db.query("PRAGMA table_info(session)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("student_id");
    expect(columns.map((column) => column.name)).toContain("password");

    const { AuthService } = await import("../src/server/auth");
    db.query("INSERT INTO session(id,uid,name,student_id,password,cookies,updated_at) VALUES(1,'123','测试','stu001','secret','[]','now')").run();
    const auth = new AuthService();
    expect((auth as unknown as { credentials?: { studentId: string; password: string } }).credentials).toEqual({
      studentId: "stu001",
      password: "secret",
    });
  });

  test("logout clears session but keeps credentials", async () => {
    const { db } = await import("../src/server/db");
    const { AuthService } = await import("../src/server/auth");
    db.query("UPDATE session SET uid='456', name='张三', cookies='[]', student_id='stu002', password='secret2' WHERE id=1").run();
    const auth = new AuthService();
    auth.client.uid = "456";
    auth.client.name = "张三";
    auth.client.jar.clear();

    auth.logout();

    expect(auth.status()).toEqual({ authenticated: false, refreshing: false });
    const row = db.query("SELECT uid, name, cookies, student_id, password FROM session WHERE id = 1").get() as Record<string, string>;
    expect(row.uid).toBe("");
    expect(row.name).toBe("");
    expect(JSON.parse(row.cookies)).toEqual([]);
    expect(row.student_id).toBe("stu002");
    expect(row.password).toBe("secret2");
  });
});
