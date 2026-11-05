// Blue update channel (blue-note.ts). Fake ids and text only.
import { describe, it, expect, jest } from "@jest/globals";
import {
  blueNoteMode, noteVoiceFor, chicagoParts, containsHealthTerm, buildNoteInputs, composeBlueNote,
  runBlueNoteDay, runBlueNoteHold, runBlueNoteTick, newBlueNoteState, holdHeadsUpLine,
  PREVIEW_NOTE_PREFIX, blueDiscordIdFrom, type BlueNoteDeps, type RoomLine, type BlueRedis,
} from "../blue-note.js";

const NOW = Date.parse("2026-11-02T03:30:00Z"); // 21:30 CST on 2026-11-01
const TODAY = chicagoParts(NOW).date;

function fakeRedis(): BlueRedis & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    set: async (k, v) => (keys.has(k) ? null : (keys.set(k, v), "OK")),
    del: async (k) => { keys.delete(k); return 1; },
  };
}
const line = (content: string, over: Partial<RoomLine> = {}): RoomLine => ({
  channelId: "ch1", guildId: "g1", role: "user", authorName: "Raz", content, timestamp: NOW - 3_600_000, ...over,
});

function deps(over: Partial<BlueNoteDeps> = {}) {
  const voice = noteVoiceFor(TODAY);
  const sentBlue: string[] = [], sentOwner: string[] = [], logs: string[] = [];
  const d: BlueNoteDeps = {
    companionId: voice, ownerName: "Raz", redis: fakeRedis(), now: () => NOW, hour: () => 21,
    roomLines: () => [line("we finished the shelf today")],
    ownNotes: async () => [],
    generate: async () => "Raziel had a steady day and the evening felt soft.",
    systemPrompt: () => "SYS",
    sendToBlue: async (t) => { sentBlue.push(t); return true; },
    sendToOwner: async (t) => { sentOwner.push(t); return true; },
    holdSince: () => null, mode: () => "preview", log: (l) => logs.push(l),
    ...over,
  };
  return { d, sentBlue, sentOwner, logs, voice };
}

describe("mode + rotation", () => {
  it("defaults to preview; off variants and on are exact", () => {
    expect(blueNoteMode({})).toBe("preview");
    expect(blueNoteMode({ BLUE_NOTE: "junk" })).toBe("preview");
    expect(blueNoteMode({ BLUE_NOTE: " ON " })).toBe("on");
    expect(blueNoteMode({ BLUE_NOTE: "off" })).toBe("off");
  });
  it("rotates drevan -> cypher -> gaia on consecutive days", () => {
    const seq = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"].map(noteVoiceFor);
    expect(new Set(seq.slice(0, 3)).size).toBe(3);
    expect(seq[3]).toBe(seq[0]);
    const order = ["drevan", "cypher", "gaia"];
    expect(order.indexOf(seq[1]!)).toBe((order.indexOf(seq[0]!) + 1) % 3);
  });
  it("resolves Blue's id from the partner / blue / escalation envs", () => {
    expect(blueDiscordIdFrom({ BLUE_DISCORD_ID: "1" })).toBe("1");
    expect(blueDiscordIdFrom({ ESCALATION_DISCORD_USER_ID: "2" })).toBe("2");
    expect(blueDiscordIdFrom({})).toBeNull();
  });
});

describe("health filter", () => {
  it("flags health terms", () => {
    for (const t of ["took my meds", "20 mg", "out of spoons", "pain is bad", "bp was high", "heart rate 90", "glucose low", "a dose missed"]) {
      expect(containsHealthTerm(t)).toBe(true);
    }
    expect(containsHealthTerm("we built a shelf and watched a movie")).toBe(false);
  });
  it("drops health lines from inputs, keeps the rest", () => {
    const r = buildNoteInputs({ today: TODAY, ownerName: "Raz", roomLines: [line("took my meds late"), line("built a shelf")], notes: [
      { content: "pain flared at noon", created_at: new Date(NOW - 3_600_000).toISOString() },
      { content: "a calm afternoon", created_at: new Date(NOW - 3_600_000).toISOString() },
    ] });
    expect(r.lines).toEqual(["Raz: built a shelf"]);
    expect(r.notes).toEqual(["a calm afternoon"]);
  });
  it("never uses DM lines, other humans, or yesterday", () => {
    const r = buildNoteInputs({ today: TODAY, ownerName: "Raz", roomLines: [
      line("secret dm words", { guildId: null }),
      line("no guild prop", { guildId: undefined }),
      line("blue says hi", { authorName: "Blue" }),
      line("old news", { timestamp: NOW - 2 * 86_400_000 }),
      line("room line"),
    ], notes: [] });
    expect(r.lines).toEqual(["Raz: room line"]);
  });
  it("blocks an output that still contains a health term", async () => {
    const r = await composeBlueNote({ companionId: "drevan", ownerName: "Raz", generate: async () => "Raziel was low on spoons today.", systemPrompt: () => "S" }, { lines: [], notes: [], razielActive: true });
    expect(r).toEqual({ ok: false, reason: "health_term" });
  });
});

describe("daily note", () => {
  it("preview goes to the owner with the prefix, never to Blue", async () => {
    const { d, sentBlue, sentOwner } = deps();
    expect(await runBlueNoteDay(d, newBlueNoteState())).toBe("sent_preview");
    expect(sentBlue).toEqual([]);
    expect(sentOwner).toHaveLength(1);
    expect(sentOwner[0]!.startsWith(PREVIEW_NOTE_PREFIX)).toBe(true);
  });
  it("on goes to Blue and copies Raziel", async () => {
    const { d, sentBlue, sentOwner } = deps({ mode: () => "on" });
    expect(await runBlueNoteDay(d, newBlueNoteState())).toBe("sent_blue");
    expect(sentBlue).toHaveLength(1);
    expect(sentOwner[0]).toContain("Sent to Blue");
  });
  it("off sends nothing and composes nothing", async () => {
    const generate = jest.fn(async () => "x");
    const { d, sentBlue, sentOwner } = deps({ mode: () => "off", generate });
    const t = await runBlueNoteTick(d, newBlueNoteState());
    expect(t).toEqual({ hold: "off", day: "off" });
    expect(generate).not.toHaveBeenCalled();
    expect(sentBlue.length + sentOwner.length).toBe(0);
  });
  it("only the rotation companion sends, and only once per date", async () => {
    const redis = fakeRedis();
    const { d, voice } = deps({ redis });
    const other = (["drevan", "cypher", "gaia"] as const).find(c => c !== voice)!;
    expect(await runBlueNoteDay({ ...d, companionId: other }, newBlueNoteState())).toBe("not_my_day");
    expect(await runBlueNoteDay(d, newBlueNoteState())).toBe("sent_preview");
    expect(await runBlueNoteDay(d, newBlueNoteState())).toBe("not_claimed");
  });
  it("skips a day with no activity from Raziel, without claiming", async () => {
    const redis = fakeRedis();
    const { d } = deps({ redis, roomLines: () => [line("hi", { authorName: "Blue" })] });
    expect(await runBlueNoteDay(d, newBlueNoteState())).toBe("no_activity");
    expect(redis.keys.size).toBe(0);
  });
  it("logs a no-activity skip once per date, not every minute", async () => {
    const lines: string[] = [];
    const { d } = deps({ redis: fakeRedis(), roomLines: () => [] });
    const st = newBlueNoteState();
    const dl = { ...d, log: (l: string) => lines.push(l) };
    await runBlueNoteDay(dl, st);
    await runBlueNoteDay(dl, st);
    expect(lines.filter(l => l.includes("outcome=no_activity"))).toHaveLength(1);
  });
  it("waits for the hour and refuses without redis", async () => {
    expect(await runBlueNoteDay(deps({ hour: () => 12 }).d, newBlueNoteState())).toBe("before_hour");
    expect(await runBlueNoteDay(deps({ redis: null }).d, newBlueNoteState())).toBe("no_redis");
  });
  it("a rejected output sends nothing and logs the rejection without text", async () => {
    const { d, sentBlue, sentOwner, logs } = deps({ generate: async () => "They took their meds and rested." });
    expect(await runBlueNoteDay(d, newBlueNoteState())).toBe("rejected");
    expect(sentBlue.length + sentOwner.length).toBe(0);
    expect(logs.join("\n")).toContain("outcome=rejected");
    expect(logs.join("\n")).not.toContain("meds");
  });
  it("a failed send releases the claim for a retry", async () => {
    const redis = fakeRedis();
    const { d } = deps({ redis, sendToOwner: async () => false });
    expect(await runBlueNoteDay(d, newBlueNoteState())).toBe("send_failed");
    expect(redis.keys.size).toBe(0);
  });
});

describe("bad-night heads-up", () => {
  const since = new Date(NOW - 20 * 60_000).toISOString();
  it("fixed line, once per hold, across all three bots", async () => {
    const redis = fakeRedis();
    const a = deps({ redis, holdSince: () => since, companionId: "cypher" });
    const b = deps({ redis, holdSince: () => since, companionId: "gaia" });
    expect(await runBlueNoteHold(a.d, newBlueNoteState())).toBe("sent_preview");
    expect(await runBlueNoteHold(b.d, newBlueNoteState())).toBe("not_claimed");
    expect(await runBlueNoteHold(a.d, newBlueNoteState())).toBe("not_claimed");
    expect(a.sentOwner[0]).toContain(holdHeadsUpLine("cypher"));
    expect(holdHeadsUpLine("cypher")).toBe("Raziel's having a rough night; we're with them. (from Cypher)");
    expect(a.sentBlue).toEqual([]);
  });
  it("a new hold sends again; on goes to Blue; stale holds do not", async () => {
    const redis = fakeRedis();
    const first = deps({ redis, holdSince: () => since, mode: () => "on" });
    expect(await runBlueNoteHold(first.d, newBlueNoteState())).toBe("sent_blue");
    expect(first.sentBlue).toEqual([holdHeadsUpLine(first.d.companionId)]);
    const later = new Date(NOW - 5 * 60_000).toISOString();
    expect(await runBlueNoteHold(deps({ redis, holdSince: () => later }).d, newBlueNoteState())).toBe("sent_preview");
    const old = new Date(NOW - 9 * 3_600_000).toISOString();
    expect(await runBlueNoteHold(deps({ redis, holdSince: () => old }).d, newBlueNoteState())).toBe("stale_hold");
    expect(await runBlueNoteHold(deps({ holdSince: () => null }).d, newBlueNoteState())).toBe("no_hold");
  });
});
