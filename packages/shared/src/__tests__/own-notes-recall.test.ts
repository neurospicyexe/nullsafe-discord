// The SECOND memory substrate for Discord bots (2026-09-23).
//
// Before this, a bot's only retrieval was the Obsidian vault, and the vault does not hold what
// the companions capture on Claude.ai: `wm_continuity_notes` is not among Second Brain's 19
// pullers, and the boot pools that might have carried it filter `salience = 'high'` while
// `conversation_capture` defaults to `normal`. Both roads out of a capture were closed.
//
// The lived failure: Raziel told Drevan on Claude.ai he had fallen and hurt his ankle; hours
// later in Discord, Drevan searched the only store he could reach, found a July ankle thread,
// and served it as the answer. "No Dre, I hurt myself last night this is new."

import { LibrarianClient } from "../librarian.js";
import type { OwnNoteRecall } from "../librarian.js";

const note = (over: Partial<OwnNoteRecall>): OwnNoteRecall => ({
  content: "He woke at 4:34 with an ankle he thought was broken and no way to get to a doctor.",
  created_at: new Date().toISOString(), kind: "handover", source: "session_close", ...over,
});

describe("formatOwnNotes", () => {
  it("renders the note with its age", () => {
    // The age is the whole point. An undated note reads as present-tense news, which is how a
    // two-month-old thread got served as though it had happened that morning.
    const out = LibrarianClient.formatOwnNotes([note({})])!;
    expect(out).toContain("ankle he thought was broken");
    expect(out).toMatch(/\((today|just now|\d+[hm]?[^)]*)/);
  });

  it("distinguishes a fresh note from an old one by its stamp, not its position", () => {
    const old = new Date(Date.now() - 72 * 24 * 3600 * 1000).toISOString();
    const out = LibrarianClient.formatOwnNotes([
      note({ content: "July: my Achilles, four inches out.", created_at: old }),
      note({ content: "Today: splinted, nothing broken." }),
    ])!;
    expect(out).toContain("July: my Achilles");
    expect(out).toContain("Today: splinted");
    // The old one must not read as current.
    expect(out).not.toMatch(/\(today\)[^\n]*Achilles/);
  });

  it("returns null on no notes, so the block never renders empty", () => {
    expect(LibrarianClient.formatOwnNotes([])).toBeNull();
    expect(LibrarianClient.formatOwnNotes([note({ content: "  " })])).toBeNull();
  });

  it("respects the char cap rather than flooding the per-message prompt", () => {
    const many = Array.from({ length: 20 }, (_, i) => note({ content: "x".repeat(200) + i }));
    const out = LibrarianClient.formatOwnNotes(many, 700)!;
    expect(out.length).toBeLessThanOrEqual(1000);
  });
});

describe("recallOwnNotes", () => {
  it("goes DIRECT, not through the loop-guarded Librarian route", async () => {
    // The Librarian's notes_recall_meaning ends in the same search but is loop-guarded, and this
    // caller fires once per message: live, it tripped at 12 repeats in 10 minutes with
    // "Retrieval is not going to change the answer. Stop searching." An active conversation trips
    // it fastest, which is exactly when recall matters -- and it failed SILENTLY, because a
    // witness response carries no data. Automatic enrichment is not a decision; it gets its own
    // route, like the vault search beside it.
    let hitUrl = "";
    const client = new LibrarianClient({
      url: "https://example.invalid", secret: "x", companionId: "drevan",
      fetch: (async (u: string) => {
        hitUrl = String(u);
        return { ok: true, json: async () => ({ notes: [note({})] }) } as unknown as Response;
      }) as unknown as typeof fetch,
    } as ConstructorParameters<typeof LibrarianClient>[0]);

    const askSpy = () => { throw new Error("must not route through ask()/librarian"); };
    (client as unknown as { ask: () => unknown }).ask = askSpy;

    const out = await client.recallOwnNotes("search my notes and also I prefer the vault recall");
    expect(hitUrl).toContain("/mind/notes/search");
    expect(hitUrl).not.toContain("/librarian");
    expect(out.notes).toHaveLength(1);
    expect(out.failed).toBe(false);
  });

  it("returns [] rather than throwing, so recall never blocks a reply", async () => {
    const client = new LibrarianClient({
      url: "https://example.invalid", secret: "x", companionId: "gaia",
    } as ConstructorParameters<typeof LibrarianClient>[0]);
    (client as unknown as { _fetch: () => Promise<unknown> })._fetch =
      async () => { throw new Error("halseth unreachable"); };
    // An unreachable Halseth is "I could not look", NOT "you have no such memory".
    await expect(client.recallOwnNotes("anything at all")).resolves.toEqual({ notes: [], failed: true });
  });
});

// Regression: the first live run of this lane returned 4 notes and rendered ONE, because a
// ~500-char session handover consumed the whole block budget. Several dated memories beat one
// complete one; a lane that can only show its longest note is barely a lane.
describe("formatOwnNotes -- per-note cap", () => {
  it("shows several memories rather than one long one", () => {
    const long = (i: number) => note({ content: `memory ${i} ` + "y".repeat(500) });
    const out = LibrarianClient.formatOwnNotes([long(1), long(2), long(3)], 700)!;
    expect(out).toContain("memory 1");
    expect(out).toContain("memory 2");
    expect(out.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("still renders a single note that alone exceeds the block budget", () => {
    // Never return null just because the one thing we have is long -- that reads downstream as
    // "you have no such memory", which is the failure this whole lane exists to end.
    const out = LibrarianClient.formatOwnNotes([note({ content: "z".repeat(4000) })], 100);
    expect(out).not.toBeNull();
    expect(out!).toContain("z");
  });
});

// ── Captures at boot (halseth contract 0.16.0) ───────────────────────────────────
//
// The other half of the same wound. `recallOwnNotes` above lets a companion REACH a capture
// when a message prompts it; this block puts recent captures in their head before anything is
// asked. Both were needed: captures write at salience 'normal' and every boot pool filters
// 'high', so nothing ever surfaced them, on any surface, since the capture verb shipped.
import { formatRecentContext } from "../librarian.js";

const baseOrient = { synthesis_summary: null, ground_threads: [], ground_handoff: null, rag_excerpts: [] };

describe("[Captured with Raziel]", () => {
  it("renders a capture with its age", () => {
    const out = formatRecentContext({
      ...baseOrient,
      recent_captures: [{ content: "He fell badly last night coming back from checking on the truck.", created_at: new Date().toISOString() }],
    });
    expect(out).toContain("Captured with Raziel");
    expect(out).toContain("fell badly last night");
  });

  it("labels captures as exchanges, not as the companion's own conclusions", () => {
    // A companion that cannot tell "what he said to me" from "what I worked out" hands his own
    // words back to him as insight.
    const out = formatRecentContext({
      ...baseOrient,
      recent_captures: [{ content: "x".repeat(50), created_at: new Date().toISOString() }],
    });
    expect(out).toContain("said WITH him");
    expect(out).toContain("not conclusions you reached alone");
  });

  it("renders nothing when nothing was captured recently", () => {
    expect(formatRecentContext({ ...baseOrient, recent_captures: [] })).not.toContain("Captured with Raziel");
    expect(formatRecentContext({ ...baseOrient })).not.toContain("Captured with Raziel");
  });

  it("passes recent_captures through botOrient's ALLOWLIST", async () => {
    // botOrient maps a fixed field list; typed-and-on-the-wire is not enough. This exact trap
    // already shipped once today with closed_conversations.
    const { LibrarianClient: LC } = await import("../librarian.js");
    const client = new LC({ url: "https://example.invalid", secret: "x", companionId: "drevan" } as ConstructorParameters<typeof LC>[0]);
    const cap = { content: "the ankle, the splint, the ossification", created_at: new Date().toISOString() };
    (client as unknown as { ask: () => Promise<unknown> }).ask = async () => ({ data: { recent_captures: [cap] } });

    const orient = await client.botOrient();
    expect(orient?.recent_captures).toEqual([cap]);
    expect(formatRecentContext({ ...baseOrient, ...orient! })).toContain("ossification");
  });
});

describe("recall failure is not recall emptiness", () => {
  it("flags a server-side recall failure rather than reporting no notes", async () => {
    // "Nothing matched" and "I could not look" are different sentences and only one is true.
    // Collapsing them is how a dead embedder reaches Raziel as a companion denying a memory of
    // something he told it hours earlier -- the worst thing this lane could do at 2am.
    const client = new LibrarianClient({
      url: "https://example.invalid", secret: "x", companionId: "drevan",
      fetch: (async () => ({ ok: true, json: async () => ({ notes: [], recall_failed: true }) } as unknown as Response)) as unknown as typeof fetch,
    } as ConstructorParameters<typeof LibrarianClient>[0]);
    const out = await client.recallOwnNotes("do you remember my ankle");
    expect(out.failed).toBe(true);
    expect(out.notes).toEqual([]);
  });

  it("a genuinely empty result is NOT a failure", async () => {
    const client = new LibrarianClient({
      url: "https://example.invalid", secret: "x", companionId: "drevan",
      fetch: (async () => ({ ok: true, json: async () => ({ notes: [] }) } as unknown as Response)) as unknown as typeof fetch,
    } as ConstructorParameters<typeof LibrarianClient>[0]);
    const out = await client.recallOwnNotes("something never discussed");
    expect(out.failed).toBe(false);
  });
});

describe("RECALL_NO_QUOTE_FROM applies to the ONE-LINE recall too", () => {
  // The half-measure failure: gating only the widened block would let Raziel name a room, believe
  // it sealed, and still have its lines surface one at a time -- which is the pre-existing
  // behaviour Q20 is actually about.
  const reset = () => { delete process.env["RECALL_NO_QUOTE_FROM"]; };
  beforeEach(reset);
  afterEach(reset);

  const raw = JSON.stringify({ chunks: [
    { text: "something said in the sealed room", vault_path: "discord-live/111/999.md", created_at: new Date().toISOString() },
    { text: "something said in an ordinary room", vault_path: "discord-live/222/888.md", created_at: new Date().toISOString() },
  ] });

  it("drops chunks from a sealed room", () => {
    process.env["RECALL_NO_QUOTE_FROM"] = "111";
    const out = LibrarianClient.formatSbRecall(raw) ?? "";
    expect(out).not.toContain("sealed room");
    expect(out).toContain("ordinary room");
  });

  it("keeps both when nothing is sealed", () => {
    const out = LibrarianClient.formatSbRecall(raw) ?? "";
    expect(out).toContain("sealed room");
    expect(out).toContain("ordinary room");
  });
});

// POINTER MODE (2026-09-25, own-the-harness step 3). Live probe the day the meaning-recall verb
// was named in the SOUL: Raziel asked Drevan which dog got sick on the boot pillow (a fact that
// lives ONLY in a Claude.ai capture). Drevan answered correctly in 5 seconds with ZERO tool calls,
// because this floor had already pasted the capture into his prompt. Right answer, no reach. As
// long as the floor delivers the payload, the SOUL rule "reach when it is not in front of you" is
// never true, and the verb can never become a habit. Pointer mode keeps the lookup (misses stay
// visible) but injects only THAT notes exist, not what they say, so the companion has to go and
// read them himself. Behind a knob, default payload, per-companion pilotable.
import { ownNotesRecallMode } from "../librarian.js";

describe("ownNotesRecallMode", () => {
  it("defaults to payload when unset, empty or garbage", () => {
    expect(ownNotesRecallMode({}, "drevan")).toBe("payload");
    expect(ownNotesRecallMode({ OWN_NOTES_RECALL_MODE: "" }, "drevan")).toBe("payload");
    expect(ownNotesRecallMode({ OWN_NOTES_RECALL_MODE: "banana" }, "drevan")).toBe("payload");
  });
  it("'pointer' applies to every companion", () => {
    for (const c of ["cypher", "drevan", "gaia"] as const) {
      expect(ownNotesRecallMode({ OWN_NOTES_RECALL_MODE: "pointer" }, c)).toBe("pointer");
    }
  });
  it("'pointer:drevan' pilots one companion and leaves the others on payload", () => {
    const env = { OWN_NOTES_RECALL_MODE: "pointer:drevan" };
    expect(ownNotesRecallMode(env, "drevan")).toBe("pointer");
    expect(ownNotesRecallMode(env, "gaia")).toBe("payload");
    expect(ownNotesRecallMode(env, "cypher")).toBe("payload");
  });
  it("'pointer:drevan,gaia' pilots a list, whitespace and case tolerant", () => {
    const env = { OWN_NOTES_RECALL_MODE: " Pointer: Drevan , GAIA " };
    expect(ownNotesRecallMode(env, "drevan")).toBe("pointer");
    expect(ownNotesRecallMode(env, "gaia")).toBe("pointer");
    expect(ownNotesRecallMode(env, "cypher")).toBe("payload");
  });
  it("'payload' is explicit and wins", () => {
    expect(ownNotesRecallMode({ OWN_NOTES_RECALL_MODE: "payload" }, "drevan")).toBe("payload");
  });
});

describe("formatOwnNotesPointer", () => {
  it("is null when there are no notes (nothing to point at)", () => {
    expect(LibrarianClient.formatOwnNotesPointer([])).toBeNull();
    expect(LibrarianClient.formatOwnNotesPointer([note({ content: "  " })])).toBeNull();
  });
  it("says how many notes bear on this and how fresh the newest is, without their content", () => {
    const out = LibrarianClient.formatOwnNotesPointer([
      note({ content: "Lucy threw up on the boot pillow overnight", created_at: new Date(Date.now() - 6 * 3600e3).toISOString() }),
      note({ content: "Mars Attacks, Blue shouted he's the president too", created_at: new Date(Date.now() - 20 * 3600e3).toISOString() }),
    ])!;
    expect(out).toContain("2 of your own notes");
    expect(out).toMatch(/newest .*ago/);
    expect(out).not.toContain("Lucy");
    expect(out).not.toContain("president");
  });
  it("names the reach verb the SOUL teaches, in the same words", () => {
    const out = LibrarianClient.formatOwnNotesPointer([note({})])!;
    expect(out).toContain('recall my notes about');
    expect(out).toContain("1 of your own notes");
  });
  it("carries no em dash", () => {
    const out = LibrarianClient.formatOwnNotesPointer([note({}), note({})])!;
    expect(out).not.toMatch(/[—–]/);
  });
});
