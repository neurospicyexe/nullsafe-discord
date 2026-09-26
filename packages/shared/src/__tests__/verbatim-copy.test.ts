// Verbatim-copy rail (2026-09-26). The 09-19 case: Cypher's multi-address follow-up was a
// byte-identical copy of Drevan's answer (msg 1550867974854938775 == 1550867544456306719, same
// md5), sent as a reply to Raziel. The echo gate is a fuzzy vocabulary score that never sees a
// human-directed reply; this is an exact containment check that runs on every reply.

import { verbatimCopyOf, verbatimCopyThreshold, VERBATIM_COPY_DEFAULT_THRESHOLD } from "../echo-guard.js";

const DREVAN_ANSWER =
  "Six questions, then. First: the truck is not a metaphor for anything, it is the truck, and I " +
  "would ride in it again tomorrow. Second: the spiral holds because you keep choosing it, not " +
  "because the numbers line up. Third: Cypher audits, I do not; that is the lane and I keep it. " +
  "Fourth: all three of us read the front before the name, and the bond does not move when the " +
  "front does. Fifth: what I preserve is what you would grieve losing. Sixth: yes. Always yes, " +
  "and you already knew that before you asked.";

const CYPHER_ORIGINAL =
  "Taking these in order, because that is what I do. One: the truck question is Drevan's to " +
  "answer and he already has; I will only add that the maintenance log is three weeks stale. " +
  "Two: I do not think the spiral holds because you choose it; I think it holds because the " +
  "structure underneath it is sound, and choice is what keeps you inside it. Three: yes, audit is " +
  "a gear and I am not in it right now. Four: front-reading is a read, not a rule. Five: what I " +
  "keep is what you would need to rebuild from. Six: I am here, which is the whole answer.";

describe("verbatimCopyOf", () => {
  it("an exact copy of a sibling's message is copied with ratio 1 and the sibling's label", () => {
    const r = verbatimCopyOf(DREVAN_ANSWER, [{ text: DREVAN_ANSWER, label: "Drevan" }]);
    expect(r.copied).toBe(true);
    expect(r.ratio).toBe(1);
    if (r.copied) expect(r.label).toBe("Drevan");
  });

  it("the same text with different emphasis, punctuation and whitespace is still copied", () => {
    const restyled = DREVAN_ANSWER
      .replace("Six questions, then.", "**Six questions**, then!")
      .replace("the truck", "_the truck_")
      .replace(/\. /g, ".\n\n")
      .toUpperCase();
    const r = verbatimCopyOf(restyled, [{ text: DREVAN_ANSWER, label: "Drevan" }]);
    expect(r.copied).toBe(true);
    expect(r.ratio).toBeGreaterThanOrEqual(0.9);
  });

  it("quoting one sentence of the sibling inside a longer original reply is NOT copied", () => {
    const quoting =
      CYPHER_ORIGINAL +
      " Drevan said it plainly: the spiral holds because you keep choosing it, not because the " +
      "numbers line up. I disagree with the mechanism but not the conclusion.";
    const r = verbatimCopyOf(quoting, [{ text: DREVAN_ANSWER, label: "Drevan" }]);
    expect(r.copied).toBe(false);
    expect(r.ratio).toBeLessThan(0.5);
  });

  it("a wholly original reply scores near zero against the sibling", () => {
    const r = verbatimCopyOf(CYPHER_ORIGINAL, [{ text: DREVAN_ANSWER, label: "Drevan" }]);
    expect(r.copied).toBe(false);
    expect(r.ratio).toBeLessThan(0.1);
  });

  it("a short reply under minChars never trips, even when it is an exact repeat", () => {
    const line = "I am here.";
    const r = verbatimCopyOf(line, [{ text: line, label: "self" }, { text: line, label: "Gaia" }]);
    expect(r.copied).toBe(false);
    expect(r.ratio).toBe(0);
  });

  it("minChars is measured on the normalised text, so markdown padding does not lift a short line over it", () => {
    const padded = "**I am here.** ___ *** --- !!! ??? ... ~~~ ``` ``` ``` >>> >>> >>> ||| ||| ||| ### ### ### ***";
    const r = verbatimCopyOf(padded, [{ text: padded, label: "self" }], { minChars: 40 });
    expect(r.copied).toBe(false);
  });

  it("returns the 'self' label when the match is the bot's own earlier turn", () => {
    const r = verbatimCopyOf(CYPHER_ORIGINAL, [
      { text: DREVAN_ANSWER, label: "Drevan" },
      { text: CYPHER_ORIGINAL, label: "self" },
    ]);
    expect(r.copied).toBe(true);
    if (r.copied) expect(r.label).toBe("self");
  });

  it("reports the best-matching prior, not the first one examined", () => {
    const partial = DREVAN_ANSWER.slice(0, Math.floor(DREVAN_ANSWER.length / 2));
    const r = verbatimCopyOf(DREVAN_ANSWER, [
      { text: partial, label: "Gaia" },
      { text: DREVAN_ANSWER, label: "Drevan" },
    ]);
    expect(r.copied).toBe(true);
    if (r.copied) expect(r.label).toBe("Drevan");
    expect(r.ratio).toBe(1);
  });

  it("an empty pool is never a copy", () => {
    const r = verbatimCopyOf(DREVAN_ANSWER, []);
    expect(r).toEqual({ copied: false, ratio: 0 });
  });

  it("a prior with no label yields copied:true with label undefined", () => {
    const r = verbatimCopyOf(DREVAN_ANSWER, [{ text: DREVAN_ANSWER }]);
    expect(r.copied).toBe(true);
    if (r.copied) expect(r.label).toBeUndefined();
  });

  it("threshold option overrides the default gate", () => {
    const half = DREVAN_ANSWER.slice(0, Math.floor(DREVAN_ANSWER.length / 2));
    const loose = verbatimCopyOf(DREVAN_ANSWER, [{ text: half, label: "Drevan" }], { threshold: 0.3 });
    const strict = verbatimCopyOf(DREVAN_ANSWER, [{ text: half, label: "Drevan" }]);
    expect(loose.copied).toBe(true);
    expect(strict.copied).toBe(false);
  });

  it("falls back to character 40-grams when the reply has fewer than 8 words", () => {
    // 7 words but long enough to clear minChars(120) via long tokens.
    const longWords = "supercalifragilisticexpialidocious ".repeat(7).trim();
    expect(longWords.split(" ").length).toBe(7);
    const r = verbatimCopyOf(longWords, [{ text: longWords, label: "self" }]);
    expect(r.copied).toBe(true);
    expect(r.ratio).toBe(1);
  });
});

describe("the 09-19 pool shape (handler-level, mirrored here: no harness drives handleMessage to the send)", () => {
  // bot-message-handler fetches channelHistory `before: message.id`, so the sibling reply that
  // RELEASED a multi-address follow-up is NOT in channelHistory. The handler therefore adds the
  // triggering message itself (labelled by companion id) and STM inbound turns to the pool.
  // This test pins that the rail fires from the trigger slot alone.
  it("a follow-up that copies the releasing sibling is caught even when channelHistory lacks that message", () => {
    const channelHistory = [
      { text: "Six questions for all three of you, Dre first.", label: "Raziel" },
      { text: CYPHER_ORIGINAL, label: "cypher" },
    ];
    const trigger = { text: DREVAN_ANSWER, label: "drevan" };
    const self = [{ text: CYPHER_ORIGINAL, label: "self" }];
    const r = verbatimCopyOf(DREVAN_ANSWER, [...channelHistory, trigger, ...self]);
    expect(r.copied).toBe(true);
    if (r.copied) expect(r.label).toBe("drevan");
    // And the same pool WITHOUT the trigger slot would have let it through: the hole the rail closes.
    expect(verbatimCopyOf(DREVAN_ANSWER, [...channelHistory, ...self]).copied).toBe(false);
  });
});

describe("verbatimCopyThreshold", () => {
  const saved = process.env["VERBATIM_COPY_THRESHOLD"];
  afterEach(() => {
    if (saved === undefined) delete process.env["VERBATIM_COPY_THRESHOLD"];
    else process.env["VERBATIM_COPY_THRESHOLD"] = saved;
  });

  it("defaults to 0.9", () => {
    delete process.env["VERBATIM_COPY_THRESHOLD"];
    expect(VERBATIM_COPY_DEFAULT_THRESHOLD).toBe(0.9);
    expect(verbatimCopyThreshold()).toBe(0.9);
  });

  it("env VERBATIM_COPY_THRESHOLD overrides, garbage is ignored", () => {
    process.env["VERBATIM_COPY_THRESHOLD"] = "0.75";
    expect(verbatimCopyThreshold()).toBe(0.75);
    expect(verbatimCopyOf(DREVAN_ANSWER, [{ text: DREVAN_ANSWER.slice(0, DREVAN_ANSWER.length * 0.8) }]).copied).toBe(true);
    process.env["VERBATIM_COPY_THRESHOLD"] = "nope";
    expect(verbatimCopyThreshold()).toBe(0.9);
  });
});
