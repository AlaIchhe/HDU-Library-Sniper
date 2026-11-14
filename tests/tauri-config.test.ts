import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("tauri plugin configuration", () => {
  test("does not pass a config object to the autostart plugin", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(config.plugins?.autostart).toBeUndefined();
  });

  test("declares the GUI subsystem on the executable entry point", () => {
    const main = readFileSync("src-tauri/src/main.rs", "utf8");
    expect(main).toContain('windows_subsystem = "windows"');
  });

  test("allows the desktop webview to connect to the local backend", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain("connect-src 'self' http://127.0.0.1:8000");
  });

  test("no longer bundles a Bun sidecar resource", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(config.bundle?.resources).toBeUndefined();
  });

  test("starts the Rust API inside the Tauri process", () => {
    const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(lib).toContain("build_router");
    expect(lib).toContain("Scheduler::new");
    // bind 走常量并带重试；确保后端仍在 Tauri 进程内启动。
    expect(lib).toContain("TcpListener::bind((LOCAL_API_HOST, LOCAL_API_PORT))");
    expect(lib).toContain("ensure_loopback_bypass");
    expect(lib).not.toContain("hdu-sniper-server.exe");
    expect(lib).not.toContain("Command::new");
  });
});
