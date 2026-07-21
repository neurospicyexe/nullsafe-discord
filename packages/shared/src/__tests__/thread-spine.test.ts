import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { LibrarianClient, ConvoActiveDto } from "../librarian.js";
import {
  isThreadsEnabled, isThreadTracked, gist, ensureThread, buildSpineBlock, parseLandMarker,
  computeReplyRef,
} from "../thread-spine.js";
import { ownEchoGated } from "../echo-guard.js";

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

describe("computeReplyRef", () => {
  it("returns the message id for an owner message when a spine is active", () => {
    expect(computeReplyRef(false, true, "m1")).toBe("m1");
  });

  it("returns undefined when neither the sender is a companion bot nor a spine is active", () => {
    expect(computeReplyRef(false, false, "m1")).toBeUndefined();
  });

  it("returns the message id for a companion-bot sender regardless of spine state", () => {
    expect(computeReplyRef(true, false, "m1")).toBe("m1");
    expect(computeReplyRef(true, true, "m1")).toBe("m1");
  });
});

describe("parseLandMarker composition with send order", () => {
  it("never leaks the [LANDS: ...] marker into the text that would be sent, across a multi-line response", () => {
    const response = [
      "First line of the reply.",
      "Second line elaborating the point.",
      "[LANDS: we settled on the migration path]",
      "",
      "A closing line after the marker.",
    ].join("\n");

    const { cleaned, resolution } = parseLandMarker(response);
    const wouldBeSent = cleaned; // exactly what sendLong would receive as `response`

    expect(resolution).toBe("we settled on the migration path");
    expect(wouldBeSent).not.toContain("[LANDS:");
    expect(wouldBeSent).not.toContain("]");
    expect(wouldBeSent).toContain("First line of the reply.");
    expect(wouldBeSent).toContain("A closing line after the marker.");
  });
});

describe("echo gate composition (2026-07-21 review): scores the cleaned text, not the raw marker-laden response", () => {
  // Reproduces the exact composition bot-message-handler.ts now does: parseLandMarker
  // runs BEFORE the echo gate, so `response` is already stripped by the time ownEchoGated
  // sees it. The bug this guards against: scoring the RAW response (marker still
  // attached) instead of the cleaned one. The marker's own text can carry vocabulary that
  // happens to match the speaker's own prior turns even when the actual reply content is
  // entirely new -- so scoring pre-strip would falsely self-loop-gate a genuinely fresh
  // reply purely because of words trapped inside "[LANDS: ...]", which is itself never
  // sent to Discord.
  const ownPriorTurns = ["migration path solution rollback", "migration path solution rollback"];
  // 8 repeats of one word neither in the pool nor a stopword -- a synthetic probe, not
  // meant to read as real prose, chosen so the math is legible: it satisfies
  // MIN_REPLY_WORDS on its own and shares zero vocabulary with ownPriorTurns.
  const freshContent = "lantern lantern lantern lantern lantern lantern lantern lantern.";
  const rawResponse = `${freshContent}\n[LANDS: migration path solution rollback migration path solution rollback migration path solution rollback migration path solution rollback]`;

  // Pin the threshold explicitly rather than relying on SELF_LOOP_DEFAULT_THRESHOLD --
  // the raw-response score (~0.57) sits close enough to the 0.55 default that a leaked
  // SELF_LOOP_THRESHOLD from another test/env would otherwise make this flaky.
  const THRESHOLD_KEY = "SELF_LOOP_THRESHOLD";
  let prevThreshold: string | undefined;
  beforeEach(() => {
    prevThreshold = process.env[THRESHOLD_KEY];
    process.env[THRESHOLD_KEY] = "0.55";
  });
  afterEach(() => {
    if (prevThreshold === undefined) delete process.env[THRESHOLD_KEY];
    else process.env[THRESHOLD_KEY] = prevThreshold;
  });

  it("the text handed to ownEchoGated equals parseLandMarker's cleaned output, not the raw response", () => {
    const spineActive = true; // spine !== null in the real handler
    const { cleaned } = spineActive ? parseLandMarker(rawResponse) : { cleaned: rawResponse, resolution: null };

    expect(cleaned).not.toBe(rawResponse);
    expect(cleaned).toBe(parseLandMarker(rawResponse).cleaned);
    expect(cleaned).not.toContain("[LANDS:");
  });

  it("scoring cleaned (fixed order) does NOT self-loop-gate a genuinely fresh reply", () => {
    const { cleaned } = parseLandMarker(rawResponse);
    const result = ownEchoGated("cypher", cleaned, ownPriorTurns);
    expect(result.gated).toBe(false);
    expect(result.score).toBe(0);
  });

  it("scoring the RAW pre-strip response (the bug) WOULD have false-positive gated this same reply", () => {
    // Proves the fix matters: the marker's own vocabulary overlaps the prior-turn pool
    // enough to trip the self-loop threshold even though the visible content is fresh.
    const result = ownEchoGated("cypher", rawResponse, ownPriorTurns);
    expect(result.gated).toBe(true);
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
