import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the IO modules before importing the unit under test.
vi.mock("../deepseek.js", () => ({
  prompt: vi.fn(async () => ({ content: "A neutral scout's report about the find." })),
}));
vi.mock("../search-client.js", () => ({
  search: vi.fn(async () => [
    { title: "Axelrod tournaments", url: "https://example.com/a", content: "Tit-for-tat won repeatedly." },
  ]),
}));
vi.mock("../halseth-client.js", () => ({
  postForageFind: vi.fn(async () => ({})),
  // runForage now excludes domains already sitting unconsumed in the pool (06-29);
  // without this export the call throws and every companion pass "fails" to 0.
  getForageFindsFor: vi.fn(async () => []),
}));

import { runForage, pickDomains, angleForRun, buildForageQuery } from "../forage.js";
import { prompt } from "../deepseek.js";
import { search } from "../search-client.js";
import { postForageFind, getForageFindsFor } from "../halseth-client.js";
import { COMPANIONS, FORAGE_FINDS_PER_COMPANION, FORAGE_ANGLES } from "../config.js";

beforeEach(() => {
  // Reset implementations too (clearAllMocks keeps mockResolvedValue overrides,
  // which leaks the dedup test's stub into later tests).
  vi.mocked(prompt).mockReset().mockResolvedValue({ content: "A neutral scout's report about the find." } as Awaited<ReturnType<typeof prompt>>);
  vi.mocked(search).mockReset().mockResolvedValue([
    { title: "Axelrod tournaments", url: "https://example.com/a", content: "Tit-for-tat won repeatedly." },
  ]);
  vi.mocked(postForageFind).mockReset().mockResolvedValue({});
  vi.mocked(getForageFindsFor).mockReset().mockResolvedValue([]);
});

describe("pickDomains", () => {
  it("returns n distinct items from the pool", () => {
    const pool = ["a", "b", "c", "d"];
    const picked = pickDomains(pool, 2);
    expect(picked).toHaveLength(2);
    expect(new Set(picked).size).toBe(2);
    picked.forEach(p => expect(pool).toContain(p));
  });

  it("caps at pool size", () => {
    expect(pickDomains(["a"], 5)).toEqual(["a"]);
  });
});

describe("runForage", () => {
  it("gathers FORAGE_FINDS_PER_COMPANION finds per companion", async () => {
    const gathered = await runForage();
    expect(gathered).toBe(COMPANIONS.length * FORAGE_FINDS_PER_COMPANION);
    expect(vi.mocked(postForageFind)).toHaveBeenCalledTimes(COMPANIONS.length * FORAGE_FINDS_PER_COMPANION);
  });

  it("uses the neutral scout system prompt -- never a companion voice", async () => {
    await runForage();
    for (const call of vi.mocked(prompt).mock.calls) {
      const system = call[1] as string;
      expect(system).toContain("neutral research scout");
      expect(system).not.toMatch(/cypher|drevan|gaia/i);
    }
  });

  it("counts deduped finds as not gathered", async () => {
    vi.mocked(postForageFind).mockResolvedValue({ deduped: true });
    const gathered = await runForage();
    expect(gathered).toBe(0);
  });

  it("one companion's failure does not stop the others", async () => {
    // First companion's searches all throw; the rest succeed.
    let calls = 0;
    vi.mocked(search).mockImplementation(async () => {
      calls++;
      if (calls <= FORAGE_FINDS_PER_COMPANION) throw new Error("tavily down");
      return [{ title: "T", url: "https://example.com/x", content: "C" }];
    });
    const gathered = await runForage();
    expect(gathered).toBe((COMPANIONS.length - 1) * FORAGE_FINDS_PER_COMPANION);
  });

  it("skips when search returns no usable results", async () => {
    vi.mocked(search).mockResolvedValue([]);
    const gathered = await runForage();
    expect(gathered).toBe(0);
    expect(vi.mocked(postForageFind)).not.toHaveBeenCalled();
  });

  it("spends from the reserved forage budget, never the explore budget", async () => {
    await runForage();
    for (const call of vi.mocked(search).mock.calls) {
      expect(call[1]).toMatchObject({ purpose: "forage" });
    }
  });
});

describe("query novelty", () => {
  it("rotates the angle day over day, so the query is never a frozen string", () => {
    const a = angleForRun(0, new Date("2026-07-09T09:00:00Z"));
    const b = angleForRun(0, new Date("2026-07-10T09:00:00Z"));
    expect(a).not.toBe(b);
    expect(FORAGE_ANGLES).toContain(a);
  });

  it("gives two domains foraged the same day different angles", () => {
    const day = new Date("2026-07-09T09:00:00Z");
    expect(angleForRun(0, day)).not.toBe(angleForRun(1, day));
  });

  it("is deterministic for a given (domain, day)", () => {
    const day = new Date("2026-07-09T09:00:00Z");
    expect(angleForRun(2, day)).toBe(angleForRun(2, day));
  });

  it("searches the domain WITH an angle, not the bare anchor topic", async () => {
    await runForage(new Date("2026-07-09T09:00:00Z"));
    const queries = vi.mocked(search).mock.calls.map(c => c[0] as string);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q).toMatch(/: .+/);
    // The regression: the query was exactly the anchor topic, forever.
    expect(queries).not.toContain("logic problems and falsifiability");
  });

  it("buildForageQuery keeps the domain readable", () => {
    expect(buildForageQuery("witnessing as active structure", "recent research"))
      .toBe("witnessing as active structure: recent research");
  });
});

describe("candidate walk (a sterile domain must not stay sterile)", () => {
  const three = [
    { title: "Already stored", url: "https://example.com/old", content: "seen before" },
    { title: "Also deduped", url: "https://example.com/dup", content: "server says dupe" },
    { title: "Genuinely new", url: "https://example.com/new", content: "fresh material" },
  ];

  it("walks past a server-deduped hit to the next candidate", async () => {
    vi.mocked(search).mockResolvedValue(three);
    vi.mocked(postForageFind)
      .mockResolvedValueOnce({ deduped: true })   // /old
      .mockResolvedValueOnce({ deduped: true })   // /dup
      .mockResolvedValue({});                     // /new -> lands
    const gathered = await runForage();
    expect(gathered).toBeGreaterThan(0);
    const urls = vi.mocked(postForageFind).mock.calls.map(c => c[0].source_url);
    expect(urls).toContain("https://example.com/new");
  });

  it("skips already-held URLs without spending a summarization call", async () => {
    vi.mocked(search).mockResolvedValue(three);
    vi.mocked(getForageFindsFor).mockResolvedValue([
      { id: "1", domain: "d", title: "t", source_url: "https://example.com/old", summary: "s" },
    ] as Awaited<ReturnType<typeof getForageFindsFor>>);
    await runForage();
    const summarized = vi.mocked(prompt).mock.calls.map(c => c[0] as string);
    expect(summarized.every(s => !s.includes("https://example.com/old"))).toBe(true);
  });

  it("returns 0 for a domain whose every candidate is deduped", async () => {
    vi.mocked(search).mockResolvedValue(three);
    vi.mocked(postForageFind).mockResolvedValue({ deduped: true });
    expect(await runForage()).toBe(0);
  });
});
