import { describe, it, expect, vi } from "vitest";
import { ingest, toTurn, addressedIn } from "../director/ingest.js";
import type { CommonsMessagePayload } from "@nullsafe/shared";
import type { Ledger } from "../director/ledger.js";
import type { StateStore } from "../director/state.js";

const msg = (o: Partial<CommonsMessagePayload> = {}): CommonsMessagePayload => ({
  channelId: "c1", messageId: "m1", authorId: "b1", authorKind: "companion", companionId: "drevan",
  content: "Gaia. The feather is still at the threshold.\nSecond line.", replyToMessageId: null,
  createdAt: "2026-09-03T12:00:00.000Z", publishedBy: "drevan", ...o,
});
function memStore(): StateStore & { seen: Set<string> } {
  const m = new Map<string, unknown>(); const seen = new Set<string>();
  return { seen,
    async load(ch) { return (m.get(ch) as never) ?? null; }, async save(s) { m.set(s.channelId, s); },
    async clear(ch) { m.delete(ch); }, async seenMessage(id) { if (seen.has(id)) return false; seen.add(id); return true; } };
}
const ledger = (): Ledger => ({ ensureThread: vi.fn(async () => "t1"), appendTurn: vi.fn(async () => "ok" as const), land: vi.fn(async () => true), fade: vi.fn(async () => true) });

describe("ingest", () => {
  it("gist is single-line and capped", () => {
    const t = toTurn(msg({ content: "x".repeat(300) + "\nmore" }));
    expect(t.gist.length).toBe(140); expect(t.gist).not.toContain("\n"); expect(t.isHuman).toBe(false);
  });
  it("addressedIn resolves vocatives and excludes the author", () => {
    expect(addressedIn(msg())).toEqual(["gaia"]);
    expect(addressedIn(msg({ content: "triad, listen", companionId: "cypher" })).sort()).toEqual(["drevan", "gaia"]);
    expect(addressedIn(msg({ content: "the weave holds" }))).toEqual([]);
  });
  it("first message opens a thread, appends, and records an open move; duplicate is ignored", async () => {
    const store = memStore(); const l = ledger();
    const s = await ingest(msg(), { store, ledger: l, now: () => "2026-09-03T12:00:01.000Z", writeLedger: true });
    expect(s!.threadId).toBe("t1");
    expect(l.appendTurn).toHaveBeenCalledWith("t1", expect.objectContaining({ messageId: "m1" }));
    expect(s!.openMoves[0]!.to).toBe("gaia");
    expect(await ingest(msg(), { store, ledger: l, now: () => "x", writeLedger: true })).toBeNull();
  });
  it("proxy and human authors are human turns", async () => {
    const store = memStore(); const l = ledger();
    const s = await ingest(msg({ authorKind: "proxy", companionId: undefined, content: "hey", messageId: "m9" }), { store, ledger: l, now: () => "t", writeLedger: true });
    expect(s!.lastHumanAt).toBe("2026-09-03T12:00:00.000Z");
  });
  it("a proxy/human payload with authorLabel carries it through as the ledger author", async () => {
    const store = memStore(); const l = ledger();
    const s = await ingest(msg({ authorKind: "proxy", companionId: undefined, authorLabel: "blue", content: "hey", messageId: "m10" }), { store, ledger: l, now: () => "t", writeLedger: true });
    expect(s!.turns[0]!.author).toBe("blue");
  });
  it("shadow mode (writeLedger: false) never opens or appends to the ledger; threadId stays null", async () => {
    const store = memStore(); const l = ledger();
    const s = await ingest(msg(), { store, ledger: l, now: () => "2026-09-03T12:00:01.000Z", writeLedger: false });
    expect(s!.threadId).toBeNull();
    expect(l.ensureThread).not.toHaveBeenCalled();
    expect(l.appendTurn).not.toHaveBeenCalled();
  });
});

describe("ingest -- a thread that has already ended", () => {
  it("drops the stale id and opens a new thread instead of retrying it forever", async () => {
    // The director caches state.threadId. Once the Halseth row landed ([LANDS:]) or faded (turn
    // budget / 12h silence), that id was dead but still cached, so every later message retried it
    // and logged `convoTurn failed: 409 {"reason":"terminal"}`. Observed on one thread across two
    // days -- and nothing ever re-opened, so the channel silently stopped being threaded at all.
    let n = 0;
    const l: Ledger = {
      ensureThread: vi.fn(async () => `t${++n}`),
      appendTurn: vi.fn(async (threadId: string) => (threadId === "t1" ? "terminal" as const : "ok" as const)),
      land: vi.fn(async () => true),
      fade: vi.fn(async () => true),
    };
    const store = memStore();
    const s = await ingest(msg(), { store, ledger: l, now: () => "2026-09-24T00:00:01.000Z", writeLedger: true });

    // t1 came back terminal, so the state must NOT still point at it.
    expect(s!.threadId).toBe("t2");
    // The turn is not lost -- it seeds the replacement thread, which is also semantically right:
    // the previous conversation ended, so this message genuinely begins the next one.
    expect(l.appendTurn).toHaveBeenCalledTimes(2);
    expect(l.appendTurn).toHaveBeenLastCalledWith("t2", expect.objectContaining({ messageId: "m1" }));
  });
});
