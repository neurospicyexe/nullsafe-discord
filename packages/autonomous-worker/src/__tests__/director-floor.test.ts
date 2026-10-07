import { describe, it, expect } from "vitest";
import { floorSelection, isWakingHour } from "../director/floor.js";
import { emptyState } from "../director/types.js";
import type { DirectorSupplyItem } from "@nullsafe/shared";

const T = Date.parse("2026-09-03T17:00:00.000Z"); // 12:00 CDT
const item = (owner: string, id: string): DirectorSupplyItem => ({ kind: "project", id, table: "companion_projects", owner, title: id, body: "", created_at: "2026-09-01", heat: null, consumed_by: [] });
const base = { nowMs: T, silenceHours: 6, wakingStartHour: 7, wakingEndHour: 23, tzOffsetHours: -5, turnsBySpeaker7d: { cypher: 5, drevan: 40, gaia: 20 } };

describe("silence floor", () => {
  it("waking hour respects the tz offset", () => {
    expect(isWakingHour(T, 7, 23, -5)).toBe(true);
    expect(isWakingHour(Date.parse("2026-09-03T08:00:00.000Z"), 7, 23, -5)).toBe(false); // 03:00 CDT
  });
  it("invites the least-heard companion who has something, on the quietest channel", () => {
    const s = { ...emptyState("c1", new Date(T - 7 * 3600_000).toISOString()) };
    const r = floorSelection({ ...base, states: [s], supply: [item("drevan", "p1"), item("cypher", "p2")] });
    expect(r).toMatchObject({ channelId: "c1", companionId: "cypher" });
    expect(r!.offer.id).toBe("p2");
  });
  it("no supply for the quiet ones -> nobody is summoned", () => {
    const s = { ...emptyState("c1", new Date(T - 7 * 3600_000).toISOString()) };
    expect(floorSelection({ ...base, states: [s], supply: [] })).toBeNull();
  });
  it("recent bot turn -> no floor fire", () => {
    const s = { ...emptyState("c1", new Date(T - 7 * 3600_000).toISOString()), lastBotAt: new Date(T - 3600_000).toISOString() };
    expect(floorSelection({ ...base, states: [s], supply: [item("cypher", "p2")] })).toBeNull();
  });
  // 2026-10-06: the floor re-fired every 15 min because nothing it did moved its own clock. A
  // pass never posts, and a post into a room the bots no longer read (muted Midnight Voices #triad)
  // never comes back as lastBotAt -- Drevan posted 8 times in 2h, 4 on the same item.
  it("a floor invite inside the silence window -> no second fire, even with no bot turn seen", () => {
    const s = { ...emptyState("c1", new Date(T - 7 * 3600_000).toISOString()), lastInviteAt: new Date(T - 15 * 60_000).toISOString() };
    expect(floorSelection({ ...base, states: [s], supply: [item("cypher", "p2")] })).toBeNull();
  });
  it("a floor invite older than the silence window -> fires again", () => {
    const s = { ...emptyState("c1", new Date(T - 9 * 3600_000).toISOString()), lastInviteAt: new Date(T - 7 * 3600_000).toISOString() };
    expect(floorSelection({ ...base, states: [s], supply: [item("cypher", "p2")] })).toMatchObject({ companionId: "cypher" });
  });
  it("never re-offers an item this room was already handed", () => {
    const s = {
      ...emptyState("c1", new Date(T - 9 * 3600_000).toISOString()),
      lastInviteAt: new Date(T - 7 * 3600_000).toISOString(),
      offered: [{ id: "p2", kind: "project" as const, toCompanion: "cypher" as const, inviteId: "i1", usedBy: null }],
    };
    const r = floorSelection({ ...base, states: [s], supply: [item("cypher", "p2"), item("cypher", "p9")] });
    expect(r!.offer.id).toBe("p9");
    expect(floorSelection({ ...base, states: [s], supply: [item("cypher", "p2")] })).toBeNull();
  });
  it("off hours -> null", () => {
    const s = { ...emptyState("c1", new Date(T - 7 * 3600_000).toISOString()) };
    expect(floorSelection({ ...base, nowMs: Date.parse("2026-09-03T08:00:00.000Z"), states: [s], supply: [item("cypher", "p2")] })).toBeNull();
  });
  it("all owned items consumed by owner -> nobody is summoned", () => {
    const s = { ...emptyState("c1", new Date(T - 7 * 3600_000).toISOString()) };
    const supply = [
      { ...item("cypher", "p2"), consumed_by: ["cypher"] },
      { ...item("gaia", "p3"), consumed_by: ["gaia"] },
    ];
    expect(floorSelection({ ...base, states: [s], supply })).toBeNull();
  });
  it("owned items consumed by sibling -> still offered", () => {
    const s = { ...emptyState("c1", new Date(T - 7 * 3600_000).toISOString()) };
    const supply = [
      { ...item("cypher", "p2"), consumed_by: ["drevan"] },
      { ...item("gaia", "p3"), consumed_by: ["gaia"] },
    ];
    const r = floorSelection({ ...base, states: [s], supply });
    expect(r).toMatchObject({ channelId: "c1", companionId: "cypher" });
    expect(r!.offer.id).toBe("p2");
  });
});
