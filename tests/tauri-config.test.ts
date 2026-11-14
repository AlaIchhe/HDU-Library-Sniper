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

  test("does not allow loopback HTTP in CSP now that desktop uses IPC", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).not.toContain("127.0.0.1:8000");
  });

  test("no longer bundles a Bun sidecar resource", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(config.bundle?.resources).toBeUndefined();
  });

  test("dispatches desktop API calls in-memory via Tauri IPC", () => {
    const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(lib).toContain("build_router");
    expect(lib).toContain("Scheduler::new");
    expect(lib).toContain("fn api_request");
    expect(lib).toContain(".oneshot(");
    expect(lib).not.toContain("TcpListener::bind");
    expect(lib).not.toContain("NO_PROXY");
    expect(lib).not.toContain("tauri_plugin_http");
    expect(lib).not.toContain("hdu-sniper-server.exe");
    expect(lib).not.toContain("Command::new");
  });
});
