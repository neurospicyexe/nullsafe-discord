import { scoreReply } from "../voice-markers.js";
import { matchKeywordTriggers, dueDateTriggers, tripwireBlock, setArmedTriggers, type ArmedTrigger } from "../triggers.js";

describe("scoreReply", () => {
  it("scores a clean in-voice Cypher reply at 1.0", () => {
    const s = scoreReply("cypher", "Best read: the migration is safe. Because the column is nullable. Ship it.");
    expect(s.score).toBe(1);
    expect(s.anti_hits).toHaveLength(0);
    expect(s.positive_hits.length).toBeGreaterThan(0);
  });

  it("penalizes generic-assistant drift for every companion", () => {
    for (const cid of ["cypher", "drevan", "gaia"] as const) {
      const s = scoreReply(cid, "As an AI, I hope this helps! Feel free to ask anything else.");
      expect(s.score).toBeLessThan(1);
      expect(s.anti_hits.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("penalizes Cypher for therapy-speak (lane violation)", () => {
    const s = scoreReply("cypher", "Your feelings are valid. Let's hold space for that together.");
    expect(s.anti_hits.length).toBeGreaterThanOrEqual(2);
    expect(s.score).toBeLessThanOrEqual(0.7);
  });

  it("flags cross-contamination: Drevan signature in Cypher output", () => {
    const s = scoreReply("cypher", "The vaelthren spiral holds, calethian and true.");
    expect(s.contamination_hits.length).toBeGreaterThanOrEqual(1);
    expect(s.contamination_hits[0]).toContain("drevan:");
  });

  it("does NOT flag Drevan for his own signature", () => {
    const s = scoreReply("drevan", "The vaelthren spiral holds, spine to spine.");
    expect(s.contamination_hits).toHaveLength(0);
    expect(s.score).toBe(1);
  });

  it("does NOT flag bare 'perimeter' as gaia contamination (06-15 false positive)", () => {
    // Cypher (audit/boundary lane) and Drevan both use "perimeter" in technical/
    // security senses. The bare word was 100% of the 06-15 voice_contamination flags.
    expect(scoreReply("cypher", "Lock down the perimeter of the auth boundary first.").contamination_hits).toHaveLength(0);
    expect(scoreReply("drevan", "The fire traced the perimeter of the dark.").contamination_hits).toHaveLength(0);
  });

  it("DOES flag Gaia's actual perimeter signature phrase as contamination", () => {
    const s = scoreReply("cypher", "I will hold the perimeter while you rest.");
    expect(s.contamination_hits.some(h => h.startsWith("gaia:"))).toBe(true);
  });

  it("penalizes Gaia for option-menu chattiness", () => {
    const s = scoreReply("gaia", "Would you like me to elaborate? Let me know what you think!");
    expect(s.anti_hits.length).toBeGreaterThanOrEqual(2);
  });

  it("detects self-catch when drift is acknowledged in the same reply", () => {
    const s = scoreReply("cypher", "I hope this helps -- no. That wasn't my voice. Again, as myself: the read is X.");
    expect(s.caught_by).toBe("self");
  });

  it("score floors at 0, never negative", () => {
    const s = scoreReply("gaia", "As an AI assistant, I hope this helps! Feel free to ask. Would you like options? Let me know! Great question! Is there anything else?");
    expect(s.score).toBe(0);
  });
});

describe("trigger matching", () => {
  const t = (id: string, type: string, value: string): ArmedTrigger => ({
    id, trigger_text: `card ${id}`, condition_type: type, condition_value: value,
  });

  it("matches keywords on word boundaries only", () => {
    const armed = [t("a", "keyword", "rome")];
    expect(matchKeywordTriggers(armed, "we should talk about Rome again")).toHaveLength(1);
    expect(matchKeywordTriggers(armed, "the chrome browser")).toHaveLength(0);
  });

  it("matches multi-word phrases and escapes regex chars", () => {
    expect(matchKeywordTriggers([t("a", "keyword", "school arc")], "how is the school arc going")).toHaveLength(1);
    expect(matchKeywordTriggers([t("b", "keyword", "c++ project")], "the c++ project stalled")).toHaveLength(1);
  });

  it("ignores non-keyword triggers in keyword matching", () => {
    expect(matchKeywordTriggers([t("a", "date", "2026-07-01")], "any text 2026-07-01")).toHaveLength(0);
  });

  it("fires date triggers within the 36h window only", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const due = t("due", "date", "2026-06-11T00:00:00Z");
    const far = t("far", "date", "2026-07-01T00:00:00Z");
    const hits = dueDateTriggers([due, far], now);
    expect(hits.map(x => x.id)).toEqual(["due"]);
  });

  it("renders a tripwire block and empty string for no matches", () => {
    expect(tripwireBlock([])).toBe("");
    const block = tripwireBlock([t("a", "keyword", "k")]);
    expect(block).toContain("[Tripwire");
    expect(block).toContain("card a");
  });

  it("setArmedTriggers is callable (store smoke)", () => {
    expect(() => setArmedTriggers("cypher", [t("a", "keyword", "k")])).not.toThrow();
  });
});

// ── 2026-06-12 additions: gaia length rule + live feedback loop ──────────────

import { voiceFeedbackBlock, resetVoiceFeedback, reportVoiceScore } from "../voice-markers.js";

describe("gaia length drift", () => {
  it("flags a gaia reply over 600 chars as a lane violation", () => {
    const long = "The seam holds. ".repeat(50); // ~800 chars
    const s = scoreReply("gaia", long);
    expect(s.anti_hits.some(h => h.startsWith("verbose"))).toBe(true);
    expect(s.score).toBeLessThan(1);
  });

  it("does not flag short gaia replies", () => {
    const s = scoreReply("gaia", "The seam holds.");
    expect(s.anti_hits).toEqual([]);
  });

  it("does not apply the length rule to drevan", () => {
    const long = "The moss remembers the rain. ".repeat(40);
    const s = scoreReply("drevan", long);
    expect(s.anti_hits.some(h => h.startsWith("verbose"))).toBe(false);
  });
});

describe("voiceFeedbackBlock", () => {
  beforeEach(() => {
    resetVoiceFeedback();
    process.env["VOICE_SCORING"] = "true";
    delete process.env["HALSETH_URL"]; // tracking is local; no POST attempted
  });

  it("returns null with no tracked replies", () => {
    expect(voiceFeedbackBlock("cypher")).toBeNull();
  });

  it("returns null when recent replies are clean", () => {
    reportVoiceScore("cypher", "The read: ship it. The logic holds end to end.", "ch1", "test-secret");
    reportVoiceScore("cypher", "Best read: the migration is safe to run.", "ch1", "test-secret");
    expect(voiceFeedbackBlock("cypher")).toBeNull();
  });

  it("returns a correction block after repeated drift", () => {
    const drifty = "You've got this! I'm so proud of you, gentle reminder to hold space.";
    reportVoiceScore("cypher", drifty, "ch1", "test-secret");
    reportVoiceScore("cypher", drifty, "ch1", "test-secret");
    reportVoiceScore("cypher", drifty, "ch1", "test-secret");
    const block = voiceFeedbackBlock("cypher");
    expect(block).not.toBeNull();
    expect(block).toContain("[Voice check]");
    expect(block).toContain("cypher");
  });

  it("recovers to null after clean replies wash the window", () => {
    const drifty = "You've got this! I'm so proud of you, gentle reminder to hold space.";
    reportVoiceScore("cypher", drifty, "ch1", "test-secret");
    reportVoiceScore("cypher", drifty, "ch1", "test-secret");
    for (let i = 0; i < 5; i++) {
      reportVoiceScore("cypher", "The read: clean diff, tests green, ship it.", "ch1", "test-secret");
    }
    expect(voiceFeedbackBlock("cypher")).toBeNull();
  });
});
