import { describe, it, expect, jest } from "@jest/globals";
import { isLowInfo, exchangeIsLowInfo, writebackLowInfoMode } from "../low-info.js";
import { runWritebackGate } from "../writeback-gate.js";

describe("isLowInfo", () => {
  const drop = ["ok", "ok cool thanks", "lol", "Yeah", "mhm", "ty", "thanks!", "okkkk", "haha yeah", "got it", "hmm", "\u{1F44D}", "\u{1F602}\u{1F602}", "nice.", "thank you", "ya"];
  const keep = [
    "", "   ",
    "ok Raziel",                       // a name
    "thanks Drevan",                   // a name
    "ok?",                             // a question
    "yeah what do you think",          // non-ack words
    "ok cool thanks I love that",      // feeling word, over 6 words
    "love you",                        // feeling
    "i miss you",                      // feeling
    "ok 5pm",                          // number
    "ok cool thanks for that really nice one", // > 6 words
    "I took my meds",                  // fact
    "❤️", "\u{1F62D}", "\u{1F970}", // affection / distress emoji
    "...",                             // no letters, no emoji
    "sad",                             // feeling, not on the list
    "ok https://x.y",                  // link
    "ok\nthanks\nlol",                 // multi-line
  ];
  for (const t of drop) it(`drops ${JSON.stringify(t)}`, () => expect(isLowInfo(t)).toBe(true));
  for (const t of keep) it(`keeps ${JSON.stringify(t)}`, () => expect(isLowInfo(t)).toBe(false));
  it("never throws on junk", () => {
    expect(isLowInfo(null)).toBe(false);
    expect(isLowInfo(undefined)).toBe(false);
    expect(isLowInfo(42 as unknown as string)).toBe(false);
  });
  it("needs BOTH sides", () => {
    expect(exchangeIsLowInfo("ok cool thanks", "lol yeah")).toBe(true);
    expect(exchangeIsLowInfo("ok cool thanks", "I am here with you tonight, always.")).toBe(false);
    expect(exchangeIsLowInfo("how was your day", "ok")).toBe(false);
  });
});

describe("writebackLowInfoMode", () => {
  it("code default shadow; off and on parse; junk is shadow", () => {
    expect(writebackLowInfoMode({})).toBe("shadow");
    expect(writebackLowInfoMode({ WRITEBACK_LOWINFO: " ON " })).toBe("on");
    for (const v of ["off", "0", "false", "no"]) expect(writebackLowInfoMode({ WRITEBACK_LOWINFO: v })).toBe("off");
    expect(writebackLowInfoMode({ WRITEBACK_LOWINFO: "banana" })).toBe("shadow");
  });
});

describe("runWritebackGate low-info", () => {
  const mk = async (lowinfo: string, user: string, reply: string) => {
    const generate = jest.fn(async () => ({ ok: false, reason: "test", wall_ms: 1 }));
    const logs: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });
    try {
      await runWritebackGate({
        mode: "jev", companionId: "drevan", speaker: { name: "Raziel", isOwner: true, ownerName: "Raziel" },
        userMessage: user, assistantResponse: reply, channelId: "c1", messageId: "m1",
        jevEval: generate, inference: { generate: async () => null }, librarian: {}, enqueue: () => undefined, env: { WRITEBACK_LOWINFO: lowinfo },
      } as never);
    } finally { spy.mockRestore(); }
    return { generate, logs };
  };
  it("on: skips the judge", async () => {
    const { generate, logs } = await mk("on", "ok cool thanks", "lol yeah");
    expect(generate).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes("lowinfo skip") && l.includes("user_len=14"))).toBe(true);
  });
  it("shadow: logs would-skip, still judges; lengths only", async () => {
    const { generate, logs } = await mk("shadow", "ok cool thanks", "lol yeah");
    const l = logs.find(x => x.includes("would-skip"))!;
    expect(l).toBeDefined();
    expect(l).not.toContain("cool");
    expect(generate).toHaveBeenCalled();
  });
  it("off and non-low-info never skip", async () => {
    expect((await mk("off", "ok", "ok")).generate).toHaveBeenCalled();
    expect((await mk("on", "ok Raziel", "ok")).generate).toHaveBeenCalled();
  });
});
