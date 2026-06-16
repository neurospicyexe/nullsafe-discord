import { jest, describe, test, expect } from "@jest/globals";
import { nudgeInterNote, librarianWriteChecked } from "../autonomous-core.js";
import { CHANNEL } from "../events.js";

describe("nudgeInterNote", () => {
  test("publishes an inter-note nudge to the recipient's channel", async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    await nudgeInterNote(redis as never, "cypher", "gaia");
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(redis.publish).toHaveBeenCalledWith(CHANNEL.interNote("gaia"), expect.stringContaining("\"fromId\":\"cypher\""));
  });

  test("is a no-op (no throw) when redis is absent", async () => {
    await expect(nudgeInterNote(null, "cypher", "gaia")).resolves.toBeUndefined();
  });
});

describe("librarianWriteChecked success reporting", () => {
  function lib(ask: () => Promise<unknown>) {
    return { ask: jest.fn(ask) } as never;
  }

  test("returns true when the write acks", async () => {
    const ok = await librarianWriteChecked(lib(async () => ({ ack: true })), "cypher", "note", "write note");
    expect(ok).toBe(true);
  });

  test("returns true when the write returns an id", async () => {
    const ok = await librarianWriteChecked(lib(async () => ({ id: "n1" })), "cypher", "note", "write note");
    expect(ok).toBe(true);
  });

  test("returns false on a silent reject (no ack, no id)", async () => {
    const ok = await librarianWriteChecked(lib(async () => ({ error: "rejected" })), "cypher", "note", "write note");
    expect(ok).toBe(false);
  });

  test("returns false when the write throws", async () => {
    const ok = await librarianWriteChecked(lib(async () => { throw new Error("down"); }), "cypher", "note", "write note");
    expect(ok).toBe(false);
  });
});
