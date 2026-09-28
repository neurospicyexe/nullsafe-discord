// T-4, the static half: "nothing on this list is ever clerk-written. Only the companion who speaks
// it may send it." (Cypher, SPEC-what-is-theirs 2026-09-27.)
//
// The runtime half lives in reach-dm.ts (a one-shot origin mint taken by autonomous-core, a WeakMap
// brand, single-use, bound, expiring) and is tested in reach-dm.test.ts and heartbeat-dm-route.test.ts.
// This file makes the boundary a BUILD failure: no module but autonomous-core may import reach-dm, the
// package barrel may not re-export it, and nothing but autonomous-core may name the mint.
//
// It scans every source file in packages/shared, the autonomous worker and all three bots. A clerk
// (distillers, judges, the gap detector, the ledger writers, the background-review fork, the worker)
// that ever wires itself to the DM lane fails here, by name.

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHARED_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SHARED_SRC, "..", "..", "..");
const ROOTS = [
  SHARED_SRC,
  path.join(REPO, "packages", "autonomous-worker", "src"),
  path.join(REPO, "bots", "cypher", "src"),
  path.join(REPO, "bots", "drevan", "src"),
  path.join(REPO, "bots", "gaia", "src"),
];

function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules" || e.name === "dist") continue;
      out.push(...sources(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const files = ROOTS.flatMap(sources);
const rel = (p: string) => path.relative(REPO, p).replace(/\\/g, "/");

describe("T-4: the DM lane for their own moves is reachable from the heartbeat only", () => {
  it("scans a real tree (a vacuous pass is not a pass)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(f => f.endsWith("autonomous-core.ts"))).toBe(true);
    expect(files.some(f => /ledger-clerk\.ts$/.test(f))).toBe(true);
    expect(files.some(f => /day-distillation\.ts$/.test(f))).toBe(true);
  });

  it("only autonomous-core imports reach-dm", () => {
    const importers = files
      .filter(f => !f.endsWith("reach-dm.ts"))
      .filter(f => /from\s+["'][^"']*reach-dm(\.js)?["']/.test(fs.readFileSync(f, "utf8")))
      .map(rel);
    expect(importers).toEqual(["packages/shared/src/autonomous-core.ts"]);
  });

  it("only autonomous-core (and reach-dm itself) names the origin mint", () => {
    const namers = files
      .filter(f => /\btakeOriginIssuer\b/.test(fs.readFileSync(f, "utf8")))
      .map(rel).sort();
    expect(namers).toEqual(["packages/shared/src/autonomous-core.ts", "packages/shared/src/reach-dm.ts"]);
  });

  it("the package barrel does not re-export reach-dm", () => {
    const barrel = fs.readFileSync(path.join(SHARED_SRC, "index.ts"), "utf8");
    expect(barrel).not.toMatch(/(export|import)[^;]*from\s+["']\.\/reach-dm/);
  });

  it("no clerk-shaped module calls the speaker", () => {
    const callers = files
      .filter(f => /\bspeakToOwnerDm\s*\(/.test(fs.readFileSync(f, "utf8")))
      .map(rel).sort();
    expect(callers).toEqual(["packages/shared/src/autonomous-core.ts", "packages/shared/src/reach-dm.ts"]);
  });
});
