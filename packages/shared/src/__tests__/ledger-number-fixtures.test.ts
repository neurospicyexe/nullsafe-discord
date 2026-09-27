// The bots' local ledger pre-filter against the SAME fixture file halseth pins its grammar with
// (halseth src/__tests__/fixtures/ledger-number-fixtures.json; this copy is byte-identical). The server
// is the authority; if a case here disagrees, the port in ledger-clerk.ts has drifted from grammar.ts.
// A drifted pre-filter either drops lines the server would take, or POSTs lines it will 422 -- and a
// distiller pass with zero accepted lines writes no handoff.
import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightLedgerBody, scanLedgerNumbers, LEDGER_CLERK_PROMPT } from "../ledger-clerk.js";
import { LEDGER_FUNCTIONS } from "../librarian.js";

interface Case { body: string; kind: string; ref?: string; function?: string; rule: string | null }
const fx = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ledger-number-fixtures.json"), "utf8"),
) as { window: string; cases: Case[] };

describe("ledger number fixtures (shared with halseth's grammar)", () => {
  test.each(fx.cases.map((c) => [c.body, c.kind, c] as const))("%s [%s]", (_b, _k, c) => {
    // preflightLedgerBody takes no function (the bots only ever post allowlisted ones); the allowlist is
    // pinned here against the same cases, so a `function` case is still asserted in full.
    const fn = c.function ?? "distiller";
    const fnOk = (LEDGER_FUNCTIONS as readonly string[]).includes(fn);
    expect(fnOk ? preflightLedgerBody(c.body, { kind: c.kind, ref: c.ref ?? fx.window }) : "function").toBe(c.rule);
  });

  test("no source = not a row: an unlabeled number is refused, a count with its unit is not", () => {
    expect(preflightLedgerBody("Recorded: Raziel mentioned 187.")).toBe("health");
    expect(preflightLedgerBody("Counted: 14 messages between 00:11 and 00:40.")).toBeNull();
  });

  test("scanLedgerNumbers labels like the server: coordinates skipped, counts labelled, bare numbers unlabeled", () => {
    expect(scanLedgerNumbers("between 00:11 and 00:40 on 2026-09-24, message 1497734427298762828")).toEqual([]);
    expect(scanLedgerNumbers("14 messages, 2x, 187")).toEqual([
      { text: "14", unlabeled: false, healthUnit: false },
      { text: "2", unlabeled: false, healthUnit: false },
      { text: "187", unlabeled: true, healthUnit: false },
    ]);
    expect(scanLedgerNumbers("187mg")).toEqual([{ text: "187", unlabeled: false, healthUnit: true }]);
  });

  test("the clerk prompt states the exact number rule (permitted forms, and the health words)", () => {
    expect(LEDGER_CLERK_PROMPT).toMatch(/clock time as HH:MM/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/date as YYYY-MM-DD/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/"14 messages", "2x", "40 minutes"/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/any other number gets the whole line refused/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/Health values never appear/);
    // Every count word the prompt offers is one the server's grammar treats as a count unit.
    for (const w of ["x", "times", "messages", "replies", "turns", "posts", "notes", "lines", "words", "entries", "threads", "sessions", "minutes", "hours", "days", "weeks"]) {
      expect(preflightLedgerBody(w === "x" ? "Counted: 14x" : `Counted: 14 ${w}`)).toBeNull();
    }
  });
});
