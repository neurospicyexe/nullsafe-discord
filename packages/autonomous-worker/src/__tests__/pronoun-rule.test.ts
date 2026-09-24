// Owner pronoun rule at the worker's inference chokepoint (deepseek.ts).
//
// 2026-09-24: background writers (signal-audit, reflection, reflect, synthesize, ...) all funnel
// through prompt()/promptWithScratchpad(), which is exactly why the fix lives there instead of at
// each of the ~15 call sites. These tests pin the default-on behavior and the explicit opt-out
// (lane-guard.ts / seed.ts's decideWithContext, both deterministic pick/score calls that must stay
// byte-identical).

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env["DEEPSEEK_API_KEY"] = "test-key";
const { prompt, promptWithScratchpad } = await import("../deepseek.js");
const { OWNER_PRONOUN_RULE } = await import("@nullsafe/shared");

function okReply(content: string): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { total_tokens: 10, completion_tokens_details: { reasoning_tokens: 0 } },
    }),
  } as unknown as Response;
}

function bodyOf(call: unknown[]): { messages: Array<{ role: string; content: string }> } {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe("prompt() -- owner pronoun rule default", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okReply("ok")));
  });

  it("appends the rule to an existing system message by default", async () => {
    await prompt("say hi", "You are Cypher.");
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = bodyOf(call);
    const sys = body.messages.find(m => m.role === "system")!;
    expect(sys.content).toContain("You are Cypher.");
    expect(sys.content).toContain(OWNER_PRONOUN_RULE);
  });

  it("pushes a system message containing just the rule when none was given", async () => {
    await prompt("say hi");
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = bodyOf(call);
    const sys = body.messages.find(m => m.role === "system");
    expect(sys).toBeDefined();
    expect(sys!.content).toBe(OWNER_PRONOUN_RULE);
  });

  it("omits the rule entirely when ownerPronounRule: false and no system message is given", async () => {
    await prompt("say hi", undefined, { ownerPronounRule: false });
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = bodyOf(call);
    const sys = body.messages.find(m => m.role === "system");
    expect(sys).toBeUndefined();
  });

  it("keeps the system message byte-identical when ownerPronounRule: false (lane-guard/decideWithContext contract)", async () => {
    await prompt("say hi", "COMPANION IDENTITY (excerpt): ...", { ownerPronounRule: false });
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = bodyOf(call);
    const sys = body.messages.find(m => m.role === "system")!;
    expect(sys.content).toBe("COMPANION IDENTITY (excerpt): ...");
    expect(sys.content).not.toContain(OWNER_PRONOUN_RULE);
  });
});

describe("promptWithScratchpad() -- owner pronoun rule default", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okReply("ok")));
  });

  it("appends the rule to the system message on both turns by default", async () => {
    await promptWithScratchpad("think it through", "now answer", "You are Drevan.");
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    for (const call of calls) {
      const sys = bodyOf(call).messages.find(m => m.role === "system")!;
      expect(sys.content).toContain("You are Drevan.");
      expect(sys.content).toContain(OWNER_PRONOUN_RULE);
    }
  });

  it("omits the rule when ownerPronounRule: false", async () => {
    await promptWithScratchpad("think it through", "now answer", "You are Drevan.", { ownerPronounRule: false });
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      const sys = bodyOf(call).messages.find(m => m.role === "system")!;
      expect(sys.content).toBe("You are Drevan.");
    }
  });
});
