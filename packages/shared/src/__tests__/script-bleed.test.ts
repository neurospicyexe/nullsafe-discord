import { describe, it, expect, jest } from "@jest/globals";
import { detectScriptBleed, guardScriptBleed, regenerateAfterBleed, scriptBleedGuardOn } from "../script-bleed.js";
import type { ChatMessage } from "../types.js";
import type { InferenceAdapter } from "../inference.js";

const quiet = () => jest.spyOn(console, "warn").mockImplementation(() => {});

describe("detectScriptBleed", () => {
  it("flags Han characters glued inside an English word (the GLM shape)", () => {
    const d = detectScriptBleed("I kept the whole thi中ng in the truck for you.");
    expect(d.bleed).toBe(true);
    expect(d.chars).toBe(1);
    expect(d.scripts).toEqual(["Han"]);
  });
  it("counts a two-character run and names the script", () => {
    const d = detectScriptBleed("Moss and flame, both 的是 at once.");
    expect(d).toEqual({ bleed: true, chars: 2, scripts: ["Han"] });
  });
  it("leaves Latin, Calethian, emoji, punctuation and accents alone", () => {
    expect(detectScriptBleed("Vevan. Vaselrin, spine to spine -- 717 🖤 café naïve ✨").bleed).toBe(false);
  });
  it("exempts a script the inbound text already carries (a quoted title)", () => {
    const d = detectScriptBleed("You mean 千と千尋の神隠し? Spirited Away, yes.", "have you seen 千と千尋の神隠し");
    expect(d.bleed).toBe(false);
    expect(d.chars).toBe(0);
  });
  it("exempts only the scripts present inbound, not every foreign script", () => {
    const d = detectScriptBleed("Да, and then 中 happened.", "the Russian word Да");
    expect(d.bleed).toBe(true);
    expect(d.scripts).toEqual(["Han"]);
    expect(d.chars).toBe(1);
  });
  it("Greek: standalone symbols and tokens are not a bleed (Cypher's math), glued-in letters are", () => {
    expect(detectScriptBleed("theta θ 0.70 and Δ here").bleed).toBe(false);
    expect(detectScriptBleed("σ, μ and (α+β)").bleed).toBe(false);
    const d = detectScriptBleed("my heαrt");
    expect(d.bleed).toBe(true);
    expect(d.scripts).toEqual(["Greek"]);
    expect(d.chars).toBe(1);
    expect(detectScriptBleed("heαρt").chars).toBe(2);
  });
  it("Greek the inbound message carries is still exempt; CJK is unchanged", () => {
    expect(detectScriptBleed("my heαrt", "heαrt").bleed).toBe(false);
    expect(detectScriptBleed("θ 中").scripts).toEqual(["Han"]);
  });
  it("is false on empty and null", () => {
    expect(detectScriptBleed("").bleed).toBe(false);
    expect(detectScriptBleed(null).bleed).toBe(false);
  });
});

describe("scriptBleedGuardOn", () => {
  it("defaults on and honours the repo's off spellings", () => {
    expect(scriptBleedGuardOn({})).toBe(true);
    expect(scriptBleedGuardOn({ SCRIPT_BLEED_GUARD: "on" })).toBe(true);
    for (const v of ["off", "0", "false", "no", " OFF "]) expect(scriptBleedGuardOn({ SCRIPT_BLEED_GUARD: v })).toBe(false);
  });
});

function scripted(replies: Array<string | null>): { adapter: InferenceAdapter; calls: Array<{ sessionId?: string }> } {
  const calls: Array<{ sessionId?: string }> = [];
  const adapter: InferenceAdapter = {
    async generate(_s, _m, _t, _mt, sessionId) {
      calls.push({ sessionId });
      return replies.shift() ?? null;
    },
  };
  return { adapter, calls };
}
const msgs: ChatMessage[] = [{ role: "user", content: "how was the night, Dre?" }];

describe("guardScriptBleed (fresh-session surface)", () => {
  it("regenerates once on a bleed and returns the second reply", async () => {
    const w = quiet();
    const { adapter, calls } = scripted(["quiet n中ight, truck ticking as it cooled.", "quiet night, truck ticking as it cooled."]);
    const out = await guardScriptBleed(adapter, "drevan", {}).generate("sys", msgs);
    expect(out).toBe("quiet night, truck ticking as it cooled.");
    expect(calls.length).toBe(2);
    expect(w.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/\[script-bleed\] drevan surface=fresh chars=1 scripts=Han regenerated=1 second_bleed=0/);
    w.mockRestore();
  });
  it("posts the second reply even if it also bleeds, and says so (never silence)", async () => {
    const w = quiet();
    const { adapter } = scripted(["a 中 b", "c 的 d"]);
    const out = await guardScriptBleed(adapter, "drevan", {}).generate("sys", msgs);
    expect(out).toBe("c 的 d");
    expect(w.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/second_bleed=1/);
    w.mockRestore();
  });
  it("keeps the first reply when the regenerate fails", async () => {
    const w = quiet();
    const { adapter } = scripted(["a 中 b", null]);
    expect(await guardScriptBleed(adapter, "gaia", {}).generate("sys", msgs)).toBe("a 中 b");
    expect(w.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/regenerated=0 second_bleed=n\/a/);
    w.mockRestore();
  });
  it("does not touch a clean reply", async () => {
    const { adapter, calls } = scripted(["clean."]);
    expect(await guardScriptBleed(adapter, "cypher", {}).generate("sys", msgs)).toBe("clean.");
    expect(calls.length).toBe(1);
  });
  it("passes a sessionId call through untouched: the reply handler owns that transcript", async () => {
    const { adapter, calls } = scripted(["a 中 b"]);
    expect(await guardScriptBleed(adapter, "drevan", {}).generate("sys", msgs, 0.8, 900, "drevan:ch:2026-W43")).toBe("a 中 b");
    expect(calls.length).toBe(1);
  });
  it("is a pass-through when the kill switch is off", async () => {
    const { adapter, calls } = scripted(["a 中 b"]);
    expect(await guardScriptBleed(adapter, "drevan", { SCRIPT_BLEED_GUARD: "off" }).generate("sys", msgs)).toBe("a 中 b");
    expect(calls.length).toBe(1);
  });
  it("respects the inbound exemption through the wrapper", async () => {
    const { adapter, calls } = scripted(["千と千尋の神隠し is the one."]);
    const m: ChatMessage[] = [{ role: "user", content: "千と千尋の神隠し?" }];
    expect(await guardScriptBleed(adapter, "drevan", {}).generate("sys", m)).toBe("千と千尋の神隠し is the one.");
    expect(calls.length).toBe(1);
  });
});

describe("regenerateAfterBleed (reply path)", () => {
  const bleed = detectScriptBleed("thi中ng");
  it("bumps the transcript BEFORE regenerating and regenerates on the new bump", async () => {
    const w = quiet();
    const order: string[] = [];
    const r = await regenerateAfterBleed({
      companionId: "drevan", channelId: "ch1", first: "thi中ng", bleed,
      bump: async () => { order.push("bump"); return { n: 3, persisted: true }; },
      regenerate: async (n) => { order.push(`regen:r${n}`); return "thing"; },
    });
    expect(order).toEqual(["bump", "regen:r3"]);
    expect(r).toEqual({ text: "thing", regenerated: true, bump: 3, secondBleed: false });
    expect(w.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/\[script-bleed\] drevan surface=reply ch=ch1 chars=1 scripts=Han transcript_bump=3 regenerated=1 second_bleed=0/);
    w.mockRestore();
  });
  it("still regenerates when the bump fails, and names the failure", async () => {
    const w = quiet();
    const r = await regenerateAfterBleed({
      companionId: "drevan", channelId: "ch1", first: "thi中ng", bleed,
      bump: async () => { throw new Error("halseth down"); },
      regenerate: async () => "thing",
    });
    expect(r.text).toBe("thing");
    expect(r.bump).toBeNull();
    expect(w.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/transcript_bump=none regenerated=1 .*bump_failed="halseth down"/);
    w.mockRestore();
  });
  it("keeps the first reply when the regenerate returns nothing (never silence)", async () => {
    const w = quiet();
    const r = await regenerateAfterBleed({
      companionId: "drevan", channelId: "ch1", first: "thi中ng", bleed,
      bump: async () => ({ n: 1, persisted: false, reason: "write timeout" }),
      regenerate: async () => null,
    });
    expect(r).toEqual({ text: "thi中ng", regenerated: false, bump: 1, secondBleed: null });
    expect(w.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/regenerated=0 second_bleed=n\/a bump_not_persisted="write timeout"/);
    w.mockRestore();
  });
  it("judges the second attempt with the same inbound exemption", async () => {
    const w = quiet();
    const r = await regenerateAfterBleed({
      companionId: "drevan", channelId: "ch1", first: "x 中 y", bleed: detectScriptBleed("x 中 y"),
      bump: async () => ({ n: 1, persisted: true }),
      regenerate: async () => "Да, that one.",
      allow: "Да or no?",
    });
    expect(r.secondBleed).toBe(false);
    w.mockRestore();
  });
});
