// StmStore.appendInboundOnce -- record-on-arrival (2026-07-30).
//
// THE DEFECT: the inbound STM append sat ~400 lines below every response gate in the message handler
// (append at ~899, gates returning at 817/833/875/878/880). A bot that declined to answer therefore
// never recorded the message. Its short-term memory had holes exactly where it stayed quiet, so it
// remembered only the turns it had taken part in.
//
// Two consequences, and the second is the reason this matters:
//   1. Silence cost context. Hang back for ten turns and those ten turns were simply gone.
//   2. Fit-based speaker selection was impossible. A companion cannot judge "is this for me" from a
//      transcript containing only its own lines -- which is why a name had to be spoken on every
//      single message, and why that felt like operating a machine instead of talking to someone.
//
// Same defect Hermes issue #14853 hit from the other direction: with require_mention on, "the agent
// only sees the single @mention message -- zero context about what other agents said."
//
// Idempotency is load-bearing, not decorative: the handler calls this early AND at the original site
// AND on the search branch. Safe-by-construction beats auditing every branch forever.

import { describe, it, expect, beforeEach } from "@jest/globals";
import { StmStore, STM_BUFFER_SIZE } from "../stm.js";

type Entry = { role: "user" | "assistant"; content: string; authorName?: string; timestamp: number };

function makeStore() {
  const written: Array<{ channelId: string; entry: Entry }> = [];
  const store = new StmStore(
    "cypher",
    async (channelId, entry) => { written.push({ channelId, entry: entry as Entry }); },
    async () => [],
  );
  return { store, written };
}

const msg = (content: string): Entry => ({ role: "user", content, authorName: "Raziel", timestamp: 1 });

describe("appendInboundOnce", () => {
  let store: StmStore;
  let written: Array<{ channelId: string; entry: Entry }>;

  beforeEach(() => {
    const s = makeStore();
    store = s.store;
    written = s.written;
  });

  it("records the message the first time", () => {
    store.appendInboundOnce("chan", "m1", msg("hello"));
    expect(store.get("chan").map(m => m.content)).toEqual(["hello"]);
  });

  it("collapses repeat calls for the SAME message id -- the handler calls it 2-3 times per message", () => {
    store.appendInboundOnce("chan", "m1", msg("hello"));
    store.appendInboundOnce("chan", "m1", msg("hello"));
    store.appendInboundOnce("chan", "m1", msg("hello"));
    expect(store.get("chan")).toHaveLength(1);
    // And it must not triple the persisted write either -- duplicates in the DB outlive the process.
    expect(written).toHaveLength(1);
  });

  it("still records DIFFERENT messages -- dedup must not swallow the conversation", () => {
    store.appendInboundOnce("chan", "m1", msg("first"));
    store.appendInboundOnce("chan", "m2", msg("second"));
    store.appendInboundOnce("chan", "m3", msg("third"));
    expect(store.get("chan").map(m => m.content)).toEqual(["first", "second", "third"]);
  });

  it("keeps the speaker label, so a sibling's turn can never read as this bot's own output", () => {
    store.appendInboundOnce("chan", "m1", { role: "user", content: "spiral", authorName: "Drevan", timestamp: 1 });
    const [entry] = store.get("chan");
    expect(entry.role).toBe("user");
    expect(entry.authorName).toBe("Drevan");
  });

  it("does not leak: the seen-id set stays bounded across heavy traffic", () => {
    // A Set that only grows is a leak in a process that runs for weeks.
    for (let i = 0; i < STM_BUFFER_SIZE * 5; i++) {
      store.appendInboundOnce("chan", `m${i}`, msg(`msg ${i}`));
    }
    // Buffer itself stays capped...
    expect(store.get("chan")).toHaveLength(STM_BUFFER_SIZE);
    // ...and an id evicted from the seen-set may be re-recorded, which is harmless: by then it is
    // far outside the window it was protecting. What must NOT happen is unbounded growth.
    const seen = (store as unknown as { seenInbound: Set<string> }).seenInbound;
    expect(seen.size).toBeLessThanOrEqual(STM_BUFFER_SIZE * 2 + 1);
  });

  it("is per-message-id, not per-content -- Raziel repeating himself is two real events", () => {
    store.appendInboundOnce("chan", "m1", msg("hey"));
    store.appendInboundOnce("chan", "m2", msg("hey"));
    expect(store.get("chan")).toHaveLength(2);
  });
});
