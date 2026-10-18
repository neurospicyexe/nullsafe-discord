import { jest, describe, it, expect } from "@jest/globals";
import { claimPkProfile, pkProfileRepeatS, pkProfileSeenKey } from "../pk-profile-seen.js";

function fakeRedis() {
  const store = new Map<string, string>();
  const set = jest.fn(async (k: string, v: string, _ex: "EX", _s: number, _nx: "NX") => {
    if (store.has(k)) return null;
    store.set(k, v);
    return "OK";
  });
  return { set, store };
}
const base = { companion: "drevan", channelId: "c1", systemId: "szplj", member: "Kyle Barnes", sessionId: "drevan:c1:2026-W42" };

describe("pkProfileSeenKey", () => {
  it("uses systemId + normalized member and the transcript id", () => {
    expect(pkProfileSeenKey(base)).toBe("ns:pkprofile:seen:drevan:c1:szplj:kyle barnes:drevan:c1:2026-W42");
  });
  it("a rotated or bumped transcript id yields a different key", () => {
    expect(pkProfileSeenKey({ ...base, sessionId: "drevan:c1:2026-W43" })).not.toBe(pkProfileSeenKey(base));
    expect(pkProfileSeenKey({ ...base, sessionId: `${base.sessionId}:r1` })).not.toBe(pkProfileSeenKey(base));
  });
});

describe("pkProfileRepeatS", () => {
  it("defaults to 6h, accepts positive ints, rejects junk", () => {
    expect(pkProfileRepeatS({})).toBe(21600);
    expect(pkProfileRepeatS({ PK_PROFILE_REPEAT_S: "60" })).toBe(60);
    for (const v of ["0", "-5", "abc", ""]) expect(pkProfileRepeatS({ PK_PROFILE_REPEAT_S: v })).toBe(21600);
  });
});

describe("claimPkProfile", () => {
  it("injects the first time, skips the second (SET NX with TTL)", async () => {
    const r = fakeRedis();
    expect(await claimPkProfile(r, base, 100)).toBe("inject");
    expect(await claimPkProfile(r, base, 100)).toBe("skip");
    expect(r.set).toHaveBeenCalledWith(pkProfileSeenKey(base), "1", "EX", 100, "NX");
  });
  it("different member, channel or companion each inject once", async () => {
    const r = fakeRedis();
    await claimPkProfile(r, base, 100);
    expect(await claimPkProfile(r, { ...base, member: "Other" }, 100)).toBe("inject");
    expect(await claimPkProfile(r, { ...base, channelId: "c2" }, 100)).toBe("inject");
    expect(await claimPkProfile(r, { ...base, companion: "gaia" }, 100)).toBe("inject");
  });
  it("re-injects after the transcript rotates", async () => {
    const r = fakeRedis();
    await claimPkProfile(r, base, 100);
    expect(await claimPkProfile(r, { ...base, sessionId: "drevan:c1:2026-W43" }, 100)).toBe("inject");
  });
  it("fails open: no redis, or a redis error, injects", async () => {
    expect(await claimPkProfile(null, base, 100)).toBe("inject");
    const bad = { set: jest.fn(async () => { throw new Error("down"); }) };
    expect(await claimPkProfile(bad as never, base, 100)).toBe("inject");
  });
});
