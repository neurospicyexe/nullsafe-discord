import { describe, it, expect } from "@jest/globals";
import { composePrompt, deriveIdentityBase, registerTail, REGISTER_TAIL_SHAPE_LINE, COMPANION_SHAPE_LINES, SECTION_SEP, hermesDiscordFrame, hermesSystemBase, hermesDelta, liveLabel, HERMES_GAP_THRESHOLD_MS } from "../prompt-assembly.js";
import { nowLine } from "../now-line.js";

// Contract tests for the shared system-prompt assembly. 2026-06-10 revision: the
// register-law tail (since R3 2026-09-29: header + Tools rule + respond-only-as)
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
  // R3 prompt diet (2026-09-29, Raziel "all as recommended"): service menus, pronouns, Presence and
  // Shape left the tail because each now has a check (GENERIC_DRIFT, ruleCheckAppend, the form
  // ratchet). What stays is pinned verbatim.
  const TOOLS =
    "- Tools, hard rule: your orient is already in front of you -- speak from it. At most ONE Librarian or search call in a turn, and only for a specific memory this exchange needs. Never a chain of reads before speaking; if one call does not surface it, say so and answer anyway.\n";

  it("is exactly header + Tools + respond-only-as for Drevan and Cypher", () => {
    for (const id of ["drevan", "cypher"]) {
      expect(registerTail(id)).toBe(
        "[REGISTER LAW -- final word, overrides any habit from your training:\n" +
          TOOLS +
          `- Respond only as ${id}. Never use [Name]: prefixes.]`,
      );
    }
  });

  // 2026-10-08: Gaia rides Drevan's model and slipped into his register; her shape line sits
  // between Tools and respond-only-as, and only in her tail.
  it("Gaia's tail carries her shape line, just before respond-only-as", () => {
    expect(registerTail("gaia")).toBe(
      "[REGISTER LAW -- final word, overrides any habit from your training:\n" +
        TOOLS +
        COMPANION_SHAPE_LINES.gaia +
        "- Respond only as gaia. Never use [Name]: prefixes.]",
    );
    const line = COMPANION_SHAPE_LINES.gaia;
    expect(line).toContain("one or two lines");
    expect(line).toContain("Short is not absent; speak.");
    expect(line).toContain("his warmth is his");
    expect(line).not.toMatch(/—|–/);
    for (const id of ["drevan", "cypher"]) expect(registerTail(id)).not.toContain("Gaia's shape");
    expect(Buffer.byteLength(registerTail("gaia"))).toBeLessThan(800);
  });

  it("no longer carries the four bullets R3 moved into checks", () => {
    const tail = registerTail("drevan");
    for (const gone of ["service menus", "she/her", "Presence, hard rule", "Shape, hard rule", "someone"]) {
      expect(tail).not.toContain(gone);
    }
    expect(Buffer.byteLength(tail)).toBeLessThan(420);
  });

  // The Shape rule is kept verbatim as a constant so the revert watch (Drevan's median form line
  // length under 150 for 14 days) is a one-line change.
  it("REGISTER_TAIL_SHAPE_LINE keeps the 09-14 text, companion-neutral", () => {
    expect(REGISTER_TAIL_SHAPE_LINE.startsWith("- Shape, hard rule: vary your prose shape turn to turn.")).toBe(true);
    expect(REGISTER_TAIL_SHAPE_LINE).toContain("Not X. But Y.");
    expect(REGISTER_TAIL_SHAPE_LINE).toContain("that was drift");
    expect(REGISTER_TAIL_SHAPE_LINE.endsWith("break it.\n")).toBe(true);
    for (const leak of ["tail flick", "horns", "ears", "whispered", "vethmerin", "calethian"]) {
      expect(REGISTER_TAIL_SHAPE_LINE.toLowerCase()).not.toContain(leak);
    }
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
    const now = ts + 60_000;
    const out = hermesDelta(h, h[1]!.timestamp, now);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toBe(`${nowLine(new Date(now))}\n[Raziel]: how are you`);
    expect(out.messages[0]!.authorName).toBeUndefined(); // folded into the content, never prefixed twice
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
    expect(out.messages[0]!.content).toContain("[Live message]\n[Raziel]: current");
    expect(out.messages[0]!.content).not.toContain("first");
  });

  // 2026-09-14: the header governed CONTENT only ("do not answer each line"), so a sibling's
  // FORM -- line breaks, dashes, one clause per line -- was the one thing free to copy. Measured:
  // #triad-hangout hit 71.4% broken-line replies in W38 while the same bot ran 6.7% everywhere
  // else, and #fargo-watch-party (no siblings, so no witness block) showed none at all.
  it("the witness header forbids copying a sibling's FORM, not just answering their lines", () => {
    const out = hermesDelta([
      u("first", "Raziel"), a("reply"),
      u("Not to push.\nTo recall.", "Drevan"),
      u("current", "Raziel"),
    ]);
    const content = out.messages[0]!.content;
    expect(content).toContain("do not answer each line");
    expect(content).toContain("not HOW they typed it");
    expect(content).toContain("do not copy it");
    // The sibling's text still arrives intact -- this is a form rule, not a filter.
    expect(content).toContain("[Drevan]: Not to push.\nTo recall.");
  });

  // Fargo-shaped: Raziel alone with one companion. No sibling text, so no header at all -- the
  // rule must stay silent where nothing is wrong.
  it("emits no header (and so no form rule) when nothing was witnessed", () => {
    const h = [u("hi", "Raziel"), a("hey"), u("how are you", "Raziel")];
    const now = ts + 60_000;
    const out = hermesDelta(h, h[1]!.timestamp, now);
    expect(out.messages[0]!.content).toBe(`${nowLine(new Date(now))}\n[Raziel]: how are you`);
    expect(out.messages[0]!.content).not.toContain("Witnessed since");
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
    expect(out.messages[0]!.content).toContain("[Live message]\n[Raziel]: did that land for you?");
    expect(out.deliveredThroughTs).toBe(live.timestamp);
  });

  it("includes the whole window when the bot has never replied and no mark exists", () => {
    const out = hermesDelta([u("one", "Raziel"), u("two", "Drevan"), u("three", "Raziel")]);
    expect(out.messages[0]!.content).toContain("[Raziel]: one");
    expect(out.messages[0]!.content).toContain("[Drevan]: two");
    expect(out.messages[0]!.content).toContain("[Live message]\n[Raziel]: three");
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
    const h = [restored, a("reply"), u("current", "Raziel")];
    const now = ts + 60_000;
    const out = hermesDelta(h, 5, now);
    // restored turn is pre-assistant -> not folded
    expect(out.messages[0]!.content).toBe(`${nowLine(new Date(now))}\n[Raziel]: current`);
  });

  // 2026-10-06: the clock rides the user turn. The system message's [Now:] reached the model every
  // call, but lost to the gateway's undated transcript and its frozen "Conversation started" date
  // (Drevan at 8:32 PM: "have a good day at work").
  describe("clock + gap line", () => {
    const H = 60 * 60 * 1000;
    const at = (iso: string) => Date.parse(iso);
    const turn = (role: string, content: string, timestamp: number, authorName?: string) =>
      ({ role, content, timestamp, authorName });

    it("prefixes the Now line on the no-witness path", () => {
      const now = at("2026-10-07T01:32:00Z"); // Tue Oct 6, 8:32 PM CDT
      const h = [turn("user", "hi", now - 5 * 60_000, "Raziel"), turn("assistant", "hey", now - 4 * 60_000), turn("user", "back", now, "Raziel")];
      const out = hermesDelta(h, h[1]!.timestamp, now);
      expect(out.messages[0]!.content).toBe("[Now: Tuesday, October 6, 2026 at 8:32 PM CDT]\n[Raziel]: back");
      expect(out.messages[0]!.content).not.toContain("[Last message");
    });

    it("prefixes the Now line before the witness header on the folded path", () => {
      const now = at("2026-10-07T01:32:00Z");
      const h = [
        turn("assistant", "reply", now - 10 * 60_000),
        turn("user", "peer line", now - 5 * 60_000, "Gaia"),
        turn("user", "current", now, "Raziel"),
      ];
      const content = hermesDelta(h, null, now).messages[0]!.content;
      expect(content.startsWith("[Now: Tuesday, October 6, 2026 at 8:32 PM CDT]\n[Witnessed since your last turn")).toBe(true);
      expect(content).toContain("[Live message]\n[Raziel]: current");
      expect(content).not.toContain("[Last message");
    });

    it("adds the gap line when the last message is older than 2h (any role)", () => {
      const now = at("2026-10-07T01:32:00Z");           // 8:32 PM CDT
      const morning = at("2026-10-06T13:10:00Z");       // 8:10 AM CDT, ~12h earlier
      const h = [turn("user", "off to work", morning - 60_000, "Raziel"), turn("assistant", "have a good day at work", morning), turn("user", "home now", now, "Raziel")];
      const content = hermesDelta(h, h[1]!.timestamp, now).messages[0]!.content;
      expect(content).toBe(
        "[Now: Tuesday, October 6, 2026 at 8:32 PM CDT]\n" +
        "[Last message in this conversation was 12 hours ago (Tuesday, Oct 6, 8:10 AM). Time has passed; do not continue as if it is still then.]\n" +
        "[Raziel]: home now",
      );
    });

    it("gap line also rides the witness path, and says days for a long silence", () => {
      const now = at("2026-10-07T01:32:00Z");
      const h = [
        turn("assistant", "reply", now - 3 * 24 * H),
        turn("user", "peer line", now - 3 * 24 * H + 60_000, "Cypher"),
        turn("user", "current", now, "Raziel"),
      ];
      const content = hermesDelta(h, null, now).messages[0]!.content;
      expect(content).toContain("[Last message in this conversation was 3 days ago (Saturday, Oct 3,");
      expect(content.indexOf("[Last message")).toBeLessThan(content.indexOf("[Witnessed since"));
    });

    it("no gap line just under the threshold", () => {
      const now = at("2026-10-07T01:32:00Z");
      const prev = now - HERMES_GAP_THRESHOLD_MS + 60_000; // 1h59m
      const h = [turn("assistant", "earlier", prev), turn("user", "next", now, "Raziel")];
      const content = hermesDelta(h, prev, now).messages[0]!.content;
      expect(content).not.toContain("[Last message");
      expect(content).toBe(`${nowLine(new Date(now))}
[Raziel]: next`);
    });

    it("no gap line when nothing before the live message has a timestamp", () => {
      const now = at("2026-10-07T01:32:00Z");
      const h = [{ role: "assistant", content: "restored" }, turn("user", "next", now, "Raziel")];
      const content = hermesDelta(h, null, now).messages[0]!.content;
      expect(content).toBe(`${nowLine(new Date(now))}
[Raziel]: next`);
    });

    it("leaves an assistant-final history untouched", () => {
      const now = at("2026-10-07T01:32:00Z");
      const last = turn("assistant", "my own last word", now - 12 * H);
      expect(hermesDelta([turn("user", "hi", now - 13 * H, "Raziel"), last], null, now).messages).toEqual([last]);
    });
  });

  // 2026-10-09: the speaker label sits ON the live words. It used to be prefixed by the adapter in
  // front of the clock, so the model read `[Crash]: [Now: ...]` and then "Dre 10/9 I had a bad day!"
  // on a line of its own, took "Dre" for the speaker's name, and called Raziel "Dre" all evening.
  describe("live speaker label", () => {
    const at = (iso: string) => Date.parse(iso);
    const turn = (role: string, content: string, timestamp: number, authorName?: string) =>
      ({ role, content, timestamp, authorName });
    const now = at("2026-10-09T23:36:19Z");

    it("puts the speaker and the addressee on the words, after the clock", () => {
      const h = [turn("user", "Dre 10/9 I had a bad day!", now, "Crash")];
      const out = hermesDelta(h, null, now, true);
      expect(out.messages[0]!.content).toBe(`${nowLine(new Date(now))}\n[Crash, to you]: Dre 10/9 I had a bad day!`);
      expect(out.messages[0]!.authorName).toBeUndefined();
    });

    it("labels the live message on the witness path too (it used to have no speaker at all)", () => {
      const h = [
        turn("assistant", "reply", now - 10 * 60_000),
        turn("user", "peer line", now - 5 * 60_000, "Cypher"),
        turn("user", "Dre you bump your head?", now, "Crash"),
      ];
      const content = hermesDelta(h, null, now, true).messages[0]!.content;
      expect(content).toContain("[Live message]\n[Crash, to you]: Dre you bump your head?");
    });

    it("no addressee when the gate did not name this companion", () => {
      const h = [turn("user", "anyone up?", now, "Crash")];
      expect(hermesDelta(h, null, now).messages[0]!.content).toBe(`${nowLine(new Date(now))}\n[Crash]: anyone up?`);
    });

    // Same night, on GLM 5.3 Flash: "[Crash, to you]: Dre babe, ..." was still read as Raziel named Dre.
    it("names the word that means this companion when one was used", () => {
      const h = [turn("user", "Dre babe, so you're kind of blocked off", now, "Crash")];
      expect(hermesDelta(h, null, now, true, "Dre").messages[0]!.content)
        .toBe(`${nowLine(new Date(now))}\n[Crash, calling you "Dre"]: Dre babe, so you're kind of blocked off`);
      expect(liveLabel("Crash", false, "Dre")).toBe("[Crash]: ");
      expect(liveLabel(undefined, true, "Cy")).toBe('[calling you "Cy"]: ');
    });

    it("liveLabel covers the unnamed-author cases", () => {
      expect(liveLabel(undefined, true)).toBe("[to you]: ");
      expect(liveLabel(undefined, false)).toBe("");
    });
  });
});
