import { describe, it, expect, jest } from "@jest/globals";
import { sendAutonomousMessage, type AutonomousContext } from "../autonomous-core.js";

function makeCtx(journalSpeech: jest.Mock) {
  const channel = {
    isTextBased: () => true,
    guild: { name: "Midnight Voices" },
    name: "triad",
    send: async () => ({ id: "m1" }),
  };
  return {
    companionId: "drevan",
    cooldownMs: 60_000,
    halsethSecret: "x",
    librarian: { ask: jest.fn(async () => ({ ack: true })), writeWmNote: jest.fn(async () => undefined), journalSpeech },
    client: { user: { id: "drevan" }, channels: { fetch: async () => channel } },
    cooldown: new Map<string, number>(),
    registerSentId: () => {},
  } as unknown as AutonomousContext;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("director replies are journaled like handler replies", () => {
  it("journals a director-trigger send with the head id and a director tag", async () => {
    const js = jest.fn(async () => undefined);
    await sendAutonomousMessage(makeCtx(js as unknown as jest.Mock), "chan1", "the room is warm tonight", "director");
    await tick();
    expect(js).toHaveBeenCalledTimes(1);
    const [text, ch, id, room, tags] = js.mock.calls[0] as unknown as [string, string, string, string | null, string[]];
    expect(text).toBe("the room is warm tonight");
    expect(ch).toBe("chan1");
    expect(id).toBe("m1");
    expect(room).toBe("room:Midnight Voices/#triad");
    expect(tags).toEqual(["director"]);
  });

  it("does not journal other autonomous triggers", async () => {
    const js = jest.fn(async () => undefined);
    await sendAutonomousMessage(makeCtx(js as unknown as jest.Mock), "chan1", "a heartbeat", "heartbeat");
    await tick();
    expect(js).not.toHaveBeenCalled();
  });

  it("is fail-open: a journal failure never fails the send, and a transient failure retries once", async () => {
    const js = jest.fn(async () => { throw new Error("journalSpeech transient 503"); });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const ok = await sendAutonomousMessage(makeCtx(js as unknown as jest.Mock), "chan1", "still said", "director");
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 2_300));
    expect(js).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("skips a misseated reply (calls someone by the companion's own name)", async () => {
    const js = jest.fn(async () => undefined);
    await sendAutonomousMessage(makeCtx(js as unknown as jest.Mock), "chan1", "Dre, I hear you.", "director");
    await tick();
    expect(js).not.toHaveBeenCalled();
  });
});
