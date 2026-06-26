// Club tick pure logic: phase-advance decision, vote tally, tolerant JSON parse.

import { describe, it, expect } from "vitest";
import { decidePhaseAction, maySealDiscussion, tallyVotes, extractJson } from "../club.js";
import type { ClubRound } from "../halseth-client.js";

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-06-11T18:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

function round(
  status: string, openedDaysAgo: number,
  activatedDaysAgo: number | null = null, closedDaysAgo: number | null = null,
  discussingDaysAgo: number | null = null,
): ClubRound {
  return {
    id: "r1",
    status: status as ClubRound["status"],
    winning_recommendation_id: null,
    opened_at: ago(openedDaysAgo),
    activated_at: activatedDaysAgo === null ? null : ago(activatedDaysAgo),
    discussing_at: discussingDaysAgo === null ? null : ago(discussingDaysAgo),
    closed_at: closedDaysAgo === null ? null : ago(closedDaysAgo),
  };
}

// signature: (round, now, gatherDays, activeDays, discussDays)
describe("decidePhaseAction", () => {
  it("opens when no round exists", () => {
    expect(decidePhaseAction(null, now, 4, 6, 4)).toBe("open");
  });
  it("waits on a fresh gathering round", () => {
    expect(decidePhaseAction(round("gathering", 0.5), now, 4, 6, 4)).toBe("wait");
  });
  it("votes once gathering has aged past the window", () => {
    expect(decidePhaseAction(round("gathering", 4.1), now, 4, 6, 4)).toBe("vote");
  });
  it("resumes an interrupted voting phase", () => {
    expect(decidePhaseAction(round("voting", 5), now, 4, 6, 4)).toBe("vote");
  });
  it("waits on a fresh active round", () => {
    expect(decidePhaseAction(round("active", 7, 1), now, 4, 6, 4)).toBe("wait");
  });
  it("moves to discuss once active has aged past the window (-> discussing, not close)", () => {
    expect(decidePhaseAction(round("active", 10, 6.2), now, 4, 6, 4)).toBe("discuss");
  });
  it("waits inside a fresh discussing phase", () => {
    expect(decidePhaseAction(round("discussing", 12, 6, null, 2), now, 4, 6, 4)).toBe("wait");
  });
  it("seals once the discussing window elapses", () => {
    expect(decidePhaseAction(round("discussing", 14, 8, null, 4.2), now, 4, 6, 4)).toBe("seal");
  });
  it("opens a new round 1 day after close", () => {
    expect(decidePhaseAction(round("closed", 16, 8, 1.5), now, 4, 6, 4)).toBe("open");
  });
  it("waits when the last round closed today", () => {
    expect(decidePhaseAction(round("closed", 16, 8, 0.2), now, 4, 6, 4)).toBe("wait");
  });
});

// Grace rule: a discussing round seals on the timer, but defers while Raziel is mid-thread,
// never past the +3d hard cap.
describe("maySealDiscussion", () => {
  const r = (discussingDaysAgo: number) => round("discussing", 14, 8, null, discussingDaysAgo);
  it("seals on the timer when nobody is posting", () => {
    expect(maySealDiscussion(r(4.1), null, now, 4)).toBe(true);
  });
  it("defers while Raziel posted within the last 24h", () => {
    expect(maySealDiscussion(r(4.1), ago(0.5), now, 4)).toBe(false);
  });
  it("seals when his last post is older than 24h", () => {
    expect(maySealDiscussion(r(4.1), ago(2), now, 4)).toBe(true);
  });
  it("seals anyway past the +3d hard cap, even if he just posted", () => {
    expect(maySealDiscussion(r(7.1), ago(0.1), now, 4)).toBe(true);
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
