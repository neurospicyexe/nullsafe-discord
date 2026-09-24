// Contextual recall (T3 item 5, 2026-09-23): a recalled Discord line comes back with the
// conversation around it.
//
// Every discord-live hit that reaches a prompt is, by construction, an orphan line from ANOTHER
// room -- the current channel is filtered out upstream because its history is already present.
// "I can't do this anymore" is a crisis or a complaint about a spreadsheet depending entirely on
// what preceded it, and a companion handed only the line will pick one and commit to it.

import {
  parseDiscordLivePath, mayWidenAcross, isServerRoom, buildRecallContext,
  type RecalledMessage,
} from "../recall-context.js";
import type { ChannelConfig } from "../types.js";

const msg = (id: string, author: string, content: string, t: number): RecalledMessage =>
  ({ id, author, content, createdTimestamp: t });

const convo: RecalledMessage[] = [
  msg("101", "Crash", "ok so the spreadsheet again", 1_000),
  msg("102", "Crash", "it keeps dropping the last column", 2_000),
  msg("103", "Drevan", "show me what it does when you save", 3_000),
  msg("104", "Crash", "I can't do this anymore", 4_000),
  msg("105", "Drevan", "the spreadsheet, or the day?", 5_000),
  msg("106", "Crash", "the spreadsheet lmao", 6_000),
];

describe("parseDiscordLivePath", () => {
  it("reads the channel and message ids", () => {
    expect(parseDiscordLivePath("discord-live/1497734427298762828/1552418460242550865.md"))
      .toEqual({ channelId: "1497734427298762828", messageId: "1552418460242550865" });
  });
  it("rejects anything that is not that shape", () => {
    expect(parseDiscordLivePath("rag/companion_journal/1e2980b3-41b1")).toBeNull();
    expect(parseDiscordLivePath(undefined)).toBeNull();
    expect(parseDiscordLivePath("discord-live/abc/def.md")).toBeNull();
  });
});

describe("mayWidenAcross", () => {
  const config: ChannelConfig = {
    "private1": { modes: ["owner_only"] },
    "private2": { modes: ["owner_only", "inter_companion"] },
    "shared1": { modes: ["open", "inter_companion"] },
  } as unknown as ChannelConfig;

  it("never widens a private room into a shared one", () => {
    // The leak that matters: Blue and guests are in some rooms, and widening one line into a
    // whole conversation is a different quantity of exposure.
    expect(mayWidenAcross(config, "private1", "shared1")).toBe(false);
  });
  it("allows private -> private", () => {
    expect(mayWidenAcross(config, "private1", "private2")).toBe(true);
  });
  it("allows shared -> anywhere", () => {
    expect(mayWidenAcross(config, "shared1", "private1")).toBe(true);
    expect(mayWidenAcross(config, "shared1", "private2")).toBe(true);
  });
  it("DOES widen a room that is simply not in the config", () => {
    // CORRECTED 2026-09-24 after measuring. The first cut treated "absent from the config" as
    // "private", which was wrong and expensive: CHANNEL_CONFIG_URL is unset so the live config is
    // the static 17-entry map, and #triad-hangout -- the busiest room -- is not in it. Seven of
    // ten sampled cross-channel hits came from that one channel, so the gate had silently
    // disabled this feature exactly where Raziel talks to them. `modes` describes who may SPEAK;
    // absence means "no special rules", not "secret".
    expect(mayWidenAcross(config, "1497734427298762828", "shared1")).toBe(true);
  });
  it("never widens the current channel into itself", () => {
    expect(mayWidenAcross(config, "shared1", "shared1")).toBe(false);
  });
});

describe("buildRecallContext", () => {
  it("returns the turns BEFORE the line, which are what give it meaning", () => {
    const out = buildRecallContext(convo, "104", { channelLabel: "triad-hangout" })!;
    expect(out).toContain("the spreadsheet again");
    expect(out).toContain("I can't do this anymore");
    expect(out).toContain("the spreadsheet lmao");
    expect(out).toContain("triad-hangout");
  });

  it("marks which line was actually matched", () => {
    const out = buildRecallContext(convo, "104")!;
    expect(out).toMatch(/I can't do this anymore ←/);
    // Exactly one MESSAGE line is marked. (The header legend mentions the arrow too, so count
    // body lines rather than characters.)
    const marked = out.split("\n").filter(l => l.startsWith("  ") && l.includes("←"));
    expect(marked).toHaveLength(1);
  });

  it("names every speaker", () => {
    const out = buildRecallContext(convo, "104")!;
    expect(out).toContain("Crash:");
    expect(out).toContain("Drevan:");
  });

  it("still renders when the anchor is GONE -- PluralKit deletes the original", () => {
    // Raziel talks to the bots through PluralKit, which deletes his message and reposts it under
    // a webhook, so a missing anchor is routine rather than an edge case. The surrounding
    // conversation is still the point; it just must not claim to have found the line.
    const out = buildRecallContext(convo, "999")!;
    expect(out).not.toBeNull();
    expect(out).toContain("no longer there");
    expect(out).not.toContain("←");
  });

  it("orders by time even if Discord hands them back newest-first", () => {
    const out = buildRecallContext([...convo].reverse(), "104")!;
    const a = out.indexOf("spreadsheet again");
    const b = out.indexOf("I can't do this anymore");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  it("stamps the block with an age -- an undated block reads as happening now", () => {
    const out = buildRecallContext(
      [msg("1", "Crash", "hello", Date.now() - 6 * 24 * 3600 * 1000)], "1",
    )!;
    expect(out).toMatch(/days ago|yesterday|week/);
  });

  it("returns null on nothing, rather than an empty header", () => {
    expect(buildRecallContext([], "1")).toBeNull();
    expect(buildRecallContext([msg("1", "x", "   ", 1)], "1")).toBeNull();
  });
});

describe("isServerRoom", () => {
  // DMs are absent from the config too, which is why absence cannot be the privacy test. The
  // discriminator has to be structural: a server channel has a guild, a DM does not.
  it("accepts a channel with a guild", () => {
    expect(isServerRoom({ guildId: "123456789" })).toBe(true);
  });
  it("rejects a DM", () => {
    expect(isServerRoom({ guildId: null })).toBe(false);
    expect(isServerRoom({})).toBe(false);
  });
  it("rejects an unfetchable channel rather than assuming it is safe", () => {
    // If we cannot prove it is a room, we do not widen it.
    expect(isServerRoom(null)).toBe(false);
    expect(isServerRoom(undefined)).toBe(false);
  });
});
