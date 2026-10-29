// The Discord render of [Linked] (halseth contract 0.22.0, M6, 2026-10-28). Until this, the bot wire
// carried no graph at all: every Discord boot reached nothing from the memory graph. The block arrives
// pre-rendered from the Worker (same text Claude.ai sees); these tests pin where and whether it lands.

import { formatRecentContext } from "../librarian.js";

const base = { synthesis_summary: null, ground_threads: [], ground_handoff: null, rag_excerpts: ["an old vault excerpt"] };
const LINKED = "[Linked]\n• Fargo -- mentioned in \"Crash reached for a snuggle\" (drevan 09-24); +15 more";

describe("formatRecentContext -- [Linked]", () => {
  it("renders the block when the Worker sent one", () => {
    const out = formatRecentContext({ ...base, graph_linked: LINKED });
    expect(out).toContain("[Linked]");
    expect(out).toContain("Fargo -- mentioned in");
  });

  it("sits above the ephemera, so excerpts are cut first under a tail budget", () => {
    const out = formatRecentContext({ ...base, graph_linked: LINKED });
    expect(out.indexOf("[Linked]")).toBeLessThan(out.indexOf("## Historical resonance"));
  });

  it("renders nothing for an empty or whitespace block, or an older Worker that sends none", () => {
    for (const graph_linked of ["", "   \n", undefined]) {
      expect(formatRecentContext({ ...base, graph_linked })).not.toContain("[Linked]");
    }
  });
});
