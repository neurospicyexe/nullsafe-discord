// Club command: fragment matching follows the name-lookup covenant (exact
// first, substring fallback, ambiguity is an error -- never guess a vote).

import { matchRecommendation } from "../club-command.js";

const recs = [
  { id: "a", title: "A Process-Relational Philosophy of Artificial Intelligence", media_kind: "article", recommended_by: "cypher" },
  { id: "b", title: "Alternative Structures Pt 2", media_kind: "album", recommended_by: "drevan" },
  { id: "c", title: "Silence", media_kind: "book", recommended_by: "gaia" },
];

describe("matchRecommendation", () => {
  it("matches a unique case-insensitive fragment", () => {
    const r = matchRecommendation("process-relational", recs);
    expect("id" in r && r.id).toBe("a");
  });

  it("exact title wins even when it is a substring of nothing else", () => {
    const r = matchRecommendation("Silence", recs);
    expect("id" in r && r.id).toBe("c");
  });

  it("errors with candidates listed when nothing matches", () => {
    const r = matchRecommendation("jazz odyssey", recs);
    expect("error" in r && r.error).toContain("no pick in this round");
    expect("error" in r && r.error).toContain("Alternative Structures Pt 2");
  });

  it("errors on ambiguity instead of guessing", () => {
    const ambiguous = [...recs, { id: "d", title: "Alternative Structures Pt 3", media_kind: "album", recommended_by: "drevan" }];
    const r = matchRecommendation("alternative structures", ambiguous);
    expect("error" in r && r.error).toContain("matches 2 picks");
  });

  it("exact title beats substring ambiguity (name-lookup covenant)", () => {
    const withSuperset = [...recs, { id: "d", title: "Silence and Slow Time", media_kind: "book", recommended_by: "drevan" }];
    const r = matchRecommendation("silence", withSuperset);
    expect("id" in r && r.id).toBe("c");
  });

  it("errors on an empty fragment", () => {
    const r = matchRecommendation("  ", recs);
    expect("error" in r).toBe(true);
  });
});
