import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("tauri plugin configuration", () => {
  test("does not pass a config object to the autostart plugin", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(config.plugins?.autostart).toBeUndefined();
  });
});
