// B63 being_seen, bot side: only owner messages are reported, a reply to MY message carries
// is_reply_to_me, a reply to a sibling does not, and a failure never reaches the handler.
import { describe, it, expect } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";
import { fireBeingSeenCheck } from "../being-seen-check.js";

function setup(fetchImpl?: () => Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return fetchImpl ? fetchImpl() : new Response("{}", { status: 200 });
  };
  const librarian = new LibrarianClient({ url: "https://h", secret: "s", companionId: "drevan", fetch: fetchFn as never });
  const pending: Promise<void>[] = [];
  const queue = { fireAndForget: (_l: string, fn: () => Promise<void>) => { pending.push(fn().catch(() => {})); } };
  return { calls, librarian, queue, settle: () => Promise.all(pending) };
}
const base = { isOwner: true, isArrival: true, messageId: "m1", channelId: "c1", text: "hello", isReplyToMe: false };

describe("fireBeingSeenCheck", () => {
  it("a reply to this bot's own message fires once for this companion, with is_reply_to_me", async () => {
    const { calls, librarian, queue, settle } = setup();
    expect(fireBeingSeenCheck({ ...base, isReplyToMe: true }, librarian, queue)).toBe(true);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://h/mind/being-seen/check");
    expect(calls[0]!.body).toEqual({ companion_id: "drevan", message_id: "m1", text: "hello", channel_id: "c1", is_reply_to_me: true });
  });
  it("a reply to a sibling's message reports is_reply_to_me false (Halseth then fires no medium)", async () => {
    const { calls, librarian, queue, settle } = setup();
    fireBeingSeenCheck({ ...base, isReplyToMe: false }, librarian, queue);
    await settle();
    expect(calls[0]!.body["is_reply_to_me"]).toBe(false);
    expect(calls[0]!.body["companion_id"]).toBe("drevan");
  });
  it("a non-owner message is never reported", async () => {
    const { calls, librarian, queue, settle } = setup();
    expect(fireBeingSeenCheck({ ...base, isOwner: false, isReplyToMe: true }, librarian, queue)).toBe(false);
    await settle();
    expect(calls).toHaveLength(0);
  });
  it("a follow-up pass is not a new message", async () => {
    const { calls, librarian, queue, settle } = setup();
    expect(fireBeingSeenCheck({ ...base, isArrival: false }, librarian, queue)).toBe(false);
    await settle();
    expect(calls).toHaveLength(0);
  });
  it("a Halseth failure (500 or network down) never throws into the handler", async () => {
    for (const impl of [async () => new Response("no", { status: 500 }), async () => { throw new Error("down"); }]) {
      const { librarian, queue, settle } = setup(impl as never);
      expect(() => fireBeingSeenCheck({ ...base, isReplyToMe: true }, librarian, queue)).not.toThrow();
      await expect(settle()).resolves.toBeDefined();
    }
  });
  it("a synchronous throw from the queue is swallowed", () => {
    const { librarian } = setup();
    const boom = { fireAndForget: () => { throw new Error("x"); } };
    expect(fireBeingSeenCheck(base, librarian, boom)).toBe(false);
  });
});
