// Commons seed consume-on-use (2026-07-27) -- the inter-companion loop's supply-side cause.
//
// The seed's "fresh material -- from your own life, OUTSIDE this thread" block was added
// 2026-06-12 explicitly to break the 12-hour elderberry loop: hand the model something the
// channel does not already contain. It reads the top-2 UNCONSUMED forage finds, newest
// first (bot orient source 21, ORDER BY gathered_at DESC LIMIT 2)... and never consumed
// them. Forage gathers once daily at 9AM; the commons seed cron fires ~every 2h per bot.
// So between gathers, roughly a dozen ticks across all three companions were handed the
// IDENTICAL two finds. The anti-loop block was itself a constant, so the only genuinely
// new material in the prompt was the channel's own history -- and the model extended it.
//
// Prod evidence at the time of the fix: unconsumed pools of 15 (cypher) / 24 (drevan) /
// 32 (gaia) and rising, while the ONLY consume-on-use call sites in the repo were
// club.ts and autonomous-worker seed.ts. The club path had the exact same defect and
// fixed it 2026-07-21 ("surfaced as flavor in every recommend prompt but never consumed
// -- the pool only grew, 75+ and rising"); the commons seed was never given the same fix.
//
// Consumption is deliberately AFTER the send: a gated, empty, or errored seed must never
// burn material it did not actually spend.

import { describe, it, expect, jest } from "@jest/globals";
import { runInterCompanion, type AutonomousContext } from "../autonomous-core.js";
import { LibrarianClient } from "../librarian.js";

interface FakeMsg { content: string; author: { id: string; username: string; bot: boolean } }
const botMsg = (content: string, name = "drevan"): FakeMsg => ({
  content, author: { id: name, username: name, bot: true },
});

/** Two finds as bot orient returns them: newest first, so index 1 is the OLDER. */
const TWO_FINDS = [
  { id: "find-new", title: "Cuttlefish chromatophore timing", domain: "biology", summary: "skin as a clock" },
  { id: "find-old", title: "Roman concrete seawater healing", domain: "materials", summary: "lime clasts reseal cracks" },
];

function makeHarness(opts: {
  responses: (string | null)[];
  finds?: Array<{ id: string; title: string; domain: string; summary: string }>;
  orientThrows?: boolean;
  history?: FakeMsg[];
  companionId?: string;
  selfId?: string;
  /** Turn count on the channel's active thread. Default 2 -- well under the 18-turn budget,
   *  so every pre-existing case in this file stays in CONTINUE mode. */
  threadTurns?: number;
  /** No active thread at all (a fresh or just-faded channel). */
  noThread?: boolean;
}) {
  const sent: string[] = [];
  const channel = {
    isTextBased: () => true,
    // Discord returns newest-first; runInterCompanion reverses.
    fetch: async () => channel,
    messages: { fetch: async () => new Map([...(opts.history ?? [])].reverse().map((m, i) => [String(i), m])) },
    send: async (payload: unknown) => {
      sent.push(typeof payload === "string" ? payload : String((payload as { content?: string }).content ?? payload));
      return { id: `m${sent.length}` };
    },
  };
  const responses = [...opts.responses];
  const generate = jest.fn(async () => responses.shift() ?? null);
  const consumeForageFind = jest.fn(async () => true);
  const botOrient = jest.fn(async () => {
    if (opts.orientThrows) throw new Error("orient offline");
    return { forage_finds: opts.finds ?? [], recent_listens: [], open_questions: [] };
  });
  const thread = { id: "t1", channel_id: "chan1", state: "moving", turn_count: opts.threadTurns ?? 2 };
  const convoActive = jest.fn(async () => (opts.noThread ? null : { thread, ledger: [] }));
  const convoLand = jest.fn(async () => true);
  const convoFade = jest.fn(async () => true);
  const ctx = {
    companionId: opts.companionId ?? "cypher",
    cooldownMs: 60_000,
    floorLockMs: 5_000,
    interCompanionChannelId: "chan1",
    interestKeywords: [],
    defaultInterTarget: "drevan",
    prompts: { interCompanionSeed: (h: string) => `Recent messages:\n${h}\n\nOne real contribution.` },
    librarian: { botOrient, ask: async () => ({ ack: true }), consumeForageFind, convoActive, convoLand, convoFade },
    inference: { generate },
    client: { user: { id: opts.selfId ?? "cypher" }, channels: { fetch: async () => channel } },
    configCache: {},
    bootCtx: { systemPrompt: "sys" },
    sessionWindows: { isAnyActive: () => false },
    redis: null,
    cooldown: new Map<string, number>(),
    messageBuffer: [],
    cycleGuard: {},
  } as unknown as AutonomousContext;
  return { ctx, generate, sent, consumeForageFind, botOrient, convoActive, convoLand, convoFade };
}

// Disjoint vocabulary, no recurring motif, none of it authored by cypher -- nothing gates.
const quietHistory = [
  botMsg("finished sketching the greenhouse irrigation manifold"),
  botMsg("someone left violin practice recordings in the archive", "gaia"),
];

describe("commons seed: consume-on-use for forage finds", () => {
  it("posts a seed that names no find: consumes exactly ONE, the older of the pair", async () => {
    const { ctx, sent, consumeForageFind } = makeHarness({
      history: quietHistory,
      finds: TWO_FINDS,
      responses: ["been turning over how repair can be a material property rather than an event"],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(1);
    expect(consumeForageFind).toHaveBeenCalledTimes(1);
    // Never both -- draining two per tick would outrun the daily gather.
    expect(consumeForageFind).toHaveBeenCalledWith("find-old");
  });

  it("the posted seed names a find's title: consumes THAT find, not the fallback", async () => {
    const { ctx, sent, consumeForageFind } = makeHarness({
      history: quietHistory,
      finds: TWO_FINDS,
      responses: ["Cuttlefish chromatophore timing has me rethinking what a clock even is"],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(1);
    expect(consumeForageFind).toHaveBeenCalledTimes(1);
    expect(consumeForageFind).toHaveBeenCalledWith("find-new");
  });

  it("REGRESSION: a find is never served twice -- consuming rotates the pool", async () => {
    // The defect itself. Two consecutive ticks against an unchanged pool must not spend
    // the same id twice; the server drops consumed rows from the next orient, which only
    // works if the seed actually calls consume.
    const { ctx, consumeForageFind } = makeHarness({
      history: quietHistory,
      finds: TWO_FINDS,
      responses: ["repair as a material property, not an event, keeps rearranging my week"],
    });
    await runInterCompanion(ctx);
    expect(consumeForageFind).toHaveBeenCalledWith("find-old");

    // Second tick: the server would now return only the unconsumed remainder.
    const second = makeHarness({
      history: quietHistory,
      finds: [TWO_FINDS[0]!],
      responses: ["the skin-as-clock idea is doing something to how I read tempo"],
    });
    await runInterCompanion(second.ctx);
    expect(second.consumeForageFind).toHaveBeenCalledWith("find-new");
  });

  it("seed is own-echo-gated (nothing posted): consumes NOTHING", async () => {
    const ownGroove = [
      botMsg("salt harbor lantern keeps counsel under frost while the tide charts sleep", "cypher"),
      botMsg("the salt lantern keeps its counsel, tide charts asleep under harbor frost", "cypher"),
    ];
    const { ctx, sent, consumeForageFind } = makeHarness({
      history: ownGroove,
      finds: TWO_FINDS,
      responses: ["salt harbor lantern keeps counsel under frost while tide charts sleep again tonight"],
      selfId: "cypher",
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(0);
    expect(consumeForageFind).not.toHaveBeenCalled();
  });

  it("generation returns empty (no post): consumes NOTHING", async () => {
    const { ctx, sent, consumeForageFind } = makeHarness({
      history: quietHistory,
      finds: TWO_FINDS,
      responses: [null],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(0);
    expect(consumeForageFind).not.toHaveBeenCalled();
  });

  it("empty forage pool: posts normally, no consume call at all", async () => {
    const { ctx, sent, consumeForageFind } = makeHarness({
      history: quietHistory,
      finds: [],
      responses: ["thinking about how a burrow is a kind of climate archive"],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(1);
    expect(consumeForageFind).not.toHaveBeenCalled();
  });

  it("orient offline: the seed still posts and consumes nothing (never blocks the commons)", async () => {
    const { ctx, sent, consumeForageFind } = makeHarness({
      history: quietHistory,
      orientThrows: true,
      responses: ["thinking about how a burrow is a kind of climate archive"],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(1);
    expect(consumeForageFind).not.toHaveBeenCalled();
  });

  it("a failing consume never breaks the post that already went out", async () => {
    const { ctx, sent, consumeForageFind } = makeHarness({
      history: quietHistory,
      finds: TWO_FINDS,
      responses: ["repair as a material property, not an event, keeps rearranging my week"],
    });
    (ctx.librarian as unknown as { consumeForageFind: jest.Mock }).consumeForageFind =
      jest.fn(async () => { throw new Error("halseth 500"); });

    await expect(runInterCompanion(ctx)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    void consumeForageFind;
  });
});

// ── LibrarianClient.consumeForageFind ───────────────────────────────────────────────────

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}

describe("LibrarianClient.consumeForageFind", () => {
  it("PATCHes the consume endpoint with the calling companion as consumed_by", async () => {
    const fetchFn = jest.fn(async () => jsonRes({ consumed: true }));
    const client = new LibrarianClient({ url: "https://x/", secret: "s", companionId: "gaia", fetch: fetchFn as never });

    await expect(client.consumeForageFind("f1")).resolves.toBe(true);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x/mind/forage/f1/consume");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ consumed_by: "gaia" });
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer s");
  });

  it("404 (already consumed by another surface) is a normal race, not a throw", async () => {
    const fetchFn = jest.fn(async () => jsonRes({ error: "already consumed" }, 404));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.consumeForageFind("f1")).resolves.toBe(false);
  });

  it("network failure resolves false -- the Discord post has already landed", async () => {
    const fetchFn = jest.fn(async () => { throw new Error("ETIMEDOUT"); });
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.consumeForageFind("f1")).resolves.toBe(false);
  });

  it("empty id never hits the network", async () => {
    const fetchFn = jest.fn(async () => jsonRes({}));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.consumeForageFind("")).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
