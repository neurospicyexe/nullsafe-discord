import { jest, describe, test, expect, beforeEach, afterAll } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_PRONOUN_RULE, withOwnerPronounRule } from "../pronoun-rule.js";
import { buildOneShotPrompt } from "../direct-inference.js";
import { distillSessionOnInactive, runDistillation } from "../distillation.js";

// ── Why this file exists ─────────────────────────────────────────────────────
// 2026-09-24: Drevan reported summaries/signal_audit calling Crash "she". Prod rows confirmed it
// across discord_session observations, day_distillation, and autonomous_exploration -- every
// BACKGROUND writer builds its own system prompt and none of them saw prompt-assembly.ts's
// registerTail pronoun clause, which only rides the live Discord turn. These tests pin the
// chokepoint (withOwnerPronounRule) and its two representative call sites: the one-shot judge
// path (direct-inference.ts, used by memory.ts) and the distillation orchestration (distillation.ts).

describe("withOwnerPronounRule", () => {
  test("appends the rule after existing content", () => {
    const out = withOwnerPronounRule("You are Cypher. Be terse.");
    expect(out.startsWith("You are Cypher. Be terse.")).toBe(true);
    expect(out).toContain(OWNER_PRONOUN_RULE);
  });

  test("is idempotent -- calling it twice never doubles the rule", () => {
    const once = withOwnerPronounRule("You are Cypher.");
    const twice = withOwnerPronounRule(once);
    expect(twice).toBe(once);
    expect(twice.split(OWNER_PRONOUN_RULE).length - 1).toBe(1);
  });

  test("handles an empty system string -- returns just the rule, no leading blank lines", () => {
    expect(withOwnerPronounRule("")).toBe(OWNER_PRONOUN_RULE);
  });

  test("trims trailing whitespace before appending, so the join is always exactly one blank line", () => {
    const out = withOwnerPronounRule("You are Cypher.\n\n   \n");
    expect(out).toBe(`You are Cypher.\n\n${OWNER_PRONOUN_RULE}`);
  });
});

describe("buildOneShotPrompt -- rule lands AFTER identity and task, never before", () => {
  const dir = mkdtempSync(join(tmpdir(), "pronoun-rule-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const ENV_KEYS = ["CYPHER_IDENTITY_PATH"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env["CYPHER_IDENTITY_PATH"];
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("identity present: rule appears once, after identity and after the task line", () => {
    const path = join(dir, "cypher.md");
    writeFileSync(path, ["# CYPHER IDENTITY", "Direct and warm.", "x".repeat(600)].join("\n"), "utf8");
    process.env["CYPHER_IDENTITY_PATH"] = path;

    const out = buildOneShotPrompt("cypher", "Write a memory to your future self.");
    expect(out).toContain(OWNER_PRONOUN_RULE);
    expect(out.indexOf("CYPHER IDENTITY")).toBeLessThan(out.indexOf(OWNER_PRONOUN_RULE));
    expect(out.indexOf("Write a memory to your future self.")).toBeLessThan(out.indexOf(OWNER_PRONOUN_RULE));
    expect(out.split(OWNER_PRONOUN_RULE).length - 1).toBe(1);
  });

  test("identity absent: rule still lands, after the no-tools frame and task", () => {
    const out = buildOneShotPrompt("cypher", "Write a memory to your future self.");
    expect(out).toContain(OWNER_PRONOUN_RULE);
    expect(out.indexOf("Write a memory to your future self.")).toBeLessThan(out.indexOf(OWNER_PRONOUN_RULE));
  });
});

describe("distillation.ts -- every inference.generate call carries the rule", () => {
  test("distillSessionOnInactive: synthesis + structured-extract system prompts both carry the rule", async () => {
    const stmStore = {
      get: () => [{ role: "user", content: "hey cy" }, { role: "assistant", content: "here" }],
      clear: jest.fn(),
    };
    const librarian = {
      witnessLog: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      synthesizeSession: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      updatePromptContext: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      writeWmNote: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      writeHandoff: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      ask: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    const generate = jest.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("a synthesis of the session")
      .mockResolvedValueOnce(JSON.stringify({ title: "t" }));
    const wq = { fireAndForget: (_key: string, fn: () => Promise<void>) => { void fn(); } };

    await distillSessionOnInactive(
      "chan-1", stmStore as any, librarian as any, { generate } as any, wq as any,
      { companionId: "cypher", synthesisPrompt: "Summarize as Cypher.", sessionExtractPrompt: "Extract JSON." },
    );

    expect(generate).toHaveBeenCalledTimes(2);
    const [synthSys] = generate.mock.calls[0]!;
    const [extractSys] = generate.mock.calls[1]!;
    expect(synthSys).toContain(OWNER_PRONOUN_RULE);
    expect(extractSys).toContain(OWNER_PRONOUN_RULE);
  });

  test("runDistillation: mid-session extract system prompt carries the rule", async () => {
    const history = Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, content: `msg ${i}`, authorName: "Raziel" }));
    const stmStore = { get: () => history };
    const librarian = {
      writePersonaBlocks: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      writeHumanBlocks: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      writeWmNote: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    const generate = jest.fn<() => Promise<string | null>>().mockResolvedValue(JSON.stringify({}));
    const wq = { fireAndForget: (_key: string, fn: () => Promise<void>) => { void fn(); } };

    await runDistillation(
      "chan-1", stmStore as any, librarian as any, { generate } as any, wq as any,
      "Extract persona/human blocks.", 5, "Raziel",
    );

    expect(generate).toHaveBeenCalledTimes(1);
    const [sys] = generate.mock.calls[0]!;
    expect(sys).toContain(OWNER_PRONOUN_RULE);
  });
});
