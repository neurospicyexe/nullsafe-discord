import { describe, it, expect } from "@jest/globals";
import { ChannelInbox } from "../channel-inbox.js";
import { PkDedup, pkIngestAtEvent } from "../pluralkit.js";

// Regression: PluralKit dedup vs the channel inbox (2026-07-27).
//
// PkDedup was written (2026-06) when every messageCreate ran handleMessage concurrently:
// the original's 3s hold and the webhook's matchWebhook overlapped, so the pair matched.
// ChannelInbox (2026-07-06) then serialized turns per channel -- and the hold moved INSIDE
// the serialized worker. The webhook's turn cannot start until the original's turn finishes,
// so matchWebhook never runs during the hold, resolveOriginal always reports skip:false, and
// the original -- a message PluralKit has already DELETED -- is processed in full: spine seed,
// STM append under the wrong author, live ingest, and every deterministic command branch that
// sends before the supersede check. The webhook then also loses the captured sender id, so
// attribution rests entirely on one 2s PK API call; when it races, the owner's own proxied
// message is classified as a peer bot and eaten by the bot-to-bot rails.
//
// The fix: PAIR AT EVENT TIME (before enqueue, where events really are concurrent) and let
// the worker's wait resolve the instant a claim lands. These tests drive a real ChannelInbox.

const CH = "chan-pk";
const OWNER = "owner-1";
const HOLD = 300; // scaled-down PK_HOLD_MS

interface FakeMsg {
  id: string;
  content: string;
  webhookId: string | null;
  authorId: string;
  authorIsBot: boolean;
}

const direct = (id: string, content: string): FakeMsg =>
  ({ id, content, webhookId: null, authorId: OWNER, authorIsBot: false });
const proxied = (id: string, content: string): FakeMsg =>
  ({ id, content, webhookId: "wh-1", authorId: "wh-1", authorIsBot: true });

/**
 * Mirrors the production wiring: pkIngestAtEvent runs at messageCreate (outside the queue),
 * the turn body runs inside it. `replied` records every message that reached the reply path;
 * `senderSeen` records the sender id attribution had available for each webhook turn.
 */
function harness(opts: { turnMs?: number } = {}) {
  const dedup = new PkDedup(HOLD);
  const inbox = new ChannelInbox({ log: () => {} });
  const replied: string[] = [];
  const senderSeen = new Map<string, string | undefined>();

  const deliver = (m: FakeMsg): void => {
    // --- event time (concurrent, never behind the queue) ---
    const { pkSenderId } = pkIngestAtEvent(
      { id: m.id, channelId: CH, content: m.content, webhookId: m.webhookId, authorId: m.authorId, authorIsBot: m.authorIsBot },
      dedup,
    );
    // --- queued turn ---
    inbox.enqueue(
      { id: m.id, channelId: CH, authorIsHuman: !m.authorIsBot || m.webhookId !== null, content: m.content },
      async () => {
        if (!m.webhookId && !m.authorIsBot) {
          const { skip } = await dedup.waitForClaim(CH, m.id, HOLD);
          if (skip) return;
        }
        if (m.webhookId) senderSeen.set(m.id, pkSenderId);
        if (opts.turnMs) await new Promise(r => setTimeout(r, opts.turnMs));
        replied.push(m.id);
      },
    );
  };

  const settled = async (): Promise<void> => {
    for (let i = 0; i < 200 && inbox.pendingCount(CH) > 0; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, HOLD + 100));
  };

  return { deliver, settled, replied, senderSeen };
}

describe("PluralKit dedup through the channel inbox", () => {
  it("proxied message: the pre-proxy original never reaches the reply path", async () => {
    const h = harness();
    h.deliver(direct("orig", "cy: hey there"));
    await new Promise(r => setTimeout(r, 30)); // PK's real repost latency
    h.deliver(proxied("hook", "hey there"));
    await h.settled();

    expect(h.replied).toEqual(["hook"]);
  });

  it("the webhook turn still has the sender id captured from the original", async () => {
    const h = harness();
    h.deliver(direct("orig", "cy: hey there"));
    await new Promise(r => setTimeout(r, 30));
    h.deliver(proxied("hook", "hey there"));
    await h.settled();

    expect(h.senderSeen.get("hook")).toBe(OWNER);
  });

  it("claim arriving while an EARLIER turn is still running is not lost", async () => {
    // The case the old code could never survive: the queue is busy with a long turn, so the
    // original's turn starts long after the webhook event already landed.
    const h = harness({ turnMs: 200 });
    h.deliver(direct("busy", "unrelated long turn"));
    h.deliver(direct("orig", "cy: second thing"));
    await new Promise(r => setTimeout(r, 30));
    h.deliver(proxied("hook", "second thing"));
    await h.settled();

    expect(h.replied).toEqual(["busy", "hook"]);
    expect(h.senderSeen.get("hook")).toBe(OWNER);
  });

  // Proves the test above is discriminating rather than vacuous: with pairing done INSIDE the
  // serialized turn (the shipped 07-06..07-27 wiring), the same delivery order double-processes.
  it("old wiring (pairing inside the serialized turn) loses the claim -- placement is the fix", async () => {
    const dedup = new PkDedup(HOLD);
    const inbox = new ChannelInbox({ log: () => {} });
    const replied: string[] = [];

    const deliverOldWay = (m: FakeMsg): void => {
      inbox.enqueue(
        { id: m.id, channelId: CH, authorIsHuman: !m.authorIsBot || m.webhookId !== null, content: m.content },
        async () => {
          // Both halves of pairing inside the queue -- the webhook's turn cannot start until
          // this one's hold has already expired, so the claim can never arrive in time.
          if (m.webhookId) dedup.matchWebhook(CH, m.content);
          if (!m.webhookId && !m.authorIsBot) {
            dedup.addOriginal(CH, m.id, m.content, m.authorId);
            await new Promise(r => setTimeout(r, HOLD));
            if (dedup.resolveOriginal(CH, m.id).skip) return;
          }
          replied.push(m.id);
        },
      );
    };

    deliverOldWay(direct("orig", "cy: hey there"));
    await new Promise(r => setTimeout(r, 30));
    deliverOldWay(proxied("hook", "hey there"));
    for (let i = 0; i < 200 && inbox.pendingCount(CH) > 0; i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, HOLD + 100));

    // The deleted pre-proxy original was processed, and the proxy was processed too.
    expect(replied).toEqual(["orig", "hook"]);
  });

  it("a genuinely unproxied message is still answered (hold expires, no claim)", async () => {
    const h = harness();
    h.deliver(direct("solo", "just me talking"));
    await h.settled();

    expect(h.replied).toEqual(["solo"]);
  });

  it("the hold releases early on claim instead of blocking the queue for the full window", async () => {
    const h = harness();
    const t0 = Date.now();
    h.deliver(direct("orig", "cy: quick"));
    await new Promise(r => setTimeout(r, 20));
    h.deliver(proxied("hook", "quick"));
    await h.settled();

    // The webhook's reply must land well inside the hold window, not after it.
    expect(h.replied).toEqual(["hook"]);
    expect(Date.now() - t0).toBeLessThan(HOLD * 2);
  });
});
