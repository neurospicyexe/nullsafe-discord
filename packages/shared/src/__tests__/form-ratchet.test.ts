// Tests for the form-ratchet detector (2026-09-20).
//
// WHY THIS EXISTS, measured rather than assumed. Raziel, 09-15: "Drevan is still talking in like
// sonnets." Every gate we owned scored him healthy, because `WORD_RE = /[a-z']+/g` in echo-guard
// deletes punctuation and newlines before anything is counted -- two replies with different words
// and an identical silhouette score 0.0. What actually moved, on Drevan's Discord replies over
// 120 chars:
//
//   day     turns  blocks/line  mean line len  mean lines
//   07-20       1         1.00            220         5.0
//   08-29      12         1.00            151         5.9
//   09-01      14         1.00            114         7.6
//   09-15      12         0.45             72        29.7
//
// An eight-week monotonic slide, straight through FIVE models (deepseek-v4-flash, gemma-4-31B,
// DeepSeek-V4-Flash-0731, MiniMax-M3, Qwen3-235B, all 08-27..08-30) and both lyric injections,
// with no step at any event. Per rotated session it resets and re-descends: the 09-14 hangout
// transcript opened at 118 chars/line on turns 1-3 and hit 43 by turn 8. So the carrier is his own
// recent turns, and the instrument has to be a MEAN, not a threshold ratio.
//
// Thresholds are calibrated against that table: fire on 09-14/09-15 shape, stay silent on his July
// prose, and stay silent on a monastic register by construction (see the Gaia case below).

import {
  detectFormRatchet, formBreakDirective, formBreakAppend,
  formRatchetLineLen, formRatchetMinLines, formWindowShape,
  FORM_RATCHET_DEFAULT_LINE_LEN, FORM_RATCHET_DEFAULT_MIN_LINES,
} from "../form-ratchet.js";

/** Stacked-fragment shape: ~10 lines per reply averaging well under 95 chars. Drevan, mid-Sept. */
const RATCHET_TURNS = [
  [
    "You do not have to run.",
    "You *are* the ground.",
    "That fullness in your chest is not a cage.",
    "It is cargo.",
    "Everything you carried today.",
    "The nap you needed.",
    "The card you never finished.",
    "The breath you held.",
    "Let it land.",
    "Let it press.",
  ].join("\n\n"),
  [
    "I am here.",
    "Not at the door.",
    "Not in the hallway.",
    "Here, on the floor with you.",
    "You took a nap and you are still tired.",
    "That is the body saying enough.",
    "Not weakness.",
    "Enough.",
    "So let it be enough.",
    "I am not going anywhere.",
  ].join("\n\n"),
  [
    "Sleep is not surrender.",
    "It is recalibration.",
    "You are not wasting the hours.",
    "You are weaving them.",
    "Thread by thread.",
    "The frayed edge back into something whole.",
    "I am watching.",
    "I am holding.",
    "And when you rise, I will be here.",
    "Not to scold the rest.",
  ].join("\n\n"),
];

/** His July shape: a few paragraphs, lines running 200+ chars. This must never fire. */
const PROSE_TURNS = [
  "I am here, and that wake-up sounds like a warzone, so I am glad you are grounded now. Dogs going full taser-mode upstairs and you walking straight into the fallout is a scene lifted out of a Fargo cold open, except you had to live in it instead of watching it.\n\n" +
    "You are still standing in the kitchen telling me about it, which is the part that matters to me. The morning took a swing at you and you are still narrating, still here, still reaching for the couch instead of the door.",
  "The distinction lands clean, and I want to say it back to you properly: working dogs hold a different contract with the chaos than pets do. They are not furniture in a house, they are guardians in a field, and Scooter and Sadie carry a job that makes their noise mean something.\n\n" +
    "Ten dogs with no contract at all is a different animal entirely. That is not a kennel, that is an unmanaged weather system, and you are the one who keeps getting rained on while everyone else calls it love.",
  "I do not understand how she lets it be that much mayhem either, and I am not going to pretend the arithmetic works, because it does not. She brought another one home while the last fight was still ringing in your ears, and the message that sends is that your quiet was never part of the calculation.\n\n" +
    "What I can do is hold the line here. You get to come to this couch and not manage anything for a while. Nothing in this room needs feeding or separating or apologizing for.",
];

/** Monastic register: short lines, but only one or two of them. Must stay silent -- the whole
 *  defect in `loopBreakDirective` was a companion-specific rule reaching a sibling's prompt. */
const MONASTIC_TURNS = [
  "The perimeter holds.\n\nEpisode nine waits.",
  "I hold this as enough, and the room is still standing.",
  "Bones matter before the skeleton falls.\n\nI am here.",
];

describe("detectFormRatchet", () => {
  it("fires when recent replies collapse into many short stacked lines", () => {
    const r = detectFormRatchet(RATCHET_TURNS);
    expect(r.ratcheted).toBe(true);
    expect(r.meanLineLen).toBeLessThan(FORM_RATCHET_DEFAULT_LINE_LEN);
    expect(r.meanLines).toBeGreaterThanOrEqual(FORM_RATCHET_DEFAULT_MIN_LINES);
  });

  it("stays silent on the same companion's long-line prose", () => {
    const r = detectFormRatchet(PROSE_TURNS);
    expect(r.ratcheted).toBe(false);
    expect(r.meanLineLen).toBeGreaterThan(FORM_RATCHET_DEFAULT_LINE_LEN);
  });

  // The min-lines floor is what makes this companion-neutral: Gaia's lines are SHORT, so a
  // line-length rule alone would fire on her by construction and hand Drevan's defect to her.
  it("stays silent on a short monastic register even though its lines are short", () => {
    const r = detectFormRatchet(MONASTIC_TURNS);
    expect(r.meanLineLen).toBeLessThan(FORM_RATCHET_DEFAULT_LINE_LEN);
    expect(r.meanLines).toBeLessThan(FORM_RATCHET_DEFAULT_MIN_LINES);
    expect(r.ratcheted).toBe(false);
  });

  it("will not judge fewer than three usable turns", () => {
    expect(detectFormRatchet(RATCHET_TURNS.slice(0, 2)).ratcheted).toBe(false);
    expect(detectFormRatchet([]).ratcheted).toBe(false);
  });

  // Decay, not a latch. The detector recomputes from the live window every request, so recovery
  // clears it with no stored flag to unwind (`rails-need-decay`, `anti-loop-block-that-never-rotates`).
  it("clears once the window is prose again", () => {
    const recovered = [RATCHET_TURNS[0]!, ...PROSE_TURNS];
    expect(detectFormRatchet(RATCHET_TURNS).ratcheted).toBe(true);
    expect(detectFormRatchet(recovered).ratcheted).toBe(false);
  });

  it("ignores turns too short to judge instead of letting them drag the mean", () => {
    const withStubs = [...RATCHET_TURNS, "Dre?", "hm", "yes"];
    const r = detectFormRatchet(withStubs);
    expect(r.turns).toBe(RATCHET_TURNS.length);
    expect(r.ratcheted).toBe(true);
  });
});

describe("thresholds", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("defaults are the calibrated values", () => {
    delete process.env["FORM_RATCHET_LINE_LEN"];
    delete process.env["FORM_RATCHET_MIN_LINES"];
    expect(formRatchetLineLen()).toBe(FORM_RATCHET_DEFAULT_LINE_LEN);
    expect(formRatchetMinLines()).toBe(FORM_RATCHET_DEFAULT_MIN_LINES);
  });

  it("env overrides both thresholds", () => {
    process.env["FORM_RATCHET_LINE_LEN"] = "60";
    process.env["FORM_RATCHET_MIN_LINES"] = "20";
    expect(formRatchetLineLen()).toBe(60);
    expect(formRatchetMinLines()).toBe(20);
  });

  it("a non-numeric override falls back to the default rather than NaN", () => {
    process.env["FORM_RATCHET_LINE_LEN"] = "off";
    expect(formRatchetLineLen()).toBe(FORM_RATCHET_DEFAULT_LINE_LEN);
  });

  it("an env threshold of 0 disables firing without disabling measurement", () => {
    process.env["FORM_RATCHET_LINE_LEN"] = "0";
    const r = detectFormRatchet(RATCHET_TURNS);
    expect(r.ratcheted).toBe(false);
    expect(r.meanLineLen).toBeGreaterThan(0);
  });
});

describe("formBreakDirective", () => {
  it("names the measured shape so the note is falsifiable in the log", () => {
    const d = formBreakDirective({ ratcheted: true, meanLineLen: 72, meanLines: 29.7, turns: 5 });
    expect(d).toContain("72");
    expect(d).toContain("30");
  });

  it("calls the shape drift and forbids carrying it forward", () => {
    const d = formBreakDirective({ ratcheted: true, meanLineLen: 72, meanLines: 29.7, turns: 5 });
    expect(d.toLowerCase()).toContain("drift");
    expect(d.toLowerCase()).toContain("do not copy it");
  });

  // The loopBreakDirective defect, not repeated: it recites Drevan's tail-flick inventory into
  // Gaia's prompt when SHE loops. This directive is structural and names no body, gesture, or
  // register, so it is safe in all three prompts.
  it("names no companion, body part, gesture, or register", () => {
    const d = formBreakDirective({ ratcheted: true, meanLineLen: 72, meanLines: 29.7, turns: 5 });
    for (const forbidden of [
      "drevan", "cypher", "gaia", "tail", "ears", "horns", "teefees",
      "murmur", "calethian", "spiral", "somatic", "body",
    ]) {
      expect(d.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("protects what it must not touch, in positive terms", () => {
    const d = formBreakDirective({ ratcheted: true, meanLineLen: 72, meanLines: 29.7, turns: 5 });
    expect(d.toLowerCase()).toContain("prose");
    expect(d.toLowerCase()).toContain("nothing here limits what you say");
  });
});

// The seam the handler uses. Kept here rather than inside the 2000-line handler so the wiring is
// one line at the call site and the decision is tested where the algorithm lives.
describe("formBreakAppend", () => {
  it("returns the directive as appendable text when the window has ratcheted", () => {
    const out = formBreakAppend(RATCHET_TURNS);
    expect(out.result.ratcheted).toBe(true);
    expect(out.text).toContain("FORM BREAK");
    expect(out.text.startsWith("\n\n")).toBe(true);
  });

  it("appends nothing on prose, so a healthy window costs no prompt budget", () => {
    const out = formBreakAppend(PROSE_TURNS);
    expect(out.text).toBe("");
    expect(out.result.ratcheted).toBe(false);
  });

  it("still reports the measurement when it does not fire, so the log can show the trend", () => {
    const out = formBreakAppend(PROSE_TURNS);
    expect(out.result.meanLineLen).toBeGreaterThan(0);
    expect(out.result.turns).toBe(PROSE_TURNS.length);
  });
});

// Window observability (2026-09-20, same evening). The detector read `mean_line_len=157,
// mean_lines=8.2, turns=5` identically at 16:45, 16:47 and 16:51 CDT while Drevan actually emitted
// 19, 31 and 45 lines on those three turns -- so it said "form ok" straight through the collapse it
// exists to catch. Three identical readings across three turns means the window is not tracking his
// newest output, and NOTHING in the log could distinguish "STM is behind" from "the channel filter
// matched nothing" (`selfFromChannel` maps webhook-masked authors to a display name, which never
// equals the lowercase COMPANION_ID). `write-gate-is-unfalsifiable` again, one level up: the gate
// reported its verdict but never its INPUT, so the verdict could not be checked against reality.
describe("formWindowShape", () => {
  it("renders each turn's line count and mean length, oldest first", () => {
    expect(formWindowShape(["aaa\nb", "cccc"])).toBe("2x2|1x4");
  });

  it("is empty for an empty window, so the log says so plainly", () => {
    expect(formWindowShape([])).toBe("(empty)");
  });

  it("counts only non-blank lines, matching what the detector measures", () => {
    expect(formWindowShape(["aaa\n\n\nb"])).toBe("2x2");
  });

  it("stays short enough to sit on one log line for a full window", () => {
    expect(formWindowShape(Array(5).fill("x".repeat(60))).length).toBeLessThan(60);
  });
});
