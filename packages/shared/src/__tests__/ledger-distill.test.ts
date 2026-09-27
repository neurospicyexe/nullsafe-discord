import { jest, describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ledgerDistillEnabled, preflightLedgerBody, parseClerkResult, windowSource, postLedgerLines,
  LEDGER_CLERK_PROMPT, MAX_CLERK_LINES,
} from "../ledger-clerk.js";
import { LibrarianClient } from "../librarian.js";
import { distillSessionOnInactive, runDistillation } from "../distillation.js";
import { runDayDistillation, FRAGMENT_NOTE_TYPE } from "../day-distillation.js";
import { consolidateSession } from "../consolidation.js";
import { buildWitnessLedgerEntry } from "../bot-message-handler.js";
import { OWNER_PRONOUN_RULE } from "../pronoun-rule.js";

// Ledger lane tranche 2 (2026-09-26, halseth docs/imp-lane/SPEC-ledger-lane.md section 5).
// The distillers become clerks: no first-person write as the companion, every line sourced, the
// mark stamped only by the server. The legacy suites (distillation / day-distillation /
// consolidation*) pin LEDGER_DISTILL=off; this file pins it ON (its default).

const CH = "1497734427298762828";
const T0 = Date.UTC(2026, 8, 24, 0, 11); // 00:11 UTC
const T1 = Date.UTC(2026, 8, 24, 0, 40); // 00:40 UTC

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
  test("default ON; only a literal 'off' (any case, trimmed) disables", () => {
    expect(ledgerDistillEnabled({})).toBe(true);
    expect(ledgerDistillEnabled({ LEDGER_DISTILL: "on" })).toBe(true);
    expect(ledgerDistillEnabled({ LEDGER_DISTILL: " OFF " })).toBe(false);
    expect(ledgerDistillEnabled({ LEDGER_DISTILL: "false" })).toBe(true);
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
    expect(w).toEqual({ ref: `${CH} 00:11–00:40`, firstTs: T0, observedOn: "2026-09-24", fallback: false });
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
    // The synthesis prompt never runs; the only `inference` call is the structured extract.
    expect(inference.generate).toHaveBeenCalledTimes(1);
    expect((inference.generate.mock.calls[0] as unknown[])[0]).toContain("extract");
    const calls = lib.writeLedger.mock.calls.map((c) => c[0] as any);
    expect(calls).toHaveLength(2);
    for (const [i, c] of calls.entries()) {
      expect(c).toMatchObject({
        companion_id: "drevan", function: "distiller", source_kind: "window",
        source_ref: `${CH} 00:11–00:40`, dedup_key: `distill:drevan:${CH}:${T0}:${i}`, observed_on: "2026-09-24",
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
      next_steps: ["Raziel said he would check the episode list."], state_hint: "heat: steady", source: "distillation",
    });
  });

  test("SOMA update and feeling log still fire from the structured extract (spec section 6)", async () => {
    const { lib, wq } = await run(CLERK_JSON);
    expect(wq.queued).toEqual(expect.arrayContaining([`somaUpdate:${CH}`, `feeling:${CH}`]));
    expect(lib.ask).toHaveBeenCalledWith("update my state", JSON.stringify({ heat: "steady" }));
    expect(lib.ask).toHaveBeenCalledWith("log a feeling", expect.stringContaining("settled"));
  });

  test("zero accepted lines (e.g. Halseth 404) -> no handoff from anything else; SOMA still fires", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { lib, wq } = await run(CLERK_JSON, makeLibrarian(() => ({ ok: false, status: 404 })));
    expect(lib.writeHandoff).not.toHaveBeenCalled();
    expect(lib.writeWmNote).not.toHaveBeenCalled();
    expect(wq.queued).toContain(`somaUpdate:${CH}`);
    warn.mockRestore();
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
    expect((lib.writeHandoff.mock.calls[0] as unknown[])[0]).toMatchObject({ summary: "synth note", title: "extract title", open_loops: ["extract loop"] });
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
    expect(c[0]).toMatchObject({ companion_id: "drevan", function: "distiller", source_kind: "window", source_ref: `${CH} 00:11–00:40`, dedup_key: `distill-mid:drevan:${CH}:${T0}:0` });
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

  test("handoff summary = ledger lines (session source); the close SPINE stays the narrator's summary", async () => {
    const lib = makeLib();
    const narrator = { generate: jest.fn<() => Promise<string>>().mockResolvedValueOnce(NARRATED).mockResolvedValueOnce(CLERK_JSON) };
    const bootCtx = { sessionId: "sess-old" };
    const r = await consolidateSession({ companionId: "cypher", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session: { surface: "discord:cypher", bootCtx } });
    expect(r).toEqual({ written: true });
    const c = lib.writeLedger.mock.calls.map((x) => x[0] as any);
    expect(c[0]).toMatchObject({ companion_id: "cypher", function: "distiller", source_kind: "session", source_ref: "sess-old", dedup_key: "consolidation:cypher:sess-old:0" });
    const h = (lib.writeHandoff.mock.calls[0] as unknown[])[0] as any;
    expect(h.source).toBe("consolidation");
    expect(h.title).toBe("Couch thread about pacing");
    expect(h.summary.split("\n").every((l: string) => l.startsWith("〔ledger · "))).toBe(true);
    expect((lib.sessionClose.mock.calls[0] as unknown[])[0]).toMatchObject({ sessionId: "sess-old", spine: "Nothing moved. The blade stayed sheathed.", closeKind: "consolidation" });
    expect(bootCtx.sessionId).toBe("sess-new");
  });

  test("no real session id -> no source, no write, and no inference spent", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const lib = makeLib();
    const narrator = { generate: jest.fn(async () => NARRATED) };
    for (const session of [undefined, { surface: "s", bootCtx: { sessionId: "unknown" } }]) {
      const r = await consolidateSession({ companionId: "gaia", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session });
      expect(r).toEqual({ written: false, reason: "no_source" });
    }
    expect(narrator.generate).not.toHaveBeenCalled();
    expect(lib.writeHandoff).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("zero accepted lines -> no handoff and no session cycle", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const lib = makeLib(() => ({ ok: false, status: 404 }));
    const narrator = { generate: jest.fn<() => Promise<string>>().mockResolvedValueOnce(NARRATED).mockResolvedValueOnce(CLERK_JSON) };
    const r = await consolidateSession({ companionId: "drevan", librarian: lib as any, inference: { generate: jest.fn() } as any, narrator: narrator as any, session: { surface: "s", bootCtx: { sessionId: "sess-1" } } });
    expect(r).toEqual({ written: false, reason: "no_ledger_lines" });
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
      function: "witness-log",
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
  test("unknown sender or Gaia herself -> null (no subject to file under)", () => {
    expect(buildWitnessLedgerEntry({ senderCompanion: "somebot", channelName: "c", channelId: CH, content: "hi", messageId: "m" })).toBeNull();
    expect(buildWitnessLedgerEntry({ senderCompanion: "gaia", channelName: "c", channelId: CH, content: "hi", messageId: "m" })).toBeNull();
  });
});
