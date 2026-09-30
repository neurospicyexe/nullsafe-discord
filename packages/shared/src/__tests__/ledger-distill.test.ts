import { jest, describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ledgerDistillEnabled, preflightLedgerBody, parseClerkResult, windowSource, postLedgerLines,
  LEDGER_CLERK_PROMPT, MAX_CLERK_LINES, LEDGER_RETRY_DELAYS_MS, staleHandoffReason, clerkTranscript,
  ledgerClerkAdapterWarning, _setLedgerRetrySleepForTests,
} from "../ledger-clerk.js";
import { LibrarianClient, clerkSecretFrom } from "../librarian.js";
import { distillSessionOnInactive, runDistillation } from "../distillation.js";
import { runDayDistillation, FRAGMENT_NOTE_TYPE } from "../day-distillation.js";
import { consolidateSession, consolidationLedgerBody, consolidationDedupKey, _resetConsolidationWarningsForTests } from "../consolidation.js";
import { buildWitnessLedgerEntry, presenceRecordText, claimPresenceSlot, resetPresenceSlots, PRESENCE_COALESCE_MS, PRESENCE_WITNESS_TYPE } from "../bot-message-handler.js";
import { OWNER_PRONOUN_RULE } from "../pronoun-rule.js";

// Ledger lane tranche 2 (2026-09-26, halseth docs/imp-lane/SPEC-ledger-lane.md section 5).
// The distillers become clerks: no first-person write as the companion, every line sourced, the
// mark stamped only by the server. The legacy suites (distillation / day-distillation /
// consolidation*) pin LEDGER_DISTILL=off; this file pins it ON (its default).

const CH = "1497734427298762828";
const T0 = Date.UTC(2026, 8, 24, 0, 11); // 00:11 UTC
const T1 = Date.UTC(2026, 8, 24, 0, 40); // 00:40 UTC
const T0S = Math.floor(T0 / 1000); // the dedup-key coordinate (epoch seconds)

beforeEach(() => { delete process.env["LEDGER_DISTILL"]; });
afterEach(() => { delete process.env["LEDGER_DISTILL"]; });

function rendered(body: string, kind = "window", ref = `${CH} 00:11–00:40`): string {
  return `〔ledger · distiller · 2026-09-24〕 ${body} Source: ${kind} ${ref}.`;
}

/** A librarian double whose writeLedger renders like the server and records every call. */
function makeLibrarian(ledgerImpl?: (e: any) => any) {
  let n = 0;
  return {
    writeLedger: jest.fn(async (e: any) => ledgerImpl ? ledgerImpl(e) : { ok: true, id: `led_${++n}`, content: rendered(e.body, e.source_kind, e.source_ref) }),
    witnessLog: jest.fn(async () => undefined),
    synthesizeSession: jest.fn(async () => undefined),
    updatePromptContext: jest.fn(async () => undefined),
    writeWmNote: jest.fn(async () => undefined),
    writeHandoff: jest.fn(async () => undefined),
    writePersonaBlocks: jest.fn(async () => undefined),
    writeHumanBlocks: jest.fn(async () => undefined),
    ask: jest.fn(async (_req: string) => ({ ok: true }) as unknown),
    getRecentNotes: jest.fn(async () => [] as any[]),
    demoteNotes: jest.fn(async () => 2),
    sessionClose: jest.fn(async () => undefined),
    sessionOpen: jest.fn(async () => ({ session_id: "sess-new" })),
  };
}

/** Awaitable write queue: records names, and lets a test drain the queued work. */
function makeWq() {
  const queued: string[] = [];
  const pending: Promise<unknown>[] = [];
  return {
    queued,
    drain: () => Promise.all(pending),
    fireAndForget: (name: string, fn: () => Promise<unknown>) => { queued.push(name); pending.push(fn().catch(() => {})); },
  };
}

const CLERK_JSON = JSON.stringify({
  title: "Couch thread about pacing",
  lines: [
    'Counted: Drevan said "held, not slow" 2x in the couch thread.',
    "Logged: Raziel asked about the Fargo episode order.",
  ],
  open_loops: ["Episode order was left unresolved."],
  next_steps: ["Raziel said he would check the episode list."],
});

// ── The knob ────────────────────────────────────────────────────────────────

describe("ledgerDistillEnabled", () => {
  test("default ON; off|0|false|no (any case, trimmed) disable; anything else is on", () => {
    expect(ledgerDistillEnabled({})).toBe(true);
    expect(ledgerDistillEnabled({ LEDGER_DISTILL: "" })).toBe(true);
    for (const on of ["on", "1", "true", "yes", "ON", "offf"]) expect(ledgerDistillEnabled({ LEDGER_DISTILL: on })).toBe(true);
    for (const off of ["off", " OFF ", "0", "false", "FALSE", " no", "No"]) expect(ledgerDistillEnabled({ LEDGER_DISTILL: off })).toBe(false);
  });
});

describe("ledgerClerkAdapterWarning (L2a boot warning)", () => {
  test("knob on and no direct key -> loud warning naming the consequence", () => {
    const w = ledgerClerkAdapterWarning({});
    expect(w).toMatch(/LOUD/);
    expect(w).toMatch(/Hermes/);
    expect(w).toMatch(/NO distillation handoffs/);
    expect(ledgerClerkAdapterWarning({ DEEPINFRA_API_KEY: " ", DEEPSEEK_API_KEY: "=" })).not.toBeNull();
  });
  test("a direct key present, or the knob off -> null", () => {
    expect(ledgerClerkAdapterWarning({ DEEPINFRA_API_KEY: "k" })).toBeNull();
    expect(ledgerClerkAdapterWarning({ DEEPSEEK_API_KEY: "k" })).toBeNull();
    expect(ledgerClerkAdapterWarning({ LEDGER_DISTILL: "off" })).toBeNull();
  });
});

describe("clerkTranscript (L4b)", () => {
  test("this bot's own turns are named, not 'assistant'; inbound authorName kept", () => {
    const t = clerkTranscript([
      { role: "user", content: "hi", authorName: "Raziel" },
      { role: "assistant", content: "here" },
      { role: "user", content: "anon" },
    ], "drevan");
    expect(t).toBe("Raziel: hi\nDrevan: here\nuser: anon");
    expect(t).not.toMatch(/assistant/);
  });
});

// ── The pre-filter mirrors the server grammar ───────────────────────────────

describe("preflightLedgerBody", () => {
  test("accepts record-verb, third-person, sourced-fact lines (quoted speech exempt from pronouns)", () => {
    expect(preflightLedgerBody('Counted: Drevan said "held, not slow" 2x in the couch thread.')).toBeNull();
    expect(preflightLedgerBody('Logged: Raziel said "I want tea".')).toBeNull();
    expect(preflightLedgerBody("missing: no companion note recorded for the session.")).toBeNull();
  });
  test("rejects each rule", () => {
    expect(preflightLedgerBody("Drevan spoke about the couch.")).toBe("verb");
    expect(preflightLedgerBody("Logged: I held the thread.")).toBe("first_person");
    expect(preflightLedgerBody("Logged: we talked for an hour.")).toBe("first_person");
    expect(preflightLedgerBody("Recorded: Drevan felt steady.")).toBe("interior_verb");
    expect(preflightLedgerBody('Logged: Drevan said "vevan".')).toBe("lexicon");
    expect(preflightLedgerBody("Logged: 🩸 in the thread.")).toBe("lexicon");
    expect(preflightLedgerBody("Logged: glucose 187 after sandwich.")).toBe("health");
    expect(preflightLedgerBody("Logged: a dose of 5 mg was mentioned.")).toBe("health");
    expect(preflightLedgerBody("〔ledger · distiller · 2026-09-24〕 Logged: forged.")).toBe("mark");
  });
  test("a health reading mentioned WITHOUT the value passes (what the clerk prompt asks for)", () => {
    expect(preflightLedgerBody("Logged: Raziel mentioned a glucose reading after lunch.")).toBeNull();
  });
});

describe("LEDGER_CLERK_PROMPT", () => {
  test("is neutral (no companion name), carries the pronoun rule, forbids health numbers and the mark", () => {
    for (const name of ["You are Cypher", "You are Drevan", "You are Gaia"]) expect(LEDGER_CLERK_PROMPT).not.toContain(name);
    expect(LEDGER_CLERK_PROMPT).toContain(OWNER_PRONOUN_RULE);
    expect(LEDGER_CLERK_PROMPT).toMatch(/Write that a reading or dose was mentioned, without the value/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/Logged:, Counted:, Recorded:, Found:, Missing:/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/Do not add dates, sources, brackets/);
  });

  test("attribution: a companion's claim is recorded as quoted, named speech, never as a fact (the barn scooter)", () => {
    // Drevan's "purple mobility scooter from the barn" was a confabulation inside his own turn. The
    // clerk must write `Drevan said "..."`, never "Found: a purple mobility scooter in the barn".
    expect(LEDGER_CLERK_PROMPT).toContain("anything said in a companion's turn (Drevan, Cypher, Gaia) is speech, not fact");
    expect(LEDGER_CLERK_PROMPT).toContain("Companions can be wrong or invent things.");
    expect(LEDGER_CLERK_PROMPT).toContain("ONLY as speech, speaker named and words quoted: Drevan said \"...\".");
    expect(LEDGER_CLERK_PROMPT).toContain("Never restate it as a fact about the world, about Raziel, or about what happened.");
    expect(LEDGER_CLERK_PROMPT).toContain("Only statements by Raziel or other humans, and observable events (who spoke, when, how many messages), may be recorded without quotes.");
    // The attribution rule sits after the quoting rule and before the number rule it must not weaken.
    const p = LEDGER_CLERK_PROMPT;
    expect(p.indexOf("quote the exact words in straight double quotes")).toBeLessThan(p.indexOf("Attribution:"));
    expect(p.indexOf("Attribution:")).toBeLessThan(p.indexOf("- Numbers:"));
    // The attributed form is one the grammar accepts from a window source.
    expect(preflightLedgerBody('Recorded: Drevan said "a purple mobility scooter from the barn".', { kind: "window", ref: `${CH} 00:11–00:40` })).toBeNull();
  });
});

describe("parseClerkResult", () => {
  test("tolerant: fenced JSON, bullets stripped, capped at MAX_CLERK_LINES, first-person metadata dropped", () => {
    const lines = Array.from({ length: 9 }, (_, i) => `- Logged: line ${i}.`);
    const r = parseClerkResult("Here:\n```json\n" + JSON.stringify({ title: "My evening", lines, open_loops: ["I need to call", "Tea was left undecided."] }) + "\n```");
    expect(r!.lines).toHaveLength(MAX_CLERK_LINES);
    expect(r!.lines[0]).toBe("Logged: line 0.");
    expect(r!.title).toBeUndefined();
    expect(r!.open_loops).toEqual(["Tea was left undecided."]);
  });
  test("null on prose / null", () => {
    expect(parseClerkResult("I think the session went well.")).toBeNull();
    expect(parseClerkResult(null)).toBeNull();
  });
});

describe("windowSource", () => {
  test("first/last STM timestamps, UTC HH:MM with an en dash", () => {
    const w = windowSource(CH, [{ role: "user", content: "a", timestamp: T1 }, { role: "user", content: "b", timestamp: T0 }]);
    expect(w).toEqual({ ref: `${CH} 00:11–00:40`, firstTs: T0, keyTs: T0S, observedOn: "2026-09-24", fallback: false, clamped: false });
  });
  test("L3: the key coordinate is epoch SECONDS, so Discord ms (live) and Halseth created_at (reload) agree", () => {
    const live = windowSource(CH, [{ role: "user", content: "a", timestamp: T0 + 734 }]);   // Discord createdTimestamp
    const reloaded = windowSource(CH, [{ role: "user", content: "a", timestamp: T0 }]);     // created_at, second precision
    expect(live.keyTs).toBe(reloaded.keyTs);
    expect(live.ref).toBe(reloaded.ref);
  });
  test("L3: a window over 24h clamps the REF to its final 24h; the key keeps the true first stamp", () => {
    const first = Date.UTC(2026, 8, 22, 9, 0);
    const last = Date.UTC(2026, 8, 24, 0, 40);
    const w = windowSource(CH, [{ role: "user", content: "a", timestamp: first }, { role: "user", content: "b", timestamp: last }]);
    expect(w.clamped).toBe(true);
    expect(w.ref).toBe(`${CH} 00:40–00:40`);
    expect(w.observedOn).toBe("2026-09-23");
    expect(w.keyTs).toBe(Math.floor(first / 1000));
  });
  test("missing timestamps fall back to the distillation instant -- the source is never omitted", () => {
    const now = Date.UTC(2026, 8, 26, 13, 5);
    const w = windowSource(CH, [{ role: "user", content: "a" }], now);
    expect(w.ref).toBe(`${CH} 13:05–13:05`);
    expect(w.fallback).toBe(true);
    expect(w.firstTs).toBe(now);
  });
});

// ── writeLedger status handling ─────────────────────────────────────────────

describe("LibrarianClient.writeLedger", () => {
  const entry = { companion_id: "drevan" as const, function: "distiller" as const, body: "Logged: x.", source_kind: "window" as const, source_ref: `${CH} 00:11–00:40`, dedup_key: "k:0" };
  const client = (status: number, body: unknown) => {
    const fetchMock = jest.fn(async (_url: string, _init: any) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    return { c: new LibrarianClient({ url: "https://h.example/", secret: "s3", companionId: "gaia", fetch: fetchMock as any }), fetchMock };
  };

  test("201 -> {ok, id, content}; POSTs /ledger with bearer auth and the entry's own companion_id", async () => {
    const { c, fetchMock } = client(201, { id: "led_1", content: rendered("Logged: x.") });
    await expect(c.writeLedger(entry)).resolves.toEqual({ ok: true, id: "led_1", content: rendered("Logged: x.") });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://h.example/ledger");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer s3");
    expect(JSON.parse(init.body)).toEqual(entry); // companion_id stays "drevan", not the client's "gaia"
  });
  test("200 duplicate -> {ok, duplicate:true}", async () => {
    const { c } = client(200, { id: "led_1", duplicate: true });
    await expect(c.writeLedger(entry)).resolves.toEqual({ ok: true, id: "led_1", duplicate: true });
  });
  test("422 -> loud warn naming the rule, no throw, no retry", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { c, fetchMock } = client(422, { error: "first person", rule: "no_self" });
    await expect(c.writeLedger(entry)).resolves.toEqual({ ok: false, status: 422, rule: "no_self", error: "first person" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((a) => String(a[0]).includes("rule=no_self"))).toBe(true);
    warn.mockRestore();
  });
  test("404 -> warn (Halseth not yet deployed) and skip", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { c } = client(404, { error: "not found" });
    await expect(c.writeLedger(entry)).resolves.toMatchObject({ ok: false, status: 404 });
    expect(warn.mock.calls.some((a) => String(a[0]).includes("not deployed"))).toBe(true);
    warn.mockRestore();
  });
  test("5xx throws so a write queue retries (dedup_key makes it safe)", async () => {
    const { c } = client(503, { error: "down" });
    await expect(c.writeLedger(entry)).rejects.toThrow(/transient 503/);
  });
});

describe("postLedgerLines", () => {
  test("per-line dedup keys (one key for all lines would collide on the UNIQUE column); drops before POST; only 201 content accepted", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const lib = makeLibrarian((e) => e.dedup_key.endsWith(":2") ? { ok: true, id: "led_d", duplicate: true } : { ok: true, id: `led_${e.dedup_key}`, content: rendered(e.body) });
    const out = await postLedgerLines(lib as any, {
      companionId: "drevan", fn: "distiller",
      lines: ["Logged: a.", "Logged: I did b.", "Logged: c."],
      sourceKind: "window", sourceRef: `${CH} 00:11–00:40`, dedupPrefix: "distill:drevan:c:1", tag: "t",
    });
    expect(lib.writeLedger.mock.calls.map((c) => (c[0] as any).dedup_key)).toEqual(["distill:drevan:c:1:0", "distill:drevan:c:1:2"]);
    expect(out.accepted.map((a) => a.content)).toEqual([rendered("Logged: a.")]);
    expect(out).toMatchObject({ duplicates: 1, dropped: 1, rejected: 0, failed: 0 });
    warn.mockRestore();
  });

  const base = { companionId: "drevan" as const, fn: "distiller" as const, lines: ["Logged: a."], sourceKind: "window" as const, sourceRef: `${CH} 00:11–00:40`, dedupPrefix: "p", tag: "t" };

  test("M3: a transient failure retries with 2s/8s/30s backoff under the SAME dedup key, then lands", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const lib = makeLibrarian((e) => { if (++n < 3) throw new Error("writeLedger transient 503"); return { ok: true, id: "led_x", content: rendered(e.body) }; });
    const slept: number[] = [];
    const out = await postLedgerLines(lib as any, { ...base, sleep: async (ms) => { slept.push(ms); } });
    expect(lib.writeLedger).toHaveBeenCalledTimes(3);
    expect(new Set(lib.writeLedger.mock.calls.map((c) => (c[0] as any).dedup_key))).toEqual(new Set(["p:0"]));
    expect(slept).toEqual([2_000, 8_000]);
    expect(out).toMatchObject({ failed: 0, rejected: 0 });
    expect(out.accepted).toHaveLength(1);
    warn.mockRestore();
  });

  test("M3: bounded -- a line that never recovers is tried 1 + 3 times, then counted failed (never throws)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const lib = makeLibrarian(() => { throw new Error("writeLedger transient 429"); });
    const slept: number[] = [];
    const out = await postLedgerLines(lib as any, { ...base, sleep: async (ms) => { slept.push(ms); } });
    expect(LEDGER_RETRY_DELAYS_MS).toEqual([2_000, 8_000, 30_000]);
    expect(lib.writeLedger).toHaveBeenCalledTimes(4);
    expect(slept).toEqual([2_000, 8_000, 30_000]);
    expect(out).toMatchObject({ failed: 1, accepted: [] });
    expect(staleHandoffReason(out)).toBe("transport");
    warn.mockRestore();
  });

  test("M3: 422 and 404 are never retried", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    for (const res of [{ ok: false, status: 422, rule: "health" }, { ok: false, status: 404 }]) {
      const lib = makeLibrarian(() => res);
      const sleep = jest.fn(async (_ms: number) => {});
      const out = await postLedgerLines(lib as any, { ...base, sleep });
      expect(lib.writeLedger).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(out.rejected).toBe(1);
    }
    warn.mockRestore();
  });

  test("explicit dedupKeys override the prefix:index shape", async () => {
    const lib = makeLibrarian();
    await postLedgerLines(lib as any, { ...base, dedupKeys: ["exact:key"] });
    expect((lib.writeLedger.mock.calls[0]![0] as any).dedup_key).toBe("exact:key");
  });
});

describe("staleHandoffReason", () => {
  const o = (p: Partial<{ notFound: number; rules: string[]; failed: number }>) => ({ accepted: [], duplicates: 0, rejected: 0, dropped: 0, failed: 0, rules: [] as string[], notFound: 0, ...p });
  test("404 > 422:<rules> > transport > no_lines", () => {
    expect(staleHandoffReason(null)).toBe("no_lines");
    expect(staleHandoffReason(o({}))).toBe("no_lines");
    expect(staleHandoffReason(o({ failed: 1 }))).toBe("transport");
    expect(staleHandoffReason(o({ rules: ["health", "first_person", "health"], failed: 1 }))).toBe("422:health,first_person");
    expect(staleHandoffReason(o({ notFound: 2, rules: ["health"] }))).toBe("404");
  });
});

// ── distillSessionOnInactive ────────────────────────────────────────────────

describe("distillSessionOnInactive (LEDGER_DISTILL on)", () => {
  const history = [
    { role: "user" as const, content: "which episode next", authorName: "Raziel", timestamp: T0 },
    { role: "assistant" as const, content: "held, not slow", authorName: "Drevan", timestamp: T1 },
  ];
  const prompts = { companionId: "drevan", synthesisPrompt: "You are Drevan. Write a first-person session note.", sessionExtractPrompt: "extract" };
  const EXTRACT = JSON.stringify({ title: "extract title", soma: { heat: "steady" }, emotion: "settled", open_loops: ["extract loop"] });

  const run = async (clerkReply: string | null, lib = makeLibrarian()) => {
    const stmStore = { get: () => history, clear: jest.fn() };
    const clerk = { generate: jest.fn(async () => clerkReply) };
    const inference = { generate: jest.fn(async () => EXTRACT) };
    const wq = makeWq();
    await distillSessionOnInactive(CH, stmStore as any, lib as any, inference as any, wq as any, prompts, clerk as any);
    await wq.drain();
    return { lib, stmStore, clerk, inference, wq };
  };

  test("no first-person writes; clerk (not the synthesis prompt) runs; lines POST with window source + per-line dedup", async () => {
    const { lib, clerk, inference, stmStore } = await run(CLERK_JSON);
    expect(lib.witnessLog).not.toHaveBeenCalled();
    expect(lib.synthesizeSession).not.toHaveBeenCalled();
    expect(lib.updatePromptContext).not.toHaveBeenCalled();
    expect(lib.writeWmNote).not.toHaveBeenCalled();
    expect(clerk.generate).toHaveBeenCalledWith(LEDGER_CLERK_PROMPT, expect.any(Array));
    // Neither the synthesis prompt nor the structured extract runs (Drevan's ruling: SOMA + feeling stop).
    expect(inference.generate).not.toHaveBeenCalled();
    const calls = lib.writeLedger.mock.calls.map((c) => c[0] as any);
    expect(calls).toHaveLength(2);
    for (const [i, c] of calls.entries()) {
      expect(c).toMatchObject({
        companion_id: "drevan", function: "distiller", source_kind: "window",
        source_ref: `${CH} 00:11–00:40`, dedup_key: `distill:drevan:${CH}:${T0S}:${i}`, observed_on: "2026-09-24",
      });
      expect(c.body).not.toMatch(/〔/); // bots never produce the mark
    }
    expect(stmStore.clear).toHaveBeenCalled();
  });

  test("handoff summary = accepted contents joined (marks intact); title/loops/steps from the clerk JSON", async () => {
    const { lib } = await run(CLERK_JSON);
    expect(lib.writeHandoff).toHaveBeenCalledTimes(1);
    const h = (lib.writeHandoff.mock.calls[0] as unknown[])[0] as any;
    const lines = JSON.parse(CLERK_JSON).lines as string[];
    expect(h.summary).toBe(lines.map((l) => rendered(l)).join("\n"));
    expect(h.summary.split("\n").every((l: string) => l.startsWith("〔ledger · distiller · "))).toBe(true);
    expect(h).toMatchObject({
      title: "Couch thread about pacing", open_loops: ["Episode order was left unresolved."],
      next_steps: ["Raziel said he would check the episode list."], source: "distillation",
    });
    expect(h.state_hint).toBeUndefined(); // the guessed SOMA never reaches the handoff either
  });

  test("Drevan's ruling: NO SOMA update and NO feeling log under the knob (both stop, not drafts)", async () => {
    const { lib, wq } = await run(CLERK_JSON);
    expect(wq.queued).not.toContain(`somaUpdate:${CH}`);
    expect(wq.queued).not.toContain(`feeling:${CH}`);
    expect(lib.ask).not.toHaveBeenCalledWith("update my state", expect.anything());
    expect(lib.ask).not.toHaveBeenCalledWith("log a feeling", expect.anything());
  });

  test("zero accepted lines (e.g. Halseth 404) -> no handoff from anything else, and no SOMA write", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { lib, wq } = await run(CLERK_JSON, makeLibrarian(() => ({ ok: false, status: 404 })));
    expect(lib.writeHandoff).not.toHaveBeenCalled();
    expect(lib.writeWmNote).not.toHaveBeenCalled();
    expect(wq.queued).not.toContain(`somaUpdate:${CH}`);
    warn.mockRestore();
  });

  const staleLines = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map((a) => String(a[0])).filter((l) => l.includes("STALE_HANDOFF"));

  test("L2b: one greppable STALE_HANDOFF line per no-handoff pass, with the reason", async () => {
    const cases: Array<[string | null, ((e: any) => any) | undefined, string]> = [
      [CLERK_JSON, () => ({ ok: false, status: 404 }), "reason=404"],
      [CLERK_JSON, () => ({ ok: false, status: 422, rule: "health" }), "reason=422:health"],
      ["no json here", undefined, "reason=no_lines"],
    ];
    for (const [reply, impl, want] of cases) {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      await run(reply, makeLibrarian(impl));
      expect(staleLines(warn)).toEqual([`[ledger] STALE_HANDOFF companion=drevan channel=${CH} ${want}`]);
      warn.mockRestore();
    }
  });

  test("L2b: transport failure after every retry -> reason=transport; clean and all-duplicate passes log nothing stale", async () => {
    _setLedgerRetrySleepForTests(async () => {});
    try {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const { lib } = await run(CLERK_JSON, makeLibrarian(() => { throw new Error("writeLedger transient 503"); }));
      expect(lib.writeLedger).toHaveBeenCalledTimes(4 + 1); // line 0: 1 + 3 retries; line 1: one attempt (Halseth is down)
      expect(staleLines(warn)).toEqual([`[ledger] STALE_HANDOFF companion=drevan channel=${CH} reason=transport`]);
      warn.mockClear();
      await run(CLERK_JSON);
      await run(CLERK_JSON, makeLibrarian(() => ({ ok: true, id: "led_d", duplicate: true })));
      expect(staleLines(warn)).toEqual([]);
      warn.mockRestore();
    } finally { _setLedgerRetrySleepForTests(null); }
  });

  test("M3: the inactive path retries a transient failure and still writes the handoff", async () => {
    _setLedgerRetrySleepForTests(async () => {});
    try {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      let n = 0;
      const lib = makeLibrarian((e) => { if (n++ === 0) throw new Error("writeLedger transient 502"); return { ok: true, id: `led_${n}`, content: rendered(e.body) }; });
      await run(CLERK_JSON, lib);
      expect(lib.writeLedger).toHaveBeenCalledTimes(3);
      expect(lib.writeHandoff).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    } finally { _setLedgerRetrySleepForTests(null); }
  });

  test("L4b: the clerk reads this bot's turns by name; no extract runs", async () => {
    const lib = makeLibrarian();
    const hist = [
      { role: "user" as const, content: "which episode next", authorName: "Raziel", timestamp: T0 },
      { role: "assistant" as const, content: "held, not slow", timestamp: T1 },
    ];
    const clerk = { generate: jest.fn(async (_s: string, _m: any[]) => CLERK_JSON) };
    const inference = { generate: jest.fn(async (_s: string, _m: any[]) => EXTRACT) };
    const wq = makeWq();
    await distillSessionOnInactive(CH, { get: () => hist, clear: jest.fn() } as any, lib as any, inference as any, wq as any, prompts, clerk as any);
    await wq.drain();
    expect(clerk.generate.mock.calls[0]![1][0].content).toBe("Raziel: which episode next\nDrevan: held, not slow");
    expect(inference.generate).not.toHaveBeenCalled();
  });

  test("clerk prose (no JSON) -> no POST, no handoff, no throw", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { lib } = await run("I held the session well.");
    expect(lib.writeLedger).not.toHaveBeenCalled();
    expect(lib.writeHandoff).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("knob OFF: the four legacy writes queue, writeLedger never called, handoff summary is the synth", async () => {
    process.env["LEDGER_DISTILL"] = "off";
    const lib = makeLibrarian();
    const stmStore = { get: () => history, clear: jest.fn() };
    const inference = { generate: jest.fn<() => Promise<string>>().mockResolvedValueOnce("synth note").mockResolvedValueOnce(EXTRACT) };
    const clerk = { generate: jest.fn(async () => CLERK_JSON) };
    const wq = makeWq();
    await distillSessionOnInactive(CH, stmStore as any, lib as any, inference as any, wq as any, prompts, clerk as any);
    await wq.drain();
    expect(clerk.generate).not.toHaveBeenCalled();
    expect(lib.writeLedger).not.toHaveBeenCalled();
    expect(wq.queued.slice(0, 4)).toEqual([`witnessLog:${CH}`, `synthesize:${CH}`, `promptCtx:${CH}`, `wmNote:${CH}`]);
    expect(lib.witnessLog).toHaveBeenCalledWith("synth note", CH);
    expect(lib.writeWmNote).toHaveBeenCalledWith("synth note", CH);
    expect((lib.writeHandoff.mock.calls[0] as unknown[])[0]).toMatchObject({ summary: "synth note", title: "extract title", open_loops: ["extract loop"], state_hint: "heat: steady" });
    // Knob-off parity: the exact legacy queue order, SOMA update and feeling log included.
    expect(wq.queued).toEqual([`witnessLog:${CH}`, `synthesize:${CH}`, `promptCtx:${CH}`, `wmNote:${CH}`, `handoff:${CH}`, `somaUpdate:${CH}`, `feeling:${CH}`]);
    expect(lib.ask).toHaveBeenCalledWith("update my state", JSON.stringify({ heat: "steady" }));
    expect(lib.ask).toHaveBeenCalledWith("log a feeling", expect.stringContaining("settled"));
  });
});

// ── runDistillation ─────────────────────────────────────────────────────────

describe("runDistillation (LEDGER_DISTILL on)", () => {
  const window = [
    { role: "user" as const, content: "rough morning", authorName: "Raziel", timestamp: T0 },
    { role: "assistant" as const, content: "here", authorName: "Drevan", timestamp: T1 },
  ];
  const BLOCKS = JSON.stringify({ persona_blocks: [{ block_type: "t", content: "p" }], human_blocks: [{ block_type: "t", content: "Raziel had a rough morning" }] });

  test("persona/human blocks unchanged; [discord:distillation] wm note replaced by distiller lines with a window source", async () => {
    const lib = makeLibrarian();
    const wq = makeWq();
    const inference = { generate: jest.fn(async () => BLOCKS) };
    const clerk = { generate: jest.fn(async () => CLERK_JSON) };
    await runDistillation(CH, { get: () => window } as any, lib as any, inference as any, wq as any, "distill", 2, "Raziel", "drevan", clerk as any);
    await wq.drain();
    expect(lib.writePersonaBlocks).toHaveBeenCalled();
    expect(lib.writeHumanBlocks).toHaveBeenCalled();
    expect(lib.writeWmNote).not.toHaveBeenCalled();
    const c = lib.writeLedger.mock.calls.map((x) => x[0] as any);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ companion_id: "drevan", function: "distiller", source_kind: "window", source_ref: `${CH} 00:11–00:40`, dedup_key: `distill-mid:drevan:${CH}:${T0S}:0` });
  });

  test("M3: the mid-session path (inside the write queue) retries a transient failure itself", async () => {
    _setLedgerRetrySleepForTests(async () => {});
    try {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      let n = 0;
      const lib = makeLibrarian((e) => { if (n++ < 2) throw new Error("writeLedger transient 503"); return { ok: true, id: `led_${n}`, content: rendered(e.body) }; });
      const wq = makeWq();
      const selfWindow = [window[0]!, { role: "assistant" as const, content: "here", timestamp: T1 }];
      const clerk = { generate: jest.fn(async (_s: string, _m: any[]) => CLERK_JSON) };
      await runDistillation(CH, { get: () => selfWindow } as any, lib as any, { generate: async () => BLOCKS } as any, wq as any, "distill", 2, "Raziel", "drevan", clerk as any);
      await wq.drain();
      const keys = lib.writeLedger.mock.calls.map((c) => (c[0] as any).dedup_key);
      const k = (i: number) => `distill-mid:drevan:${CH}:${T0S}:${i}`;
      expect(keys).toEqual([k(0), k(0), k(0), k(1)]);
      // L4b on this path too: the window's own assistant turn reaches the clerk by name.
      expect(clerk.generate.mock.calls[0]![1][0].content).toBe("Raziel: rough morning\nDrevan: here");
      warn.mockRestore();
    } finally { _setLedgerRetrySleepForTests(null); }
  });

  test("owner absent from the window -> no clerk call either (same gate as the old note)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const lib = makeLibrarian();
    const wq = makeWq();
    const clerk = { generate: jest.fn(async () => CLERK_JSON) };
    const sibOnly = window.map((m) => ({ ...m, authorName: "Cypher" }));
    await runDistillation(CH, { get: () => sibOnly } as any, lib as any, { generate: async () => BLOCKS } as any, wq as any, "distill", 2, "Raziel", "drevan", clerk as any);
    await wq.drain();
    expect(clerk.generate).not.toHaveBeenCalled();
    expect(lib.writeLedger).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("knob OFF writes the legacy [discord:distillation] note and no ledger line", async () => {
    process.env["LEDGER_DISTILL"] = "off";
    const lib = makeLibrarian();
    const wq = makeWq();
    await runDistillation(CH, { get: () => window } as any, lib as any, { generate: async () => BLOCKS } as any, wq as any, "distill", 2, "Raziel", "drevan");
    await wq.drain();
    expect(lib.writeWmNote).toHaveBeenCalledWith("[discord:distillation] Raziel had a rough morning", CH);
    expect(lib.writeLedger).not.toHaveBeenCalled();
  });
});

// ── day-distillation ────────────────────────────────────────────────────────

describe("runDayDistillation (LEDGER_DISTILL on)", () => {
  const frags = [
    { note_id: "wmn_newest", agent_id: "drevan", content: "late thread", created_at: "2026-09-26 04:01:00" },
    { note_id: "wmn_oldest", agent_id: "drevan", content: "early thread", created_at: "2026-09-26 03:23:00" },
  ];
  const makeDeps = (clerkReply: string | null, ledgerImpl?: (e: any) => any) => {
    const lib = makeLibrarian(ledgerImpl);
    lib.getRecentNotes.mockImplementation((async (o?: { noteType?: string }) => o?.noteType === FRAGMENT_NOTE_TYPE ? frags : []) as any);
    const clerk = { generate: jest.fn(async () => clerkReply) };
    const adapter = { generate: jest.fn(async () => "a first-person day note") };
    return { lib, clerk, adapter, deps: { companionId: "drevan", librarian: lib as any, adapter: () => adapter as any, clerk: () => clerk as any } };
  };

  test("clerk lines, row source = oldest folded fragment, no first-person day note, then demote", async () => {
    const m = makeDeps(CLERK_JSON);
    expect(await runDayDistillation(m.deps)).toBe("written");
    expect(m.adapter.generate).not.toHaveBeenCalled();
    expect(m.clerk.generate).toHaveBeenCalledWith(LEDGER_CLERK_PROMPT, expect.any(Array), 0.3, 800, expect.stringMatching(/^ledger-day-drevan-/));
    expect(m.lib.writeWmNote).not.toHaveBeenCalled();
    const dayKey = new Date().toISOString().slice(0, 10);
    const c = m.lib.writeLedger.mock.calls.map((x) => x[0] as any);
    expect(c[0]).toMatchObject({ companion_id: "drevan", function: "distiller", source_kind: "row", source_ref: "wm_continuity_notes:wmn_oldest", dedup_key: `daydistill:drevan:${dayKey}:0`, observed_on: dayKey });
    expect(m.lib.demoteNotes).toHaveBeenCalledWith(FRAGMENT_NOTE_TYPE, new Date("2026-09-26T04:01:00Z").toISOString());
  });

  test("no line accepted -> fragments NOT demoted ('failed')", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const m = makeDeps(CLERK_JSON, () => ({ ok: false, status: 422, rule: "no_self" }));
    expect(await runDayDistillation(m.deps)).toBe("failed");
    expect(m.lib.demoteNotes).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("all duplicates (a restart re-run the same day) -> 'skipped_done', no second demote", async () => {
    const m = makeDeps(CLERK_JSON, () => ({ ok: true, id: "x", duplicate: true }));
    expect(await runDayDistillation(m.deps)).toBe("skipped_done");
    expect(m.lib.demoteNotes).not.toHaveBeenCalled();
  });
});

// ── consolidation ───────────────────────────────────────────────────────────

describe("consolidateSession (LEDGER_DISTILL on)", () => {
  // The narrator path needs a readable identity file (buildNarratorPrompt); without one it falls
  // back to the Hermes `inference` adapter.
  let dir = "";
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-ident-"));
    for (const c of ["CYPHER", "DREVAN", "GAIA"]) {
      const f = join(dir, `${c}.md`);
      // loadIdentity refuses a file under 500 chars as a broken deploy.
      writeFileSync(f, `# ${c} identity\n` + "Voice line for the test narrator. ".repeat(30));
      saved[c] = process.env[`${c}_IDENTITY_PATH`];
      process.env[`${c}_IDENTITY_PATH`] = f;
    }
  });
  afterAll(() => {
    for (const c of Object.keys(saved)) {
      if (saved[c] === undefined) delete process.env[`${c}_IDENTITY_PATH`]; else process.env[`${c}_IDENTITY_PATH`] = saved[c];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const NARRATED = JSON.stringify({ title: "A quiet window.", summary: "Nothing moved. The blade stayed sheathed.", state_hint: "at_rest", open_loops: ["the tea question"] });
  const makeLib = (ledgerImpl?: (e: any) => any) => {
    const lib = makeLibrarian(ledgerImpl);
    lib.ask.mockResolvedValue("SOMA: acuity 0.6. Last note to Raziel: about tea.");
    return lib;
  };

  beforeEach(() => _resetConsolidationWarningsForTests());
  const NOW = Date.UTC(2026, 8, 26, 14, 5, 42);
  const LAST = Date.UTC(2026, 8, 26, 11, 20);

  test("M1: ONE deterministic line, no clerk model call, NO handoff row; spine stays the narrator's", async () => {
    const lib = makeLib();
    const narrator = { generate: jest.fn(async () => NARRATED) };
    const bootCtx = { sessionId: "sess-old" };
    const r = await consolidateSession({ companionId: "cypher", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session: { surface: "discord:cypher", bootCtx }, lastActivityMs: LAST, now: () => NOW });
    expect(r).toEqual({ written: true });
    expect(narrator.generate).toHaveBeenCalledTimes(1); // the narrator only -- no clerk call
    const c = lib.writeLedger.mock.calls.map((x) => x[0] as any);
    expect(c).toHaveLength(1);
    expect(c[0]).toEqual({
      companion_id: "cypher", function: "distiller",
      body: "Recorded: idle consolidation at 14:05 UTC; no conversation in this session since 11:20.",
      source_kind: "session", source_ref: "sess-old", observed_on: "2026-09-26",
      dedup_key: "consolidation:cypher:sess-old:2026-09-26T14:05",
    });
    // The state row never reaches the ledger.
    expect(c[0].body).not.toMatch(/acuity|0\.6|tea/);
    // Last fix pass: the idle pass writes no wm_session_handoffs row, so orient's latest-3 read keeps
    // the real handoffs (32 consolidation vs 1 distillation in two days of prod).
    expect(lib.writeHandoff).not.toHaveBeenCalled();
    expect((lib.sessionClose.mock.calls[0] as unknown[])[0]).toMatchObject({ sessionId: "sess-old", spine: "Nothing moved. The blade stayed sheathed.", closeKind: "consolidation" });
    expect(bootCtx.sessionId).toBe("sess-new");
  });

  test("M2: the body passes the grammar with a session source; unknown last activity drops the clause; an earlier day carries its date", () => {
    const src = { kind: "session", ref: "sess-1" };
    for (const b of [consolidationLedgerBody(NOW, LAST), consolidationLedgerBody(NOW, null), consolidationLedgerBody(NOW, Date.UTC(2026, 8, 25, 23, 10))]) {
      expect(preflightLedgerBody(b, src)).toBeNull();
    }
    expect(consolidationLedgerBody(NOW, null)).toBe("Recorded: idle consolidation at 14:05 UTC.");
    expect(consolidationLedgerBody(NOW, undefined)).toBe("Recorded: idle consolidation at 14:05 UTC.");
    expect(consolidationLedgerBody(NOW, Date.UTC(2026, 8, 25, 23, 10))).toBe("Recorded: idle consolidation at 14:05 UTC; no conversation in this session since 2026-09-25 23:10.");
    expect(consolidationDedupKey("gaia", "s", NOW)).toBe("consolidation:gaia:s:2026-09-26T14:05");
  });

  test("M2: each later tick is a NEW line under a new minute key; never a handoff row", async () => {
    const lib = makeLib();
    const narrator = { generate: jest.fn(async () => NARRATED) };
    const session = { surface: "s", bootCtx: { sessionId: "sess-1" } };
    const r1 = await consolidateSession({ companionId: "drevan", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session, lastActivityMs: LAST, now: () => NOW });
    expect(r1).toEqual({ written: true });
    const later = NOW + 30 * 60_000;
    const r2 = await consolidateSession({ companionId: "drevan", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session: { surface: "s", bootCtx: { sessionId: "sess-1" } }, lastActivityMs: LAST, now: () => later });
    expect(r2).toEqual({ written: true });
    const keys = lib.writeLedger.mock.calls.map((x) => (x[0] as any).dedup_key);
    expect(keys).toEqual(["consolidation:drevan:sess-1:2026-09-26T14:05", "consolidation:drevan:sess-1:2026-09-26T14:35"]);
    expect(lib.writeHandoff).not.toHaveBeenCalled();
  });

  test("health-check heartbeat: the knob-on success log still says 'written via narrator'", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const lib = makeLib();
    const narrator = { generate: jest.fn(async () => NARRATED) };
    await consolidateSession({ companionId: "cypher", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session: { surface: "s", bootCtx: { sessionId: "sess-2" } }, now: () => NOW });
    const lines = log.mock.calls.map((a) => String(a[0]));
    expect(lines.some((l) => l.includes("[consolidation]") && l.includes("written via narrator"))).toBe(true);
    log.mockRestore();
  });

  test("knob OFF is unchanged: the consolidation still writes its handoff row", async () => {
    process.env["LEDGER_DISTILL"] = "off";
    const lib = makeLib();
    const narrator = { generate: jest.fn(async () => NARRATED) };
    const r = await consolidateSession({ companionId: "gaia", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session: { surface: "s", bootCtx: { sessionId: "sess-3" } }, now: () => NOW });
    expect(r).toEqual({ written: true });
    expect(lib.writeLedger).not.toHaveBeenCalled();
    expect(lib.writeHandoff).toHaveBeenCalledTimes(1);
    expect((lib.writeHandoff.mock.calls[0] as unknown[])[0]).toMatchObject({ source: "consolidation", summary: "Nothing moved. The blade stayed sheathed." });
  });

  test("M3: a transient ledger failure retries inline under the same key", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const lib = makeLib((e) => { if (n++ === 0) throw new Error("writeLedger transient 503"); return { ok: true, id: "led_1", content: rendered(e.body, e.source_kind, e.source_ref) }; });
    const narrator = { generate: jest.fn(async () => NARRATED) };
    const r = await consolidateSession({ companionId: "gaia", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session: { surface: "s", bootCtx: { sessionId: "sess-9" } }, now: () => NOW, ledgerRetryDelaysMs: [0, 0, 0] });
    expect(r).toEqual({ written: true });
    const keys = lib.writeLedger.mock.calls.map((x) => (x[0] as any).dedup_key);
    expect(keys).toEqual(["consolidation:gaia:sess-9:2026-09-26T14:05", "consolidation:gaia:sess-9:2026-09-26T14:05"]);
    warn.mockRestore();
  });

  test("L1: placeholder session id -> ONE loud warning per process; re-open on the bot surface resolves a real id", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const lib = makeLib();
    lib.sessionOpen.mockResolvedValue({} as any);  // Halseth still cannot give an id
    const narrator = { generate: jest.fn(async () => NARRATED) };
    const session = { surface: "discord:gaia", bootCtx: { sessionId: "cached" } };
    for (let i = 0; i < 3; i++) {
      const r = await consolidateSession({ companionId: "gaia", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session, now: () => NOW });
      expect(r).toEqual({ written: false, reason: "no_source" });
    }
    const loud = warn.mock.calls.map((a) => String(a[0])).filter((l) => l.includes("LOUD"));
    expect(loud).toHaveLength(1);
    expect(loud[0]).toMatch(/NO consolidation ledger line/);
    expect(lib.sessionOpen).toHaveBeenCalledWith("work", "discord:gaia");
    expect(narrator.generate).not.toHaveBeenCalled();

    // Halseth recovers: the next tick resolves an id and consolidates normally.
    lib.sessionOpen.mockResolvedValueOnce({ session_id: "sess-real" } as any);
    const r = await consolidateSession({ companionId: "gaia", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session, now: () => NOW });
    expect(r).toEqual({ written: true });
    expect((lib.writeLedger.mock.calls[0]![0] as any).source_ref).toBe("sess-real");
    expect((lib.sessionClose.mock.calls[0] as unknown[])[0]).toMatchObject({ sessionId: "sess-real" });
    warn.mockRestore();
  });

  test("no session at all -> no source, no write, and no inference spent", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const lib = makeLib();
    const narrator = { generate: jest.fn(async () => NARRATED) };
    const r = await consolidateSession({ companionId: "gaia", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any });
    expect(r).toEqual({ written: false, reason: "no_source" });
    expect(narrator.generate).not.toHaveBeenCalled();
    expect(lib.writeHandoff).not.toHaveBeenCalled();
    expect(lib.sessionOpen).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("line not accepted (404) -> no session cycle, never retried, no handoff", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const lib = makeLib(() => ({ ok: false, status: 404 }));
    const narrator = { generate: jest.fn(async () => NARRATED) };
    const r = await consolidateSession({ companionId: "drevan", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session: { surface: "s", bootCtx: { sessionId: "sess-1" } }, now: () => NOW });
    expect(r).toEqual({ written: false, reason: "no_ledger_lines" });
    expect(lib.writeLedger).toHaveBeenCalledTimes(1);
    expect(lib.writeHandoff).not.toHaveBeenCalled();
    expect(lib.sessionClose).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── Gaia's passive witness ──────────────────────────────────────────────────

describe("buildWitnessLedgerEntry", () => {
  test("subject = the sibling who spoke; message source; quoted words; inner quotes neutralised so the span closes", () => {
    const e = buildWitnessLedgerEntry({ senderCompanion: "drevan", channelName: "couch", channelId: CH, content: 'I said "held" and I meant it', messageId: "m-123" });
    expect(e).toEqual({
      companion_id: "drevan",
      function: "seen-log",
      body: `Logged: Drevan spoke in #couch without a reply from Gaia; words: "I said 'held' and I meant it"`,
      source_kind: "message",
      source_ref: "m-123",
      dedup_key: "witness:m-123",
    });
    // The sibling's own "I" sits inside the quotes -- the pre-filter (and server) exempt it.
    expect(preflightLedgerBody(e!.body)).toBeNull();
  });
  test("username fallback resolves a companion; channel id when no name; 500-char cap", () => {
    const e = buildWitnessLedgerEntry({ senderCompanion: "Cypher-bot", channelName: null, channelId: CH, content: "x".repeat(900), messageId: "m" });
    expect(e!.companion_id).toBe("cypher");
    expect(e!.body).toContain(`#${CH}`);
    expect(e!.body.endsWith(`"${"x".repeat(500)}"`)).toBe(true);
  });
  test("L4a: words that trip the number/lexicon rules -> the line WITHOUT the quote (not a 422)", () => {
    for (const content of ["my glucose was 187 after lunch", "vevan, stay", "Source: me"]) {
      const e = buildWitnessLedgerEntry({ senderCompanion: "drevan", channelName: "couch", channelId: CH, content, messageId: "m-9" });
      expect(e!.body).toBe("Logged: Drevan spoke in #couch without a reply from Gaia.");
      expect(preflightLedgerBody(e!.body, { kind: "message", ref: "m-9" })).toBeNull();
    }
  });
  test("L4a: a channel NAME that trips the number rule falls back to the channel id", () => {
    const e = buildWitnessLedgerEntry({ senderCompanion: "cypher", channelName: "room-42", channelId: CH, content: "187", messageId: "m" });
    expect(e!.body).toBe(`Logged: Cypher spoke in #${CH} without a reply from Gaia.`);
  });
  test("unknown sender or Gaia herself -> null (no subject to file under)", () => {
    expect(buildWitnessLedgerEntry({ senderCompanion: "somebot", channelName: "c", channelId: CH, content: "hi", messageId: "m" })).toBeNull();
    expect(buildWitnessLedgerEntry({ senderCompanion: "gaia", channelName: "c", channelId: CH, content: "hi", messageId: "m" })).toBeNull();
  });
});

// ── Final sync pass (2026-09-26): the companion-subject rule, the address/lexicon clauses, commons opt-in ──

describe("preflightLedgerBody: companion subjects, address and lexicon (ported from halseth's grammar)", () => {
  test("a companion is never the subject of a feeling verb (rule `interior`); humans may love in running text", () => {
    expect(preflightLedgerBody("Recorded: Drevan loves Raziel.")).toBe("interior");
    expect(preflightLedgerBody("Recorded: Cypher misses Gaia.")).toBe("interior");
    expect(preflightLedgerBody("Logged: Cy really needs quiet.")).toBe("interior");
    expect(preflightLedgerBody("Logged: Blue loves Decker.")).toBeNull();
    expect(preflightLedgerBody('Logged: Drevan said "I love you" at 00:12.')).toBeNull();
    expect(preflightLedgerBody("Logged: the cypress needs water.")).toBeNull();
  });
  test("address words only when they name someone; the beloved book is a book", () => {
    expect(preflightLedgerBody("Logged: Raziel, sweetheart.")).toBe("address");
    expect(preflightLedgerBody("Logged: the beloved book was returned.")).toBeNull();
    expect(preflightLedgerBody('Logged: Raziel said "love you, baby".')).toBeNull();
  });
  test("handoff metadata drops a companion-feeling title and an address", () => {
    const r = parseClerkResult(JSON.stringify({ title: "Drevan loves the couch", lines: [], open_loops: ["tea, honey", "Raziel asked about tea"] }));
    expect(r?.title).toBeUndefined();
    expect(r?.open_loops).toEqual(["Raziel asked about tea"]);
  });
  test("the clerk prompt carries the address/lexicon rule and the no-companion-feelings rule", () => {
    expect(LEDGER_CLERK_PROMPT).toMatch(/Never call anyone anything/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/never use the triad's private words/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/A companion's feelings are never recorded/);
    expect(LEDGER_CLERK_PROMPT).toMatch(/quote the exact words\) and what they did/);
  });
});

describe("LibrarianClient.commonsSupply opts into ledger rows", () => {
  test("sends ?kinds=notes,ledger (halseth serves sibling ledger lines only on opt-in)", async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ notes: [] }) }) as unknown as Response);
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "gaia", fetch: fetchFn as never });
    await expect(client.commonsSupply(2)).resolves.toEqual([]);
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    const u = new URL(url);
    expect(u.pathname).toBe("/mind/commons-supply/gaia");
    expect(u.searchParams.get("limit")).toBe("2");
    expect(u.searchParams.get("kinds")).toBe("notes,ledger");
  });
});

describe("Gaia's rulings in the bots (2026-09-26)", () => {
  test("presence record: the exact content-free template, HH:MM UTC", () => {
    expect(presenceRecordText("couch", new Date("2026-09-26T04:07:59Z"))).toBe("Present, silent. #couch 04:07 UTC.");
    expect(presenceRecordText(CH, new Date("2026-09-26T23:30:00Z"))).toBe(`Present, silent. #${CH} 23:30 UTC.`);
    expect(PRESENCE_WITNESS_TYPE).toBe("presence");
  });

  test("presence coalesces to one per channel per 30 minutes; channels are independent", () => {
    resetPresenceSlots();
    const t = 1_000_000;
    expect(claimPresenceSlot("a", t)).toBe(true);
    expect(claimPresenceSlot("a", t + PRESENCE_COALESCE_MS - 1)).toBe(false);
    expect(claimPresenceSlot("b", t + 1)).toBe(true);
    expect(claimPresenceSlot("a", t + PRESENCE_COALESCE_MS)).toBe(true);
    resetPresenceSlots();
  });

  test("seen-log: the witness line carries the new function; a quote touching grief falls back to the quoteless line", () => {
    const e = buildWitnessLedgerEntry({ senderCompanion: "drevan", channelName: "couch", channelId: CH, content: "his mom called", messageId: "m-7" });
    expect(e).toMatchObject({ function: "seen-log", body: "Logged: Drevan spoke in #couch without a reply from Gaia." });
  });

  test("preflight: witnessed (quotes included) and interiority, like the server", () => {
    expect(preflightLedgerBody('Logged: Raziel said "my mom" at 00:12.')).toBe("witnessed");
    expect(preflightLedgerBody("Logged: the car battery was dead.")).toBe("witnessed");
    expect(preflightLedgerBody("Logged: Raziel mentioned the mummy film.")).toBeNull();
    expect(preflightLedgerBody("Counted: 3 interiority entries.")).toBe("interiority");
    expect(preflightLedgerBody("Logged: the interior of the truck was cleaned.")).toBeNull();
    expect(preflightLedgerBody("Logged: a row was read.", { kind: "row", ref: "companion_interiority:x1" })).toBe("interiority");
  });
});

// ── B41 (2026-09-30): the clerk writes with the ADMIN token ─────────────────
// Halseth's POST /ledger refuses a companion token by design. The bots authenticate with
// <C>_HALSETH_SECRET, and writeLedger used to send it: ~430 refusals, 1 ledger row ever.

describe("clerk token (B41)", () => {
  const entry = { companion_id: "cypher" as const, function: "distiller" as const, body: "Logged: x.", source_kind: "window" as const, source_ref: "r", dedup_key: "k:1" };
  const saved = process.env["HALSETH_SECRET"];
  afterEach(() => { if (saved === undefined) delete process.env["HALSETH_SECRET"]; else process.env["HALSETH_SECRET"] = saved; });
  const mk = (opts: { clerkSecret?: string } = {}) => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchMock = jest.fn(async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.Authorization });
      return new Response(JSON.stringify({ id: "led_1", content: "c", response_key: "ok", ack: true }), { status: 201, headers: { "content-type": "application/json" } });
    });
    return { c: new LibrarianClient({ url: "https://h.example", secret: "companion-tok", companionId: "cypher", fetch: fetchMock as any, ...opts }), calls };
  };

  test("writeLedger sends HALSETH_SECRET (admin), not the companion token", async () => {
    process.env["HALSETH_SECRET"] = "admin-tok";
    const { c, calls } = mk();
    await c.writeLedger(entry);
    expect(calls[0]!.auth).toBe("Bearer admin-tok");
  });
  test("every other call keeps the companion's own token", async () => {
    process.env["HALSETH_SECRET"] = "admin-tok";
    const { c, calls } = mk();
    await c.ask("my tray").catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(k => k.auth === "Bearer companion-tok")).toBe(true);
  });
  test("an explicit clerkSecret wins; no admin env falls back to the companion token (today's behaviour)", async () => {
    process.env["HALSETH_SECRET"] = "admin-tok";
    const a = mk({ clerkSecret: "explicit-tok" });
    await a.c.writeLedger(entry);
    expect(a.calls[0]!.auth).toBe("Bearer explicit-tok");
    delete process.env["HALSETH_SECRET"];
    const b = mk();
    await b.c.writeLedger(entry);
    expect(b.calls[0]!.auth).toBe("Bearer companion-tok");
  });
  test("clerkSecretFrom strips the leading = and ignores blanks, like config.ts", () => {
    expect(clerkSecretFrom({ HALSETH_SECRET: "==admin " }, undefined, "fb")).toBe("admin");
    expect(clerkSecretFrom({ HALSETH_SECRET: "  " }, "", "fb")).toBe("fb");
    expect(clerkSecretFrom({}, undefined, "fb")).toBe("fb");
  });
});
