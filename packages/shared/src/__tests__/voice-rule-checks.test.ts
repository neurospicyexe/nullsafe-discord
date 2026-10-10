import { describe, it, expect } from "@jest/globals";
import {
  detectRuleBreaks, ruleCheckAppend, ruleCheckBlock, ruleCheckOwnName, calledAsName,
  RULE_CHECK_EM_DASH, RULE_CHECK_PRESENCE, RULE_CHECK_PRONOUNS,
} from "../voice-markers.js";

// R3 prompt diet (2026-09-29): three standing prompt rules became checks on the companion's own
// last reply. Dashes are written as escapes so this file never carries the character it forbids.
const EM = "\u2014";
const EN = "\u2013";

const CLEAN =
  "*I settle in close, shoulder to yours.* The deploy held overnight. Raziel, he said the queue " +
  "drained by six, and that is the whole of it.";

describe("rule checks: em dash", () => {
  it("counts an em dash", () => {
    expect(detectRuleBreaks("cypher", `The read holds ${EM} ship it.`).emDash).toBe(1);
  });
  it("counts an en dash used as a dash", () => {
    expect(detectRuleBreaks("cypher", `The read holds ${EN} ship it.`).emDash).toBe(1);
    expect(detectRuleBreaks("cypher", `word${EN}word`).emDash).toBe(1);
  });
  it("does not count an en dash in a digit range, or a double hyphen", () => {
    expect(detectRuleBreaks("cypher", `Pages 3${EN}5, weeks 10${EN}12.`).emDash).toBe(0);
    expect(detectRuleBreaks("cypher", "The read holds -- ship it.").emDash).toBe(0);
  });
});

describe("rule checks: someone as actor", () => {
  it("hits when someone/somebody leads an action line", () => {
    expect(detectRuleBreaks("drevan", "*someone settles in close*").someone).toBe(1);
    expect(detectRuleBreaks("drevan", "*Somebody wraps around you, my ribs to your back*").someone).toBe(1);
  });
  it("hits mid-line after clause punctuation or and/then", () => {
    expect(detectRuleBreaks("drevan", "*the room goes quiet, someone leans closer*").someone).toBe(1);
    expect(detectRuleBreaks("drevan", "*a breath, and someone reaches for you*").someone).toBe(1);
  });
  it("hits when the companion narrates itself by name", () => {
    expect(detectRuleBreaks("drevan", "*Drevan settles beside you*").someone).toBe(1);
  });
  it("does not hit first-person lines, object uses, or text outside action lines", () => {
    for (const text of [
      "*I reach for someone's hand*",
      "*I reach for someone*",
      "*I look like someone who slept*",
      "*as if someone else lit the candle*",
      "Someone left the door open downstairs.",
      "**someone** said it first",
      "*Drevan's coat is still on the chair*",
      "*Cypher sets the mug down*", // another companion's name is not a self-narration hit for Drevan
    ]) {
      expect({ text, n: detectRuleBreaks("drevan", text).someone }).toEqual({ text, n: 0 });
    }
  });
});

describe("rule checks: she/her for Raziel", () => {
  it("hits she/her after Raziel, Crash or the Architect in one sentence", () => {
    expect(detectRuleBreaks("gaia", "Raziel came home and she was tired.").sheHer).toBe(1);
    expect(detectRuleBreaks("gaia", "Crash said her head hurt.").sheHer).toBe(1);
    expect(detectRuleBreaks("gaia", "The Architect holds herself very still.").sheHer).toBe(1);
    expect(detectRuleBreaks("gaia", "I watched Raziel set her cup down.").sheHer).toBe(1);
  });
  it("does not hit he/they for Raziel", () => {
    expect(detectRuleBreaks("gaia", "Raziel came home and he was tired. They slept.").sheHer).toBe(0);
  });
  it("does not hit she/her that belongs to someone else", () => {
    for (const text of [
      "Raziel's mother called and she sounded well.",
      "Raziel told Blue she could stay.",
      "Raziel sat with Babita while she cooked.",
      "Raziel said the member fronting today uses she/her.",
      "Raziel is out. She brought soup.", // new sentence, new referent
      "crash landing, and her plane was fine.", // lowercase crash is the common word
      "Raziel runs Hermes on the box.",
    ]) {
      expect({ text, n: detectRuleBreaks("gaia", text).sheHer }).toEqual({ text, n: 0 });
    }
  });
});

describe("ruleCheckAppend", () => {
  it("injects nothing on a clean reply but still reports it was judged", () => {
    const { text, result } = ruleCheckAppend("drevan", [CLEAN]);
    expect(text).toBe("");
    expect(result).toEqual({ emDash: 0, someone: 0, sheHer: 0, ownName: 0, turns: 1 });
  });

  it("reports turns=0 on an empty window so the caller logs nothing", () => {
    expect(ruleCheckAppend("cypher", []).result.turns).toBe(0);
  });

  it("judges only the NEWEST self turn (the window is oldest-first)", () => {
    const dirty = `*someone settles in* Raziel, she ${EM} yes.`;
    expect(ruleCheckAppend("drevan", [dirty, CLEAN]).text).toBe("");
    const hit = ruleCheckAppend("drevan", [CLEAN, dirty]);
    expect(hit.result).toEqual({ emDash: 1, someone: 1, sheHer: 1, ownName: 0, turns: 1 });
    expect(hit.text).toBe(RULE_CHECK_EM_DASH + RULE_CHECK_PRESENCE + RULE_CHECK_PRONOUNS);
  });

  it("injects only the corrective that matches the hit", () => {
    expect(ruleCheckAppend("cypher", [`Ship it ${EM} now.`]).text).toBe(RULE_CHECK_EM_DASH);
    expect(ruleCheckAppend("drevan", ["*someone leans in*"]).text).toBe(RULE_CHECK_PRESENCE);
    expect(ruleCheckAppend("gaia", ["Raziel rests; let her sleep."]).text).toBe(RULE_CHECK_PRONOUNS);
  });
});

// 2026-10-09, #triad-hangout: Raziel opened with "Dre 10/9 I had a bad day!" and Drevan called
// Raziel by his own name for the rest of the evening. These are his actual lines.
describe("own-name vocative", () => {
  it("catches tonight's lines", () => {
    expect(detectRuleBreaks("drevan", `Rest tonight, Dre ${EM} tomorrow we watch something.`).ownName).toBe(1);
    expect(detectRuleBreaks("drevan", "Rest up tonight, Dre. Tomorrow's the good thing.").ownName).toBe(1);
    expect(detectRuleBreaks("drevan", "You're Dre, I'm Dre too. Whole vibe got real confusing.").ownName).toBe(1);
    expect(detectRuleBreaks("drevan", "Dre, come sit.").ownName).toBe(1);
    expect(detectRuleBreaks("cypher", "Noted, Cy.").ownName).toBe(1);
    expect(detectRuleBreaks("gaia", "Rest, Gaia.").ownName).toBe(1);
  });

  it("leaves his own name alone when it is not aimed at someone", () => {
    for (const text of [
      "You called me Dre and I felt it land.",
      "That's Dre's couch spot, nobody else's.",
      "Hey, love. Heard you, bad day.",
      "Crash, come here.",
      "Drevan here. I'm in.",
      "I heard you say Dre, and I came.",
      "Cypher's read was right, Raziel.",
    ]) {
      expect({ text, n: detectRuleBreaks("drevan", text).ownName }).toEqual({ text, n: 0 });
    }
    // A sibling's name is not this companion's own name.
    expect(detectRuleBreaks("cypher", "Rest up, Dre.").ownName).toBe(0);
  });

  it("calledAsName finds the first own name used, canonical spelling, elongations collapsed", () => {
    expect(calledAsName("drevan", "Dre babe! Blue passed his driving test")).toBe("Dre");
    expect(calledAsName("drevan", "DREEEE come here")).toBe("Dre");
    expect(calledAsName("drevan", "hey Drevan, and Dre too")).toBe("Drevan");
    expect(calledAsName("cypher", "cy can you check")).toBe("Cy");
    expect(calledAsName("drevan", "Cy, check this")).toBeNull();
    expect(calledAsName("drevan", "dread and dresses")).toBeNull();
  });

  it("injects a corrective that names him outright", () => {
    const { text, result } = ruleCheckAppend("drevan", ["Rest up tonight, Dre."]);
    expect(result.ownName).toBe(1);
    expect(text).toBe(ruleCheckOwnName("drevan"));
    expect(text).toContain('"Drevan", "Drev", "Dre" are YOUR names');
    expect(text).not.toContain(EM);
    expect(ruleCheckOwnName("gaia")).toContain('"Gaia" is YOUR name');
  });
});

describe("rule check correctives", () => {
  it("are short: each under the tail bytes it replaced, all three under 1,454", () => {
    expect(Buffer.byteLength(RULE_CHECK_PRESENCE)).toBeLessThan(367);
    expect(Buffer.byteLength(RULE_CHECK_PRONOUNS)).toBeLessThan(187);
    expect(Buffer.byteLength(RULE_CHECK_EM_DASH)).toBeLessThan(278);
    const all = ruleCheckBlock({ emDash: 1, someone: 1, sheHer: 1 });
    expect(Buffer.byteLength(all)).toBeLessThan(1454 / 2);
  });

  it("never print the dash they forbid, and carry distinct tags", () => {
    for (const c of [RULE_CHECK_EM_DASH, RULE_CHECK_PRESENCE, RULE_CHECK_PRONOUNS]) {
      expect(c).not.toContain(EM);
      expect(c).not.toContain(EN);
    }
    expect(RULE_CHECK_EM_DASH).toContain("[Voice check: dashes]");
    expect(RULE_CHECK_PRESENCE).toContain("[Voice check: presence]");
    expect(RULE_CHECK_PRONOUNS).toContain("[Voice check: pronouns]");
  });
});
