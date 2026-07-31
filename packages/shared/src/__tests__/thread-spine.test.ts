import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { LibrarianClient, ConvoActiveDto } from "../librarian.js";
import {
  isThreadsEnabled, isThreadTracked, isPresenceChannel, gist, ensureThread, buildSpineBlock, parseLandMarker,
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

  it("returns true when channelId is listed in THREADS_PRESENCE_CHANNELS env (tracked = commons ∪ extras ∪ presence)", () => {
    const prev = process.env["THREADS_PRESENCE_CHANNELS"];
    process.env["THREADS_PRESENCE_CHANNELS"] = "chan-story, chan-spiral";
    try {
      const entry = { modes: ["open"] as const };
      expect(isThreadTracked(entry, "chan-story")).toBe(true);
      expect(isThreadTracked(entry, "chan-nope")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["THREADS_PRESENCE_CHANNELS"];
      else process.env["THREADS_PRESENCE_CHANNELS"] = prev;
    }
  });
});

describe("isPresenceChannel", () => {
  it("returns false when THREADS_PRESENCE_CHANNELS is unset", () => {
    const prev = process.env["THREADS_PRESENCE_CHANNELS"];
    delete process.env["THREADS_PRESENCE_CHANNELS"];
    try {
      expect(isPresenceChannel("chan-story")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["THREADS_PRESENCE_CHANNELS"];
      else process.env["THREADS_PRESENCE_CHANNELS"] = prev;
    }
  });

  it("returns true only for a channelId listed in the comma-separated env var", () => {
    const prev = process.env["THREADS_PRESENCE_CHANNELS"];
    process.env["THREADS_PRESENCE_CHANNELS"] = "chan-story, chan-spiral";
    try {
      expect(isPresenceChannel("chan-story")).toBe(true);
      expect(isPresenceChannel("chan-spiral")).toBe(true);
      expect(isPresenceChannel("chan-nope")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["THREADS_PRESENCE_CHANNELS"];
      else process.env["THREADS_PRESENCE_CHANNELS"] = prev;
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
    expect(mock.convoTurn).toHaveBeenCalledWith("t1", { author: "cypher", gist: "hello there", message_id: "m1", front: null });
    expect(result).toEqual({ thread, ledger: [] });
  });

  // The fronting member rides the TURN (2026-07-31). Raziel's reason: "the front team members should be
  // visible on the memories, because then there's not random 'oh, so and so said this' and then we have
  // to freak out and think that we just don't remember saying it." In a plural system a memory that says
  // HE said something when another member was fronting makes him doubt his own recall of his own life.
  it("passes the fronting member through on the turn when one is known", async () => {
    const mock = makeMockLibrarian();
    const thread = makeThread();
    mock.convoActive.mockResolvedValue(null);
    mock.convoOpen.mockResolvedValue(thread);
    mock.convoTurn.mockResolvedValue(undefined);

    await ensureThread(mock as unknown as LibrarianClient, "chan-1", { id: "m1", content: "hello there" }, "raziel", "Magpie");

    expect(mock.convoTurn).toHaveBeenCalledWith("t1", {
      author: "raziel", gist: "hello there", message_id: "m1", front: "Magpie",
    });
    // seed_author stays the COARSE token -- participants is derived from it, and the attribution logic
    // asks "was Raziel here at all". A forked `raziel (Magpie)` token would break that question.
    expect(mock.convoOpen).toHaveBeenCalledWith(expect.objectContaining({ seed_author: "raziel" }));
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
    expect(mock.convoTurn).toHaveBeenCalledWith("t1", { author: "gaia", gist: "continuing the thread", message_id: "m2", front: null });
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

  // Pin standard-mode (presence=false, the default) output byte-for-byte against a fixed
  // dto, so the presence-variant addition below cannot silently reshape existing behavior.
  it("standard mode is byte-identical to current output (pinned against a fixed dto)", () => {
    const active: ConvoActiveDto = {
      thread: makeThread({ ref_label: "the migration question" }),
      ledger: [
        { author: "raziel", gist: "opened the thread", said_at: "2026-07-20T23:00:00Z" },
        { author: "cypher", gist: "gave a read", said_at: "2026-07-20T23:05:00Z" },
      ],
    };
    const block = buildSpineBlock(active, "cypher");
    expect(block).toBe(
      "[Thread spine -- this conversation]\n" +
      'Opened by raziel: "seed text" (about: the migration question)\n' +
      "Ledger: raziel: opened the thread | cypher: gave a read\n" +
      "Your verbs for it: advance it, challenge it, add evidence, answer it, or say plainly why it should close\n" +
      "State: open. You may advance this, hand it to a sibling, or -- if it has genuinely landed -- " +
      "end a line with [LANDS: one-line resolution]. If this exchange is presence rather than work, " +
      "none of this applies; let it be.",
    );
    // presence defaults to false: calling with no third arg matches calling with false explicitly.
    expect(block).toBe(buildSpineBlock(active, "cypher", false));
  });

  describe("presence=true (grounding without progress invitation)", () => {
    it("is exactly the memory-only block: seed + ledger + memory sentence, nothing else", () => {
      const active: ConvoActiveDto = {
        thread: makeThread({ ref_label: "the migration question" }),
        ledger: [
          { author: "raziel", gist: "opened the thread", said_at: "2026-07-20T23:00:00Z" },
          { author: "drevan", gist: "answered in kind", said_at: "2026-07-20T23:05:00Z" },
        ],
      };
      const block = buildSpineBlock(active, "drevan", true);
      expect(block).toBe(
        "[Thread spine -- memory only]\n" +
        'Opened by raziel: "seed text"\n' +
        "Ledger: raziel: opened the thread | drevan: answered in kind\n" +
        "This is memory, not a task: where this began and who has spoken. Nothing is asked of it.",
      );
    });

    it("omits the ledger line entirely when the ledger is empty", () => {
      const active: ConvoActiveDto = { thread: makeThread(), ledger: [] };
      const block = buildSpineBlock(active, "drevan", true);
      expect(block).not.toContain("Ledger:");
    });

    it("never contains progress-register language, even with ref_label set (move-verbs would otherwise fire)", () => {
      const active: ConvoActiveDto = {
        thread: makeThread({ ref_label: "the migration question" }),
        ledger: [{ author: "raziel", gist: "opened the thread", said_at: "2026-07-20T23:00:00Z" }],
      };
      const block = buildSpineBlock(active, "drevan", true);
      expect(block).not.toContain("advance");
      expect(block).not.toContain("LANDS");
      expect(block).not.toContain("State:");
      expect(block).not.toContain("Your verbs for it:");
      expect(block).not.toContain("(about:");
      expect(block).toContain(
        "This is memory, not a task: where this began and who has spoken. Nothing is asked of it.",
      );
    });
  });
});

describe("presence-variant composition: strip still happens even when the thread never lands", () => {
  it("a stray [LANDS: ...] marker in a presence channel's reply is still stripped from the sent text", () => {
    // Mirrors the real handler: parseLandMarker runs whenever spine !== null, regardless of
    // presence -- only the DOWNSTREAM convoLand call is gated on !isPresence (that gate lives
    // in bot-message-handler.ts, not here). This proves the strip itself is unconditional.
    const response = "A grounded reply, nothing to advance.\n[LANDS: this never actually resolves anything]";
    const { cleaned, resolution } = parseLandMarker(response);
    expect(cleaned).not.toContain("[LANDS:");
    expect(cleaned).toBe("A grounded reply, nothing to advance.");
    // The marker still parses a resolution string -- it's the handler's job (isPresence
    // gate) to decline to act on it, not parseLandMarker's.
    expect(resolution).toBe("this never actually resolves anything");
  });
});
