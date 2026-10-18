import { describe, it, expect } from "@jest/globals";
import { pkRoomLabel, speakerFrame, cutImpersonation } from "../speaker-frame.js";
import { buildWritebackSpeaker, judgeWriteback } from "../memory.js";
import { renderJevState } from "../jev-gate.js";
import type { InferenceAdapter } from "../inference.js";

describe("pkRoomLabel", () => {
  it("Raziel's fronts keep (via PK), unchanged", () => {
    expect(pkRoomLabel("Noah M.", { isBlueSystem: false })).toBe("Noah M. (via PK)");
  });
  it("Blue's members read (Blue's system)", () => {
    expect(pkRoomLabel("Megan", { isBlueSystem: true })).toBe("Megan (Blue's system)");
  });
});

describe("speakerFrame names Blue's system", () => {
  const f = speakerFrame("drevan", "Megan (Blue's system, through PluralKit)", null);
  it("explains the Blue label", () => {
    expect(f).toContain(`"(Blue's system)" marks a member of Blue's system`);
    expect(f).toContain("Raziel's husband");
    expect(f).toContain(`"(via PK)" marks a system member speaking`);
  });
});

describe("cutImpersonation accepts the Blue label", () => {
  it("cuts a [Megan (Blue's system)]: line", () => {
    const r = cutImpersonation("drevan", "Hello there.\n[Megan (Blue's system)]: and then I said", ["Megan"]);
    expect(r.cut).toBe(true);
    expect(r.text).toBe("Hello there.");
  });
  it("still cuts the via PK form", () => {
    expect(cutImpersonation("drevan", "Hi.\n**Megan (via PK):** x", ["Megan"]).cut).toBe(true);
  });
});

describe("writeback speaker for Blue's system", () => {
  const blue = buildWritebackSpeaker({ pkMemberName: "Kyle Barnes || 🍂", frontPronouns: "he/him", isOwner: false, isBlue: true, ownerName: "Crash", authorUsername: "kyle" });
  it("is kind blue with name and pronouns", () => {
    expect(blue).toMatchObject({ kind: "blue", isOwner: false, pronouns: "he/him" });
  });
  it("without isBlue stays guest", () => {
    expect(buildWritebackSpeaker({ pkMemberName: "Dave", isOwner: false, ownerName: "Crash", authorUsername: "d" })).toMatchObject({ kind: "guest" });
  });
  it("judge prompt says member of Blue's system, family, not a guest", async () => {
    const seen: string[] = [];
    const adapter: InferenceAdapter = { generate: async (system, messages) => { seen.push([system, ...messages.map((m) => m.content)].join(" | ")); return "ACTION: skip" + String.fromCharCode(10) + "CONTENT:"; } };
    await judgeWriteback("I had a really hard day and felt overwhelmed about everything today.", "I hear you, that sounds like a heavy weight to carry right now.", adapter, "drevan", blue);
    const all = seen.join(" | ");
    expect(all).toContain("a member of Blue's system (Blue is Raziel's husband, family, not a guest)");
  });
  it("renderJevState frames blue distinctly", () => {
    const s = renderJevState("drevan", blue, "hi", "hello");
    expect(s).toContain("Blue's system");
    expect(s).not.toContain("neither the owner nor a sibling");
  });
});
