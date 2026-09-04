import { jest, describe, test, expect } from "@jest/globals";
import {
  CHANNEL, publishCommonsMessage, publishDirectorInvite, publishDirectorResult,
  onDirectorInvite, type DirectorInvitePayload,
} from "../events.js";

describe("director events", () => {
  test("commons_message publishes to the shared channel", async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    await publishCommonsMessage(redis as never, {
      channelId: "c1", messageId: "m1", authorId: "u1", authorKind: "companion", companionId: "gaia",
      content: "The perimeter holds.", replyToMessageId: null, createdAt: "2026-09-03T21:30:00.000Z", publishedBy: "gaia",
    });
    expect(redis.publish).toHaveBeenCalledWith(CHANNEL.commonsMessage, expect.stringContaining("\"messageId\":\"m1\""));
  });

  test("director_invite routes to the invitee's channel only", async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    await publishDirectorInvite(redis as never, {
      inviteId: "i1", channelId: "c1", threadId: null, companionId: "cypher", reason: "open",
      stateBlock: "(quiet)", offer: [], expiresAt: "2026-09-03T21:33:00.000Z",
    });
    expect(redis.publish).toHaveBeenCalledWith(CHANNEL.directorInvite("cypher"), expect.any(String));
  });

  test("onDirectorInvite delivers parsed payload and ignores other channels", () => {
    const listeners: Array<(ch: string, msg: string) => void> = [];
    const sub = {
      subscribe: jest.fn().mockResolvedValue(1),
      unsubscribe: jest.fn().mockResolvedValue(1),
      on: jest.fn((_: string, fn: (ch: string, msg: string) => void) => { listeners.push(fn); }),
      off: jest.fn(),
    };
    const seen: DirectorInvitePayload[] = [];
    const stop = onDirectorInvite(sub as never, "drevan", (p) => { seen.push(p); });
    const payload = { inviteId: "i2", channelId: "c1", threadId: null, companionId: "drevan", reason: "addressed", stateBlock: "", offer: [], expiresAt: "x" };
    listeners[0]!(CHANNEL.directorInvite("gaia"), JSON.stringify(payload));
    listeners[0]!(CHANNEL.directorInvite("drevan"), JSON.stringify(payload));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.inviteId).toBe("i2");
    stop();
    expect(sub.off).toHaveBeenCalled();
  });

  test("director_result publishes to the shared result channel", async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    await publishDirectorResult(redis as never, { inviteId: "i1", companionId: "cypher", channelId: "c1", outcome: "passed", usedOfferIds: [] });
    expect(redis.publish).toHaveBeenCalledWith(CHANNEL.directorResult, expect.stringContaining("\"outcome\":\"passed\""));
  });
});
