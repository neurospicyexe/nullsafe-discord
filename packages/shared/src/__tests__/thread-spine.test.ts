import { jest, describe, it, expect, afterEach } from "@jest/globals";
import type { LibrarianClient, ConvoActiveDto } from "../librarian.js";
import {
  isThreadsEnabled, isThreadTracked, gist, ensureThread, buildSpineBlock, parseLandMarker,
} from "../thread-spine.js";

describe("isThreadTracked", () => {
  it("returns true for a commons entry (autonomous + inter_companion modes)", () => {
    const entry = { modes: ["autonomous", "inter_companion"] as const };
    expect(isThreadTracked(entry, "chan-1")).toBe(true);
  });

  it("returns false for an open-mode-only entry not in the extra-channels list", () => {
    const prev = process.env["THREADS_EXTRA_CHANNELS"];
    delete process.env["THREADS_EXTRA_CHANNELS"];
    try {
      const entry = { modes: ["open"] as const };
      expect(isThreadTracked(entry, "chan-2")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["THREADS_EXTRA_CHANNELS"];
      else process.env["THREADS_EXTRA_CHANNELS"] = prev;
    }
  });

  it("returns true when channelId is listed in THREADS_EXTRA_CHANNELS env", () => {
    const prev = process.env["THREADS_EXTRA_CHANNELS"];
    process.env["THREADS_EXTRA_CHANNELS"] = "chan-9, chan-3";
    try {
      const entry = { modes: ["open"] as const };
      expect(isThreadTracked(entry, "chan-3")).toBe(true);
      expect(isThreadTracked(entry, "chan-nope")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["THREADS_EXTRA_CHANNELS"];
      else process.env["THREADS_EXTRA_CHANNELS"] = prev;
    }
  });
});

describe("isThreadsEnabled", () => {
  afterEach(() => {
    delete process.env["THREADS_ENABLED"];
  });

  it("reads THREADS_ENABLED at call time", () => {
    delete process.env["THREADS_ENABLED"];
    expect(isThreadsEnabled()).toBe(false);
    process.env["THREADS_ENABLED"] = "true";
    expect(isThreadsEnabled()).toBe(true);
    process.env["THREADS_ENABLED"] = "false";
    expect(isThreadsEnabled()).toBe(false);
  });
});

describe("gist", () => {
  it("collapses whitespace, trims, and truncates to 140 chars", () => {
    expect(gist("  hello   world  \n\n  ")).toBe("hello world");
    const long = "a".repeat(200);
    expect(gist(long)).toBe("a".repeat(140));
  });
});

function makeThread(overrides: Partial<ConvoActiveDto["thread"]> = {}): ConvoActiveDto["thread"] {
  return {
    id: "t1", channel_id: "chan-1", seed_text: "seed text", seed_author: "raziel",
    ref_type: null, ref_id: null, ref_label: null,
    state: "open", turn_count: 1, last_turn_at: "2026-07-21T00:00:00Z",
    ...overrides,
  };
}

function makeMockLibrarian() {
  return {
    convoActive: jest.fn(),
    convoOpen: jest.fn(),
    convoTurn: jest.fn(),
    convoLand: jest.fn(),
  };
}

describe("ensureThread", () => {
  it("opens then appends when no thread is active", async () => {
    const mock = makeMockLibrarian();
    mock.convoActive.mockResolvedValue(null);
    const thread = makeThread();
    mock.convoOpen.mockResolvedValue(thread);
    mock.convoTurn.mockResolvedValue(undefined);

    const msg = { id: "m1", content: "hello there" };
    const result = await ensureThread(mock as unknown as LibrarianClient, "chan-1", msg, "cypher");

    expect(mock.convoOpen).toHaveBeenCalledWith({
      channel_id: "chan-1", seed_text: "hello there",
      seed_author: "cypher", seed_message_id: "m1",
    });
    expect(mock.convoTurn).toHaveBeenCalledWith("t1", { author: "cypher", gist: "hello there", message_id: "m1" });
    expect(result).toEqual({ thread, ledger: [] });
  });

  it("returns null when convoOpen fails to produce a thread", async () => {
    const mock = makeMockLibrarian();
    mock.convoActive.mockResolvedValue(null);
    mock.convoOpen.mockResolvedValue(null);

    const msg = { id: "m1", content: "hello there" };
    const result = await ensureThread(mock as unknown as LibrarianClient, "chan-1", msg, "cypher");

    expect(result).toBeNull();
    expect(mock.convoTurn).not.toHaveBeenCalled();
  });

  it("appends only (no convoOpen) when a thread is already active", async () => {
    const mock = makeMockLibrarian();
    const thread = makeThread();
    const active: ConvoActiveDto = { thread, ledger: [{ author: "raziel", gist: "prior", said_at: "2026-07-20T23:00:00Z" }] };
    mock.convoActive.mockResolvedValue(active);
    mock.convoTurn.mockResolvedValue(undefined);

    const msg = { id: "m2", content: "continuing the thread" };
    const result = await ensureThread(mock as unknown as LibrarianClient, "chan-1", msg, "gaia");

    expect(mock.convoOpen).not.toHaveBeenCalled();
    expect(mock.convoTurn).toHaveBeenCalledWith("t1", { author: "gaia", gist: "continuing the thread", message_id: "m2" });
    expect(result).toEqual(active);
  });
});

describe("parseLandMarker", () => {
  it("extracts the resolution and strips the marker", () => {
    const response = "Here's my read on it.\n[LANDS: we agreed on the migration path]\n";
    const result = parseLandMarker(response);
    expect(result.resolution).toBe("we agreed on the migration path");
    expect(result.cleaned).not.toContain("[LANDS:");
    expect(result.cleaned).toBe("Here's my read on it.");
  });

  it("passes through unchanged when no marker is present", () => {
    const response = "Just a normal reply, nothing to land.";
    const result = parseLandMarker(response);
    expect(result.resolution).toBeNull();
    expect(result.cleaned).toBe(response);
  });
});

describe("buildSpineBlock", () => {
  it("contains the presence sentence verbatim", () => {
    const active: ConvoActiveDto = { thread: makeThread(), ledger: [] };
    const block = buildSpineBlock(active, "cypher");
    expect(block).toContain(
      "If this exchange is presence rather than work, none of this applies; let it be.",
    );
  });

  it("includes the verbs line only when ref_label is set", () => {
    const withoutRefLabel: ConvoActiveDto = { thread: makeThread({ ref_label: null }), ledger: [] };
    const blockWithout = buildSpineBlock(withoutRefLabel, "cypher");
    expect(blockWithout).not.toContain("Your verbs for it:");

    const withRefLabel: ConvoActiveDto = { thread: makeThread({ ref_label: "the migration question" }), ledger: [] };
    const blockWith = buildSpineBlock(withRefLabel, "cypher");
    expect(blockWith).toContain("Your verbs for it:");
    expect(blockWith).toContain("(about: the migration question)");
  });
});
