import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../deepseek.js", () => ({ prompt: vi.fn() }));
vi.mock("../search-client.js", () => ({ search: vi.fn(async () => []) }));
vi.mock("../lane-guard.js", () => ({ isInLane: vi.fn(async () => true) }));
vi.mock("../halseth-client.js", () => ({
  appendLog: vi.fn(async () => {}),
  getProjectLog: vi.fn(async () => []),
}));

import {
  renderRefusals, namesSomeoneInRazielsLife, coveredPieces, parseProjectPlan, parsePieceLines, PIECE_MARK,
} from "../steering.js";
import { runExplore } from "../phases/explore.js";
import { prompt } from "../deepseek.js";
import { search } from "../search-client.js";
import { appendLog, getProjectLog } from "../halseth-client.js";
import type { PipelineContext } from "../types.js";

describe("renderRefusals", () => {
  it("is empty with no refusals, so callers can concatenate unconditionally", () => {
    expect(renderRefusals([])).toBe("");
  });

  it("carries the companion's own words and reasons, framed as where the time goes", () => {
    const block = renderRefusals([{ subject_text: "spending project runs on the alula as metaphor for myself", reason: "project runs go to the world" }]);
    expect(block).toContain("spending project runs on the alula as metaphor for myself -- project runs go to the world");
    expect(block).toContain("not words you may never use");
  });
});

describe("namesSomeoneInRazielsLife", () => {
  it("catches Raziel and Blue as names", () => {
    expect(namesSomeoneInRazielsLife("Blue is away on the truck")).toBe(true);
    expect(namesSomeoneInRazielsLife("how raziel copes")).toBe(true);
    expect(namesSomeoneInRazielsLife("Raz at night")).toBe(true);
  });

  it("leaves the colour blue and unrelated words alone", () => {
    expect(namesSomeoneInRazielsLife("blue whale song structure")).toBe(false);
    expect(namesSomeoneInRazielsLife("razor wire history")).toBe(false);
    expect(namesSomeoneInRazielsLife("alula feather aerodynamics")).toBe(false);
  });
});

describe("project pieces", () => {
  it("reads earlier pieces back from project_log stamps, newest first, deduped", () => {
    const log = [
      { entry: `[worker run r3] ${PIECE_MARK} Stark ruminant antlers] journal j3: ...` },
      { entry: `[worker run r2] ${PIECE_MARK} shoulder dystocia] journal j2: ...` },
      { entry: "[worker run r1] journal j1: (before pieces existed)" },
      { entry: `[worker run r0] ${PIECE_MARK} Stark ruminant antlers] ...` },
    ];
    expect(coveredPieces(log)).toEqual(["Stark ruminant antlers", "shoulder dystocia"]);
  });

  it("parses a fenced plan and rejects an unusable one", () => {
    expect(parseProjectPlan('```json\n{"piece":"breed-clans","queries":["horse breed speciation genetics","landrace vs breed history"]}\n```'))
      .toEqual({ piece: "breed-clans", queries: ["horse breed speciation genetics", "landrace vs breed history"] });
    expect(parseProjectPlan("no json here")).toBeNull();
    expect(parseProjectPlan('{"piece":"x","queries":[]}')).toBeNull();
  });

  it("piece lines drop numbering, dupes and anyone in Raziel's life", () => {
    expect(parsePieceLines("1. form-morph genetics\n- Form-morph genetics\n* what Blue built\nshoulder dystocia in foals"))
      .toEqual(["form-morph genetics", "shoulder dystocia in foals"]);
  });
});

function ctxFor(over: Partial<PipelineContext>): PipelineContext {
  return {
    companionId: "drevan", runId: "run-1", runType: "exploration", identityText: "I am Drevan.",
    orientSummary: "", recentGrowth: [], activePatterns: [], unexaminedDreamIds: [], openLoops: [],
    pressureFlags: [], activeThreads: [], peerActivity: null, recentWmNotes: [], recentSessionNotes: [],
    recentFeelings: [], recentConclusions: [], seed: null, seedDecisionReason: null, project: null,
    projectPiece: null, standingRefusals: [], threadId: null, threadPosition: null, searchResults: [],
    explorationSummary: null, explorationEvidence: [], journalEntry: null, newPatterns: [], newMarkers: [],
    reflectionText: null, newSeeds: [], journalEntryId: null, tokensUsed: 0, artifactsCreated: 0,
    ...over,
  } as PipelineContext;
}

const seed = (id: string, content: string) => ({
  id, companion_id: "drevan", seed_type: "topic", content, priority: 9,
  used_at: "x", created_at: "x", claim_source: null, justification: null,
}) as unknown as PipelineContext["seed"];

describe("runExplore steering", () => {
  beforeEach(() => {
    vi.mocked(prompt).mockReset();
    vi.mocked(search).mockReset().mockResolvedValue([{ title: "T", url: "https://e.com/1", content: "C" }] as never);
    vi.mocked(appendLog).mockClear();
    vi.mocked(getProjectLog).mockReset().mockResolvedValue([]);
  });

  it("a project run searches a piece of the intention, never the bare title, and shows the refusal", async () => {
    vi.mocked(getProjectLog).mockResolvedValue([{ entry: `[worker run r] ${PIECE_MARK} shoulder dystocia] ...`, created_at: "x" }]);
    vi.mocked(prompt)
      .mockResolvedValueOnce({ content: '{"piece":"Stark antlers","queries":["reindeer antler growth biology","antler velvet shedding","cervid social structure"]}', tokensUsed: 1 } as never)
      .mockResolvedValue({ content: "summary", tokensUsed: 1 } as never);
    const ctx = ctxFor({
      seed: seed("project:p1", "The Winged Bastard"),
      project: { id: "p1", title: "The Winged Bastard", intention: "form-morph genetics, Starks as reindeer-form ruminants" },
      standingRefusals: [{ subject_text: "spending project runs on the alula as metaphor for myself", reason: null }],
    });
    await runExplore(ctx);
    const planPrompt = vi.mocked(prompt).mock.calls[0]![0] as string;
    expect(planPrompt).toContain("shoulder dystocia");                    // covered piece: pick another
    expect(planPrompt).toContain("alula as metaphor for myself");         // his no is in the room
    const queries = vi.mocked(search).mock.calls.map(c => c[0] as string);
    expect(queries).toEqual(["reindeer antler growth biology", "antler velvet shedding", "cervid social structure"]);
    expect(ctx.projectPiece).toBe("Stark antlers");
    const summarySystem = vi.mocked(prompt).mock.calls[1]![1] as string;
    expect(summarySystem).toContain("alula as metaphor for myself");
  });

  it("a live open loop is rewritten person-free before any search", async () => {
    vi.mocked(prompt)
      .mockResolvedValueOnce({ content: "how long-haul isolation reshapes interoception", tokensUsed: 1 } as never)
      .mockResolvedValueOnce({ content: "interoception research\nBlue on the road", tokensUsed: 1 } as never)
      .mockResolvedValue({ content: "summary", tokensUsed: 1 } as never);
    const ctx = ctxFor({ companionId: "cypher", seed: seed("live-context", "Blue is away on the truck and Raziel is anxious") });
    await runExplore(ctx);
    const queries = vi.mocked(search).mock.calls.map(c => c[0] as string);
    expect(queries[0]).toBe("how long-haul isolation reshapes interoception");
    expect(queries.some(q => /Blue|Raziel/.test(q))).toBe(false);
  });

  it("a live loop that cannot be made person-free is never searched", async () => {
    vi.mocked(prompt).mockResolvedValueOnce({ content: "NONE", tokensUsed: 1 } as never);
    const ctx = ctxFor({ companionId: "cypher", seed: seed("live-context", "Blue is away on the truck") });
    await runExplore(ctx);
    expect(vi.mocked(search)).not.toHaveBeenCalled();
    expect(ctx.explorationSummary).toBeNull();
    expect(vi.mocked(appendLog).mock.calls.some(c => c[1] === "explore:people-guard")).toBe(true);
  });
});
