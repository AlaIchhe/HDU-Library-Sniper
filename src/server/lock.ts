import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { dataDir } from "./config";

const lockPath = `${dataDir}/hdu-library-sniper.job.lock`;
const lockTtlMs = 10 * 60_000;

export function tryAcquireJobLock(owner: "booking" | "check-in"): (() => void) | undefined {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const content = JSON.parse(readFileSync(lockPath, "utf8")) as { acquiredAt?: number };
      if (Date.now() - Number(content.acquiredAt || 0) < lockTtlMs) return undefined;
      unlinkSync(lockPath);
    } catch {
      try { unlinkSync(lockPath); } catch { return undefined; }
    }
  }
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, JSON.stringify({ owner, acquiredAt: Date.now(), pid: process.pid }), "utf8");
    closeSync(fd);
    return () => { try { unlinkSync(lockPath); } catch { /* stale lock cleanup handles crashes */ } };
  } catch {
    return undefined;
  }
}
