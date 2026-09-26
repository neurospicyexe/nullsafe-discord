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

// StmStore.retract -- rotate-on-retract (2026-09-26).
//
// `<prefix>: retract` archived the journal rows, the wm note and the vault doc, and the mistake
// still echoed back: the bot's own STM window re-sent the retracted reply to the gateway on every
// turn until the 19:00 CDT rotation. This drops the in-memory copy; Halseth drops its own
// stm_entries rows in POST /admin/retract, so this deliberately does NOT touch the DB.
describe("retract", () => {
  const bot = (content: string): Entry => ({ role: "assistant", content, timestamp: 2 });
  const long = "the number was 187, and I said it with confidence";

  it("drops assistant entries whose content contains the retracted text, and reports the count", () => {
    const { store, written } = makeStore();
    store.append("chan", msg("what was it"));
    store.append("chan", bot(long));
    store.append("chan", bot(`[Drevan] ${long} (and more)`));
    store.append("chan", bot("something unrelated that stays in the window"));
    const before = written.length;
    expect(store.retract("chan", long)).toBe(2);
    expect(store.get("chan").map(m => m.content)).toEqual(["what was it", "something unrelated that stays in the window"]);
    // No DB write for a retract: Halseth owns its own rows.
    expect(written).toHaveLength(before);
  });

  it("also drops an entry the retracted text CONTAINS (a chunked reply's shorter fragment)", () => {
    const { store } = makeStore();
    store.append("chan", bot("the number was 187, and I said it"));
    expect(store.retract("chan", `${long} -- and then a second chunk followed`)).toBe(1);
    expect(store.get("chan")).toHaveLength(0);
  });

  it("never drops a user turn, even one that quotes the retracted words", () => {
    const { store } = makeStore();
    store.append("chan", msg(long));
    store.append("chan", bot(long));
    expect(store.retract("chan", long)).toBe(1);
    expect(store.get("chan").map(m => m.role)).toEqual(["user"]);
  });

  it("refuses a needle under 20 chars so a tiny chunk cannot wipe the window", () => {
    const { store } = makeStore();
    store.append("chan", bot("ok."));
    store.append("chan", bot("sure, done."));
    expect(store.retract("chan", "  ok.  ")).toBe(0);
    expect(store.get("chan")).toHaveLength(2);
  });

  it("is scoped to the channel and returns 0 on an unknown one", () => {
    const { store } = makeStore();
    store.append("chan", bot(long));
    expect(store.retract("other", long)).toBe(0);
    expect(store.get("chan")).toHaveLength(1);
  });
});
