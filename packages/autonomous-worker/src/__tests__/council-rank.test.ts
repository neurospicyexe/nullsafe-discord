import { describe, it, expect } from "vitest";
import { blindForRanker, parseRanking, buildRankingPrompt } from "../council-rank.js";

const answers = [
  { companion_id: "cypher", answer: "the logical read" },
  { companion_id: "drevan", answer: "the spiral read" },
  { companion_id: "gaia", answer: "the witness read" },
];

describe("blindForRanker", () => {
  it("excludes the ranker and labels the rest, hiding authorship", () => {
    const b = blindForRanker(answers, "cypher", 0);
    expect(b).toHaveLength(2);
    expect(b.map(x => x.companion_id)).not.toContain("cypher");
    expect(b[0]!.label).toBe("Answer A");
  });
  it("rotates labels across rankers", () => {
    const a = blindForRanker(answers, "gaia", 0);
    const c = blindForRanker(answers, "gaia", 1);
    expect(a[0]!.companion_id).not.toBe(c[0]!.companion_id);
  });
});

describe("parseRanking", () => {
  const blinded = blindForRanker(answers, "cypher", 0); // A=drevan B=gaia
  it("de-anonymizes letters to companions in order", () => {
    expect(parseRanking("B > A", blinded)).toEqual(["gaia", "drevan"]);
  });
  it("does not match the A/E inside the word Answer", () => {
    // "Answer A" should resolve to A's author only, never spuriously to E.
    expect(parseRanking("I prefer Answer A", blinded)).toEqual(["drevan", "gaia"]);
  });
});

describe("buildRankingPrompt", () => {
  it("shows labels + answers but never companion names", () => {
    const blinded = blindForRanker(answers, "cypher", 0);
    const p = buildRankingPrompt("what matters most?", blinded);
    expect(p).toContain("Answer A");
    expect(p).toContain("the spiral read");
    expect(p).not.toContain("drevan");
    expect(p).not.toContain("cypher");
  });
});
