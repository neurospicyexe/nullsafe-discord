import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../deepseek.js", () => ({
  prompt: vi.fn(async () => ({ content: "A neutral scout's report." })),
}));
vi.mock("../search-client.js", () => ({
  search: vi.fn(async () => [{ title: "T", url: "https://example.com/a", content: "c" }]),
}));
vi.mock("../halseth-client.js", () => ({
  postForageFind: vi.fn(async () => ({})),
  getForageFindsFor: vi.fn(async () => []),
  getOpenProjects: vi.fn(async () => []),
  getAgencyState: vi.fn(async () => ({ preferences: [], refusals: [] })),
}));
vi.mock("../makes-client.js", () => ({ getInterests: vi.fn(async () => []) }));

import { runForage, substituteInterest } from "../forage.js";
import { postForageFind } from "../halseth-client.js";
import { getInterests } from "../makes-client.js";
import { FORAGE_FINDS_PER_COMPANION } from "../config.js";

const warm = { name: "knot theory", status: "active", heat: 0.8, why: "loops that cannot undo" };

describe("substituteInterest (pure)", () => {
  it("replaces ONE slot and never adds one", () => {
    const r = substituteInterest("cypher", ["a", "b"], [warm]);
    expect(r.domains).toHaveLength(2);
    expect(r.domains).toContain("knot theory");
    expect(r.domains[0]).toBe("a");
    expect(r.interest).toBe("knot theory");
  });
  it("never substitutes for Gaia", () => {
    const r = substituteInterest("gaia", ["a", "b"], [warm]);
    expect(r.domains).toEqual(["a", "b"]);
    expect(r.interest).toBeNull();
  });
  it("ignores cold, inactive and health-shaped interests", () => {
    expect(substituteInterest("drevan", ["a"], [{ ...warm, heat: 0.49 }]).interest).toBeNull();
    expect(substituteInterest("drevan", ["a"], [{ ...warm, status: "dormant" }]).interest).toBeNull();
    expect(substituteInterest("drevan", ["a"], [{ ...warm, name: "my medication schedule" }]).interest).toBeNull();
  });
  it("picks the warmest", () => {
    const r = substituteInterest("cypher", ["a", "b"], [warm, { ...warm, name: "tide tables", heat: 0.95 }]);
    expect(r.interest).toBe("tide tables");
  });
  it("is a no-op with no interests or no slots", () => {
    expect(substituteInterest("cypher", ["a"], null).domains).toEqual(["a"]);
    expect(substituteInterest("cypher", [], [warm]).domains).toEqual([]);
  });
});

describe("runForage interest slot", () => {
  const realFetch = globalThis.fetch;
  const fermentBody = (mood: number, nn: number) => ({
    floats: [{ value: mood }, { value: mood }, { value: mood }],
    drives: [{ drive_key: "novelty_need", level: nn }],
  });
  beforeEach(() => {
    vi.mocked(postForageFind).mockClear();
    vi.mocked(getInterests).mockReset().mockResolvedValue([warm] as never);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(fermentBody(0.5, 0.4)), { status: 200 })) as never;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("keeps the total find count (substitutes, never adds)", async () => {
    const n = await runForage(new Date("2026-11-02T12:00:00Z"));
    // 3 companions x FORAGE_FINDS_PER_COMPANION slots, one result each
    expect(n).toBeLessThanOrEqual(3 * FORAGE_FINDS_PER_COMPANION);
    const domains = vi.mocked(postForageFind).mock.calls.map(c => c[0].domain);
    const byCompanion = (c: string) => vi.mocked(postForageFind).mock.calls.filter(x => x[0].companion_id === c).length;
    expect(byCompanion("cypher")).toBeLessThanOrEqual(FORAGE_FINDS_PER_COMPANION);
    expect(domains).toContain("knot theory");
    const gaiaDomains = vi.mocked(postForageFind).mock.calls.filter(x => x[0].companion_id === "gaia").map(x => x[0].domain);
    expect(gaiaDomains).not.toContain("knot theory");
  });

  it("fails soft: an interests error leaves today's behaviour", async () => {
    vi.mocked(getInterests).mockRejectedValue(new Error("interests -> 500"));
    const n = await runForage(new Date("2026-11-02T12:00:00Z"));
    expect(n).toBeGreaterThan(0);
    expect(vi.mocked(postForageFind).mock.calls.map(c => c[0].domain)).not.toContain("knot theory");
  });

  it("flat pace skips the optional interest slot", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(fermentBody(0.2, 0.1)), { status: 200 })) as never;
    await runForage(new Date("2026-11-02T12:00:00Z"));
    expect(vi.mocked(postForageFind).mock.calls.map(c => c[0].domain)).not.toContain("knot theory");
  });

  it("FORAGE_INTERESTS=off stops the substitution", async () => {
    process.env["FORAGE_INTERESTS"] = "off";
    try {
      await runForage(new Date("2026-11-02T12:00:00Z"));
      expect(getInterests).not.toHaveBeenCalled();
    } finally { delete process.env["FORAGE_INTERESTS"]; }
  });
});
