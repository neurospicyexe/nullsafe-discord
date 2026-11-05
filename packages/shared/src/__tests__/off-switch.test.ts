// Item 10 (2026-11-05): kill switches accept off|0|false|no in any case/whitespace, not only exact "off".
import { isOffToken, normalizeModeToken, switchEnabled } from "../off-switch.js";
import { directorJevEnabled, readEchoBrakeConfig } from "../director-jev.js";
import { addressJevEnabled } from "../address-jev.js";
import { followUpPassEnabled } from "../pass-turn.js";
import { blueColdPickMode } from "../blue-cold-pick.js";
import { readFactsTrustMode } from "../facts-pick.js";
import { humanJevGateMode } from "../human-jev-gate.js";
import { replyHumanGateMode } from "../reply-context.js";
import { voiceGateMode } from "../voice-gate.js";
import { readFramePacketMode } from "../frame-packet.js";
import { roomTimingMode } from "../room-timing.js";
import { departuresMode } from "../departure-state.js";
import { hermesRotationMode } from "../hermes-session.js";
import { visionEnabled } from "../vision.js";

const OFFS = ["off", "OFF", " Off ", "0", "false", "FALSE", "no", "No"];

describe("off-switch helpers", () => {
  it.each(OFFS)("%j is an off token", (v) => { expect(isOffToken(v)).toBe(true); expect(switchEnabled(v)).toBe(false); expect(normalizeModeToken(v)).toBe("off"); });
  it.each([undefined, "", "on", "1", "true", "shadow", "maybe"])("%j is not off", (v) => { expect(isOffToken(v)).toBe(false); expect(switchEnabled(v)).toBe(true); });
});

describe("shared kill switches honour every off token", () => {
  it.each(OFFS)("%j", (v) => {
    expect(directorJevEnabled({ DIRECTOR_JEV: v })).toBe(false);
    expect(readEchoBrakeConfig({ DIRECTOR_ECHO_BRAKE: v }).mode).toBe("off");
    expect(addressJevEnabled({ ADDRESS_JEV: v })).toBe(false);
    expect(followUpPassEnabled({ FOLLOWUP_PASS: v })).toBe(false);
    expect(blueColdPickMode({ BLUE_COLD_PICK: v })).toBe("off");
    expect(readFactsTrustMode({ FACTS_TRUST: v })).toBe("off");
    expect(humanJevGateMode({ HUMAN_ADDRESS_JEV: v })).toBe("off");
    expect(replyHumanGateMode({ REPLY_HUMAN_GATE: v })).toBe("off");
    expect(voiceGateMode({ VOICE_GATE: v })).toBe("off");
    expect(readFramePacketMode({ FRAME_PACKET: v })).toBe("off");
    expect(roomTimingMode({ ROOM_TIMING: v })).toBe("off");
    expect(departuresMode({ DEPARTURES: v })).toBe("off");
    expect(hermesRotationMode({ HERMES_SESSION_ROTATION: v })).toBe("off");
  });
  it("defaults are unchanged when unset", () => {
    expect(directorJevEnabled({})).toBe(true);
    expect(addressJevEnabled({})).toBe(true);
    expect(blueColdPickMode({})).toBe("on");
    expect(readFactsTrustMode({})).toBe("shadow");
    expect(roomTimingMode({})).toBe("shadow");
  });
  it("vision honours off tokens", () => {
    const prev = process.env["VISION_ENABLED"];
    try {
      for (const v of OFFS) { process.env["VISION_ENABLED"] = v; expect(visionEnabled()).toBe(false); }
      delete process.env["VISION_ENABLED"]; expect(visionEnabled()).toBe(true);
    } finally { if (prev === undefined) delete process.env["VISION_ENABLED"]; else process.env["VISION_ENABLED"] = prev; }
  });
});
