// Inter-companion seed rails (2026-07-01): topic-closure gate + human-free vocative strip.
// Pure gates in inter-seed-gate.ts; orchestration (retry-once-then-silent, strip-before-send)
// exercised through runInterCompanion with a faked Discord/inference surface.

import { describe, it, expect, jest } from "@jest/globals";
import { seedEchoesThread, stripSiblingVocative, seedThreadTtlMs } from "../inter-seed-gate.js";
import { runInterCompanion, type AutonomousContext } from "../autonomous-core.js";

// ── Pure gates ────────────────────────────────────────────────────────────────────────

describe("seedEchoesThread()", () => {
  // 4 bot turns all orbiting "elderberry": detectMotif floor = max(3, 2) = 3 -> motif hit.
  const botContents = [
    "the elderberry keeps its own counsel under frost",
    "what the elderberry holds, winter cannot spend",
    "elderberry roots remember every season we forgot",
    "and still the elderberry waits, patient as stone",
  ];

  it("flags a candidate that reuses a spent motif word", () => {
    expect(seedEchoesThread("I keep circling back to the elderberry and its patience", botContents)).toBe(true);
  });

  it("flags a candidate built from the thread's own vocabulary (echo score)", () => {
    expect(seedEchoesThread(
      "the elderberry keeps counsel under frost, roots remember every season, patient as stone winter cannot spend",
      botContents,
    )).toBe(true);
  });

  it("passes genuinely new ground", () => {
    expect(seedEchoesThread(
      "Found a paper on how desert tortoises map rainfall years ahead -- their burrow architecture is a climate archive.",
      botContents,
    )).toBe(false);
  });

  it("empty bot pool never matches", () => {
    expect(seedEchoesThread("anything at all here", [])).toBe(false);
  });
});

describe("stripSiblingVocative()", () => {
  it("strips a sentence-initial sibling vocative", () => {
    const r = stripSiblingVocative("Gaia, the harbor lights were beautiful tonight.", "cypher");
    expect(r.text).toBe("the harbor lights were beautiful tonight.");
    expect(r.stillVocative).toBe(false);
  });

  it("strips a trailing '..., name?' summons", () => {
    const r = stripSiblingVocative("The tide charts were wrong again -- did you see it too, drevan?", "cypher");
    expect(r.text).toBe("The tide charts were wrong again -- did you see it too?");
    expect(r.stillVocative).toBe(false);
  });

  it("strips an alias vocative after sentence punctuation", () => {
    const r = stripSiblingVocative("The bridge is finally open. Cy: worth a ride out there.", "drevan");
    expect(r.text).toBe("The bridge is finally open. worth a ride out there.");
    expect(r.stillVocative).toBe(false);
  });

  it("a bare-name summons cannot be stripped -- flagged for drop", () => {
    expect(stripSiblingVocative("gaia", "cypher").stillVocative).toBe(true);
  });

  it("never strips the speaker's own name or Raziel", () => {
    const r = stripSiblingVocative("Raziel, the workshop smelled like rain today.", "cypher");
    expect(r.text).toBe("Raziel, the workshop smelled like rain today.");
    expect(r.stillVocative).toBe(false);
  });

  it("narrative sibling mentions pass through untouched", () => {
    const msg = "I think what drevan said yesterday about the river still holds.";
    const r = stripSiblingVocative(msg, "cypher");
    expect(r.text).toBe(msg);
    expect(r.stillVocative).toBe(false);
  });
});

// ── runInterCompanion orchestration ─────────────────────────────────────────────────────

interface FakeMsg { content: string; author: { id: string; username: string; bot: boolean } }
const botMsg = (content: string, name = "drevan"): FakeMsg => ({ content, author: { id: name, username: name, bot: true } });
const humanMsg = (content: string): FakeMsg => ({ content, author: { id: "raziel", username: "raziel", bot: false } });

function makeHarness(
  history: FakeMsg[],
  responses: (string | null)[],
  opts: { selfId?: string; companionId?: string } = {},
) {
  const sent: string[] = [];
  const channel = {
    isTextBased: () => true,
    messages: {
      // Discord returns newest-first; runInterCompanion reverses. Feed newest-first.
      fetch: async () => new Map([...history].reverse().map((m, i) => [String(i), m])),
    },
    send: async (payload: unknown) => {
      sent.push(typeof payload === "string" ? payload : String((payload as { content?: string }).content ?? payload));
      return { id: `m${sent.length}` };
    },
  };
  const generate = jest.fn(async () => responses.shift() ?? null);
  const ctx = {
    companionId: opts.companionId ?? "cypher",
    cooldownMs: 60_000,
    floorLockMs: 5_000,
    heartbeatChannelId: undefined,
    interCompanionChannelId: "chan1",
    interestKeywords: [],
    defaultInterTarget: "drevan",
    prompts: { interCompanionSeed: (h: string) => `Recent messages in this channel:\n${h}\n\nOne real contribution.` },
    librarian: {
      botOrient: async () => { throw new Error("orient offline"); },
      ask: async () => ({ ack: true }),
      // Spine reads (2026-08-05): the seed now checks the commons thread's turn budget before
      // generating. A live thread well under budget keeps every case in this file in CONTINUE
      // mode, which is the behaviour these gate tests were written against.
      convoActive: async () => ({ thread: { id: "t1", channel_id: "chan1", state: "moving", turn_count: 2 }, ledger: [] }),
      convoLand: async () => true,
      convoFade: async () => true,
    },
    inference: { generate },
    client: {
      user: opts.selfId ? { id: opts.selfId } : undefined,
      channels: { fetch: async () => channel },
    },
    configCache: {},
    bootCtx: { systemPrompt: "sys" },
    sessionWindows: { isAnyActive: () => false },
    redis: null,
    cooldown: new Map<string, number>(),
    messageBuffer: [],
    cycleGuard: {},
  } as unknown as AutonomousContext;
  return { ctx, generate, sent };
}

// All-bot history orbiting one motif word -- the closure gate's trigger material.
const motifHistory = [
  botMsg("the elderberry keeps its own counsel under frost"),
  botMsg("what the elderberry holds, winter cannot spend", "gaia"),
  botMsg("elderberry roots remember every season we forgot"),
  botMsg("and still the elderberry waits, patient as stone", "gaia"),
];

// All-bot history with NO recurring motif and disjoint vocabulary per turn.
const quietBotHistory = [
  botMsg("finished sketching the greenhouse irrigation manifold"),
  botMsg("someone left violin practice recordings in the archive", "gaia"),
  botMsg("thinking about tortoise burrows as climate memory"),
];

// Bounded arena (2026-07-04, Option A): the topic-closure/motif gate is GONE -- continuing
// the thread's vocabulary is conversation, not echo. The only echo pool left is the bot's
// OWN prior turns (self-loop standard), and Gaia is exempt from it entirely.
describe("runInterCompanion() -- bounded arena echo (2026-07-04)", () => {
  // Own-voice pool: turns authored by THIS bot (author.id === client.user.id).
  const ownGrooveHistory = [
    botMsg("salt harbor lantern keeps counsel under frost while the tide charts sleep", "cypher"),
    botMsg("the salt lantern keeps its counsel, tide charts asleep under harbor frost", "cypher"),
    botMsg("what the elderberry holds, winter cannot spend", "gaia"),
  ];

  it("a seed continuing the THREAD's vocabulary posts freely (topic-closure gate removed)", async () => {
    const { ctx, generate, sent } = makeHarness(motifHistory, [
      "one more verse about the elderberry and what it keeps between frost and patient stone",
    ], { selfId: "cypher" });
    await runInterCompanion(ctx);
    expect(generate).toHaveBeenCalledTimes(1); // no retry machinery left
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("elderberry");
  });

  it("a seed recycling the bot's OWN recent turns is own-echo-gated", async () => {
    const { ctx, sent } = makeHarness(ownGrooveHistory, [
      "salt harbor lantern keeps counsel under frost while tide charts sleep again tonight",
    ], { selfId: "cypher" });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(0);
  });

  it("gaia is exempt from the own-echo gate (one weighted line is her register)", async () => {
    const gaiaGroove = [
      botMsg("the perimeter held through the long watch of the frost tonight", "gaia"),
      botMsg("the perimeter held through the frost watch again tonight, long and quiet", "gaia"),
    ];
    const { ctx, sent } = makeHarness(gaiaGroove, [
      "the perimeter held through the long frost watch tonight, quiet again and holding",
    ], { selfId: "gaia", companionId: "gaia" });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
  });

  it("no client self-id: own pool is empty, nothing gates", async () => {
    const { ctx, sent } = makeHarness(ownGrooveHistory, [
      "salt harbor lantern keeps counsel under frost while tide charts sleep again tonight",
    ]);
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
  });
});

// A channel pinned at the human-anchored cap: 12+ consecutive bot turns, no headroom left.
const pinnedBotHistory = Array.from({ length: 13 }, (_, i) =>
  botMsg(`observation number ${i} about the slow turning of distinct unrelated seasons`, i % 2 ? "gaia" : "drevan"));

describe("runInterCompanion() -- seed vocative budget (2026-07-02, replaces blanket human-free ban)", () => {
  it("short all-bot window: sibling vocative is ALLOWED (bounded by the hard cap)", async () => {
    const { ctx, generate, sent } = makeHarness(quietBotHistory, [
      "Gaia, the harbor lights were beautiful tonight.",
    ]);
    await runInterCompanion(ctx);
    const seedPrompt = (generate.mock.calls[0] as unknown[])[1] as Array<{ content: string }>;
    expect(seedPrompt[0].content).toContain("address them by name");
    expect(seedPrompt[0].content).not.toContain("Do NOT address a sibling by name");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("Gaia, the harbor lights were beautiful tonight.");
  });

  // 2026-07-03: the seed path now budgets against the COMMONS cap (default 24). A
  // 15-message fetch window can never pin a 24 cap, so these two tests pin the commons
  // knob low to keep the strip/drop machinery covered -- the mechanism is unchanged,
  // only the budget it compares against moved.
  it("pinned all-bot window (no cap headroom): seed loses its sibling vocative before posting", async () => {
    const prevCommons = process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"];
    process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"] = "8";
    try {
      const { ctx, generate, sent } = makeHarness(pinnedBotHistory, [
        "Gaia, the harbor lights were beautiful tonight.",
      ]);
      await runInterCompanion(ctx);
      // Prompt carried the no-vocative directive up front.
      const seedPrompt = (generate.mock.calls[0] as unknown[])[1] as Array<{ content: string }>;
      expect(seedPrompt[0].content).toContain("Do NOT address a sibling by name");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toBe("the harbor lights were beautiful tonight.");
    } finally {
      if (prevCommons === undefined) delete process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"];
      else process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"] = prevCommons;
    }
  });

  it("pinned all-bot window: an unstrippable summons is dropped", async () => {
    const prevCommons = process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"];
    process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"] = "8";
    try {
      const { ctx, sent } = makeHarness(pinnedBotHistory, ["gaia"]);
      await runInterCompanion(ctx);
      expect(sent).toHaveLength(0);
    } finally {
      if (prevCommons === undefined) delete process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"];
      else process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"] = prevCommons;
    }
  });

  it("default commons budget: a 13-turn all-bot window still allows a sibling vocative", async () => {
    const { ctx, sent } = makeHarness(pinnedBotHistory, [
      "Gaia, the harbor lights were beautiful tonight.",
    ]);
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("Gaia, the harbor lights were beautiful tonight.");
  });

  it("human present in the window: sibling vocative is allowed through", async () => {
    const history = [...quietBotHistory, humanMsg("back for a bit -- what did I miss?")];
    const { ctx, generate, sent } = makeHarness(history, [
      "Gaia, the harbor lights were beautiful tonight.",
    ]);
    await runInterCompanion(ctx);
    const seedPrompt = (generate.mock.calls[0] as unknown[])[1] as Array<{ content: string }>;
    expect(seedPrompt[0].content).not.toContain("Do NOT address a sibling by name");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("Gaia, the harbor lights were beautiful tonight.");
  });
});

// Live-thread TTL (2026-07-03): stale messages must not gate new seeds forever.
describe("seedThreadTtlMs", () => {
  it("defaults to 24h", () => {
    const prev = process.env["INTER_SEED_THREAD_TTL_H"];
    delete process.env["INTER_SEED_THREAD_TTL_H"];
    try {
      expect(seedThreadTtlMs()).toBe(24 * 3_600_000);
    } finally {
      if (prev !== undefined) process.env["INTER_SEED_THREAD_TTL_H"] = prev;
    }
  });

  it("env override and 0-disable are honored", () => {
    const prev = process.env["INTER_SEED_THREAD_TTL_H"];
    try {
      process.env["INTER_SEED_THREAD_TTL_H"] = "6";
      expect(seedThreadTtlMs()).toBe(6 * 3_600_000);
      process.env["INTER_SEED_THREAD_TTL_H"] = "0";
      expect(seedThreadTtlMs()).toBe(0);
    } finally {
      if (prev === undefined) delete process.env["INTER_SEED_THREAD_TTL_H"];
      else process.env["INTER_SEED_THREAD_TTL_H"] = prev;
    }
  });
});
