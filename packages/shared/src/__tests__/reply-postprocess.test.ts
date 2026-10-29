import { describe, it, expect } from "@jest/globals";
import { postProcessReply } from "../reply-postprocess.js";

const run = (raw: string, o: { careFollowUp?: boolean; hasSpine?: boolean } = {}) => {
  const keys: string[] = [];
  const r = postProcessReply(raw, { careFollowUp: !!o.careFollowUp, hasSpine: !!o.hasSpine, onModelToken: k => keys.push(k) });
  return { r, keys };
};

describe("postProcessReply", () => {
  it("passes plain text through untouched", () => {
    const { r, keys } = run("just a reply");
    expect(r).toEqual({ text: "just a reply", spineResolution: null, passed: false });
    expect(keys).toEqual([]);
  });
  it("strips [model:x] and reports the lowercased key", () => {
    const { r, keys } = run("ok [model: GLM-Flash ] go");
    expect(r.text).toBe("ok  go");
    expect(keys).toEqual(["glm-flash"]);
  });
  it("parses and strips [LANDS: ...] only with a spine", () => {
    const withSpine = run("done. [LANDS: shipped it]", { hasSpine: true });
    expect(withSpine.r.text).toBe("done.");
    expect(withSpine.r.spineResolution).toBe("shipped it");
    const without = run("done. [LANDS: shipped it]");
    expect(without.r.text).toBe("done. [LANDS: shipped it]");
    expect(without.r.spineResolution).toBeNull();
  });
  it("a care follower's [PASS] is held and skips the strip/parse", () => {
    const { r, keys } = run("[PASS]", { careFollowUp: true, hasSpine: true });
    expect(r.passed).toBe(true);
    expect(keys).toEqual([]);
    expect(run("[PASS]").r.passed).toBe(false);
  });
  it("N-1: the resolution comes from the text it is run on (first text vs regen text)", () => {
    const first = run("bled thi中ng [LANDS: first]", { hasSpine: true }).r;
    const regen = run("clean thing [model:x] [LANDS: second]", { hasSpine: true });
    expect(first.spineResolution).toBe("first");
    expect(regen.r.spineResolution).toBe("second");
    expect(regen.r.text).toBe("clean thing");
    expect(regen.keys).toEqual(["x"]);
    // a regen that dropped the marker must not inherit the first text's resolution
    expect(run("clean thing", { hasSpine: true }).r.spineResolution).toBeNull();
  });
  it("N-1: a regen that is [PASS] on a care follow-up is held", () => {
    expect(run("[PASS]", { careFollowUp: true }).r.passed).toBe(true);
  });
});
