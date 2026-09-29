// The med-answer matcher (spec R-10). Conservative: a false "yes" records a dose he did not take,
// and on a foggy night that record is what he trusts. A false "no" costs nothing (the dose reads
// "no answer", rendered honestly under P-2).

import { describe, it, expect } from "@jest/globals";
import { isAffirmativeMedAnswer } from "../med-answer.js";

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
