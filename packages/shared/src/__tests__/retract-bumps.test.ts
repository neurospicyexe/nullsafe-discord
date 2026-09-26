// Retract bumps (2026-09-26 review). The first cut cached a FAILED load as "no bumps" for the
// life of the process, then the next retract wrote the in-memory map whole -- which after that
// failed load held only one channel, erasing every other channel's persisted bump.
import { RetractBumps, parseRetractBumps, type RetractBumpsIo } from "../retract-bumps.js";

function fakeIo(initial: string | null) {
  const state = { value: initial, reads: 0, writes: [] as string[], failReads: 0, failWrite: false };
  const io: RetractBumpsIo = {
    read: async () => {
      state.reads++;
      if (state.failReads > 0) { state.failReads--; throw new Error("halseth 503"); }
      return state.value;
    },
    write: async (v) => {
      if (state.failWrite) throw new Error("setSetting 500");
      state.writes.push(v);
      state.value = v;
    },
  };
  return { io, state };
}
const quiet = { log: () => {} };

describe("parseRetractBumps", () => {
  it("keeps positive finite counts, floors them, drops everything else", () => {
    const m = parseRetractBumps(JSON.stringify({ a: 2, b: 0, c: -1, d: "3", e: 1.9 }));
    expect([...m]).toEqual([["a", 2], ["e", 1]]);
    expect(parseRetractBumps(null).size).toBe(0);
    expect(parseRetractBumps("not json").size).toBe(0);
    expect(parseRetractBumps("[1,2]").size).toBe(0);
  });
});

describe("RetractBumps.ensureLoaded", () => {
  it("loads the persisted map", async () => {
    const { io } = fakeIo(JSON.stringify({ chanA: 3 }));
    const b = new RetractBumps(io, quiet);
    await b.ensureLoaded();
    expect(b.get("chanA")).toBe(3);
    expect(b.isLoaded).toBe(true);
  });

  it("a failed load is NOT cached as 'no bumps': the next need retries (after the throttle)", async () => {
    const { io, state } = fakeIo(JSON.stringify({ chanA: 3 }));
    state.failReads = 1;
    let t = 0;
    const b = new RetractBumps(io, { ...quiet, now: () => t, retryAfterMs: 1000 });
    await b.ensureLoaded();
    expect(b.get("chanA")).toBe(0);
    expect(b.isLoaded).toBe(false);
    // Inside the throttle: no second read on the reply path.
    t = 500;
    await b.ensureLoaded();
    expect(state.reads).toBe(1);
    // Past it: retried, and now it holds.
    t = 1500;
    await b.ensureLoaded();
    expect(state.reads).toBe(2);
    expect(b.get("chanA")).toBe(3);
  });

  it("concurrent callers share one read", async () => {
    const { io, state } = fakeIo(JSON.stringify({ chanA: 1 }));
    const b = new RetractBumps(io, quiet);
    await Promise.all([b.ensureLoaded(), b.ensureLoaded(), b.ensureLoaded()]);
    expect(state.reads).toBe(1);
  });

  it("never throws, even when every read fails", async () => {
    const { io, state } = fakeIo(null);
    state.failReads = 99;
    const b = new RetractBumps(io, quiet);
    await expect(b.ensureLoaded()).resolves.toBeUndefined();
  });
});

describe("RetractBumps.bump", () => {
  it("re-reads and merges before writing, so other channels' bumps survive a failed boot load", async () => {
    const { io, state } = fakeIo(JSON.stringify({ chanA: 3, chanB: 1 }));
    state.failReads = 1; // the boot load fails ...
    const b = new RetractBumps(io, quiet);
    await b.ensureLoaded();
    expect(b.get("chanA")).toBe(0);
    // ... and the retract on chanC must not erase chanA/chanB.
    const r = await b.bump("chanC");
    expect(r).toEqual({ n: 1, persisted: true });
    expect(JSON.parse(state.value!)).toEqual({ chanA: 3, chanB: 1, chanC: 1 });
  });

  it("increments on top of the persisted count, max-merged with memory", async () => {
    const { io, state } = fakeIo(JSON.stringify({ chanA: 2 }));
    const b = new RetractBumps(io, quiet);
    expect((await b.bump("chanA")).n).toBe(3);
    // Another process (or a hand edit) lowered it: memory keeps the higher count.
    state.value = JSON.stringify({ chanA: 1 });
    expect((await b.bump("chanA")).n).toBe(4);
  });

  it("when the merge read fails it does NOT write, still rotates in memory, and says why", async () => {
    const { io, state } = fakeIo(JSON.stringify({ chanA: 3 }));
    state.failReads = 1;
    const b = new RetractBumps(io, quiet);
    const r = await b.bump("chanC");
    expect(r.persisted).toBe(false);
    if (!r.persisted) expect(r.reason).toContain("could not read the persisted map");
    expect(r.n).toBe(1);
    expect(b.get("chanC")).toBe(1);
    expect(state.writes).toEqual([]);
    expect(JSON.parse(state.value!)).toEqual({ chanA: 3 });
  });

  it("a failed write is reported, and the in-memory bump holds", async () => {
    const { io, state } = fakeIo(null);
    state.failWrite = true;
    const b = new RetractBumps(io, quiet);
    const r = await b.bump("chanA");
    expect(r).toEqual({ n: 1, persisted: false, reason: "setSetting 500" });
    expect(b.get("chanA")).toBe(1);
  });

  it("a hung write is bounded", async () => {
    const io: RetractBumpsIo = { read: async () => null, write: () => new Promise(() => {}) };
    const b = new RetractBumps(io, { ...quiet, timeoutMs: 20 });
    const r = await b.bump("chanA");
    expect(r.persisted).toBe(false);
    if (!r.persisted) expect(r.reason).toContain("timed out");
  });
});
