// Club tick pure logic: phase-advance decision, vote tally, tolerant JSON parse.

import { describe, it, expect } from "vitest";
import { decidePhaseAction, tallyVotes, extractJson } from "../club.js";

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-06-11T18:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

function round(status: string, openedDaysAgo: number, activatedDaysAgo: number | null = null, closedDaysAgo: number | null = null) {
  return {
    id: "r1",
    status: status as "gathering" | "voting" | "active" | "closed",
    winning_recommendation_id: null,
    opened_at: ago(openedDaysAgo),
    activated_at: activatedDaysAgo === null ? null : ago(activatedDaysAgo),
    closed_at: closedDaysAgo === null ? null : ago(closedDaysAgo),
  };
}

describe("decidePhaseAction", () => {
  it("opens when no round exists", () => {
    expect(decidePhaseAction(null, now, 2, 4)).toBe("open");
  });
  it("waits on a fresh gathering round", () => {
    expect(decidePhaseAction(round("gathering", 0.5), now, 2, 4)).toBe("wait");
  });
  it("votes once gathering has aged past the window", () => {
    expect(decidePhaseAction(round("gathering", 2.1), now, 2, 4)).toBe("vote");
  });
  it("resumes an interrupted voting phase", () => {
    expect(decidePhaseAction(round("voting", 3), now, 2, 4)).toBe("vote");
  });
  it("waits on a fresh active round", () => {
    expect(decidePhaseAction(round("active", 5, 1), now, 2, 4)).toBe("wait");
  });
  it("discusses once active has aged past the window", () => {
    expect(decidePhaseAction(round("active", 7, 4.2), now, 2, 4)).toBe("discuss");
  });
  it("opens a new round 1 day after close", () => {
    expect(decidePhaseAction(round("closed", 9, 5, 1.5), now, 2, 4)).toBe("open");
  });
  it("waits when the last round closed today", () => {
    expect(decidePhaseAction(round("closed", 9, 5, 0.2), now, 2, 4)).toBe("wait");
  });
});

describe("tallyVotes", () => {
  const recs = [
    { id: "a", created_at: "2026-06-10 01:00:00" },
    { id: "b", created_at: "2026-06-10 02:00:00" },
    { id: "c", created_at: "2026-06-10 03:00:00" },
  ];
  it("picks the majority", () => {
    const votes = [
      { recommendation_id: "b" }, { recommendation_id: "b" }, { recommendation_id: "a" },
    ];
    expect(tallyVotes(votes, recs)).toBe("b");
  });
  it("breaks ties by earliest recommendation", () => {
    const votes = [{ recommendation_id: "b" }, { recommendation_id: "c" }];
    expect(tallyVotes(votes, recs)).toBe("b");
  });
  it("falls back to earliest rec when nobody voted", () => {
    expect(tallyVotes([], recs)).toBe("a");
  });
  it("returns null with no recommendations", () => {
    expect(tallyVotes([], [])).toBeNull();
  });
});

describe("extractJson", () => {
  it("parses a clean JSON object", () => {
    expect(extractJson('{"title":"X"}')).toEqual({ title: "X" });
  });
  it("pulls the object out of chatter", () => {
    expect(extractJson('Sure! Here it is:\n```json\n{"title":"X","pitch":"y"}\n```')).toEqual({ title: "X", pitch: "y" });
  });
  it("returns null on garbage", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});
