import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SHUTDOWN_FLUSH_MS, SHUTDOWN_SESSION_CLOSE_MS, SHUTDOWN_SUBS_MS, SHUTDOWN_BACKSTOP_MS,
} from "./shutdown-budget.js";

describe("shutdown budget", () => {
  const worst = SHUTDOWN_FLUSH_MS + SHUTDOWN_SESSION_CLOSE_MS + SHUTDOWN_SUBS_MS;
  it("gives closure distillation more than the old 1.5s that cut it off", () => {
    expect(SHUTDOWN_FLUSH_MS).toBeGreaterThanOrEqual(8000);
  });
  it("worst-case sum fits under the backstop", () => {
    expect(worst).toBeLessThanOrEqual(SHUTDOWN_BACKSTOP_MS);
  });
  it("backstop fits under every pm2 kill_timeout", () => {
    const cfg = readFileSync(resolve(process.cwd(), "../../ecosystem.config.js"), "utf8");
    const all = [...cfg.matchAll(/kill_timeout:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const k of all) expect(k).toBeGreaterThan(SHUTDOWN_BACKSTOP_MS);
  });
});
