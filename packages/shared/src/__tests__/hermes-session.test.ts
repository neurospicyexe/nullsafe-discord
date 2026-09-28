import { describe, it, expect } from "@jest/globals";
import { hermesRotationMode, hermesSessionEpoch, hermesSessionIds } from "../hermes-session.js";

describe("hermesRotationMode", () => {
  it("defaults to weekly when the env var is unset", () => {
    expect(hermesRotationMode({})).toBe("weekly");
  });

  it("reads daily and off", () => {
    expect(hermesRotationMode({ HERMES_SESSION_ROTATION: "daily" })).toBe("daily");
    expect(hermesRotationMode({ HERMES_SESSION_ROTATION: "off" })).toBe("off");
  });

  it("falls back to weekly (never throws) on a garbage value", () => {
    expect(hermesRotationMode({ HERMES_SESSION_ROTATION: "monthly" })).toBe("weekly");
    expect(hermesRotationMode({ HERMES_SESSION_ROTATION: "" })).toBe("weekly");
    expect(hermesRotationMode({ HERMES_SESSION_ROTATION: "WEEKLY" })).toBe("weekly");
  });
});

describe("hermesSessionEpoch", () => {
  it("is null for off (no rotation)", () => {
    expect(hermesSessionEpoch(new Date("2026-09-05T12:00:00Z"), "off")).toBeNull();
  });

  // B28 (2026-09-28): both modes roll at 04:00 America/Chicago, not 00:00 UTC (19:00 CDT, the
  // middle of Raziel's evening). 2026-09-05 is CDT (UTC-5), so 04:00 local = 09:00Z.
  it("daily is the Chicago date, rolling at 04:00 local", () => {
    expect(hermesSessionEpoch(new Date("2026-09-06T08:59:59.999Z"), "daily")).toBe("2026-09-05");
    expect(hermesSessionEpoch(new Date("2026-09-06T09:00:00Z"), "daily")).toBe("2026-09-06");
  });

  it("daily no longer rolls at UTC midnight (19:00 CDT stays in the same epoch)", () => {
    expect(hermesSessionEpoch(new Date("2026-09-05T23:59:59.999Z"), "daily")).toBe("2026-09-05");
    expect(hermesSessionEpoch(new Date("2026-09-06T00:00:00Z"), "daily")).toBe("2026-09-05");
  });

  describe("weekly (ISO-8601 week of the Chicago rotation day, Monday 04:00 start)", () => {
    // Noon UTC is 06:00-07:00 Chicago in either season: past 04:00 on the same date, so these keep
    // testing the ISO week-year edges rather than the boundary hour.
    it("2026-01-01 (Thursday) is ISO week 2026-W01", () => {
      expect(hermesSessionEpoch(new Date("2026-01-01T12:00:00Z"), "weekly")).toBe("2026-W01");
    });

    it("2027-01-01 (Friday) falls in the PRIOR ISO week-year: 2026-W53", () => {
      expect(hermesSessionEpoch(new Date("2027-01-01T12:00:00Z"), "weekly")).toBe("2026-W53");
    });

    it("2024-12-30 (Monday) falls in the NEXT ISO week-year: 2025-W01", () => {
      expect(hermesSessionEpoch(new Date("2024-12-30T12:00:00Z"), "weekly")).toBe("2025-W01");
    });

    it("2025-01-01 (Wednesday) is also 2025-W01", () => {
      expect(hermesSessionEpoch(new Date("2025-01-01T12:00:00Z"), "weekly")).toBe("2025-W01");
    });

    it("a CDT week rolls at Monday 04:00 CDT = 09:00Z, to the minute", () => {
      // 2026-09-28 is a Monday, CDT (UTC-5).
      expect(hermesSessionEpoch(new Date("2026-09-28T08:59:00Z"), "weekly")).toBe("2026-W39"); // 03:59 CDT
      expect(hermesSessionEpoch(new Date("2026-09-28T08:59:59.999Z"), "weekly")).toBe("2026-W39");
      expect(hermesSessionEpoch(new Date("2026-09-28T09:00:00Z"), "weekly")).toBe("2026-W40"); // 04:00 CDT
    });

    it("the old boundary (Sunday 19:00 CDT = Monday 00:00Z) no longer rotates", () => {
      expect(hermesSessionEpoch(new Date("2026-09-27T23:59:00Z"), "weekly")).toBe("2026-W39");
      expect(hermesSessionEpoch(new Date("2026-09-28T00:00:00Z"), "weekly")).toBe("2026-W39");
    });

    it("a CST week (after the 2026-11-01 fall-back) rolls at Monday 04:00 CST = 10:00Z", () => {
      // 2026-11-02 is the Monday after DST ends; CST is UTC-6.
      expect(hermesSessionEpoch(new Date("2026-11-02T09:00:00Z"), "weekly")).toBe("2026-W44"); // 03:00 CST
      expect(hermesSessionEpoch(new Date("2026-11-02T09:59:00Z"), "weekly")).toBe("2026-W44"); // 03:59 CST
      expect(hermesSessionEpoch(new Date("2026-11-02T10:00:00Z"), "weekly")).toBe("2026-W45"); // 04:00 CST
    });

    it("does not rotate within one rotation week (Monday 04:00 vs. next Monday 03:59)", () => {
      const start = hermesSessionEpoch(new Date("2026-10-05T09:00:00Z"), "weekly");
      const end = hermesSessionEpoch(new Date("2026-10-12T08:59:00Z"), "weekly");
      expect(start).toBe("2026-W41");
      expect(end).toBe(start);
    });

    // The honest check for "stable and monotonic across DST": sample every 15 minutes across both
    // 2026 transitions and assert the epoch changes exactly once, at the expected instant, and
    // never returns to an earlier value (the November repeated hour must not flap).
    it.each([
      ["fall-back week (2026-11-01)", "2026-10-30T00:00:00Z", "2026-11-03T12:00:00Z", "2026-11-02T10:00:00Z", "2026-W44", "2026-W45"],
      ["spring-forward week (2027-03-14)", "2027-03-12T00:00:00Z", "2027-03-16T12:00:00Z", "2027-03-15T09:00:00Z", "2027-W10", "2027-W11"],
    ])("%s: exactly one change, at Monday 04:00 local, never backwards", (_n, from, to, edge, before, after) => {
      const seen: string[] = [];
      const changes: string[] = [];
      for (let t = Date.parse(from); t <= Date.parse(to); t += 15 * 60_000) {
        const e = hermesSessionEpoch(new Date(t), "weekly")!;
        if (seen.length && seen[seen.length - 1] !== e) changes.push(new Date(t).toISOString());
        if (seen[seen.length - 1] !== e) seen.push(e);
      }
      expect(seen).toEqual([before, after]);
      expect(changes).toEqual([new Date(edge).toISOString()]);
    });

    it("daily is monotonic through the fall-back repeated hour (01:00-02:00 CDT/CST on 11-01)", () => {
      const days = new Set<string>();
      for (let t = Date.parse("2026-11-01T05:00:00Z"); t <= Date.parse("2026-11-01T09:45:00Z"); t += 15 * 60_000) {
        days.add(hermesSessionEpoch(new Date(t), "daily")!);
      }
      // 00:00 CDT through 03:45 CST: all before 04:00, all the 10-31 rotation day.
      expect([...days]).toEqual(["2026-10-31"]);
      expect(hermesSessionEpoch(new Date("2026-11-01T10:00:00Z"), "daily")).toBe("2026-11-01"); // 04:00 CST
    });
  });
});

describe("hermesSessionIds", () => {
  it("sessionKey is always companionId:channelId, independent of mode or epoch", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    for (const mode of ["off", "daily", "weekly"] as const) {
      expect(hermesSessionIds("cypher", "chan1", now, mode).sessionKey).toBe("cypher:chan1");
    }
  });

  it("off: sessionId equals the stable key (no rotation suffix)", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const { sessionId, sessionKey } = hermesSessionIds("cypher", "chan1", now, "off");
    expect(sessionId).toBe("cypher:chan1");
    expect(sessionId).toBe(sessionKey);
  });

  it("daily: sessionId is key:epoch and differs from the key", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const { sessionId, sessionKey } = hermesSessionIds("drevan", "chan2", now, "daily");
    expect(sessionId).toBe("drevan:chan2:2026-09-05");
    expect(sessionKey).toBe("drevan:chan2");
    expect(sessionId).not.toBe(sessionKey);
  });

  it("weekly: sessionId is key:epoch using the ISO week", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const { sessionId, sessionKey } = hermesSessionIds("gaia", "chan3", now, "weekly");
    expect(sessionId).toBe("gaia:chan3:2026-W01");
    expect(sessionKey).toBe("gaia:chan3");
  });

  it("the key stays identical across a rotation while the id changes", () => {
    // 2026-01-05 is a Monday in CST (UTC-6): the boundary is 10:00Z.
    const before = hermesSessionIds("cypher", "chan1", new Date("2026-01-05T09:59:00Z"), "weekly");
    const after = hermesSessionIds("cypher", "chan1", new Date("2026-01-05T10:00:00Z"), "weekly");
    expect(before.sessionKey).toBe(after.sessionKey);
    expect(before.sessionId).not.toBe(after.sessionId);
  });
});

// Rotate-on-retract (2026-09-26): a retracted reply kept echoing from the gateway transcript until
// the scheduled rotation. A per-channel bump forces a fresh transcript now; the key (LTM scope)
// must not move with it.
describe("hermesSessionIds retract bump", () => {
  const now = new Date("2026-09-26T12:00:00Z");

  it("bump = 0 (default) leaves the id exactly as before", () => {
    expect(hermesSessionIds("drevan", "chan2", now, "daily", 0).sessionId).toBe("drevan:chan2:2026-09-26");
    expect(hermesSessionIds("drevan", "chan2", now, "daily").sessionId).toBe("drevan:chan2:2026-09-26");
  });

  it("bump > 0 suffixes the id with :r<n> and leaves the key alone", () => {
    const ids = hermesSessionIds("drevan", "chan2", now, "daily", 3);
    expect(ids.sessionId).toBe("drevan:chan2:2026-09-26:r3");
    expect(ids.sessionKey).toBe("drevan:chan2");
  });

  it("applies under off too (there is no epoch to ride, so the bump is the only rotation)", () => {
    expect(hermesSessionIds("cypher", "chan1", now, "off", 1).sessionId).toBe("cypher:chan1:r1");
  });

  it("each bump is a distinct id, and a scheduled rotation still changes it further", () => {
    const a = hermesSessionIds("gaia", "chan3", now, "weekly", 1).sessionId;
    const b = hermesSessionIds("gaia", "chan3", now, "weekly", 2).sessionId;
    const c = hermesSessionIds("gaia", "chan3", new Date("2026-10-05T12:00:00Z"), "weekly", 2).sessionId;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
