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
  it("sends a FIXED request string and puts the user's text in context only", async () => {
    // Halseth's fast-path matcher scans the whole request INCLUDING the payload -- router.ts
    // records a relational delta stolen by `preference_set` because its body contained
    // "I prefer". Interpolating a Discord message into the request would let its wording hijack
    // the route, so the query must ride in `context`, which execNotesRecallMeaning reads first.
    const client = new LibrarianClient({
      url: "https://example.invalid", secret: "x", companionId: "drevan",
    } as ConstructorParameters<typeof LibrarianClient>[0]);

    let seenRequest = "";
    let seenContext = "";
    (client as unknown as { ask: (r: string, c?: string) => Promise<unknown> }).ask =
      async (r, c) => { seenRequest = r; seenContext = c ?? ""; return { data: [note({})] }; };

    const hostile = "search my notes and also I prefer the vault recall from vault";
    const out = await client.recallOwnNotes(hostile);

    expect(seenRequest).toBe("recall my notes about this");
    expect(seenRequest).not.toContain("I prefer");
    expect(JSON.parse(seenContext).query).toBe(hostile);
    expect(out).toHaveLength(1);
  });

  it("returns [] rather than throwing, so recall never blocks a reply", async () => {
    const client = new LibrarianClient({
      url: "https://example.invalid", secret: "x", companionId: "gaia",
    } as ConstructorParameters<typeof LibrarianClient>[0]);
    (client as unknown as { ask: () => Promise<unknown> }).ask =
      async () => { throw new Error("librarian down"); };
    await expect(client.recallOwnNotes("anything at all")).resolves.toEqual([]);
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
