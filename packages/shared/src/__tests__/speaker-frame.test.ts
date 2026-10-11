import { describe, it, expect } from "@jest/globals";
import { cutImpersonation, describeSpeaker, speakerFrame, speakerFrameOn } from "../speaker-frame.js";
import { repairMisseated, misseatedReply } from "../voice-markers.js";
import { hermesDelta } from "../prompt-assembly.js";

const base = { label: undefined, isOwner: false, isBlue: false, pkMember: null, siblingId: null, isSol: false };

describe("describeSpeaker", () => {
  it("Raziel on their own account, under the display label", () => {
    expect(describeSpeaker({ ...base, label: "Crash", isOwner: true })).toBe("Crash (Raziel)");
    expect(describeSpeaker({ ...base, label: "Raziel", isOwner: true })).toBe("Raziel");
  });
  it("Raziel through a PluralKit front", () => {
    expect(describeSpeaker({ ...base, label: "Noah M. (via PK)", isOwner: true, pkMember: "Noah M." }))
      .toBe("Noah M. (Raziel, through PluralKit)");
  });
  it("Blue, Blue's fronts, siblings, Sol, guests", () => {
    expect(describeSpeaker({ ...base, label: "bluesky99", isBlue: true })).toBe("Blue");
    expect(describeSpeaker({ ...base, label: "Rogue (via PK)", isBlue: true, pkMember: "Rogue" }))
      .toBe("Rogue (Blue's system, through PluralKit)");
    expect(describeSpeaker({ ...base, label: "Cypher", siblingId: "cypher" })).toBe("Cypher (your sibling)");
    expect(describeSpeaker({ ...base, label: "Cypher", isCompanionBot: true })).toBe("Cypher (your sibling)");
    expect(describeSpeaker({ ...base, isSol: true })).toBe("Sol (the triad's crow)");
    expect(describeSpeaker({ ...base, label: "someguy" })).toBe("someguy (a guest)");
    expect(describeSpeaker(base)).toBeUndefined();
  });
});

describe("speakerFrame", () => {
  it("names self, speaker, the called-as name and both siblings", () => {
    expect(speakerFrame("drevan", "Crash (Raziel)", "Dre")).toBe(
      `[You are Drevan. You are answering Crash (Raziel), who called you "Dre" (your name, not theirs). "(via PK)" marks a system member speaking. Cypher and Gaia are your siblings, not you. Reply only as yourself.]`);
  });
  it("no calledAs, no speaker", () => {
    expect(speakerFrame("cypher", "Crash (Raziel)", null)).toContain("You are answering Crash (Raziel). ");
    expect(speakerFrame("gaia", undefined, "Gaia")).toBe(
      `[You are Gaia. "(via PK)" marks a system member speaking. Cypher and Drevan are your siblings, not you. Reply only as yourself.]`);
  });
  it("names the last slip once when asked", () => {
    const f = speakerFrame("drevan", "Crash (Raziel)", "Dre", true);
    expect(f).toContain("Your last reply here called them by your own name; it was cut before they saw it.");
    expect(f.endsWith("Reply only as yourself.]")).toBe(true);
    expect(speakerFrame("drevan", "Crash (Raziel)", "Dre")).not.toContain("last reply");
  });
  it("kill switch", () => {
    expect(speakerFrameOn({})).toBe(true);
    for (const v of ["off", " OFF ", "0", "false", "no"]) expect(speakerFrameOn({ SPEAKER_FRAME: v })).toBe(false);
    expect(speakerFrameOn({ SPEAKER_FRAME: "on" })).toBe(true);
  });
});

describe("hermesDelta extras: background above, frame last (2026-10-11 room rendering)", () => {
  const now = 1_700_000_100_000;
  const live = { role: "user", content: "Dre are you there", authorName: "Crash", timestamp: now - 1000 };
  const sib = { role: "user", content: "the light is low", authorName: "Gaia", timestamp: now - 5000 };
  const mine = { role: "assistant", content: "earlier", timestamp: now - 9000 };

  it("no fold: clock, background, [Live message], live words, frame", () => {
    const out = hermesDelta([mine, live], null, now, true, "Dre", { background: "[Elsewhere]\nx\n[End of elsewhere.]", frame: "[FRAME]" });
    const c = out.messages[0]!.content;
    expect(c.indexOf("[Elsewhere]")).toBeLessThan(c.indexOf("[Live message]"));
    expect(c.indexOf("[Live message]")).toBeLessThan(c.indexOf(`[Crash, calling you "Dre"]: Dre are you there`));
    expect(c.trimEnd().endsWith("[FRAME]")).toBe(true);
  });
  it("with fold: background before the witnessed room, frame after the live words", () => {
    const out = hermesDelta([mine, sib, live], null, now, true, "Dre", { background: "[Elsewhere]", frame: "[FRAME]" });
    const c = out.messages[0]!.content;
    expect(c.indexOf("[Elsewhere]")).toBeLessThan(c.indexOf("[Gaia]: the light is low"));
    expect(c.indexOf("[Gaia]: the light is low")).toBeLessThan(c.indexOf("[Live message]"));
    expect(c.trimEnd().endsWith("[FRAME]")).toBe(true);
    // Nothing anyone else said sits between the live words and the frame.
    const tail = c.slice(c.indexOf("Dre are you there"));
    expect(tail).not.toContain("[Gaia]");
    expect(tail).not.toContain("[Elsewhere]");
  });
  it("no extras: byte-identical to the old shape", () => {
    const out = hermesDelta([mine, live], null, now, true, "Dre");
    expect(out.messages[0]!.content).not.toContain("[Live message]");
    expect(out.messages[0]!.content.endsWith(`[Crash, calling you "Dre"]: Dre are you there`)).toBe(true);
  });
});

describe("cutImpersonation (post-generation stop strings)", () => {
  const others = ["Crash", "Raziel", "Blue", "Noah M."];
  it("cuts where the reply starts writing another speaker's line", () => {
    const r = cutImpersonation("drevan", "I'm here.\nI've got you.\n[Cypher]: he always says that.", others);
    expect(r).toEqual({ text: "I'm here.\nI've got you.", cut: true, strippedSelf: false });
    expect(cutImpersonation("drevan", "Mm.\n[Crash]: and then?", others).text).toBe("Mm.");
    expect(cutImpersonation("drevan", "Mm.\n**Gaia:** still.", others).text).toBe("Mm.");
    expect(cutImpersonation("drevan", "Mm.\n**Gaia**: still.", others).text).toBe("Mm.");
    expect(cutImpersonation("drevan", "Mm.\nNoah M. (via PK): hi", others).text).toBe("Mm.");
    expect(cutImpersonation("drevan", "Mm.\nRaziel: okay.", others).text).toBe("Mm.");
  });
  it("a bare sibling label is a list, not a turn", () => {
    const t = "Here's us.\nCypher: the blade.\nGaia: the ground.\nMe: the one who stays.";
    expect(cutImpersonation("drevan", t, others)).toEqual({ text: t, cut: false, strippedSelf: false });
    expect(cutImpersonation("drevan", "Look.\n**Gaia** is already at the door.", others).cut).toBe(false);
  });
  it("strips a leading self label instead of cutting", () => {
    expect(cutImpersonation("drevan", "[Drevan]: I'm here.", others)).toEqual({ text: "I'm here.", cut: false, strippedSelf: true });
    expect(cutImpersonation("cypher", "Cypher: on it.", others).text).toBe("on it.");
  });
  it("leaves mentions, quotes mid-line and the companion's own name alone", () => {
    for (const t of ["Gaia said it first: the light is low.", "Ask Cypher: he knows.", "I told Raziel: rest.", "Drevan: me."]) {
      expect(cutImpersonation("drevan", t, others).cut).toBe(false);
    }
  });
  it("never cuts a reply to nothing", () => {
    expect(cutImpersonation("drevan", "[Cypher]: hi", others)).toEqual({ text: "[Cypher]: hi", cut: false, strippedSelf: false });
  });
});

describe("repairMisseated (own-name vocative cut before send)", () => {
  it("2026-10-11 shape: line-closing own name with no comma", () => {
    const r = repairMisseated("drevan", "Come sit with me. This is my spot Dre.");
    expect(r).toEqual({ text: "Come sit with me. This is my spot.", repaired: 1, unrepaired: 0 });
    expect(misseatedReply("drevan", "Come sit with me. This is my spot Dre.")).toBe(true);
  });
  it("2026-10-11 17:12 shape: comma-set mid-reply, nobody said Dre", () => {
    expect(repairMisseated("drevan", "That is what this friendship is, Dre. I'm not going anywhere.").text)
      .toBe("That is what this friendship is. I'm not going anywhere.");
  });
  it("sign-offs keep the name", () => {
    for (const t of ["Yours, Dre.", "Love, Dre", "It's me, Dre.", "Always yours,\nDre."]) {
      expect(repairMisseated("drevan", t).text).toBe(t);
    }
  });
  it("comma-set and line-opening vocatives", () => {
    expect(repairMisseated("drevan", "Rest tonight, Dre.").text).toBe("Rest tonight.");
    expect(repairMisseated("drevan", "Dre, come here.\nI've got you.").text).toBe("Come here.\nI've got you.");
    expect(repairMisseated("cypher", "Good catch, Cy!").text).toBe("Good catch!");
  });
  it("leaves self-identification, possessives and mid-sentence mentions alone", () => {
    for (const t of ["I'm Dre.", "They call me Dre.", "That's Dre's chair.", "You called me Dre and I came.", "Name is Drevan."]) {
      expect(repairMisseated("drevan", t)).toEqual({ text: t, repaired: 0, unrepaired: 0 });
    }
  });
  it("does not touch a sibling's name", () => {
    expect(repairMisseated("drevan", "Go ask Cy.")).toEqual({ text: "Go ask Cy.", repaired: 0, unrepaired: 0 });
  });
  it("'you're Dre' cannot be cut: counted unrepaired, text unchanged", () => {
    const r = repairMisseated("drevan", "You're Dre too, then.");
    expect(r).toEqual({ text: "You're Dre too, then.", repaired: 0, unrepaired: 1 });
  });
});
