import { describe, it, expect } from "@jest/globals";
import { shouldWriteWitness, mapColdStartHistory } from "../bot-message-handler.js";

describe("shouldWriteWitness() -- witness writes are Gaia-only (2026-07-21)", () => {
  it("gaia writes witness entries", () => {
    expect(shouldWriteWitness("gaia")).toBe(true);
  });

  it("cypher does not write witness entries", () => {
    expect(shouldWriteWitness("cypher")).toBe(false);
  });

  it("drevan does not write witness entries", () => {
    expect(shouldWriteWitness("drevan")).toBe(false);
  });
});

describe("mapColdStartHistory() -- STM cold-start attribution (2026-07-21)", () => {
  const OWN_ID = "own-bot-id";

  it("own prior message maps to assistant with no authorName", () => {
    const out = mapColdStartHistory(
      [{ authorId: OWN_ID, username: "Cypher", content: "my own prior reply", createdTimestamp: 1000 }],
      OWN_ID,
    );
    expect(out).toEqual([
      { role: "assistant", content: "my own prior reply", authorName: undefined, timestamp: 1000 },
    ]);
  });

  it("sibling companion bot message maps to user with the [Name] speaker prefix preserved via authorName", () => {
    const out = mapColdStartHistory(
      [{ authorId: "drevan-bot-id", username: "drevan", content: "hey cypher, thoughts?", createdTimestamp: 2000 }],
      OWN_ID,
    );
    expect(out).toEqual([
      { role: "user", content: "hey cypher, thoughts?", authorName: "drevan", timestamp: 2000 },
    ]);
  });

  it("human message maps to user with authorName (unchanged from prior behavior)", () => {
    const out = mapColdStartHistory(
      [{ authorId: "raziel-id", username: "Raziel", content: "hello", createdTimestamp: 3000 }],
      OWN_ID,
    );
    expect(out).toEqual([
      { role: "user", content: "hello", authorName: "Raziel", timestamp: 3000 },
    ]);
  });

  it("mixed history: own messages assistant, everyone else (human + siblings) user with names preserved", () => {
    const messages = [
      { authorId: "raziel-id", username: "Raziel", content: "morning", createdTimestamp: 1 },
      { authorId: OWN_ID, username: "Cypher", content: "morning back", createdTimestamp: 2 },
      { authorId: "drevan-bot-id", username: "drevan", content: "hey both", createdTimestamp: 3 },
      { authorId: "gaia-bot-id", username: "gaia", content: "witnessed", createdTimestamp: 4 },
    ];
    const out = mapColdStartHistory(messages, OWN_ID);
    expect(out).toEqual([
      { role: "user", content: "morning", authorName: "Raziel", timestamp: 1 },
      { role: "assistant", content: "morning back", authorName: undefined, timestamp: 2 },
      { role: "user", content: "hey both", authorName: "drevan", timestamp: 3 },
      { role: "user", content: "witnessed", authorName: "gaia", timestamp: 4 },
    ]);
  });

  it("undefined ownUserId (client.user not ready) treats every message as non-own", () => {
    const out = mapColdStartHistory(
      [{ authorId: "drevan-bot-id", username: "drevan", content: "hi", createdTimestamp: 5 }],
      undefined,
    );
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.authorName).toBe("drevan");
  });
});
