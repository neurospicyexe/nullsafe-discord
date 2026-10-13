#!/usr/bin/env node
/**
 * Backfill the Jev voice onto address-shadow rows written before step 2 (2026-10-13), so the Jev
 * vs Flash vs today's-code read-out exists on day zero instead of after a week of wall clock.
 *
 * Reads ADDRESS_SHADOW_LOG (default /app/logs/address-shadow.jsonl). For every kind:"shadow" row
 * WITHOUT a `jev` field, rebuilds the Jev state from the row's own text, turns and holder (exactly
 * what the live shadow sends; rows before step 2 are all Raziel's), calls Jev through Halseth
 * POST /admin/jev, and writes the row back out with the step-2 fields filled. `spoke` rows and
 * rows that already carry Jev pass through unchanged. The live log is never modified: output goes
 * to --out (default /tmp/address-shadow-jev.jsonl). Then:
 *
 *   node scripts/address-shadow-report.mjs --file /tmp/address-shadow-jev.jsonl --out /tmp/address-jev
 *
 * USAGE (on the VPS, from /app/nullsafe-discord, after `npm run build`):
 *   node scripts/address-jev-backfill.mjs [--file x.jsonl] [--out y.jsonl] [--limit N] [--concurrency 4]
 *
 * Env: HALSETH_URL and HALSETH_SECRET (or ADMIN_SECRET), read from .env the same way the bots do.
 * Stdout: counts only, never message text. Cost: one Jev call per row (~1-2k tokens at $42/B).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const FILE = flag("--file", process.env.ADDRESS_SHADOW_LOG ?? "/app/logs/address-shadow.jsonl");
const OUT = flag("--out", "/tmp/address-shadow-jev.jsonl");
const LIMIT = Number(flag("--limit", "0"));
const CONC = Math.max(1, Number(flag("--concurrency", "4")));
// --refit (2026-10-13): re-ask rows that already carry Jev but predate a newly added question
// (the #9 relevance nouls), so a new question gets day-zero numbers too.
const REFIT = process.argv.includes("--refit");

try { createRequire(import.meta.url)("dotenv").config(); } catch { /* env may already be set */ }

const shared = await import("../packages/shared/dist/address-jev.js");
const { extractAddress } = await import("../packages/shared/dist/channel-config.js");
const { renderJevAddressState, jevAddressEval, jevAgreesFlash, jevAgreesToday, todayRoute } = shared;

if (!existsSync(FILE)) { console.error(`[jev-backfill] no such file: ${FILE}`); process.exit(1); }
if (!process.env.HALSETH_URL || !(process.env.HALSETH_SECRET ?? process.env.ADMIN_SECRET)) {
  console.error("[jev-backfill] HALSETH_URL and HALSETH_SECRET/ADMIN_SECRET must be set"); process.exit(1);
}

const lines = readFileSync(FILE, "utf8").split(/\r?\n/).filter((l) => l.trim());
const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
const todo = rows.map((r, i) => ({ r, i })).filter(({ r }) => r && r.kind === "shadow" && (!("jev" in r) || (REFIT && !(r.jev && r.jev.fit && Object.keys(r.jev.fit).length))));
const work = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
console.log(`[jev-backfill] ${rows.length} lines, ${todo.length} shadow rows without Jev, running ${work.length} at concurrency ${CONC}`);

let ok = 0; let fail = 0; const reasons = {};
let next = 0;
async function worker() {
  while (next < work.length) {
    const { r } = work[next++];
    const holder = r.holder ?? null;
    const state = renderJevAddressState({ speakerSide: "raziel", speakerLabel: "Raziel", text: r.text ?? "", turns: r.turns ?? [], holder });
    const res = await jevAddressEval(state);
    // The row's regex verdict is flattened ({type, ids}); re-derive the AddressType from the text.
    const regex = extractAddress(r.text ?? "");
    const route = todayRoute({ regex, holder, speakerSide: "raziel", humanAddressee: null });
    r.speaker_side = "raziel";
    r.human_addressee = null;
    r.today_route = route;
    r.jev_wall_ms = res.wall_ms;
    r.backfilled = true;
    if (res.ok) {
      ok++;
      r.jev = res.verdict;
      r.jev_failure = null;
      r.jev_latency_ms = res.latency_ms;
      r.jev_agree_flash = jevAgreesFlash(res.verdict, r.model ?? null, holder);
      r.jev_agree_today = jevAgreesToday(res.verdict, route, holder);
    } else {
      fail++;
      reasons[res.reason] = (reasons[res.reason] ?? 0) + 1;
      r.jev = null;
      r.jev_failure = res.reason;
      r.jev_latency_ms = null;
      r.jev_agree_flash = null;
      r.jev_agree_today = null;
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

writeFileSync(OUT, rows.filter(Boolean).map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`[jev-backfill] ok=${ok} failed=${fail}${Object.keys(reasons).length ? ` (${Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}; wrote ${OUT} (contains message text)`);
