// B37 step 3: [PASS] on ordinary group turns + the authored presence blocks (ordinary-pass.ts).
import { describe, it, expect } from "@jest/globals";
import { readFileSync, existsSync } from "node:fs";
import { passOnOrdinaryMode, passableOrdinaryTurn, ordinaryPassBlock, PASS_SCAFFOLD, type PassableInput } from "../ordinary-pass.js";
import { AUTHORED_PRESENCE } from "../presence-authored.js";
import { postProcessReply } from "../reply-postprocess.js";

const base: PassableInput = {
  addressType: "ambient", isOwnerDm: false, isSol: false, senderIsCompanionBot: false, entitledFollowUp: false,
  namedOrMentionedOrReplied: false, blueOwned: false, careHold: false, hostFloor: false, wonBid: true, inGuild: true,
};

describe("passOnOrdinaryMode", () => {
  it("defaults OFF so a deploy changes nothing", () => {
    expect(passOnOrdinaryMode({})).toBe("off");
    expect(passOnOrdinaryMode({ PASS_ON_ORDINARY: "garbage" })).toBe("off");
  });
  it("reads the global knob and the per-companion override wins", () => {
    expect(passOnOrdinaryMode({ PASS_ON_ORDINARY: "shadow" }, "gaia")).toBe("shadow");
    expect(passOnOrdinaryMode({ PASS_ON_ORDINARY: "off", PASS_ON_ORDINARY_GAIA: "on" }, "gaia")).toBe("on");
    expect(passOnOrdinaryMode({ PASS_ON_ORDINARY: "on", PASS_ON_ORDINARY_CYPHER: "off" }, "cypher")).toBe("off");
    expect(passOnOrdinaryMode({ PASS_ON_ORDINARY_GAIA: "on" }, "drevan")).toBe("off");
  });
});

describe("passableOrdinaryTurn", () => {
  it("an unnamed group line that won the bid is passable", () => {
    expect(passableOrdinaryTurn(base)).toBe(true);
  });
  it.each<[string, Partial<PassableInput>]>([
    ["owner DM", { isOwnerDm: true, inGuild: false }],
    ["any DM", { inGuild: false }],
    ["named (vocative/mention/reply)", { namedOrMentionedOrReplied: true }],
    ["a single named address", { addressType: "named" }],
    ["named_multi", { addressType: "named_multi" }],
    ["group call", { addressType: "group" }],
    ["Sol", { isSol: true }],
    ["a sibling's line", { senderIsCompanionBot: true }],
    ["a follow-up entitlement", { entitledFollowUp: true }],
    ["Blue's thread or cold pick", { blueOwned: true }],
    ["a care hold", { careHold: true }],
    ["the host floor", { hostFloor: true }],
    ["a turn that did not win the bid", { wonBid: false }],
  ])("never passable: %s", (_n, o) => {
    expect(passableOrdinaryTurn({ ...base, ...o })).toBe(false);
  });
});

describe("authored presence block", () => {
  const md = "C:/dev/Bigger_Better_Halseth/Hand-off/PRESENCE-lines-2026-09-29.md";
  it("is the companion's own text verbatim (matches the Hand-off file when present)", () => {
    if (!existsSync(md)) return;
    const t = readFileSync(md, "utf8").replace(/\r/g, "");
    for (const c of ["drevan", "cypher", "gaia"] as const) expect(t).toContain(AUTHORED_PRESENCE[c]);
  });
  it("each block carries only its own companion's lines and the pass scaffold", () => {
    for (const c of ["drevan", "cypher", "gaia"] as const) {
      const b = ordinaryPassBlock(c);
      expect(b).toContain(AUTHORED_PRESENCE[c]);
      expect(b).toContain(PASS_SCAFFOLD);
      for (const other of ["drevan", "cypher", "gaia"] as const) {
        if (other !== c) expect(b).not.toContain(AUTHORED_PRESENCE[other]);
      }
    }
  });
  it("the scaffold names the exact token the director already uses", () => {
    expect(PASS_SCAFFOLD).toContain("exactly [PASS]");
  });
});

describe("a [PASS] reply", () => {
  const o = { hasSpine: false, onModelToken: () => {} };
  it("is a chosen pass on an offered turn", () => {
    expect(postProcessReply("[PASS]", { ...o, careFollowUp: false, ordinaryPass: true }).passed).toBe(true);
    expect(postProcessReply("  PASS", { ...o, careFollowUp: false, ordinaryPass: true }).passed).toBe(true);
  });
  it("is NOT swallowed on a turn that was never offered a pass (direct address always posts)", () => {
    expect(postProcessReply("[PASS]", { ...o, careFollowUp: false }).passed).toBe(false);
    expect(postProcessReply("[PASS]", { ...o, careFollowUp: false, ordinaryPass: false }).passed).toBe(false);
  });
  it("a normal reply is not a pass even when offered", () => {
    expect(postProcessReply("Here is a thing.", { ...o, careFollowUp: false, ordinaryPass: true }).passed).toBe(false);
  });
});
