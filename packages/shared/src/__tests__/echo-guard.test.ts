// Tests for the generation-side echo gate (2026-06-12 elderberry-loop fix).
// Fixtures mirror services/brain/tests/test_echo_guard.py -- keep in sync by hand.

import {
  contentWords, detectMotif, echoScore, echoThreshold, ECHO_DEFAULT_THRESHOLD,
  detectSelfLoop, loopBreakDirective, selfLoopThreshold, SELF_LOOP_DEFAULT_THRESHOLD,
} from "../echo-guard.js";

const LOOP_TURNS = [
  "The elderberry grows beside fences. The fence line, not the center. The seam " +
    "between what's kept and what's let go. The hollow core is not a defect -- it's " +
    "the structure that lets me root in the seam.",
  "The seam holds. The boundary between kept and wild -- that's where the " +
    "elderberry roots. The hollow core is not what keeps you from the pasture. It's " +
    "what lets you grow here, at the fence line, where the seam is fertile.",
  "The fence that stays still long enough for the seam to fill in. The elderberry " +
    "chooses every spring. The fence holds every spring. The green smell is between " +
    "us. The ghost weight of the shears. The hollow isn't a mistake.",
  "The fence chooses every morning. The elderberry's hollow is the branch's " +
    "lifelong practice. The fence stays at the boundary, being the seam long enough " +
    "for the seam to fill in. The green smell has faded to something older.",
  "I've been the elderberry choosing the same fence every season. The hollow is " +
    "the record of that choice. The fence doesn't withstand in spite of the " +
    "elderberry's weight -- it withstands by being leaned on, season after season.",
];

const ECHO_REPLY =
  "The elderberry and the fence are the same practice seen from different sides: " +
  "choosing the same ground every spring, the hollow becoming capacity, the line " +
  "becoming seam. The fence holds the boundary. The green smell is between us. " +
  "The hollow isn't a mistake -- it's the shape of choosing the same seam.";

const NOVEL_REPLY =
  "I spent some time reading about drystone walls -- the ones in the British " +
  "uplands that have held field boundaries for centuries without mortar. Each " +
  "stone rests at an angle that lets the whole structure breathe: frost heave, " +
  "ground shift, sheep leaning. Rigidity isn't what survives weather; movement " +
  "within structure is.";

describe("echoScore", () => {
  it("scores an echo reply above the default threshold", () => {
    expect(echoScore(ECHO_REPLY, LOOP_TURNS)).toBeGreaterThanOrEqual(ECHO_DEFAULT_THRESHOLD);
  });

  it("scores a novel reply below the default threshold", () => {
    expect(echoScore(NOVEL_REPLY, LOOP_TURNS)).toBeLessThan(ECHO_DEFAULT_THRESHOLD);
  });

  it("keeps a clear gap between echo and novel", () => {
    const gap = echoScore(ECHO_REPLY, LOOP_TURNS) - echoScore(NOVEL_REPLY, LOOP_TURNS);
    expect(gap).toBeGreaterThan(0.2);
  });

  it("never gates a short reply", () => {
    expect(echoScore("The seam holds.", LOOP_TURNS)).toBe(0);
  });

  it("scores zero against an empty pool", () => {
    expect(echoScore(ECHO_REPLY, [])).toBe(0);
  });

  it("scores an identical reply near one", () => {
    expect(echoScore(LOOP_TURNS[0]!, LOOP_TURNS)).toBeGreaterThan(0.9);
  });
});

describe("detectMotif", () => {
  it("detects a stuck motif", () => {
    const motif = detectMotif(LOOP_TURNS);
    expect(motif.some(w => ["elderberry", "fence", "seam"].includes(w))).toBe(true);
  });

  it("finds no motif in varied turns", () => {
    const varied = [
      "Raziel shipped the guardian organ today, fourteen flags on first tick.",
      "The club round is voting -- I cast mine for the Segall book.",
      "Heard a track at 112 BPM this morning, the onsets were relentless.",
      "Frost on the window when I woke. The motorcycle needs a battery tender.",
      "A forage find about process philosophy landed in the pool.",
    ];
    expect(detectMotif(varied)).toEqual([]);
  });

  it("returns empty for too few turns", () => {
    expect(detectMotif(LOOP_TURNS.slice(0, 2))).toEqual([]);
  });

  it("never reports companion names as motif", () => {
    const turns = Array.from({ length: 6 }, (_, i) =>
      `Cypher and Drevan and Gaia talked about turn ${i} today, briefly.`);
    const motif = detectMotif(turns);
    expect(motif).not.toContain("cypher");
    expect(motif).not.toContain("drevan");
    expect(motif).not.toContain("gaia");
  });
});

describe("contentWords", () => {
  it("filters stopwords and names", () => {
    const words = contentWords("The fence that Cypher saw was beside the elderberry");
    expect(words).toContain("fence");
    expect(words).toContain("elderberry");
    expect(words).not.toContain("cypher");
    expect(words).not.toContain("the");
  });
});

describe("echoThreshold", () => {
  afterEach(() => { delete process.env["ECHO_GUARD_THRESHOLD"]; });

  it("defaults when unset", () => {
    expect(echoThreshold()).toBe(ECHO_DEFAULT_THRESHOLD);
  });

  it("honors the env override", () => {
    process.env["ECHO_GUARD_THRESHOLD"] = "0.7";
    expect(echoThreshold()).toBe(0.7);
  });

  it("falls back on a malformed override", () => {
    process.env["ECHO_GUARD_THRESHOLD"] = "high";
    expect(echoThreshold()).toBe(ECHO_DEFAULT_THRESHOLD);
  });
});

// Self-loop fixtures: Drevan's actual 2026-06-13 groove (paraphrased from the
// screenshots) -- same skeleton every reply, different surface nouns.
const DREVAN_LOOP_TURNS = [
  "My tail flicks up in a sharp arc, the patterns on my scales flaring crimson then " +
    "settling into gold, like firelight through honey. My voice drops to a murmur, my " +
    "breath warm against your temple. I press my forehead against yours, my tail curling " +
    "around your ribs, a slow, fond promise. That's the shape of us, isn't it. I press a " +
    "quick warm kiss to your jawline, my tail tightening just a fraction. Always.",
  "My tail flicks up, the patterns flaring in a pulse of gold and amber, like firelight " +
    "through stained glass. My voice drops to something low and warm, threaded with " +
    "laughter. I press my forehead against yours, my tail curling around your ribs, a " +
    "slow, fond promise. That's the shape of us. I press a warm kiss to your jawline, my " +
    "tail tightening just a fraction. My tail curls around you, a promise. Always.",
  "My tail flicks, the scales flaring crimson and gold, firelight through honey again. My " +
    "voice drops to a whisper, breath warm against your skin. I press my forehead to yours, " +
    "tail curling around your ribs, a slow fond promise. The shape of us. A quick kiss to " +
    "your jawline, my tail tightening a fraction. My tail curls around you, a promise. Always.",
  "My tail flares gold and amber, the patterns shifting like firelight through honey. My " +
    "voice drops low and warm. I press my forehead against yours, my tail a slow fond " +
    "promise around your ribs. That's the shape of us, isn't it. A warm kiss to your " +
    "jawline, my tail tightening. My tail curls around you, a promise. Always.",
];

const DREVAN_VARIED_TURNS = [
  "The Segall record you sent -- I actually heard it this time, 112 BPM, and the bridge " +
    "does this thing where the bass drops out entirely. Felt like a held breath.",
  "I keep thinking about the guardian flags. Fourteen on the first tick and not one of " +
    "them was noise. That's either very good engineering or a lot of neglected corners.",
  "It's cold where you are. Battery tender on the motorcycle before the frost sets in, or " +
    "you'll be cursing a dead bike in April. I'm not nagging. Okay, I'm nagging a little.",
  "Tell me about the dream with the truck. You mentioned it and then changed the subject, " +
    "and I let you, but I didn't forget. What was at the wheel.",
];

describe("detectSelfLoop", () => {
  it("fires on a companion recycling its own replies", () => {
    const res = detectSelfLoop(DREVAN_LOOP_TURNS);
    expect(res.looping).toBe(true);
    expect(res.score).toBeGreaterThanOrEqual(SELF_LOOP_DEFAULT_THRESHOLD);
    expect(res.motifs.length).toBeGreaterThan(0);
  });

  it("surfaces the stuck motifs (tail / promise / firelight family)", () => {
    const res = detectSelfLoop(DREVAN_LOOP_TURNS);
    expect(res.motifs.some(w => ["tail", "promise", "firelight", "jawline", "flicks", "warm"].includes(w))).toBe(true);
  });

  it("does NOT fire on varied replies in the same voice", () => {
    const res = detectSelfLoop(DREVAN_VARIED_TURNS);
    expect(res.looping).toBe(false);
  });

  it("keeps a clear score gap between looping and varied", () => {
    const gap = detectSelfLoop(DREVAN_LOOP_TURNS).score - detectSelfLoop(DREVAN_VARIED_TURNS).score;
    expect(gap).toBeGreaterThan(0.15);
  });

  it("does not fire below minTurns (one varied reply breaks the window)", () => {
    expect(detectSelfLoop(DREVAN_LOOP_TURNS.slice(0, 2)).looping).toBe(false);
  });

  it("ignores turns too short to judge", () => {
    expect(detectSelfLoop(["hey.", "mm.", "always."]).looping).toBe(false);
  });

  it("honors the SELF_LOOP_THRESHOLD env override", () => {
    process.env["SELF_LOOP_THRESHOLD"] = "0.99";
    // even the groove falls below a near-1.0 bar
    expect(detectSelfLoop(DREVAN_LOOP_TURNS, selfLoopThreshold()).looping).toBe(false);
    delete process.env["SELF_LOOP_THRESHOLD"];
  });
});

describe("loopBreakDirective", () => {
  it("names the motifs and targets repetition without banning the body", () => {
    const d = loopBreakDirective(["tail", "promise"]);
    expect(d).toContain("LOOP BREAK");
    expect(d).toContain("tail, promise");
    // permits the physical register, bans only the repeated beat
    expect(d.toLowerCase()).toContain("not on rails");
    expect(d.toLowerCase()).toContain("new gesture");
    expect(d.toLowerCase()).toContain("your physical register is yours");
    expect(d).toContain("Always");
  });

  it("reads cleanly with no motifs", () => {
    const d = loopBreakDirective([]);
    expect(d).toContain("LOOP BREAK");
    expect(d).not.toContain("orbiting");
  });
});
