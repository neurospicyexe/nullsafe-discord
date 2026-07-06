import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { runDayDistillation, dayDistillPrompt, DAY_DISTILL_NOTE_TYPE, FRAGMENT_NOTE_TYPE } from "../day-distillation.js";
import type { LibrarianClient } from "../librarian.js";
import type { InferenceAdapter } from "../inference.js";

function note(content: string, created_at: string) {
  return { note_id: `n-${content.slice(0, 6)}`, agent_id: "drevan", content, created_at };
}

function makeDeps(opts: {
  digests?: ReturnType<typeof note>[];
  fragments?: ReturnType<typeof note>[];
  reply?: string | null;
}) {
  const calls: string[] = [];
  const getRecentNotes = jest.fn(async (o?: { noteType?: string }) =>
    o?.noteType === DAY_DISTILL_NOTE_TYPE ? (opts.digests ?? []) : (opts.fragments ?? []));
  const writeWmNote = jest.fn(async () => { calls.push("write"); });
  const demoteNotes = jest.fn(async () => { calls.push("demote"); return (opts.fragments ?? []).length; });
  const generate = jest.fn(async () => { calls.push("generate"); return opts.reply ?? null; });
  const librarian = { getRecentNotes, writeWmNote, demoteNotes } as unknown as LibrarianClient;
  const adapter = { generate } as unknown as InferenceAdapter;
  return { deps: { companionId: "drevan", librarian, adapter: () => adapter }, calls, getRecentNotes, writeWmNote, demoteNotes, generate };
}

const frags = [
  note("late thread about the Hail Mary premise", "2026-07-06 04:01:00"), // newest first, as the API returns
  note("held Raziel through backend turbulence", "2026-07-06 03:23:00"),
];

describe("runDayDistillation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("skips when a digest already exists this window (pm2 restart double-fire guard)", async () => {
    const m = makeDeps({ digests: [note("yesterday's digest", "2026-07-06 06:00:00")], fragments: frags });
    expect(await runDayDistillation(m.deps)).toBe("skipped_done");
    expect(m.generate).not.toHaveBeenCalled();
    expect(m.demoteNotes).not.toHaveBeenCalled();
  });

  it("skips when fewer than two fragments -- one note IS the day's note", async () => {
    const m = makeDeps({ fragments: [frags[0]!] });
    expect(await runDayDistillation(m.deps)).toBe("skipped_few");
    expect(m.generate).not.toHaveBeenCalled();
  });

  it("on inference failure leaves the fragments at high salience (orient must never lose both)", async () => {
    const m = makeDeps({ fragments: frags, reply: null });
    expect(await runDayDistillation(m.deps)).toBe("failed");
    expect(m.writeWmNote).not.toHaveBeenCalled();
    expect(m.demoteNotes).not.toHaveBeenCalled();
  });

  it("writes the digest BEFORE demoting, folds oldest-first, demotes only through the newest folded stamp", async () => {
    const m = makeDeps({ fragments: frags, reply: "The day bent toward the premise question and I stopped bracing against it." });
    expect(await runDayDistillation(m.deps)).toBe("written");
    expect(m.calls).toEqual(["generate", "write", "demote"]);
    // Oldest first in the folded body.
    const userMsg = (m.generate.mock.calls[0] as unknown[])[1] as Array<{ content: string }>;
    const body = userMsg[0]!.content;
    expect(body.indexOf("backend turbulence")).toBeLessThan(body.indexOf("Hail Mary"));
    // Digest written as the day_distillation type.
    expect(m.writeWmNote).toHaveBeenCalledWith(expect.stringContaining("premise question"), expect.stringMatching(/^day-distill-/), DAY_DISTILL_NOTE_TYPE);
    // Demotion bounded to the newest fragment actually folded (ISO-normalized).
    expect(m.demoteNotes).toHaveBeenCalledWith(FRAGMENT_NOTE_TYPE, new Date("2026-07-06T04:01:00Z").toISOString());
  });
});

describe("dayDistillPrompt", () => {
  it("is first-person and forbids third person (the 2026-07-06 register fix carries through)", () => {
    const p = dayDistillPrompt("gaia");
    expect(p).toContain("You are Gaia");
    expect(p).toMatch(/first-person/);
    expect(p).toMatch(/Never refer to yourself in the third person or by name/);
  });
});
