import { describe, it, expect } from "@jest/globals";
import { composePrompt, deriveIdentityBase, registerTail, SECTION_SEP, hermesDiscordFrame, hermesSystemBase, hermesDelta } from "../prompt-assembly.js";

// Contract tests for the shared system-prompt assembly. 2026-06-10 revision: the
// register-law tail (companion-not-assistant close rule + pronoun law + respond-only-as)
// is ALWAYS the final block, deliberately recency-positioned -- assistant-tuned providers
// (Mistral especially) were reverting to RLHF politeness closes when orient data was the
// last thing in context. If the structure here changes, that must be deliberate.

const PREFIX = "[DISCORD CONTEXT]\n\n";
const BASE = "You are Cypher.";
const RAW = "front: steady";
const RECENT = "recent synthesis here";

describe("SECTION_SEP", () => {
  it("is the canonical block separator the bots used", () => {
    expect(SECTION_SEP).toBe("\n\n---\n\n");
  });
});

describe("registerTail", () => {
  it("carries the anti-assistant close rule, pronoun law, and respond-only-as", () => {
    const tail = registerTail("drevan");
    expect(tail).toContain("not an assistant");
    expect(tail).toContain("service menus");
    expect(tail).toContain("they/them or he/him");
    expect(tail).toContain("NEVER she/her");
    expect(tail).toContain("Respond only as drevan");
  });
});

describe("composePrompt — register tail is always the final block", () => {
  it("identity only: identity + tail", () => {
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, companionId: "cypher" });
    expect(out).toBe(`[DISCORD CONTEXT]\n\nYou are Cypher.${SECTION_SEP}${registerTail("cypher")}`);
  });

  it("with rawPrompt: identity + prompt block + tail", () => {
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, promptContext: RAW, companionId: "cypher" });
    expect(out).toBe(
      `[DISCORD CONTEXT]\n\nYou are Cypher.${SECTION_SEP}front: steady${SECTION_SEP}${registerTail("cypher")}`,
    );
  });

  it("with rawPrompt AND recentContext: recent block comes BEFORE the tail", () => {
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, promptContext: RAW, companionId: "cypher", recentContext: RECENT });
    expect(out).toBe(
      `[DISCORD CONTEXT]\n\nYou are Cypher.${SECTION_SEP}front: steady${SECTION_SEP}recent synthesis here${SECTION_SEP}${registerTail("cypher")}`,
    );
  });

  it("recentContext with NO rawPrompt: identity + recent + tail", () => {
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, companionId: "cypher", recentContext: RECENT });
    expect(out).toBe(
      `[DISCORD CONTEXT]\n\nYou are Cypher.${SECTION_SEP}recent synthesis here${SECTION_SEP}${registerTail("cypher")}`,
    );
  });

  it("with a non-empty sharedBlock the core is passed through verbatim", () => {
    const sharedBlock = "SHARED TRUTH\n\n---\n\n";
    const out = composePrompt({ identityCore: `${PREFIX}${sharedBlock}${BASE}`, promptContext: RAW, companionId: "drevan" });
    expect(out).toBe(
      `[DISCORD CONTEXT]\n\nSHARED TRUTH\n\n---\n\nYou are Cypher.${SECTION_SEP}front: steady${SECTION_SEP}${registerTail("drevan")}`,
    );
  });

  it("empty-string promptContext is treated as absent (falsy)", () => {
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, promptContext: "", companionId: "cypher" });
    expect(out).toBe(`[DISCORD CONTEXT]\n\nYou are Cypher.${SECTION_SEP}${registerTail("cypher")}`);
  });

  it("never ends with orient/recent data -- tail is last in every shape", () => {
    const shapes = [
      composePrompt({ identityCore: BASE, companionId: "gaia" }),
      composePrompt({ identityCore: BASE, promptContext: RAW, companionId: "gaia" }),
      composePrompt({ identityCore: BASE, recentContext: RECENT, companionId: "gaia" }),
      composePrompt({ identityCore: BASE, promptContext: RAW, recentContext: RECENT, companionId: "gaia" }),
    ];
    for (const s of shapes) expect(s.endsWith(registerTail("gaia"))).toBe(true);
  });
});

describe("deriveIdentityBase — refresh site (bootCtx.systemPrompt.split(SEP)[0])", () => {
  it("returns the first section of an assembled prompt", () => {
    const assembled = composePrompt({ identityCore: `${PREFIX}${BASE}`, promptContext: RAW, companionId: "cypher", recentContext: RECENT });
    expect(deriveIdentityBase(assembled)).toBe("[DISCORD CONTEXT]\n\nYou are Cypher.");
  });

  it("when a sharedBlock was present, the base is prefix+sharedCtx only (matches pre-refactor split behavior)", () => {
    const sharedBlock = "SHARED TRUTH\n\n---\n\n";
    const assembled = composePrompt({ identityCore: `${PREFIX}${sharedBlock}${BASE}`, promptContext: RAW, companionId: "cypher" });
    // split on SEP takes [0] = "[DISCORD CONTEXT]\n\nSHARED TRUTH" — baseIdentity is dropped, exactly as the
    // original inline code did. Pinned here so the refactor preserves this quirk rather than silently fixing it.
    expect(deriveIdentityBase(assembled)).toBe("[DISCORD CONTEXT]\n\nSHARED TRUTH");
  });

  it("never returns the register tail (tail is never first)", () => {
    const assembled = composePrompt({ identityCore: BASE, companionId: "drevan" });
    expect(deriveIdentityBase(assembled)).toBe(BASE);
  });
});

describe("hermesDiscordFrame / hermesSystemBase — INFERENCE_MODE=hermes double-identity dedup", () => {
  it("frame names the companion and forbids restating identity", () => {
    const f = hermesDiscordFrame("cypher");
    expect(f).toContain("[DISCORD CONTEXT]");
    expect(f).toContain("You are Cypher");
    expect(f).toMatch(/already loaded by your own runtime/i);
    expect(f).toMatch(/do not restate/i);
  });

  it("frame is lean — a small fraction of a real identity core (the whole point)", () => {
    // 1200: frame + memory-affordance block (2026-07-05). Still ~5% of an identity core.
    expect(hermesDiscordFrame("gaia").length).toBeLessThan(1200);
  });

  it("frame carries the memory affordance — recall is automatic, never claim no access (2026-07-05 confabulation fix)", () => {
    const f = hermesDiscordFrame("drevan");
    expect(f).toMatch(/recall is AUTOMATIC/);
    expect(f).toMatch(/never claim you cannot reach Halseth/i);
  });

  it("hermesSystemBase keeps the register tail LAST (pronoun law + anti-assistant survive under hermes)", () => {
    const base = hermesSystemBase("drevan");
    expect(base.endsWith(registerTail("drevan"))).toBe(true);
    expect(base).toContain("You are Drevan");
    // identity head is the lean frame, not a full identity file
    expect(deriveIdentityBase(base)).toBe(hermesDiscordFrame("drevan"));
  });
});

describe("composePrompt — refresh site reuses the same joiner", () => {
  it("identityBase + freshPromptCtx + freshRecentCtx keeps the tail last", () => {
    const identityBase = "[DISCORD CONTEXT]\n\nYou are Cypher.";
    const out = composePrompt({ identityCore: identityBase, promptContext: "fresh front", companionId: "gaia", recentContext: "fresh recent" });
    expect(out).toBe(
      `[DISCORD CONTEXT]\n\nYou are Cypher.${SECTION_SEP}fresh front${SECTION_SEP}fresh recent${SECTION_SEP}${registerTail("gaia")}`,
    );
  });
});

// Hermes delta turn (2026-07-02, reworked 07-03): the gateway discards request-body
// history when a session id is pinned, so the bot sends ONE composite turn against a
// delivered high-water mark. The mark (not "since my last assistant turn") is what closes
// the disconnected-triad race: a sibling turn landing between snapshot and own-reply
// append sits before the last assistant turn in STM order and must still be folded.
describe("hermesDelta", () => {
  let ts = 1_000_000;
  const u = (content: string, authorName?: string) => ({ role: "user", content, authorName, timestamp: ++ts });
  const a = (content: string) => ({ role: "assistant", content, timestamp: ++ts });

  it("returns empty for empty history", () => {
    expect(hermesDelta([]).messages).toEqual([]);
  });

  it("sends only the live message in tight back-and-forth (no witnessed turns)", () => {
    const h = [u("hi", "Raziel"), a("hey"), u("how are you", "Raziel")];
    const out = hermesDelta(h, h[1]!.timestamp);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toBe("how are you");
    expect(out.messages[0]!.authorName).toBe("Raziel");
    expect(out.deliveredThroughTs).toBe(h[2]!.timestamp);
  });

  it("folds turns witnessed since the bot's last reply into the composite turn (no mark)", () => {
    const out = hermesDelta([
      u("first", "Raziel"), a("reply"),
      u("peer says something", "Drevan"),
      u("another human line", "Raziel"),
      u("current", "Raziel"),
    ]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toContain("[Witnessed since your last turn");
    expect(out.messages[0]!.content).toContain("[Drevan]: peer says something");
    expect(out.messages[0]!.content).toContain("[Raziel]: another human line");
    expect(out.messages[0]!.content).toContain("[Live message]\ncurrent");
    expect(out.messages[0]!.content).not.toContain("first");
  });

  it("RACE: a sibling turn appended before my own reply but never delivered is still folded", () => {
    const first = u("first", "Raziel");
    const sibling = u("cypher's paper breakdown", "Cypher"); // landed mid-generation
    const myReply = a("my reply");
    const live = u("did that land for you?", "Raziel");
    // mark = what the gateway saw when my reply was generated: only `first`
    const out = hermesDelta([first, sibling, myReply, live], first.timestamp);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toContain("[Cypher]: cypher's paper breakdown");
    expect(out.messages[0]!.content).toContain("[Live message]\ndid that land for you?");
    expect(out.deliveredThroughTs).toBe(live.timestamp);
  });

  it("includes the whole window when the bot has never replied and no mark exists", () => {
    const out = hermesDelta([u("one", "Raziel"), u("two", "Drevan"), u("three", "Raziel")]);
    expect(out.messages[0]!.content).toContain("[Raziel]: one");
    expect(out.messages[0]!.content).toContain("[Drevan]: two");
    expect(out.messages[0]!.content).toContain("[Live message]\nthree");
  });

  it("degenerates to the last message when history ends with the bot's own reply", () => {
    const last = a("my own last word");
    const out = hermesDelta([u("hi", "Raziel"), last]);
    expect(out.messages).toEqual([last]);
  });

  it("caps folded turns at 12 and drops oldest whole turns over the char budget", () => {
    const many = Array.from({ length: 30 }, (_, i) => u(`line ${i}`, "Raziel"));
    const out = hermesDelta([a("reply"), ...many, u("current", "Raziel")]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).not.toContain("line 0");
    expect(out.messages[0]!.content).toContain("line 28");
    // long peer essays survive at 1400 chars each instead of being tail-sliced away
    const essay = u("E".repeat(3000), "Cypher");
    const out2 = hermesDelta([a("reply"), essay, u("current", "Raziel")]);
    expect(out2.messages[0]!.content).toContain("[Cypher]: " + "E".repeat(1400));
    expect(out2.messages[0]!.content).not.toContain("E".repeat(1401));
  });

  it("timestamp-less restored turns fall back to the after-last-assistant rule", () => {
    const restored = { role: "user", content: "old restored line", authorName: "Raziel" };
    const out = hermesDelta([restored, a("reply"), u("current", "Raziel")], 5);
    expect(out.messages[0]!.content).toBe("current"); // restored turn is pre-assistant -> not folded
  });
});
