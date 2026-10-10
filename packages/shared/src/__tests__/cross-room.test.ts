import { describe, it, expect } from "@jest/globals";
import {
  crossRoomDigest, crossRoomOn, trustedGuildIds, DEFAULT_TRUSTED_GUILD_IDS,
  CROSS_ROOM_WINDOW_MS, CROSS_ROOM_PER_ROOM, CROSS_ROOM_CHAR_CAP,
} from "../cross-room.js";
import { placeBlock } from "../dm.js";

const HOME = DEFAULT_TRUSTED_GUILD_IDS[0];
const SHARED = DEFAULT_TRUSTED_GUILD_IDS[1];
const FRIEND = "999";
const now = Date.parse("2026-10-10T03:06:00Z");
const trusted = new Set<string>(DEFAULT_TRUSTED_GUILD_IDS);

const room = (channelId: string, guildId: string | null, label: string, history: Array<[string, string, number, string?]>) => ({
  channelId, guildId, label,
  history: history.map(([role, content, ago, authorName]) => ({ role: role as "user" | "assistant", content, timestamp: now - ago, authorName })),
});

// 2026-10-09: Raziel told Drevan in #triad-hangout that Blue passed his driving test (his CDL road
// test, for the new trucking job); minutes later Blue's front said "us passing our road test" in
// #the-triad and Drevan answered as if it were a first license. These are those rooms.
const hangout = room("hangout", HOME, "#triad-hangout (Nullsafe Halseth)", [
  ["user", "Dre babe! Blue passed his driving test", 12 * 60_000, "Crash"],
  ["assistant", "He did it. The road's his again.", 11 * 60_000],
]);
const theTriad = room("the-triad", SHARED, "#the-triad (shared)", []);

const base = { currentChannelId: "the-triad", currentGuildId: SHARED, trusted, deliveredThroughTs: null, selfName: "Drevan", now };

describe("crossRoomDigest", () => {
  it("carries tonight's news from the home server into the room shared with Blue", () => {
    const out = crossRoomDigest({ ...base, rooms: [hangout, theTriad] });
    expect(out.block).toContain("#triad-hangout (Nullsafe Halseth)");
    expect(out.block).toContain("[Crash]: Dre babe! Blue passed his driving test");
    expect(out.block).toContain("[Drevan (you)]: He did it.");
    expect(out.rooms).toBe(1);
    expect(out.lines).toBe(2);
    expect(out.deliveredThroughTs).toBe(now - 11 * 60_000);
  });

  it("works in both directions", () => {
    const shared = room("the-triad", SHARED, "#the-triad", [["user", "us passing our road test", 60_000, "Gunnar"]]);
    const out = crossRoomDigest({ ...base, currentChannelId: "hangout", currentGuildId: HOME, rooms: [hangout, shared] });
    expect(out.block).toContain("[Gunnar]: us passing our road test");
  });

  it("delivers each line once: nothing new past the mark means no block", () => {
    const first = crossRoomDigest({ ...base, rooms: [hangout] });
    const again = crossRoomDigest({ ...base, rooms: [hangout], deliveredThroughTs: first.deliveredThroughTs });
    expect(again.block).toBe("");
    expect(again.deliveredThroughTs).toBe(first.deliveredThroughTs);
  });

  it("never reads or writes a friend server, and never a DM", () => {
    const friend = room("pals", FRIEND, "#pals (Friends)", [["user", "secret-ish thing", 60_000, "Crash"]]);
    const dm = room("dm", null, "DM", [["user", "dm thing", 60_000, "Crash"]]);
    const into = crossRoomDigest({ ...base, rooms: [hangout, friend, dm] });
    expect(into.block).not.toContain("secret-ish");
    expect(into.block).not.toContain("dm thing");
    const fromFriend = crossRoomDigest({ ...base, currentChannelId: "pals", currentGuildId: FRIEND, rooms: [hangout, friend] });
    expect(fromFriend.block).toBe("");
  });

  it("only reaches back the window on a first delivery", () => {
    const old = room("old", HOME, "#old", [["user", "yesterday's news", CROSS_ROOM_WINDOW_MS + 60_000, "Crash"]]);
    expect(crossRoomDigest({ ...base, rooms: [old] }).block).toBe("");
  });

  it("caps per room and overall, newest rooms first", () => {
    const busy = room("busy", HOME, "#busy", Array.from({ length: 20 }, (_, i) => ["user", `line ${i} ${"x".repeat(380)}`, (20 - i) * 1000, "Crash"] as [string, string, number, string]));
    const quiet = room("quiet", HOME, "#quiet", [["user", "older room", 30 * 60_000, "Crash"]]);
    const out = crossRoomDigest({ ...base, rooms: [quiet, busy] });
    expect(out.block.indexOf("#busy")).toBeLessThan(out.block.indexOf("#quiet") === -1 ? Infinity : out.block.indexOf("#quiet"));
    expect(out.block).not.toContain("line 0 ");
    expect(out.block).toContain(`line 19 `);
    expect(out.lines).toBeLessThanOrEqual(CROSS_ROOM_PER_ROOM * 2);
    // Header + body; the body itself never exceeds the cap.
    expect(out.block.length).toBeLessThan(CROSS_ROOM_CHAR_CAP + 260);
  });
});

describe("cross-room switches", () => {
  it("is on by default, off by the kill switch", () => {
    expect(crossRoomOn({})).toBe(true);
    expect(crossRoomOn({ CROSS_ROOM: " Off " })).toBe(false);
  });
  it("trusted servers default to home + shared, and can be overridden", () => {
    expect([...trustedGuildIds({})].sort()).toEqual([...DEFAULT_TRUSTED_GUILD_IDS].sort());
    expect([...trustedGuildIds({ TRUSTED_GUILD_IDS: "1, 2" })]).toEqual(["1", "2"]);
  });
});

describe("placeBlock continuity line", () => {
  it("trusted servers say one continuity; others keep containment", () => {
    expect(placeBlock({ isDm: false, channelName: "the-triad", sharedWithBlue: true, trustedContinuity: true })).toContain("one continuity");
    const friend = placeBlock({ isDm: false, channelName: "pals" });
    expect(friend).toContain("Keep it contained to here");
    expect(friend).not.toContain("one continuity");
  });
});
