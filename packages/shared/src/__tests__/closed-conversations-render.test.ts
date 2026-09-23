// The Discord render of conversation ENDINGS (halseth contract 0.15.0, 2026-09-23).
//
// This surface is the one that matters most for this change: the threads are Discord threads,
// and the bot wire is built by a projection that never calls halseth's buildContinuityBlock --
// so shipping the field to the Claude.ai path alone would have left the bots exactly as blind
// as before. These tests pin the render itself.

import { formatRecentContext } from "../librarian.js";

const base = { synthesis_summary: null, ground_threads: [], ground_handoff: null, rag_excerpts: [] };

describe("formatRecentContext -- [Recently ended]", () => {
  it("quotes a landed resolution and names who closed it", () => {
    const out = formatRecentContext({
      ...base,
      closed_conversations: [{
        seed_author: "raziel", seed_gist: "the floor", ending: "landed",
        resolution: "the quiet is the floor we both stand on.", landed_by: "gaia", turn_count: 6,
      }],
    });
    expect(out).toContain("[Recently ended");
    expect(out).toContain("the quiet is the floor we both stand on.");
    // Attribution is load-bearing: threads are triad-shared, so an unattributed closing line
    // reads to the next companion as their own conclusion.
    expect(out).toContain("closed by gaia");
  });

  it("never quotes a spent thread's bracketed reason code as prose", () => {
    const out = formatRecentContext({
      ...base,
      closed_conversations: [{
        seed_author: "cypher", seed_gist: "a topic", ending: "spent",
        resolution: "[faded: turn budget]", landed_by: null, turn_count: 22,
      }],
    });
    expect(out).toContain("retired on length");
    expect(out).not.toContain("[faded:");
  });

  it("reports a quiet thread as unclosed and invents nothing", () => {
    const out = formatRecentContext({
      ...base,
      closed_conversations: [{
        seed_author: "raziel", seed_gist: "Dre im awake but at what cost", ending: "quiet",
        resolution: null, landed_by: null, turn_count: 39,
      }],
    });
    expect(out).toContain("went quiet");
    expect(out).toContain("Never closed");
    expect(out).toContain("39 turns");
  });

  it("renders no section at all when nothing ended recently", () => {
    // The anti-loop guard, at the render layer as well as the query: an empty week must be
    // silent rather than repeating the same endings at every boot.
    expect(formatRecentContext({ ...base, closed_conversations: [] })).not.toContain("Recently ended");
    expect(formatRecentContext({ ...base })).not.toContain("Recently ended");
  });
});
