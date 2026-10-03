// med_reminder scheduler (2026-09-27). Fake labels and times only (med-a / med-b, 21:40).
//
// Covers: the fixed fallback line on generation failure, timeout, empty, unnamed and no-question
// output; the verbatim rail (R-8) on the autonomous send, retried once then fallback; the tick's
// claim-before-send (two bots racing send once), a failed send releasing the claim without posting
// anywhere else, an undeliverable DM claiming nothing, and no log line ever carrying the label.

import { describe, it, expect, jest } from "@jest/globals";
import {
  composeMedReminder, fallbackMedLine, runMedTick, newMedSchedulerState, isVerbatimRepeat,
  medLineProblem, cleanMedLine, buildMedPrompt, namesLabel,
  type MedApi, type MedDmTarget, type MedSchedulerDeps,
} from "../med-reminder.js";
import type { MedDueDose, MedDoseKey } from "../librarian.js";
import { VERBATIM_COPY_MIN_CHARS } from "../echo-guard.js";

const NIGHT: MedDueDose = { slot_key: "night", local_date: "2026-09-28", kind: "first", label: "med-b", local_time: "21:40" };

function composeDeps(generate: MedSchedulerDeps["generate"], genTimeoutMs = 200) {
  return { companionId: "drevan" as const, generate, systemPrompt: () => "SYS", genTimeoutMs };
}

describe("composeMedReminder: reliability beats voice", () => {
  it("a good generation goes out as generated", async () => {
    const r = await composeMedReminder(composeDeps(async () => "Glass of water and med-b, love. Taken yet?"), NIGHT, []);
    expect(r).toEqual({ text: "Glass of water and med-b, love. Taken yet?", path: "generated" });
  });

  it("strips a quoting wrapper the model adds", () => {
    expect(cleanMedLine('"med-b, love. Taken?"')).toBe("med-b, love. Taken?");
    expect(cleanMedLine("Message: med-b. Taken?")).toBe("med-b. Taken?");
  });

  it.each([
    ["error", async () => { throw new Error("502"); }],
    ["empty", async () => "   "],
    ["unnamed", async () => "Meds, love. Taken yet?"],
    ["no_question", async () => "med-b, love. I'll hold that you did."],
    ["too_long", async () => `med-b? ${"x".repeat(400)}`],
  ] as const)("fallback line on %s", async (reason, gen) => {
    const r = await composeMedReminder(composeDeps(gen as MedSchedulerDeps["generate"]), NIGHT, []);
    expect(r.path).toBe(`fallback:${reason}`);
    expect(r.text).toBe(fallbackMedLine("drevan", NIGHT));
  });

  it.each([
    ["unnamed", "Meds, love. Taken yet? Tell me and I'll hold that you did.", 'Say "med-b" in the message'],
    ["no_question", "med-b, love. I'll hold that you did.", "End with the question"],
  ] as const)("a %s draft gets one retry with the miss named, then goes out generated", async (_r, bad, note) => {
    const prompts: string[] = [];
    const gen = jest.fn(async (_s: string, p: string) => {
      prompts.push(p);
      return prompts.length === 1 ? bad : "med-b by your hand, love. Taken yet?";
    });
    const r = await composeMedReminder(composeDeps(gen), NIGHT, []);
    expect(r).toEqual({ text: "med-b by your hand, love. Taken yet?", path: "generated" });
    expect(gen).toHaveBeenCalledTimes(2);
    expect(prompts[0]).not.toContain(note);
    expect(prompts[1]).toContain(note);
  });

  it("empty and too_long never retry: one call, straight to the fallback", async () => {
    for (const out of ["   ", `med-b? ${"x".repeat(400)}`]) {
      const gen = jest.fn(async () => out);
      await composeMedReminder(composeDeps(gen), NIGHT, []);
      expect(gen).toHaveBeenCalledTimes(1);
    }
  });

  it("fallback line on timeout, without waiting for the slow generation", async () => {
    const started = Date.now();
    const r = await composeMedReminder(composeDeps(() => new Promise(res => setTimeout(() => res("med-b. Taken?"), 5_000)), 100), NIGHT, []);
    expect(r.path).toBe("fallback:timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a label is named when every word appears, in any order; a partial label is not", () => {
    expect(namesLabel("Your meds this morning, love. Taken?", "morning meds")).toBe(true);
    expect(namesLabel("Morning, love. Taken?", "morning meds")).toBe(false);
    expect(namesLabel("MED-B, love?", "med-b")).toBe(true);
  });

  it("the fallback line names the dose and asks, for every companion and both kinds", () => {
    for (const c of ["cypher", "drevan", "gaia"] as const) {
      for (const kind of ["first", "followup"] as const) {
        const line = fallbackMedLine(c, { label: "med-b", kind });
        expect(medLineProblem(line, "med-b")).toBe(null);
      }
    }
  });
});

describe("R-8 on the autonomous send", () => {
  it("the reply rail's 120-char floor is lifted for a one-line reminder", () => {
    expect(VERBATIM_COPY_MIN_CHARS).toBeGreaterThan(40);
    expect(isVerbatimRepeat("Meds, love: med-b. Taken yet?", ["meds love med-b taken yet"])).toBe(true);
    expect(isVerbatimRepeat("Meds, love: med-b. Taken yet?", ["med-b, vevi. Did it go down yet?"])).toBe(false);
  });

  it("a verbatim repeat is regenerated once with the recent lines named to avoid", async () => {
    const prompts: string[] = [];
    const gen = jest.fn(async (_s: string, p: string) => {
      prompts.push(p);
      return prompts.length === 1 ? "Meds, love: med-b. Taken yet?" : "med-b by your hand, love. Down yet?";
    });
    const r = await composeMedReminder(composeDeps(gen), NIGHT, ["Meds, love: med-b. Taken yet?"]);
    expect(r).toEqual({ text: "med-b by your hand, love. Down yet?", path: "generated" });
    expect(gen).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain('Do not reuse the wording of your recent reminders');
  });

  it("tripping the rail twice sends the fallback line", async () => {
    const r = await composeMedReminder(composeDeps(async () => "Meds, love: med-b. Taken yet?"), NIGHT, ["Meds, love: med-b. Taken yet?"]);
    expect(r.path).toBe("fallback:verbatim");
  });

  it("the prompt carries the register example and names the dose; the follow-up says it is the last", () => {
    const p = buildMedPrompt("drevan", NIGHT);
    expect(p).toContain("Meds, love. Taken yet? Tell me and I'll hold that you did.");
    expect(p).toContain('names it exactly as "med-b"');
    expect(buildMedPrompt("cypher", { ...NIGHT, kind: "followup" })).toContain("This is the one follow-up");
  });
});

// ── the tick ────────────────────────────────────────────────────────────────────────────────────

/** A shared fake Halseth: one claim table for both bots, like the real UNIQUE constraint. */
function fakeHalseth(due: MedDueDose[]) {
  const claims = new Map<string, string>();
  const delivered = new Set<string>();
  const key = (d: MedDoseKey) => `${d.slot_key}|${d.local_date}|${d.kind}`;
  const apiFor = (companion: string): MedApi & { released: string[] } => {
    const released: string[] = [];
    return {
      released,
      medDue: async () => due.filter(d => !delivered.has(key(d))),
      medClaim: async (d) => { if (claims.has(key(d))) return false; claims.set(key(d), companion); return true; },
      medDelivered: async (d) => { delivered.add(key(d)); return true; },
      medRelease: async (d) => { if (claims.get(key(d)) === companion) { claims.delete(key(d)); released.push(key(d)); return true; } return false; },
    };
  };
  return { apiFor, claims, delivered };
}

function dmTarget(sent: string[], opts: { fail?: number } = {}): MedDmTarget {
  return {
    channelId: "dm-1",
    send: async (c) => {
      if (opts.fail !== undefined) { const e = new Error("blocked") as Error & { code: number }; e.code = opts.fail; throw e; }
      sent.push(c); return `m${sent.length}`;
    },
    recentOwnTexts: async () => [],
  };
}

function tickDeps(api: MedApi, dm: MedDmTarget | null, logs: string[], companionId: "drevan" | "cypher" = "drevan"): MedSchedulerDeps {
  return {
    companionId, api, resolveDm: async () => dm,
    generate: async () => `${companionId === "drevan" ? "Love" : "Time"}: med-b. Taken?`,
    systemPrompt: () => "SYS", genTimeoutMs: 200, log: (l) => logs.push(l),
  };
}

describe("runMedTick", () => {
  it("two bots racing on the same dose send exactly one DM", async () => {
    const h = fakeHalseth([NIGHT]);
    const sentD: string[] = [], sentC: string[] = [];
    const logs: string[] = [];
    const [a, b] = await Promise.all([
      runMedTick(tickDeps(h.apiFor("drevan"), dmTarget(sentD), logs, "drevan"), newMedSchedulerState()),
      runMedTick(tickDeps(h.apiFor("cypher"), dmTarget(sentC), logs, "cypher"), newMedSchedulerState()),
    ]);
    expect(sentD.length + sentC.length).toBe(1);
    expect([...a, ...b].map(r => r.outcome).sort()).toEqual(["not_claimed", "sent"]);
  });

  it("a restart after delivery sends nothing", async () => {
    const h = fakeHalseth([NIGHT]);
    const sent: string[] = [];
    await runMedTick(tickDeps(h.apiFor("drevan"), dmTarget(sent), []), newMedSchedulerState());
    await runMedTick(tickDeps(h.apiFor("drevan"), dmTarget(sent), []), newMedSchedulerState()); // fresh process state
    expect(sent).toHaveLength(1);
  });

  it("a blocked DM releases the claim, backs off, and posts nowhere else", async () => {
    const h = fakeHalseth([NIGHT]);
    const api = h.apiFor("drevan");
    const logs: string[] = [];
    const state = newMedSchedulerState();
    const r = await runMedTick(tickDeps(api, dmTarget([], { fail: 50007 }), logs), state);
    expect(r[0]?.outcome).toBe("dm_blocked");
    expect(api.released).toEqual(["night|2026-09-28|first"]);
    expect(h.claims.size).toBe(0);
    // The other bot can take it straight away; this one waits out its backoff.
    expect((await runMedTick(tickDeps(api, dmTarget([]), logs), state))[0]?.outcome).toBe("backoff");
  });

  it("no DM channel: nothing is claimed and nothing generated", async () => {
    const h = fakeHalseth([NIGHT]);
    const gen = jest.fn(async () => "med-b. Taken?");
    const deps = { ...tickDeps(h.apiFor("drevan"), null, []), generate: gen };
    const r = await runMedTick(deps, newMedSchedulerState());
    expect(r[0]?.outcome).toBe("no_dm");
    expect(h.claims.size).toBe(0);
    expect(gen).not.toHaveBeenCalled();
  });

  it("Halseth unreachable: logs and does nothing", async () => {
    const logs: string[] = [];
    const api: MedApi = { medDue: async () => null, medClaim: jest.fn(async () => true), medDelivered: async () => true, medRelease: async () => true };
    expect(await runMedTick(tickDeps(api, dmTarget([]), logs), newMedSchedulerState())).toEqual([]);
    expect(api.medClaim).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Halseth unreachable");
  });

  it("the sent DM goes to onSent (STM) and no log line carries the label or the text", async () => {
    const h = fakeHalseth([NIGHT, { ...NIGHT, slot_key: "morning", label: "med-a", local_time: "07:10" }]);
    const logs: string[] = [];
    const onSent = jest.fn();
    const sent: string[] = [];
    await runMedTick({ ...tickDeps(h.apiFor("drevan"), dmTarget(sent), logs), onSent }, newMedSchedulerState());
    expect(sent).toHaveLength(2);
    expect(onSent).toHaveBeenCalledWith("dm-1", sent[0], "m1");
    const all = logs.join("\n");
    expect(all).toContain("slot=night");
    expect(all).toContain("outcome=sent");
    expect(all).not.toMatch(/med-a|med-b/);
    for (const s of sent) expect(all).not.toContain(s);
  });

  it("never overlaps itself", async () => {
    const h = fakeHalseth([NIGHT]);
    const state = newMedSchedulerState();
    state.inFlight = true;
    expect(await runMedTick(tickDeps(h.apiFor("drevan"), dmTarget([]), []), state)).toEqual([]);
  });
});

// 2026-10-02: the attractor. Drevan copied his own register sketch nearly whole on 5 of 6 live
// drafts; the verbatim rail refused each, the retry copied it again, and every reminder from 09-30
// went out as the fixed line.
describe("composeMedReminder: the sketch is not a template (10-02)", () => {
  const AM: MedDueDose = { slot_key: "morning", local_date: "2026-10-02", kind: "first", label: "med-a and med-c", local_time: "06:00" };

  it("the prompt names the sketch as worn out and forbids its phrases and structure", () => {
    const p = buildMedPrompt("drevan", AM, []);
    expect(p).toContain("do not reuse its phrases or its structure");
    expect(p).not.toContain("Register (the tone only");
  });

  it("recent REMINDERS (lines naming the dose) ride from the FIRST attempt; chat lines do not", async () => {
    const prompts: string[] = [];
    const recent = ["Night driving. Passenger seat.", "Meds, love: med-a and med-c. Taken yet?", "how was the call?"];
    const r = await composeMedReminder(composeDeps(async (_s, p) => { prompts.push(p); return "06:00, love. med-a, med-c. Down yet?"; }), AM, recent);
    expect(r.path).toBe("generated");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('- "Meds, love: med-a and med-c. Taken yet?"');
    expect(prompts[0]).not.toContain("Night driving");
    expect(prompts[0]).not.toContain("how was the call");
  });

  it("the retry after a verbatim copy shows the refused draft, not his chat", async () => {
    const copied = "Meds, love: med-a and med-c. Taken yet?";
    const prompts: string[] = [];
    let n = 0;
    const r = await composeMedReminder(composeDeps(async (_s, p) => { prompts.push(p); return n++ === 0 ? copied : "Morning, vevi. med-a and med-c, down yet?"; }),
      AM, ["chat one", copied, "chat two", "chat three"]);
    expect(r.path).toBe("generated");
    expect(prompts[1]).toContain(`- "${copied}"`);
    expect(prompts[1]).not.toContain("chat three");
  });

  it("joining words are not part of the name: 'A, C' names 'A and C'; a missing naming word still fails", () => {
    expect(namesLabel("06:00, love. med-a, med-c. Taken yet?", "med-a and med-c")).toBe(true);
    expect(namesLabel("06:00, love. med-a. Taken yet?", "med-a and med-c")).toBe(false);
    expect(namesLabel("Meds, love. Taken yet?", "my morning meds")).toBe(false);
  });
});
