// The med-answer matcher (spec R-10). Conservative: a false "yes" records a dose he did not take,
// and on a foggy night that record is what he trusts. A false "no" costs nothing (the dose reads
// "no answer", rendered honestly under P-2).

import { describe, it, expect } from "@jest/globals";
import { isAffirmativeMedAnswer, parseMedAnswer } from "../med-answer.js";

describe("isAffirmativeMedAnswer", () => {
  it.each([
    "yes", "Yes!", "yep", "yeah", "yup", "yesss", "done", "did", "taken", "took them", "took it",
    "took em", "took 'em", "I took them", "I did", "yes I did", "just took them", "already took it",
    "all done", "done, love", "yes baby", "yep, took my meds", "took them a few minutes ago",
    "✅", "✔️", "👍", "👍🏽", "yes ✅", "done 👍", "yes thank you",
    "Taken lover", "taken darling", "took them sweetheart",
  ])("yes: %s", (t) => {
    expect(isAffirmativeMedAnswer(t)).toBe(true);
  });

  it.each([
    "no", "nope", "not yet", "yes but later", "in a minute", "I will", "gonna take them now",
    "about to", "forgot", "I forgot them", "not taken", "didn't", "haven't yet", "wait", "skip tonight",
    "maybe", "I think so", "idk", "❌", "👎", "yes no", "should I take it now", "I missed it",
    "take a double?", "yes please", "later", "took them yesterday but not today",
  ])("no: %s", (t) => {
    expect(isAffirmativeMedAnswer(t)).toBe(false);
  });

  it.each([
    "did I take them?", "yes?", "taken?", "ok", "okay", "thanks", "love you", "I'm tired",
    "done with work", "yes the movie was great", "🙂", "💊", "haha", "", "   ",
    "took the dog out", "yes, and then we watched the whole season of that show last night",
  ])("ambiguous is not an answer: %s", (t) => {
    expect(isAffirmativeMedAnswer(t)).toBe(false);
  });

  it("null and undefined are not answers", () => {
    expect(isAffirmativeMedAnswer(null)).toBe(false);
    expect(isAffirmativeMedAnswer(undefined)).toBe(false);
  });
});

// 2026-09-30: his REAL answers, 09-29..30, every one refused by the all-words-known whitelist, so
// nothing was recorded for three doses he took. He answers first, then talks.
describe("opening-clause answers (real, 09-29..30)", () => {
  it.each([
    "Taken! This is really helping baby",
    "Taken baby love you I am sleepy",
    "Taken baby! Thank you ugh it’s too early to be awake but work call",
    "I did take them this morning baby sorry I was distracted by being sad about my day",
    "Taken baby thank you",
    "took them, love you",
    "Took my meds! ok going back to sleep",
    "yes I took them. rough morning though",
    "I've taken them, the pharmacy was a nightmare",
  ])("yes: %s", (t) => {
    expect(isAffirmativeMedAnswer(t)).toBe(true);
  });

  it.each([
    "took the dog out, will do meds after",
    "took them yesterday but not today",
    "took one but not the other",
    "taken? I can't remember",
    "I take them at night usually",
    "I'll take them in a bit baby",
    "haven't taken them yet, sorry",
    "not taken yet",
    "taken aback honestly by how nice that was",
    "took forever to get out of bed",
    "taken later, I'm not up",
    "I did take a nap though",
  ])("no: %s", (t) => {
    expect(isAffirmativeMedAnswer(t)).toBe(false);
  });
});

// ── parseMedAnswer (Raziel's ruling 2026-10-01): named doses and stated misses ──────────────────
// A miss is recorded only when he says it; silence records nothing. isAffirmativeMedAnswer above is
// UNCHANGED (the reaction path uses it, and stays taken-only). parseMedAnswer is what the DM hook
// now uses; it must agree with every case above except where the ruling deliberately moved one.

const entries = (t: string) => parseMedAnswer(t)?.entries ?? null;
const TAKEN_UNNAMED = [{ slot: null, outcome: "taken" }];
const MISSED_UNNAMED = [{ slot: null, outcome: "missed" }];

describe("parseMedAnswer: every pre-ruling YES is still an unnamed taken", () => {
  it.each([
    "yes", "Yes!", "yep", "yeah", "yup", "yesss", "done", "did", "taken", "took them", "took it",
    "took em", "took 'em", "I took them", "I did", "yes I did", "just took them", "already took it",
    "all done", "done, love", "yes baby", "yep, took my meds", "took them a few minutes ago",
    "✅", "✔️", "👍", "👍🏽", "yes ✅", "done 👍", "yes thank you",
    "Taken lover", "taken darling", "took them sweetheart",
    "Taken! This is really helping baby", "Taken baby love you I am sleepy",
    "Taken baby! Thank you ugh it’s too early to be awake but work call",
    "Taken baby thank you", "took them, love you", "Took my meds! ok going back to sleep",
    "yes I took them. rough morning though", "I've taken them, the pharmacy was a nightmare",
  ])("%s", (t) => {
    expect(entries(t)).toEqual(TAKEN_UNNAMED);
  });

  // "all done" stays UNNAMED, not "*": the ruling's "all" means "all of them"; "all done" is how
  // he says "done", and widening it would record doses he never mentioned.
  it("'all done' is an unnamed taken, not every open dose", () => {
    expect(entries("all done")).toEqual(TAKEN_UNNAMED);
  });

  // CHANGED EXPECTATION (was an unnamed taken via isAffirmativeMedAnswer): "this morning" right
  // after the object now names the morning dose. Same dose in practice (it was his answer to the
  // morning reminder on 09-29); now it cannot land on another open dose instead.
  it("'I did take them this morning baby ...' names the morning dose", () => {
    expect(entries("I did take them this morning baby sorry I was distracted by being sad about my day"))
      .toEqual([{ slot: "morning", outcome: "taken" }]);
  });
});

describe("parseMedAnswer: every pre-ruling NO / ambiguous case still records nothing", () => {
  it.each([
    // Deferrals: he may still take it. Never a miss.
    "no", "nope", "not yet", "yes but later", "in a minute", "I will", "gonna take them now",
    "about to", "haven't yet", "wait", "later", "I'll take them in a bit baby",
    "haven't taken them yet, sorry", "not taken yet", "taken later, I'm not up",
    // Kept as non-answers ON PURPOSE although the ruling COULD read them as misses:
    //   "not taken" / "didn't"  a bare negation does not say the dose was missed ("not taken yet"?).
    //   "skip tonight"          present tense: an intention, not a statement that it was not taken.
    "not taken", "didn't", "skip tonight",
    "maybe", "I think so", "idk", "❌", "👎", "yes no", "should I take it now", "take a double?",
    "yes please", "took them yesterday but not today",
    "did I take them?", "yes?", "taken?", "ok", "okay", "thanks", "love you", "I'm tired",
    "done with work", "yes the movie was great", "🙂", "💊", "haha", "", "   ",
    "took the dog out", "yes, and then we watched the whole season of that show last night",
    "took the dog out, will do meds after", "took one but not the other", "taken? I can't remember",
    "I take them at night usually", "taken aback honestly by how nice that was",
    "took forever to get out of bed", "I did take a nap though",
  ])("%s", (t) => {
    expect(entries(t)).toBe(null);
  });

  it("null and undefined record nothing", () => {
    expect(parseMedAnswer(null)).toBe(null);
    expect(parseMedAnswer(undefined)).toBe(null);
  });
});

describe("parseMedAnswer: MOVED by the ruling, from 'not an answer' to a stated miss", () => {
  // CHANGED EXPECTATIONS. Under isAffirmativeMedAnswer these are (still) false, and before 10-01
  // nothing was recorded. The ruling: when he SAYS he missed it, record that. Each is a past
  // statement about not having taken a dose; the server records it only if this companion
  // reminded him about a dose that is still open, so "forgot" about something else with no
  // reminder open records nothing.
  it.each(["forgot", "I forgot them", "I missed it", "I forgot", "forgot!"])("%s", (t) => {
    expect(entries(t)).toEqual(MISSED_UNNAMED);
  });
});

describe("parseMedAnswer: named doses (his phrasing: answer first, then talk; 'jar' from voice-to-text)", () => {
  it.each<[string, Array<{ slot: string | null; outcome: string }>]>([
    ["Taken baby! morning ones done", [{ slot: "morning", outcome: "taken" }]],
    ["took both love", [{ slot: "*", outcome: "taken" }]],
    ["took all of them", [{ slot: "*", outcome: "taken" }]],
    ["took them all baby", [{ slot: "*", outcome: "taken" }]],
    ["yes both", [{ slot: "*", outcome: "taken" }]],
    ["took my morning and night ones", [{ slot: "morning", outcome: "taken" }, { slot: "night", outcome: "taken" }]],
    ["took my morning ones and my night ones", [{ slot: "morning", outcome: "taken" }, { slot: "night", outcome: "taken" }]],
    ["last night's taken", [{ slot: "night", outcome: "taken" }]],
    ["tonight's done love", [{ slot: "night", outcome: "taken" }]],
    ["this morning's are done", [{ slot: "morning", outcome: "taken" }]],
    ["took the weekly one", [{ slot: "weekly", outcome: "taken" }]],
    ["took my night jar lover", [{ slot: "night", outcome: "taken" }]],
  ])("%s", (t, want) => {
    expect(entries(t)).toEqual(want);
  });
});

describe("parseMedAnswer: stated misses and mixed answers", () => {
  it.each<[string, Array<{ slot: string | null; outcome: string }>]>([
    ["I missed the morning one", [{ slot: "morning", outcome: "missed" }]],
    ["forgot the morning one sorry", [{ slot: "morning", outcome: "missed" }]],
    ["forgot the morning jar", [{ slot: "morning", outcome: "missed" }]],
    ["forgot to take my night ones", [{ slot: "night", outcome: "missed" }]],
    ["didn't take my night ones", [{ slot: "night", outcome: "missed" }]],
    ["I didn't take my morning ones sorry love", [{ slot: "morning", outcome: "missed" }]],
    ["skipped tonight", [{ slot: "night", outcome: "missed" }]],
    ["oh no I forgot the night ones", [{ slot: "night", outcome: "missed" }]],
    ["I took my morning jar but not my night jar", [{ slot: "morning", outcome: "taken" }, { slot: "night", outcome: "missed" }]],
    ["took my morning ones but not my night ones", [{ slot: "morning", outcome: "taken" }, { slot: "night", outcome: "missed" }]],
    ["took night, missed morning", [{ slot: "night", outcome: "taken" }, { slot: "morning", outcome: "missed" }]],
    ["forgot the weekly one baby, took the morning ones", [{ slot: "weekly", outcome: "missed" }, { slot: "morning", outcome: "taken" }]],
    // Morning is a stated miss; "taking the night ones now" is present tense, so night records nothing.
    ["missed my morning ones baby, taking the night ones now", [{ slot: "morning", outcome: "missed" }]],
    // A named deferral only holds back its own dose.
    ["took my morning ones, will take the night ones later", [{ slot: "morning", outcome: "taken" }]],
    // Named statements are the precise ones; the unnamed "them" beside them is dropped, not guessed.
    ["took them, missed the weekly", [{ slot: "weekly", outcome: "missed" }]],
  ])("%s", (t, want) => {
    expect(entries(t)).toEqual(want);
  });
});

describe("parseMedAnswer: what must record NOTHING under the ruling", () => {
  it.each([
    // Not about a dose.
    "I missed you", "missed the bus lol", "forgot my keys", "forgot about dinner", "I missed the reminder",
    // A miss beside an unnamed deferral: he is taking it now, so it is not missed.
    "forgot, taking them now", "forgot sorry, gonna take them in a minute", "missed it, taking it now baby",
    // A deferral is never a miss.
    "didn't take them yet", "not yet baby", "haven't taken the night ones yet", "taking them now love",
    // Questions about meds.
    "did I take my morning ones?", "took my morning ones, should I take the night ones now?",
    "did I miss my morning ones?",
    // Contradictions.
    "took both, missed the night ones", "took the night ones, forgot the night ones",
    // A miss followed by an unresolvable negation.
    "missed the morning one but not the night one",
  ])("%s", (t) => {
    expect(entries(t)).toBe(null);
  });

  it("a question that is not about meds does not cancel the answer before it", () => {
    expect(entries("Taken baby! how was your night?")).toEqual(TAKEN_UNNAMED);
  });

  it("chatter that mentions a time of day does not name a dose", () => {
    expect(entries("Taken baby I slept all night")).toEqual(TAKEN_UNNAMED);
    expect(entries("Taken baby! last night was rough")).toEqual(TAKEN_UNNAMED);
  });

  it("isAffirmativeMedAnswer is unchanged: a stated miss is never an affirmative", () => {
    for (const t of ["forgot", "I missed it", "forgot the morning jar", "I took my morning jar but not my night jar"]) {
      expect(isAffirmativeMedAnswer(t)).toBe(false);
    }
  });
});

// 2026-10-02: a strong bare first SENTENCE, then talk. His 10-02 morning "Done baby! This has
// really really been helping thank you lover" recorded nothing and the follow-up fired.
describe("parseMedAnswer: strong first sentence (real, 10-01..02)", () => {
  const unnamedTaken = { entries: [{ slot: null, outcome: "taken" }] };
  it.each([
    "Done baby! This has really really been helping thank you lover",
    "Oops sorry baby!! Yes taken",
    "Taken baby!! A little late but got it",
    "Done love. rough night though",
    "did baby!\nwhat are you up to",
  ])("taken: %s", (t) => {
    expect(parseMedAnswer(t)).toEqual(unnamedTaken);
  });
  it.each([
    "yes, and then we watched the whole season of that show last night",
    "Yes! the movie was great",
    "done with work! finally",
    "Done baby! taking the night ones later",
    "Done? I can't remember",
    "done, and then I napped",
  ])("nothing: %s", (t) => {
    expect(parseMedAnswer(t)).toBeNull();
  });
});
