import { describe, test, expect } from "vitest";
import { runSolHoardPass, solHoardEnabled, type HoardPassDeps } from "../sol-hoard.js";

function deps(over: Partial<HoardPassDeps> = {}): HoardPassDeps & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    isActive: async () => false,
    creatures: async () => [{ id: "sol1", name: "Sol", disposition: "present" }] as never,
    hoard: async () => ({ hoarded: [{ make_id: "m1", companion_id: "cypher", kind: "scad", title: "T" }], skipped: [], moment: "*Sol finds it.*", reacted_to: "m1" }),
    post: async (_u, t) => { posts.push(t); return true; },
    webhookUrl: "https://discord.com/api/webhooks/1/x",
    now: () => 0,
    ...over,
  };
}

describe("solHoardEnabled", () => {
  test("on unless off", () => {
    expect(solHoardEnabled({})).toBe(true);
    expect(solHoardEnabled({ SOL_HOARD: "off" })).toBe(false);
    expect(solHoardEnabled({ SOL_HOARD: "on" })).toBe(true);
  });
});

describe("runSolHoardPass", () => {
  test("posts Halseth's reaction verbatim", async () => {
    const d = deps();
    const line = await runSolHoardPass(d);
    expect(d.posts).toEqual(["*Sol finds it.*"]);
    expect(line).toMatch(/kept 1.*reacted to m1/);
  });
  test("waits while a human is talking: no hoard call at all", async () => {
    let called = false;
    const d = deps({ isActive: async () => true, hoard: async () => { called = true; return { moment: null }; } });
    expect(await runSolHoardPass(d)).toMatch(/waits/);
    expect(called).toBe(false);
  });
  test("no reaction: posts nothing", async () => {
    const d = deps({ hoard: async () => ({ hoarded: [{ make_id: "m1", companion_id: "drevan", kind: "writing", title: "T" }], skipped: [], moment: null }) });
    await runSolHoardPass(d);
    expect(d.posts).toEqual([]);
  });
  test("log line never carries a title", async () => {
    const d = deps({ hoard: async () => ({ hoarded: [{ make_id: "m1", companion_id: "cypher", kind: "scad", title: "SECRET" }], skipped: [{ make_id: "m2", reason: "names_a_person" }], moment: null }) });
    const line = await runSolHoardPass(d);
    expect(line).not.toContain("SECRET");
    expect(line).toContain("names_a_person");
  });
  test("webhook unset: says so, does not throw", async () => {
    const d = deps({ webhookUrl: undefined });
    expect(await runSolHoardPass(d)).toMatch(/unset/);
  });
  test("no Sol: nothing", async () => {
    const d = deps({ creatures: async () => [] as never });
    expect(await runSolHoardPass(d)).toBe("no Sol");
  });
});
