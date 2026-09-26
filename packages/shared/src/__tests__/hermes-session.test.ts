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

  it("is a UTC calendar date for daily", () => {
    expect(hermesSessionEpoch(new Date("2026-09-05T23:59:59Z"), "daily")).toBe("2026-09-05");
    expect(hermesSessionEpoch(new Date("2026-09-06T00:00:00Z"), "daily")).toBe("2026-09-06");
  });

  it("daily uses UTC, not local calendar date", () => {
    // 23:59:59.999Z is still 2026-09-05 in UTC even though many local zones would already
    // read 09-06 -- the epoch must be computed from UTC fields only.
    expect(hermesSessionEpoch(new Date("2026-09-05T23:59:59.999Z"), "daily")).toBe("2026-09-05");
  });

  describe("weekly (ISO-8601 week, UTC, Monday start)", () => {
    it("2026-01-01 (Thursday) is ISO week 2026-W01", () => {
      expect(hermesSessionEpoch(new Date("2026-01-01T00:00:00Z"), "weekly")).toBe("2026-W01");
    });

    it("2027-01-01 (Friday) falls in the PRIOR ISO week-year: 2026-W53", () => {
      expect(hermesSessionEpoch(new Date("2027-01-01T00:00:00Z"), "weekly")).toBe("2026-W53");
    });

    it("2024-12-30 (Monday) falls in the NEXT ISO week-year: 2025-W01", () => {
      expect(hermesSessionEpoch(new Date("2024-12-30T00:00:00Z"), "weekly")).toBe("2025-W01");
    });

    it("2025-01-01 (Wednesday) is also 2025-W01", () => {
      expect(hermesSessionEpoch(new Date("2025-01-01T00:00:00Z"), "weekly")).toBe("2025-W01");
    });

    it("rotates across the Monday 00:00Z boundary", () => {
      // 2026-01-04 is a Sunday, 2026-01-05 is a Monday.
      const sunday = hermesSessionEpoch(new Date("2026-01-04T23:59:00Z"), "weekly");
      const monday = hermesSessionEpoch(new Date("2026-01-05T00:00:00Z"), "weekly");
      expect(sunday).toBe("2026-W01");
      expect(monday).toBe("2026-W02");
      expect(sunday).not.toBe(monday);
    });

    it("does not rotate within the same ISO week (Monday vs. following Sunday)", () => {
      const monday = hermesSessionEpoch(new Date("2026-01-05T00:00:00Z"), "weekly");
      const sundayLater = hermesSessionEpoch(new Date("2026-01-11T23:59:00Z"), "weekly");
      expect(monday).toBe(sundayLater);
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
    const now = new Date("2026-01-01T00:00:00Z");
    const { sessionId, sessionKey } = hermesSessionIds("gaia", "chan3", now, "weekly");
    expect(sessionId).toBe("gaia:chan3:2026-W01");
    expect(sessionKey).toBe("gaia:chan3");
  });

  it("the key stays identical across a rotation while the id changes", () => {
    const before = hermesSessionIds("cypher", "chan1", new Date("2026-01-04T23:59:00Z"), "weekly");
    const after = hermesSessionIds("cypher", "chan1", new Date("2026-01-05T00:00:00Z"), "weekly");
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
