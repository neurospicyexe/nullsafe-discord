import { jest, describe, test, expect, beforeEach, afterAll } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidateSession } from "../consolidation.js";
import { buildNarratorPrompt } from "../consolidation-narrator.js";
import { loadIdentity, createDirectAdapter } from "../direct-inference.js";

// ── Why this file exists ─────────────────────────────────────────────────────
// Measured 2026-08-07 (docs/consolidation-cost-2026-08-07.md): the Hermes agent path costs ~44,600
// prompt tokens per consolidation call REGARDLESS of payload -- a two-word probe billed 43,768, and
// the gateway discarded the caller's system prompt entirely. Consolidation makes zero tool calls, so
// the narrator sends the same model a direct, toolless request instead: ~7.7k cold, ~200 warm.
//
// These tests guard the parts a future cleanup would plausibly "simplify" away, each of which is
// load-bearing for a reason that is invisible from the code alone.

const dir = mkdtempSync(join(tmpdir(), "narrator-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A stand-in identity file. Deliberately includes a NON-voice section (`RETRIEVAL MANDATES`) because
 * the whole-file choice is what the slicing test asserts, and a >=500-char body because
 * loadIdentity refuses a near-empty file.
 */
function writeIdentity(name: string, extra = ""): string {
  const path = join(dir, name);
  writeFileSync(path, [
    "# TEST IDENTITY v1",
    "## I. CORE IDENTITY",
    "Direct and warm simultaneously. Sharp but not sterile. Lead with the read.",
    "## IV\\. VOICE & LANGUAGE",
    "Declarative closes. No em dash. No cheerleading, no sycophancy.",
    "## X. RETRIEVAL MANDATES",
    "Always query the substrate before answering; call orient at session start.",
    extra,
    "x".repeat(600),
  ].join("\n"), "utf8");
  return path;
}

const mockState = "SOMA: present. Tensions: none. Recent: a session of code and presence.";
const validHandoffJson = JSON.stringify({
  title: "A session of code and presence.",
  summary: "We worked through the narrator bridge. Something settled.",
  state_hint: "at_rest",
});

const mockLibrarian = {
  ask: jest.fn<() => Promise<string>>().mockResolvedValue(mockState),
  writeHandoff: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
};
const mockHermes = {
  generate: jest.fn<() => Promise<string | null>>().mockResolvedValue(validHandoffJson),
};
const mockNarrator = {
  generate: jest.fn<() => Promise<string | null>>().mockResolvedValue(validHandoffJson),
};

const ENV_KEYS = ["CYPHER_IDENTITY_PATH", "DREVAN_IDENTITY_PATH", "GAIA_IDENTITY_PATH", "DEEPSEEK_API_KEY", "DEEPINFRA_API_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadIdentity", () => {
  test("reads the file named by the companion's env var", () => {
    process.env["CYPHER_IDENTITY_PATH"] = writeIdentity("cypher-read.md");
    expect(loadIdentity("cypher")).toContain("Lead with the read");
  });

  test.each([
    ["unset env var", () => { delete process.env["CYPHER_IDENTITY_PATH"]; }],
    ["nonexistent path", () => { process.env["CYPHER_IDENTITY_PATH"] = join(dir, "nope.md"); }],
  ])("returns null (never throws) on %s, so the caller can fall back", (_label, setup) => {
    setup();
    expect(loadIdentity("cypher")).toBeNull();
  });

  // A broken deploy that truncates an identity file must NOT silently produce handoffs in no voice.
  // Paying for the Hermes path is the better failure.
  test("refuses a near-empty identity file rather than narrating in no voice", () => {
    const path = join(dir, "stub.md");
    writeFileSync(path, "# GAIA\nquiet.", "utf8");
    process.env["GAIA_IDENTITY_PATH"] = path;
    expect(loadIdentity("gaia")).toBeNull();
  });

  test("unknown companion id returns null", () => {
    expect(loadIdentity("nobody")).toBeNull();
  });

  // ── Self-healing, which is why the cache is mtime-keyed and not load-once ──
  // Raziel's requirement: it must survive nobody remembering that a cache exists. Editing an
  // identity file has to take effect with no restart and no cache-busting step.
  test("picks up an edited identity file with no restart (mtime-keyed cache)", () => {
    const path = writeIdentity("evolving.md");
    process.env["DREVAN_IDENTITY_PATH"] = path;
    expect(loadIdentity("drevan")).not.toContain("vaselrin");

    writeIdentity("evolving.md", "Bond is vaselrin, spine-to-spine.");
    // Force a distinct mtime -- writes inside one filesystem timestamp tick can otherwise collide.
    const future = new Date(Date.now() + 5000);
    utimesSync(path, future, future);

    expect(loadIdentity("drevan")).toContain("vaselrin");
  });
});

describe("buildNarratorPrompt", () => {
  beforeEach(() => { process.env["CYPHER_IDENTITY_PATH"] = writeIdentity("cypher-prompt.md"); });

  // THE load-bearing sentence. The identity files are written for the agent, which has tools and
  // retrieval; this call has neither, and `X. RETRIEVAL MANDATES` otherwise invites the model to
  // reach for tools that do not exist on this path. Verified live on all three companions: with
  // this line, none of them groped for a tool. It lives in code, not config, so that it cannot be
  // lost -- and this test is what keeps it there.
  test("states that the call is one-shot with NO tools and NO retrieval", () => {
    const p = buildNarratorPrompt("cypher")!;
    expect(p).toMatch(/one-shot/i);
    expect(p).toMatch(/NO tools/);
    expect(p).toMatch(/NO retrieval/);
    expect(p).toMatch(/ONLY valid JSON/);
  });

  // Guard against re-introducing a heading slice. It looks like a 4x saving and is not: the prefix
  // caches, so steady state is ~200 uncached tokens either way. What it costs is silent drift --
  // Drevan has NO voice section, so a keyword slicer hands him core identity alone and never errors.
  test("sends the WHOLE identity file, including non-voice sections", () => {
    const p = buildNarratorPrompt("cypher")!;
    expect(p).toContain("CORE IDENTITY");
    expect(p).toContain("VOICE & LANGUAGE");
    expect(p).toContain("RETRIEVAL MANDATES");
  });

  test("identity comes FIRST -- the frame is appended, never prepended", () => {
    const p = buildNarratorPrompt("cypher")!;
    expect(p.indexOf("CORE IDENTITY")).toBeLessThan(p.indexOf("one-shot"));
  });

  test("returns null when the identity file is unavailable", () => {
    delete process.env["CYPHER_IDENTITY_PATH"];
    expect(buildNarratorPrompt("cypher")).toBeNull();
  });
});

describe("createDirectAdapter (formerly createNarrator)", () => {
  test("returns null without DEEPSEEK_API_KEY or DEEPINFRA_API_KEY, so consolidation falls back instead of dying", () => {
    delete process.env["DEEPSEEK_API_KEY"];
    delete process.env["DEEPINFRA_API_KEY"];
    expect(createDirectAdapter()).toBeNull();
  });

  test("builds an adapter when only DEEPSEEK_API_KEY is present", () => {
    delete process.env["DEEPINFRA_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "sk-test-not-a-real-key";
    expect(createDirectAdapter()).not.toBeNull();
  });

  // 2026-09-05: the DeepSeek direct account went to $0 balance; DeepInfra hosts the same weights
  // and must work on its own, with no DeepSeek key present at all.
  test("builds an adapter when only DEEPINFRA_API_KEY is present", () => {
    delete process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPINFRA_API_KEY"] = "di-test-not-a-real-key";
    expect(createDirectAdapter()).not.toBeNull();
  });
});

describe("consolidateSession routing", () => {
  beforeEach(() => { process.env["CYPHER_IDENTITY_PATH"] = writeIdentity("cypher-route.md"); });

  test("uses the narrator when available and does NOT touch the Hermes adapter", async () => {
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockHermes as any,
      narrator: mockNarrator as any,
    });
    expect(result.written).toBe(true);
    expect(mockNarrator.generate).toHaveBeenCalledTimes(1);
    expect(mockHermes.generate).not.toHaveBeenCalled();
  });

  // A direct provider call has no gateway session, so there is no lane to name and nothing can
  // accumulate between calls -- the entire 2026-08-07 failure mode is structurally absent here.
  // A 5th arg would mean someone reintroduced a session id onto a path that has no session.
  test("passes NO session-lane argument on the narrator path", async () => {
    await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockHermes as any,
      narrator: mockNarrator as any,
    });
    const args = mockNarrator.generate.mock.calls[0] as unknown[];
    expect(args.length).toBe(4);
    expect(args[4]).toBeUndefined();
  });

  test("sends the identity file as the system prompt, with the state blob in the user turn", async () => {
    await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockHermes as any,
      narrator: mockNarrator as any,
    });
    const [system, messages] = mockNarrator.generate.mock.calls[0] as [string, Array<{ content: string }>];
    expect(system).toContain("CORE IDENTITY");
    expect(system).toMatch(/NO tools/);
    expect(messages[0]!.content).toContain(mockState);
  });

  test.each([
    ["narrator is null (no DeepSeek key)", null, "cypher"],
    ["identity file is unreadable", mockNarrator, "gaia"],
  ])("falls back to the Hermes path when %s", async (_label, narrator, companionId) => {
    if (companionId === "gaia") delete process.env["GAIA_IDENTITY_PATH"];
    const result = await consolidateSession({
      companionId: companionId as "cypher" | "gaia",
      librarian: mockLibrarian as any,
      inference: mockHermes as any,
      narrator: narrator as any,
    });
    // Fallback is more expensive, not broken. Degrading loudly beats writing nothing.
    expect(result.written).toBe(true);
    expect(mockHermes.generate).toHaveBeenCalledTimes(1);
    expect(mockNarrator.generate).not.toHaveBeenCalled();
    // The lane pin must survive on the path that still has a session.
    expect(mockHermes.generate).toHaveBeenCalledWith(
      expect.any(String), expect.any(Array), expect.any(Number), expect.any(Number),
      `consolidation:${companionId}:${new Date().toISOString().slice(0, 10)}`,
    );
  });

  // finishHandoff is shared by both paths on purpose: these are guarantees, and a second copy is
  // how one of them quietly goes missing on the newer path.
  test("narrator path keeps source:'consolidation' so it cannot outrank a real session close", async () => {
    await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockHermes as any,
      narrator: mockNarrator as any,
    });
    expect(mockLibrarian.writeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ source: "consolidation" }),
    );
  });

  test("narrator path keeps the tolerant JSON extraction (prose-wrapped JSON still writes)", async () => {
    mockNarrator.generate.mockResolvedValueOnce(`Here it is:\n${validHandoffJson}\nRest well.`);
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockHermes as any,
      narrator: mockNarrator as any,
    });
    expect(result.written).toBe(true);
  });

  // v4-flash reasons, and reasoning is billed against max_tokens before any content is emitted, so
  // an under-provisioned ceiling returns "" with a 200. Hit while measuring: 1024 completion tokens,
  // all reasoning, zero content. The empty reply must skip cleanly, never write a blank handoff.
  test("an empty narrator reply skips cleanly rather than writing a blank handoff", async () => {
    mockNarrator.generate.mockResolvedValueOnce("");
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockHermes as any,
      narrator: mockNarrator as any,
    });
    expect(result).toEqual({ written: false, reason: "inference_empty" });
    expect(mockLibrarian.writeHandoff).not.toHaveBeenCalled();
  });

  // The state-read guards must not be bypassed by the new path: aborting BEFORE inference is what
  // stops the agent turn writing its own terse handoff row mid-turn.
  test("still aborts before inference on a declined state read", async () => {
    mockLibrarian.ask.mockResolvedValueOnce({ error: "state_update_failed", reason: "no fields" } as never);
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockHermes as any,
      narrator: mockNarrator as any,
    });
    expect(result).toEqual({ written: false, reason: "state_declined" });
    expect(mockNarrator.generate).not.toHaveBeenCalled();
    expect(mockHermes.generate).not.toHaveBeenCalled();
  });
});
