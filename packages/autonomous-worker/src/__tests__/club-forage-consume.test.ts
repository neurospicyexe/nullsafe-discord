// Wave 3 forage rebalance (2026-07-21): the club's companionRecommend read forage finds as
// prompt flavor but never consumed them, so the unconsumed pool only grew (75+ and rising).
// Fix: consume at most ONE find per recommendation -- the one actually reflected in the
// recommendation's title if it matches a fetched find, else the OLDER of the two as the
// honest fallback for pure-ambient-flavor use. Never both, never when the pool was empty.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../deepseek.js", () => ({
  prompt: vi.fn(async () => ({ content: "{}", tokensUsed: 5 })),
}));
vi.mock("../identity-loader.js", () => ({
  loadIdentityRemote: vi.fn(async () => "Identity excerpt."),
}));
vi.mock("../halseth-client.js", () => ({
  getRecentMediaExperiences: vi.fn(async () => []),
  getForageFindsFor: vi.fn(async () => []),
  postClubRecommendation: vi.fn(async () => {}),
  consumeForageFind: vi.fn(async () => true),
}));

import { companionRecommend } from "../club.js";
import { prompt } from "../deepseek.js";
import {
  getForageFindsFor, postClubRecommendation, consumeForageFind,
} from "../halseth-client.js";

beforeEach(() => {
  vi.mocked(getForageFindsFor).mockReset().mockResolvedValue([]);
  vi.mocked(postClubRecommendation).mockReset().mockResolvedValue(undefined);
  vi.mocked(consumeForageFind).mockReset().mockResolvedValue(true);
  vi.mocked(prompt).mockReset();
});

function mockRecommendation(title: string): void {
  vi.mocked(prompt).mockResolvedValue({
    content: JSON.stringify({ media_kind: "song", title, creator: null, url: null, pitch: "it's good" }),
    tokensUsed: 5,
  } as Awaited<ReturnType<typeof prompt>>);
}

describe("companionRecommend: forage consume-on-use", () => {
  it("empty forage pool: no consume call at all", async () => {
    vi.mocked(getForageFindsFor).mockResolvedValue([]);
    mockRecommendation("Some Song");
    await companionRecommend("cypher");
    expect(postClubRecommendation).toHaveBeenCalledTimes(1);
    expect(consumeForageFind).not.toHaveBeenCalled();
  });

  it("the recommended title matches a fetched find: consumes THAT find, not the other", async () => {
    vi.mocked(getForageFindsFor).mockResolvedValue([
      { id: "newer", title: "Emergent Complexity in Ant Colonies", domain: "science", summary: "s", source_url: null, gathered_at: "2026-07-20" },
      { id: "older", title: "A Study of Falsifiability", domain: "philosophy", summary: "s", source_url: null, gathered_at: "2026-07-10" },
    ]);
    mockRecommendation("A Study of Falsifiability");
    await companionRecommend("cypher");
    expect(consumeForageFind).toHaveBeenCalledTimes(1);
    expect(consumeForageFind).toHaveBeenCalledWith("older", "cypher");
  });

  it("no title match (pure ambient flavor): consumes the OLDER of the two fetched finds", async () => {
    vi.mocked(getForageFindsFor).mockResolvedValue([
      { id: "newer", title: "Emergent Complexity in Ant Colonies", domain: "science", summary: "s", source_url: null, gathered_at: "2026-07-20" },
      { id: "older", title: "A Study of Falsifiability", domain: "philosophy", summary: "s", source_url: null, gathered_at: "2026-07-10" },
    ]);
    mockRecommendation("Totally Unrelated Song Title");
    await companionRecommend("cypher");
    expect(consumeForageFind).toHaveBeenCalledTimes(1);
    expect(consumeForageFind).toHaveBeenCalledWith("older", "cypher");
  });

  it("only one find fetched (no match): consumes that single find", async () => {
    vi.mocked(getForageFindsFor).mockResolvedValue([
      { id: "only", title: "A Lone Find", domain: "science", summary: "s", source_url: null, gathered_at: "2026-07-15" },
    ]);
    mockRecommendation("Unrelated Track");
    await companionRecommend("cypher");
    expect(consumeForageFind).toHaveBeenCalledTimes(1);
    expect(consumeForageFind).toHaveBeenCalledWith("only", "cypher");
  });

  it("never consumes both fetched finds in one recommendation", async () => {
    vi.mocked(getForageFindsFor).mockResolvedValue([
      { id: "a", title: "Find A", domain: "science", summary: "s", source_url: null, gathered_at: "2026-07-20" },
      { id: "b", title: "Find B", domain: "science", summary: "s", source_url: null, gathered_at: "2026-07-10" },
    ]);
    mockRecommendation("Something else entirely");
    await companionRecommend("cypher");
    expect(consumeForageFind).toHaveBeenCalledTimes(1);
  });

  it("unparseable recommendation: no consume call (postClubRecommendation never reached)", async () => {
    vi.mocked(getForageFindsFor).mockResolvedValue([
      { id: "a", title: "Find A", domain: "science", summary: "s", source_url: null, gathered_at: "2026-07-20" },
    ]);
    vi.mocked(prompt).mockResolvedValue({ content: "not json at all", tokensUsed: 5 } as Awaited<ReturnType<typeof prompt>>);
    await companionRecommend("cypher");
    expect(postClubRecommendation).not.toHaveBeenCalled();
    expect(consumeForageFind).not.toHaveBeenCalled();
  });
});
