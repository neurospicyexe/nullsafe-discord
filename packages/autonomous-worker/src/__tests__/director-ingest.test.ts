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
const ledger = (): Ledger => ({ ensureThread: vi.fn(async () => "t1"), appendTurn: vi.fn(async () => {}), land: vi.fn(async () => true), fade: vi.fn(async () => true) });

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
    const s = await ingest(msg(), { store, ledger: l, now: () => "2026-09-03T12:00:01.000Z" });
    expect(s!.threadId).toBe("t1");
    expect(l.appendTurn).toHaveBeenCalledWith("t1", expect.objectContaining({ messageId: "m1" }));
    expect(s!.openMoves[0]!.to).toBe("gaia");
    expect(await ingest(msg(), { store, ledger: l, now: () => "x" })).toBeNull();
  });
  it("proxy and human authors are human turns", async () => {
    const store = memStore(); const l = ledger();
    const s = await ingest(msg({ authorKind: "proxy", companionId: undefined, content: "hey", messageId: "m9" }), { store, ledger: l, now: () => "t" });
    expect(s!.lastHumanAt).toBe("2026-09-03T12:00:00.000Z");
  });
});
