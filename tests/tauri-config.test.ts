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
});