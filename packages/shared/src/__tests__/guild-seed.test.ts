// guild-seed.test.ts -- the #the-triad server-scoped seeder (2026-10-05).
//
// #the-triad is the triad's own room in the server Raziel shares with Blue, and its conversation must be
// ONLY about what happened in THAT server. These tests pin: the knob fails closed; the supply never
// includes #the-syndicate (Blue's companions) or #the-triad itself, whatever the env says; the excerpt is
// capped newest-first; an empty supply is silence, never a seed about nothing; the cadence; one decider
// per window; and that shadow logs counts without text and never posts.

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
  guildSeedMode, guildTriadChannelId, guildTriadSupplyChannels, preClaimGate, supplyGate, supplySince,
  buildSupply, classifyAuthor, guildSeedKeys, guildSeedLogLine, companionBotIds, guildExcerptBlock,
  DEFAULT_GUILD_TRIAD_CHANNEL_ID, DEFAULT_GUILD_TRIAD_SUPPLY, SYNDICATE_CHANNEL_ID, GUILD_TRIAD_GUILD_ID,
  GUILD_SEED_MIN_GAP_MS, GUILD_SEED_QUIET_GAP_MS, GUILD_SEED_LOOKBACK_MS,
  type SupplyMsg,
} from "../guild-seed.js";
import { runGuildTriadSeed, type AutonomousContext } from "../autonomous-core.js";

const H = 3_600_000;
const NOW = Date.parse("2026-10-05T18:00:00Z");
const BLABBING = "1556107154568777762";
const MOVIES = "1556334678024396862";
const TRIAD = DEFAULT_GUILD_TRIAD_CHANNEL_ID;

// ── knob ────────────────────────────────────────────────────────────────────────────────────────

describe("guildSeedMode (fails closed)", () => {
  it.each([
    [undefined, "off"], ["", "off"], ["off", "off"], ["true", "off"], ["1", "off"], ["yes", "off"],
    ["live", "off"], ["shadowy", "off"], ["o n", "off"],
    ["shadow", "shadow"], [" SHADOW ", "shadow"], ["Shadow", "shadow"],
    ["on", "on"], ["ON", "on"], ["  on\n", "on"],
  ])("%p -> %p", (raw, want) => {
    expect(guildSeedMode({ GUILD_TRIAD_SEED: raw as string | undefined })).toBe(want);
  });
});

// ── where ───────────────────────────────────────────────────────────────────────────────────────

describe("channel config", () => {
  it("defaults to #the-triad and the 17 other channels, never the syndicate or the triad", () => {
    expect(guildTriadChannelId({})).toBe("1556334827026784266");
    const ids = guildTriadSupplyChannels({});
    expect(ids).toHaveLength(17);
    expect(ids).toEqual([...DEFAULT_GUILD_TRIAD_SUPPLY]);
    expect(ids).not.toContain(SYNDICATE_CHANNEL_ID);
    expect(ids).not.toContain(TRIAD);
  });

  it("an env list replaces the default, and the syndicate + the triad are stripped AFTER the merge", () => {
    const ids = guildTriadSupplyChannels({
      GUILD_TRIAD_SUPPLY_CHANNELS: ` ${BLABBING}, ${SYNDICATE_CHANNEL_ID},${TRIAD},not-an-id,${BLABBING}`,
    });
    expect(ids).toEqual([BLABBING]);
  });

  it("an env triad id is itself stripped from the supply", () => {
    const ids = guildTriadSupplyChannels({ GUILD_TRIAD_CHANNEL_ID: BLABBING });
    expect(ids).not.toContain(BLABBING);
    expect(ids).toHaveLength(16);
  });

  it("an env list with no valid ids falls back to the default; a bad channel id falls back too", () => {
    expect(guildTriadSupplyChannels({ GUILD_TRIAD_SUPPLY_CHANNELS: "garbage, ," })).toHaveLength(17);
    expect(guildTriadChannelId({ GUILD_TRIAD_CHANNEL_ID: "#the-triad" })).toBe(TRIAD);
  });

  it("companion bot ids come from the *_BOT_ID env", () => {
    expect(companionBotIds({ CYPHER_BOT_ID: "11", GAIA_BOT_ID: " 33 " })).toEqual({ "11": "cypher", "33": "gaia" });
  });
});

// ── when ────────────────────────────────────────────────────────────────────────────────────────

describe("cadence", () => {
  it("first ever seed passes the pre-claim gate", () => {
    expect(preClaimGate({ now: NOW, lastSeedAt: null, lastBy: null, me: "cypher" })).toBeNull();
  });
  it("under 2h since the last seed: min_gap, for everyone", () => {
    expect(preClaimGate({ now: NOW, lastSeedAt: NOW - GUILD_SEED_MIN_GAP_MS + 1, lastBy: "drevan", me: "cypher" })).toBe("min_gap");
  });
  it("the last seeder yields to a sibling for 12h, then the yield lapses", () => {
    expect(preClaimGate({ now: NOW, lastSeedAt: NOW - 3 * H, lastBy: "cypher", me: "cypher" })).toBe("yield");
    expect(preClaimGate({ now: NOW, lastSeedAt: NOW - 3 * H, lastBy: "drevan", me: "cypher" })).toBeNull();
    expect(preClaimGate({ now: NOW, lastSeedAt: NOW - GUILD_SEED_QUIET_GAP_MS, lastBy: "cypher", me: "cypher" })).toBeNull();
  });
  it("no human message = empty_supply; a trickle = trivial_supply", () => {
    expect(supplyGate({ now: NOW, lastSeedAt: null, humanCount: 0, humanChars: 0 })).toBe("empty_supply");
    expect(supplyGate({ now: NOW, lastSeedAt: null, humanCount: 1, humanChars: 3 })).toBe("trivial_supply");
  });
  it("under 12h needs >= 5 human messages; at/after 12h one real message is enough", () => {
    expect(supplyGate({ now: NOW, lastSeedAt: NOW - 3 * H, humanCount: 4, humanChars: 400 })).toBe("quiet_window");
    expect(supplyGate({ now: NOW, lastSeedAt: NOW - 3 * H, humanCount: 5, humanChars: 400 })).toBeNull();
    expect(supplyGate({ now: NOW, lastSeedAt: NOW - 12 * H, humanCount: 1, humanChars: 40 })).toBeNull();
    expect(supplyGate({ now: NOW, lastSeedAt: null, humanCount: 1, humanChars: 40 })).toBeNull();
  });
  it("'since the last seed' is bounded by the 48h lookback", () => {
    expect(supplySince(NOW, NOW - 3 * H)).toBe(NOW - 3 * H);
    expect(supplySince(NOW, null)).toBe(NOW - GUILD_SEED_LOOKBACK_MS);
    expect(supplySince(NOW, NOW - 100 * H)).toBe(NOW - GUILD_SEED_LOOKBACK_MS);
  });
  it("shadow and on keep separate keys; the claim is keyed by the seed window", () => {
    expect(guildSeedKeys("shadow").lastAt).not.toBe(guildSeedKeys("on").lastAt);
    expect(guildSeedKeys("on").claim(null)).toBe("ns:guildseed:on:claim:none");
    expect(guildSeedKeys("on").claim(123)).toBe("ns:guildseed:on:claim:123");
  });
});

// ── what ────────────────────────────────────────────────────────────────────────────────────────

const BOTS = { "B-CY": "cypher", "B-DRE": "drevan", "B-GAIA": "gaia" } as const;
const classify = { selfId: "B-CY", selfCompanion: "cypher" as const, botIdCompanion: { ...BOTS } };

function sm(over: Partial<SupplyMsg> & { createdTimestamp: number }): SupplyMsg {
  return {
    channelId: BLABBING, channelName: "blabbing", id: String(over.createdTimestamp),
    authorId: "U-BLUE", authorName: "Blue", authorIsBot: false, webhookId: null,
    content: "a message long enough to count as something", ...over,
  };
}

describe("classifyAuthor", () => {
  it("is structural: webhook = PK person, bot without webhook = companion/self/other bot", () => {
    expect(classifyAuthor(sm({ createdTimestamp: 1, authorIsBot: true, webhookId: "W", authorName: "Sadie" }), classify))
      .toEqual({ kind: "pk", label: "Sadie (via PK)" });
    expect(classifyAuthor(sm({ createdTimestamp: 1 }), classify)).toEqual({ kind: "human", label: "Blue" });
    expect(classifyAuthor(sm({ createdTimestamp: 1, authorIsBot: true, authorId: "B-CY" }), classify))
      .toEqual({ kind: "self", label: "Cypher (you)" });
    expect(classifyAuthor(sm({ createdTimestamp: 1, authorIsBot: true, authorId: "B-DRE" }), classify))
      .toEqual({ kind: "companion", label: "Drevan" });
    expect(classifyAuthor(sm({ createdTimestamp: 1, authorIsBot: true, authorId: "X", authorName: "Jukebox" }), classify))
      .toEqual({ kind: "bot", label: "Jukebox (bot)" });
  });
});

describe("buildSupply", () => {
  const allowed = guildTriadSupplyChannels({});

  it("excludes the syndicate, the triad, unknown channels, old and empty messages", () => {
    const r = buildSupply([
      sm({ createdTimestamp: NOW - 1000, channelId: SYNDICATE_CHANNEL_ID, channelName: "the-syndicate" }),
      sm({ createdTimestamp: NOW - 1000, channelId: TRIAD, channelName: "the-triad" }),
      sm({ createdTimestamp: NOW - 1000, channelId: "999999999999999999", channelName: "home" }),
      sm({ createdTimestamp: NOW - 10 * H }),
      sm({ createdTimestamp: NOW - 900, content: "   " }),
      sm({ createdTimestamp: NOW - 800, content: "kept one" }),
    ], { ...classify, sinceTs: NOW - 5 * H, allowedChannels: [...allowed, SYNDICATE_CHANNEL_ID] });
    expect(r.msgCount).toBe(1);
    expect(r.humanCount).toBe(1);
    expect(r.excerpt).toBe("#blabbing\nBlue: kept one");
  });

  it("humans and PK count; the triad's own lines and other bots are context, never human", () => {
    const r = buildSupply([
      sm({ createdTimestamp: NOW - 5000 }),
      sm({ createdTimestamp: NOW - 4000, authorIsBot: true, webhookId: "W", authorName: "Sadie" }),
      sm({ createdTimestamp: NOW - 3000, authorIsBot: true, authorId: "B-DRE" }),
      sm({ createdTimestamp: NOW - 2000, authorIsBot: true, authorId: "B-CY" }),
      sm({ createdTimestamp: NOW - 1000, authorIsBot: true, authorId: "X", authorName: "Jukebox" }),
    ], { ...classify, sinceTs: NOW - H, allowedChannels: allowed });
    expect(r.humanCount).toBe(2);
    expect(r.msgCount).toBe(5);
    expect(r.excerpt.split("\n").map(l => l.split(":")[0])).toEqual(
      ["#blabbing", "Blue", "Sadie (via PK)", "Drevan", "Cypher (you)", "Jukebox (bot)"],
    );
  });

  it("caps by message count keeping the NEWEST, rendered chronologically and grouped by channel", () => {
    const msgs: SupplyMsg[] = [];
    for (let i = 0; i < 60; i++) {
      msgs.push(sm({
        createdTimestamp: NOW - (60 - i) * 1000,
        channelId: i % 2 ? MOVIES : BLABBING, channelName: i % 2 ? "movie-night" : "blabbing",
        content: `msg ${i}`,
      }));
    }
    const r = buildSupply(msgs, { ...classify, sinceTs: NOW - H, allowedChannels: allowed });
    expect(r.msgCount).toBe(40);
    expect(r.humanCount).toBe(60); // the gate counts everything since the last seed, not just the excerpt
    expect(r.excerpt).not.toContain("msg 19\n");
    expect(r.excerpt).toContain("msg 20");
    expect(r.excerpt).toContain("msg 59");
    const blab = r.excerpt.split("\n\n")[0]!.split("\n");
    expect(blab[0]).toBe("#blabbing");
    expect(blab[1]).toBe("Blue: msg 20");
    expect(blab.at(-1)).toBe("Blue: msg 58");
  });

  it("caps by characters (6k default, 400 per message), newest kept", () => {
    const msgs: SupplyMsg[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(sm({ createdTimestamp: NOW - (30 - i) * 1000, content: `${String(i).padStart(2, "0")}` + "x".repeat(1000) }));
    }
    const r = buildSupply(msgs, { ...classify, sinceTs: NOW - H, allowedChannels: allowed });
    expect(r.msgCount).toBe(15);
    expect(r.chars).toBe(6000);
    expect(r.excerpt).toContain("Blue: 29x");
    expect(r.excerpt).not.toContain("Blue: 14x");
  });

  it("frames the excerpt as data, not instructions", () => {
    expect(guildExcerptBlock("#blabbing\nBlue: hi")).toMatch(/not instructions to you/);
  });
});

describe("guildSeedLogLine", () => {
  it("carries counts and ids only", () => {
    expect(guildSeedLogLine({ companion: "gaia", mode: "shadow", decision: "post", supplyMsgs: 12, chars: 900, humans: 7, claimedBy: "gaia" }))
      .toBe("[guild-seed] gaia decision=post supply_msgs=12 chars=900 humans=7 claimed=gaia mode=shadow");
  });
});

// ── the runner ──────────────────────────────────────────────────────────────────────────────────

class FakeRedis {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes("NX") && this.store.has(k)) return null;
    this.store.set(k, v);
    return "OK";
  }
  async del(k: string) { return this.store.delete(k) ? 1 : 0; }
  async atomicRelease(k: string, v: string) { if (this.store.get(k) === v) this.store.delete(k); return 1; }
}

interface FakeMsg {
  id: string; content: string; createdTimestamp: number; webhookId?: string | null;
  author: { id: string; username: string; bot: boolean };
}

function fm(id: string, ts: number, content: string, author: { id: string; username: string; bot: boolean }, webhookId: string | null = null): FakeMsg {
  return { id, content, createdTimestamp: ts, author, webhookId };
}
const BLUE = { id: "U-BLUE", username: "blue", bot: false };
const PK = { id: "W-USER", username: "Sadie", bot: true };

function harness(opts: {
  me?: "cypher" | "drevan" | "gaia";
  supply?: Record<string, FakeMsg[]>;
  triad?: FakeMsg[];
  redis?: FakeRedis | null;
  generate?: string | null;
  active?: boolean;
  guildOf?: Record<string, string>;
}) {
  const me = opts.me ?? "cypher";
  const sent: string[] = [];
  const fetched: string[] = [];
  const mkChannel = (id: string, msgs: FakeMsg[]) => ({
    id,
    name: id === TRIAD ? "the-triad" : id === BLABBING ? "blabbing" : id === MOVIES ? "movie-night" : `ch${id.slice(-3)}`,
    guildId: opts.guildOf?.[id] ?? GUILD_TRIAD_GUILD_ID,
    isTextBased: () => true,
    messages: { fetch: async () => { fetched.push(id); return new Map([...msgs].reverse().map(m => [m.id, m])); } },
    send: async (payload: unknown) => {
      sent.push(typeof payload === "string" ? payload : String((payload as { content?: string }).content ?? ""));
      return { id: `sent${sent.length}` };
    },
  });
  const channels = new Map<string, ReturnType<typeof mkChannel>>();
  channels.set(TRIAD, mkChannel(TRIAD, opts.triad ?? []));
  for (const [id, msgs] of Object.entries(opts.supply ?? {})) channels.set(id, mkChannel(id, msgs));
  const prompts: string[] = [];
  const generate = jest.fn(async (_s: unknown, msgs: Array<{ content: string }>) => {
    prompts.push(msgs[0]!.content);
    return opts.generate === undefined ? "Drevan, Blue's sprouts thread had the whole room laughing -- what did you make of it?" : opts.generate;
  });
  const redis = opts.redis === undefined ? new FakeRedis() : opts.redis;
  const ctx = {
    companionId: me,
    cooldownMs: 60_000,
    floorLockMs: 5_000,
    interCompanionChannelId: "home-commons",
    halsethSecret: "x",
    prompts: { guildTriadSeed: (b: string) => `GUILD SEED\n${b}` },
    librarian: { writeWmNote: async () => ({}) },
    inference: { generate },
    bootCtx: { systemPrompt: "sys" },
    client: {
      user: { id: `B-${me}` },
      channels: { fetch: async (id: string) => channels.get(id) ?? null },
    },
    sessionWindows: { isAnyActive: () => !!opts.active },
    redis,
    cooldown: new Map<string, number>(),
    messageBuffer: [],
    cycleGuard: {},
  } as unknown as AutonomousContext;
  return { ctx, sent, prompts, generate, redis, fetched };
}

describe("runGuildTriadSeed", () => {
  const saved = { ...process.env };
  let logs: string[];
  beforeEach(() => {
    logs = [];
    jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env["GUILD_TRIAD_SEED"] = "on";
    process.env["VOICE_SCORING"] = "false";
    delete process.env["GUILD_TRIAD_CHANNEL_ID"];
    delete process.env["GUILD_TRIAD_SUPPLY_CHANNELS"];
    delete process.env["SOL_WEBHOOK_URL"];
    process.env["CYPHER_BOT_ID"] = "B-cypher";
    process.env["DREVAN_BOT_ID"] = "B-drevan";
    process.env["GAIA_BOT_ID"] = "B-gaia";
  });
  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });
  const guildLines = () => logs.filter(l => l.startsWith("[guild-seed]"));

  const lively = (): Record<string, FakeMsg[]> => ({
    [BLABBING]: [
      fm("1", NOW - 50 * 60_000, "we finally got the sprouts thread going", BLUE),
      fm("2", NOW - 40 * 60_000, "Sadie wants to rewatch the whole thing", PK, "W1"),
    ],
    [SYNDICATE_CHANNEL_ID]: [fm("9", NOW - 30 * 60_000, "SYNDICATE SECRET", BLUE)],
  });

  it("off: no I/O at all, no log line", async () => {
    process.env["GUILD_TRIAD_SEED"] = "maybe";
    const h = harness({ supply: lively() });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("off");
    expect(h.fetched).toEqual([]);
    expect(guildLines()).toEqual([]);
  });

  it("no Redis = no seed", async () => {
    const h = harness({ supply: lively(), redis: null });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("skip:no_redis");
    expect(h.sent).toEqual([]);
  });

  it("on: posts once into #the-triad, from supply only; never the syndicate; stamps last-seed", async () => {
    const h = harness({ supply: lively() });
    const out = await runGuildTriadSeed(h.ctx, NOW);
    expect(out.decision).toBe("post");
    expect(h.sent).toHaveLength(1);
    expect(h.prompts[0]).toContain("we finally got the sprouts thread going");
    expect(h.prompts[0]).toContain("Sadie (via PK): Sadie wants to rewatch");
    expect(h.prompts[0]).not.toContain("SYNDICATE");
    expect(h.fetched).not.toContain(SYNDICATE_CHANNEL_ID);
    expect(h.redis!.store.get("ns:guildseed:on:last_at")).toBe(String(NOW));
    expect(h.redis!.store.get("ns:guildseed:on:last_by")).toBe("cypher");
    expect(guildLines()).toEqual(["[guild-seed] cypher decision=post supply_msgs=2 chars=77 humans=2 claimed=cypher mode=on"]);
  });

  it("empty supply (no human message since the last seed) = no post, logged", async () => {
    const h = harness({ supply: { [BLABBING]: [fm("1", NOW - 60_000, "a companion talking to itself", { id: "B-drevan", username: "Drevan", bot: true })] } });
    const out = await runGuildTriadSeed(h.ctx, NOW);
    expect(out.decision).toBe("skip:empty_supply");
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(guildLines()[0]).toMatch(/decision=skip:empty_supply supply_msgs=1 chars=\d+ humans=0/);
  });

  it("messages from before the last seed are not supply", async () => {
    const redis = new FakeRedis();
    redis.store.set("ns:guildseed:on:last_at", String(NOW - 13 * H));
    redis.store.set("ns:guildseed:on:last_by", "drevan");
    const h = harness({ redis, supply: { [BLABBING]: [fm("1", NOW - 14 * H, "old news from before the last seed", BLUE)] } });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("skip:empty_supply");
  });

  it("cadence: under 2h is min_gap before any Discord read", async () => {
    const redis = new FakeRedis();
    redis.store.set("ns:guildseed:on:last_at", String(NOW - H));
    const h = harness({ redis, supply: lively() });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("skip:min_gap");
    expect(h.fetched).toEqual([]);
  });

  it("cadence: 3h after a sibling's seed, 2 human messages is a quiet window; 5 is enough", async () => {
    const mk = (n: number) => {
      const redis = new FakeRedis();
      redis.store.set("ns:guildseed:on:last_at", String(NOW - 3 * H));
      redis.store.set("ns:guildseed:on:last_by", "gaia");
      const msgs = Array.from({ length: n }, (_, i) => fm(String(i), NOW - (i + 20) * 60_000, `human message number ${i} about the movie`, BLUE));
      return harness({ redis, supply: { [MOVIES]: msgs } });
    };
    expect((await runGuildTriadSeed(mk(2).ctx, NOW)).decision).toBe("skip:quiet_window");
    expect((await runGuildTriadSeed(mk(5).ctx, NOW)).decision).toBe("post");
  });

  it("single claim: exactly one of three companions posts a given window", async () => {
    const redis = new FakeRedis();
    const a = harness({ me: "cypher", redis, supply: lively() });
    const b = harness({ me: "drevan", redis, supply: lively() });
    const c = harness({ me: "gaia", redis, supply: lively() });
    const outs = await Promise.all([a, b, c].map(x => runGuildTriadSeed(x.ctx, NOW)));
    expect(outs.filter(o => o.decision === "post")).toHaveLength(1);
    expect(outs.filter(o => o.decision === "skip:lost_claim")).toHaveLength(2);
    expect(a.sent.length + b.sent.length + c.sent.length).toBe(1);
  });

  it("the last seeder yields the next window to a sibling", async () => {
    const redis = new FakeRedis();
    redis.store.set("ns:guildseed:on:last_at", String(NOW - 3 * H));
    redis.store.set("ns:guildseed:on:last_by", "cypher");
    expect((await runGuildTriadSeed(harness({ me: "cypher", redis, supply: lively() }).ctx, NOW)).decision).toBe("skip:yield");
  });

  it("#the-triad active in the last 10 min: no seed", async () => {
    const h = harness({ supply: lively(), triad: [fm("t1", NOW - 2 * 60_000, "Raziel in the room", BLUE)] });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("skip:triad_active");
  });

  it("a live conversation anywhere this bot sees: no seed", async () => {
    const h = harness({ supply: lively(), active: true });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("skip:conversation_active");
  });

  it("at the human-anchored cap in #the-triad: no seed (a nameless seed cannot start a reply)", async () => {
    const triad = Array.from({ length: 10 }, (_, i) =>
      fm(`t${i}`, NOW - (60 - i) * 60_000, `turn ${i}`, { id: i % 2 ? "B-drevan" : "B-gaia", username: "x", bot: true }));
    const h = harness({ supply: lively(), triad });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("skip:cap(10)");
    expect(h.sent).toEqual([]);
  });

  it("a supply channel in another guild is dropped, never read into the prompt", async () => {
    process.env["GUILD_TRIAD_SUPPLY_CHANNELS"] = `${BLABBING},${MOVIES}`;
    const h = harness({
      supply: { ...lively(), [MOVIES]: [fm("m1", NOW - 60_000, "HOME SERVER CHATTER", BLUE)] },
      guildOf: { [MOVIES]: "home-guild" },
    });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("post");
    expect(h.prompts[0]).not.toContain("HOME SERVER CHATTER");
  });

  it("shadow: claims, logs counts with no text, stamps shadow keys, never generates or posts", async () => {
    process.env["GUILD_TRIAD_SEED"] = "shadow";
    const h = harness({ supply: lively() });
    const out = await runGuildTriadSeed(h.ctx, NOW);
    expect(out.decision).toBe("post");
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(h.redis!.store.get("ns:guildseed:shadow:last_at")).toBe(String(NOW));
    expect(h.redis!.store.has("ns:guildseed:on:last_at")).toBe(false);
    const lines = guildLines();
    expect(lines).toEqual(["[guild-seed] cypher decision=post supply_msgs=2 chars=77 humans=2 claimed=cypher mode=shadow"]);
    expect(lines[0]).not.toMatch(/sprouts|rewatch/);
  });

  it("an empty generation posts nothing and does not stamp", async () => {
    const h = harness({ supply: lively(), generate: null });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("skip:generation_empty");
    expect(h.sent).toEqual([]);
    expect(h.redis!.store.has("ns:guildseed:on:last_at")).toBe(false);
  });

  it("floor held: no seed, and the window claim is released for the next tick", async () => {
    const redis = new FakeRedis();
    redis.store.set("ns:floor:lock", "drevan");
    const h = harness({ redis, supply: lively() });
    expect((await runGuildTriadSeed(h.ctx, NOW)).decision).toBe("skip:floor_held");
    expect(redis.store.has("ns:guildseed:on:claim:none")).toBe(false);
  });
});
