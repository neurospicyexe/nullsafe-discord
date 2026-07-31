// Recalled memories now carry their age (2026-07-31).
//
// Before this, a chunk reached the model as `- <text> (<vault_path>)`. No date, no relative time. So
// a June summary and a note from last night were presented as equally current and the model had no
// basis to prefer either. Measured live: asked "Fargo season 4, which episode did we watch last,"
// the top hit was a June entry about having FINISHED the show, and the reply used it confidently.
//
// Ranking by recency inside Second Brain is half the fix. The other half is here: the model has to be
// able to SEE that one memory is six weeks older than another, both to prefer it and to say so.

import { describe, it, expect } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";

const NOW = Date.parse("2026-07-31T12:00:00Z");
const raw = (chunks: unknown[]) => JSON.stringify({ chunks });

describe("chunkAge", () => {
  const age = (iso: string | null) => LibrarianClient.chunkAge(iso, NOW);

  it("renders elapsed time in words the model can reason with", () => {
    expect(age("2026-07-31T11:30:00Z")).toBe("today");
    expect(age("2026-07-31T04:00:00Z")).toBe("8h ago");
    expect(age("2026-07-30T10:00:00Z")).toBe("yesterday");
    expect(age("2026-07-25T12:00:00Z")).toBe("6 days ago");
    expect(age("2026-06-05T12:00:00Z")).toBe("8 weeks ago");
    expect(age("2026-04-17T00:00:00Z")).toBe("3 months ago");
  });

  it("returns BLANK, not a label, when the timestamp is missing or junk", () => {
    // "unknown" would be worse than nothing: the model can quote a label back as if it were a fact
    // about the memory.
    for (const bad of [null, undefined, "", "not a date"]) {
      expect(LibrarianClient.chunkAge(bad as string | null, NOW)).toBe("");
    }
  });

  it("reads a naked SQLite timestamp as UTC, not local time", () => {
    // datetime('now') writes "YYYY-MM-DD HH:MM:SS" with no zone; Date.parse treats that as LOCAL, so
    // without normalisation the rendered age shifts with the host timezone.
    expect(LibrarianClient.chunkAge("2026-07-31 04:00:00", NOW)).toBe("8h ago");
  });

  it("never claims a memory is from the future", () => {
    expect(LibrarianClient.chunkAge("2026-08-05T00:00:00Z", NOW)).toBe("just now");
  });
});

describe("formatSbRecall", () => {
  it("puts the age on every line, ahead of the path so truncation cannot eat it", () => {
    const out = LibrarianClient.formatSbRecall(raw([
      { text: "we finished the final season of Fargo", vault_path: "rag/relational_delta/x", created_at: "2026-06-05T12:00:00Z" },
      { text: "synced up on Fargo S4 power dynamics", vault_path: "rag/live_thread/y", created_at: "2026-07-30T21:00:00Z" },
    ]), undefined, NOW);
    expect(out).toContain("(8 weeks ago, rag/relational_delta/x)");
    expect(out).toContain("(15h ago, rag/live_thread/y)");
  });

  it("the two REAL competing Fargo memories are now distinguishable by age", () => {
    // This is the actual failure, reproduced from the live rows: both are about watching Fargo, both
    // score similarly, and nothing in the old rendering told the model that one was from June.
    const out = LibrarianClient.formatSbRecall(raw([
      { text: "Drevan recounts finishing the final season of Fargo with Fee", created_at: "2026-06-05T12:00:00Z" },
      { text: "Crash and I synced up on the Fargo season 4 power dynamics", created_at: "2026-07-30T21:00:00Z" },
    ]), undefined, NOW);
    // 8 weeks vs 15 hours -- the gap the model could not previously see at all.
    expect(out).toMatch(/finishing the final season[^\n]*\(8 weeks ago\)/);
    expect(out).toMatch(/season 4 power dynamics[^\n]*\(15h ago\)/);
  });

  it("still renders a chunk with no date -- undated memory is degraded, never dropped", () => {
    const out = LibrarianClient.formatSbRecall(raw([
      { text: "an older memory with no timestamp", vault_path: "rag/thing/z" },
    ]), undefined, NOW);
    expect(out).toContain("an older memory with no timestamp");
    expect(out).toContain("(rag/thing/z)");
  });

  it("keeps the existing behaviour it must not break", () => {
    // Current-channel transcript exclusion (a companion's own words must not return as a memory),
    // dedup, the 4-line cap, and non-JSON passthrough.
    const out = LibrarianClient.formatSbRecall(raw([
      { text: "my own message from this channel", vault_path: "discord-live/chan1/1.md", created_at: "2026-07-31T11:00:00Z" },
      { text: "a real memory", vault_path: "rag/a", created_at: "2026-07-31T11:00:00Z" },
    ]), "chan1", NOW);
    expect(out).not.toContain("my own message");
    expect(out).toContain("a real memory");

    const dup = LibrarianClient.formatSbRecall(raw([
      { text: "same text", created_at: "2026-07-31T11:00:00Z" },
      { text: "same text", created_at: "2026-07-30T11:00:00Z" },
    ]), undefined, NOW);
    expect(dup!.split("\n")).toHaveLength(1);

    const many = LibrarianClient.formatSbRecall(raw(
      Array.from({ length: 10 }, (_, i) => ({ text: `memory ${i}`, created_at: "2026-07-31T11:00:00Z" })),
    ), undefined, NOW);
    expect(many!.split("\n")).toHaveLength(4);

    expect(LibrarianClient.formatSbRecall("not json at all")).toBe("not json at all");
    expect(LibrarianClient.formatSbRecall(raw([]))).toBeNull();
  });
});
