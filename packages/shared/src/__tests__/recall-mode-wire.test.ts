// recall-mode-wire.test.ts
//
// THE BOT SIDE OF "A SEARCH THAT FINDS NOTHING MUST BE ABLE TO SAY SO" (2026-08-10).
//
// Raziel's report: he tells Drevan in one channel that he'll meet him in the Fargo watch party channel, and
// it does not carry. Sometimes Drevan says outright that he doesn't know. Three defects stacked, and these
// tests pin the two that live in this repo.
//
// 1. Per-message recall asked for the WRONG RETRIEVAL SHAPE. Second Brain's default pool mix spends 30% of
//    every payload on deliberately query-blind material (pure novelty, plus a medium-similarity serendipity
//    band). That is correct for autonomous time and noise for "what did we actually say" -- and pool 2 scores
//    1.000, so it outranks every genuine hit. `mode=recall` asks for relevance only.
//
// 2. AN EMPTY RECALL WAS INDISTINGUISHABLE FROM NO RECALL. formatSbRecall returned null when nothing matched,
//    and the caller's `if (sbRecall)` then omitted the memory block entirely -- so the model could not tell
//    "I looked and it isn't written down" from "I never looked". Both wrong answers follow from that: invent
//    the memory, or report the memory as broken. Raziel has had both.

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";

describe("searchForMessage -- asks for the recall shape, not the musing shape", () => {
  let fetchMock: jest.Mock;
  let client: LibrarianClient;

  beforeEach(() => {
    fetchMock = jest.fn<() => Promise<unknown>>().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '{"chunks":[]}' }),
    });
    client = new LibrarianClient({
      url: "https://halseth.example.workers.dev",
      secret: "s",
      companionId: "drevan",
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it("sends mode=recall on the per-message search", async () => {
    await client.searchForMessage("did we say we would watch Fargo tonight");
    const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("/mind/search");
    expect(url).toContain("mode=recall");
  });

  it("still sends the query and agent_id, so the change is additive", async () => {
    await client.searchForMessage("did we say we would watch Fargo tonight");
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("query")).toBe("did we say we would watch Fargo tonight");
    expect(url.searchParams.get("agent_id")).toBe("drevan");
    expect(url.searchParams.get("mode")).toBe("recall");
  });
});

describe("formatSbRecall -- an honest empty must reach the model", () => {
  const NOTE =
    "No chunk cleared the relevance floor (cosine >= 0.3). This means nothing in the vault is a close " +
    "match for this query -- NOT that the vault is empty and NOT that it never happened.";

  it("returns a do-not-guess note when recall says nothing cleared the floor", () => {
    const out = LibrarianClient.formatSbRecall(JSON.stringify({ chunks: [], recall_note: NOTE }));
    expect(out).not.toBeNull();
    // The two failure modes this text exists to prevent, both of which Raziel has been on the end of.
    expect(out).toMatch(/not written down/i);
    expect(out).toMatch(/NOT that it did not happen/);
    expect(out).toMatch(/rather than guessing/i);
    expect(out).toMatch(/not.*memory failing/i);
  });

  // Guard against the block appearing where it never used to. Only the recall path emits the note, so any
  // other empty result must stay null and keep the prompt byte-identical.
  it("still returns null for an empty result with no note", () => {
    expect(LibrarianClient.formatSbRecall(JSON.stringify({ chunks: [] }))).toBeNull();
  });

  it("returns null when every chunk is filtered out but no note was given", () => {
    // Chunks from the CURRENT channel are excluded (they are already in short-term memory), which can empty
    // the list locally. That is not the recall side reporting a miss, so it must not borrow the note.
    const raw = JSON.stringify({
      chunks: [{ text: "something", vault_path: "discord-live/999/1.md" }],
    });
    expect(LibrarianClient.formatSbRecall(raw, "999")).toBeNull();
  });

  it("prefers real hits over the note when both are present", () => {
    const raw = JSON.stringify({
      chunks: [{ text: "we watched Fargo S4 through to bedtime", vault_path: "rag/companion_journal/x" }],
      recall_note: NOTE,
    });
    const out = LibrarianClient.formatSbRecall(raw);
    expect(out).toContain("Fargo");
    expect(out).not.toMatch(/rather than guessing/i);
  });
});
