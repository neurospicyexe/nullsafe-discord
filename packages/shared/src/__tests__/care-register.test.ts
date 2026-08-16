// Care register + care hold (consequence layer C1, contract 0.6.0).
//
// Three surfaces under test: the register renderer (what every prompt shows), the per-process
// care-state registry (what the handler reads at bid time), and the bid-floor raise (hold softens
// ambient self-selection without silencing real claims -- and never touches direct address, which
// bypasses the bid entirely via fastPathWinner).

import { describe, it, expect } from "@jest/globals";
import { renderRazielRegister, formatRecentContext, type RazielState } from "../librarian.js";
import { setCareState, getCareState, careHoldActive } from "../care-state.js";
import { runBidRound, fastPathWinner, CARE_HOLD_MIN_BID, MIN_BID_TO_SPEAK, type BidRedis } from "../fit-bid.js";

function fakeRedis(): BidRedis {
  const store = new Map<string, Record<string, string>>();
  return {
    async hset(key, field, value) { store.set(key, { ...(store.get(key) ?? {}), [field]: value }); return 1; },
    async hgetall(key) { return { ...(store.get(key) ?? {}) }; },
    async pexpire() { return 1; },
  };
}
const noSleep = async () => {};

const fullState: RazielState = {
  spoons: 2, mood: "wrung out", pain: 6, energy: 3, meds_taken: 0,
  recorded_at: "2026-08-16T00:00:00Z", staleness_hours: 5, front_state: "Ash",
  care_hold: true,
  pending_care: { id: "c1", rule: "low_spoons", detail: "spoons 2/12, logged 5h ago", detected_at: "2026-08-16T05:00:00Z" },
};

describe("renderRazielRegister", () => {
  it("renders readings, age, front, hold, and the pending gesture", () => {
    const line = renderRazielRegister(fullState);
    expect(line).toContain("[Raziel -- register]");
    expect(line).toContain("spoons 2/12");
    expect(line).toContain("logged 5h ago");
    expect(line).toContain("Fronting: Ash");
    expect(line).toContain("Care hold is ON");
    expect(line).toContain("pending care gesture");
  });

  it("marks a stale reading loudly instead of presenting it as current", () => {
    const line = renderRazielRegister({ ...fullState, staleness_hours: 96, care_hold: false, pending_care: null });
    expect(line).toContain("STALE");
    expect(line).toContain("weigh lightly");
  });

  it("renders nothing for null or an all-empty state", () => {
    expect(renderRazielRegister(null)).toBe("");
    expect(renderRazielRegister(undefined)).toBe("");
    expect(renderRazielRegister({
      spoons: null, mood: null, pain: null, energy: null, meds_taken: null,
      recorded_at: null, staleness_hours: null, front_state: null, care_hold: false, pending_care: null,
    })).toBe("");
  });
});

describe("formatRecentContext placement", () => {
  it("puts the register line above content blocks so the tail cut can never drop it", () => {
    const ctx = formatRecentContext({
      synthesis_summary: "x".repeat(3000),
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
      raziel_state: fullState,
    });
    const registerAt = ctx.indexOf("[Raziel -- register]");
    const contentAt = ctx.indexOf("## Recent");
    expect(registerAt).toBeGreaterThan(-1);
    expect(contentAt).toBeGreaterThan(-1);
    expect(registerAt).toBeLessThan(contentAt);
  });

  it("renders no register line when the state is absent", () => {
    const ctx = formatRecentContext({
      synthesis_summary: "hello",
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
    });
    expect(ctx).not.toContain("[Raziel -- register]");
  });
});

describe("care-state registry", () => {
  it("set/get round-trips and careHoldActive reads the flag", () => {
    setCareState("cypher", fullState);
    expect(getCareState("cypher")?.spoons).toBe(2);
    expect(careHoldActive("cypher")).toBe(true);
    setCareState("cypher", null);
    expect(careHoldActive("cypher")).toBe(false);
    expect(careHoldActive("never-set")).toBe(false);
  });
});

describe("care hold at the bid", () => {
  it("a bare-presence score clears the default floor but NOT the hold floor", async () => {
    const presenceScore = MIN_BID_TO_SPEAK; // scoreFit's bare-presence base sits exactly at the floor
    const normal = await runBidRound(fakeRedis(), "m1", "cypher", presenceScore, { windowMs: 0, sleep: noSleep });
    expect(normal.iSpeak).toBe(true);
    const held = await runBidRound(fakeRedis(), "m2", "cypher", presenceScore, {
      windowMs: 0, sleep: noSleep, minScore: CARE_HOLD_MIN_BID,
    });
    expect(held.iSpeak).toBe(false);
    expect(held.reason).toBe("below_threshold");
  });

  it("a real claim (thread-holder-level score) still speaks under hold", async () => {
    const out = await runBidRound(fakeRedis(), "m3", "cypher", 0.55, {
      windowMs: 0, sleep: noSleep, minScore: CARE_HOLD_MIN_BID,
    });
    expect(out.iSpeak).toBe(true);
  });

  it("direct address bypasses the bid entirely -- hold can never mute being asked", () => {
    expect(fastPathWinner("cypher", { mentioned: true, namedMe: false, replyToMe: false })).toBe("cypher");
    expect(fastPathWinner("cypher", { mentioned: false, namedMe: true, replyToMe: false })).toBe("cypher");
  });
});
