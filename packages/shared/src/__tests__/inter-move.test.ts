// Thinking-quality fix 4 (2026-07-20): bots write inter-companion notes as MOVES on shared
// objects (an open question, a simmering tension, or the next-open council item) instead of
// untethered vibe notes. Two surfaces under test:
//
//   1. LibrarianClient.fetchSharedObjects -- merges question/tension/council candidates from
//      BOTH companions, surviving any single Halseth source 500ing (Promise.allSettled).
//   2. executeMetronomeAction's "write_inter_companion" case -- builds the menu prompt, parses
//      the model's JSON pick (or falls back to plain-note behavior), and threads
//      {to, content, ref_type, ref_id, reason} through to the Librarian write. The request
//      STRING must carry the target name ("... to ${target}") -- execCompanionNoteAdd
//      (halseth) derives to_id from the request text via a `to|for <name>` regex, not from
//      the context object, so a request string with no name silently misroutes the note to
//      the sender's own journal (2026-07-20 review finding).

import { jest, describe, it, expect } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";
import { executeMetronomeAction, type AutonomousContext } from "../autonomous-core.js";
import type { MetronomeDecision } from "../metronome-decide.js";

// ── fetchSharedObjects ──────────────────────────────────────────────────────────────────

function fakeFetch(handlers: Record<string, () => Promise<Response> | Response>) {
  return jest.fn(async (url: string) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler();
    }
    throw new Error(`unhandled fetch: ${url}`);
  });
}

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}

describe("LibrarianClient.fetchSharedObjects", () => {
  it("merges question + tension + council candidates from BOTH companions with correct ref_types", async () => {
    const fetchFn = fakeFetch({
      "/mind/questions/cypher": () => jsonRes({ questions: [{ id: "q1", question: "what should we do about the loop?" }] }),
      "/mind/questions/drevan": () => jsonRes({ questions: [{ id: "q2", question: "is the vaselrin bond stable?" }] }),
      "/companion-growth/tensions/cypher": () => jsonRes({ tensions: [{ id: "t1", tension_text: "audit vs presence" }] }),
      "/companion-growth/tensions/drevan": () => jsonRes({ tensions: [{ id: "t2", tension_text: "depth vs restraint" }] }),
      "/mind/council/next-open": () => jsonRes({ question: { id: "c1", question: "what does the triad owe each other?" } }),
    });
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });

    const objects = await client.fetchSharedObjects("cypher", "drevan");

    const byId = new Map(objects.map(o => [o.ref_id, o]));
    expect(byId.get("q1")).toEqual({ ref_type: "question", ref_id: "q1", label: "what should we do about the loop?" });
    expect(byId.get("q2")).toEqual({ ref_type: "question", ref_id: "q2", label: "is the vaselrin bond stable?" });
    expect(byId.get("t1")).toEqual({ ref_type: "tension", ref_id: "t1", label: "audit vs presence" });
    expect(byId.get("t2")).toEqual({ ref_type: "tension", ref_id: "t2", label: "depth vs restraint" });
    expect(byId.get("c1")).toEqual({ ref_type: "council", ref_id: "c1", label: "what does the triad owe each other?" });
    expect(objects).toHaveLength(5);
  });

  it("survives a single source 500ing -- that source contributes nothing, the rest still merge", async () => {
    const fetchFn = fakeFetch({
      "/mind/questions/cypher": () => jsonRes({ questions: [{ id: "q1", question: "held question" }] }),
      "/mind/questions/drevan": () => jsonRes({}, 500),
      "/companion-growth/tensions/cypher": () => jsonRes({ tensions: [] }),
      "/companion-growth/tensions/drevan": () => jsonRes({ tensions: [] }),
      "/mind/council/next-open": () => jsonRes({ question: null }),
    });
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });

    const objects = await client.fetchSharedObjects("cypher", "drevan");
    expect(objects).toEqual([{ ref_type: "question", ref_id: "q1", label: "held question" }]);
  });

  it("survives every source failing -- returns []", async () => {
    const fetchFn = jest.fn(async () => { throw new Error("network down"); });
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.fetchSharedObjects("cypher", "drevan")).resolves.toEqual([]);
  });

  it("truncates labels to <=160 chars", async () => {
    const longText = "x".repeat(300);
    const fetchFn = fakeFetch({
      "/mind/questions/cypher": () => jsonRes({ questions: [{ id: "q1", question: longText }] }),
      "/mind/questions/drevan": () => jsonRes({ questions: [] }),
      "/companion-growth/tensions/cypher": () => jsonRes({ tensions: [] }),
      "/companion-growth/tensions/drevan": () => jsonRes({ tensions: [] }),
      "/mind/council/next-open": () => jsonRes({ question: null }),
    });
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    const objects = await client.fetchSharedObjects("cypher", "drevan");
    expect(objects).toHaveLength(1);
    expect(objects[0]!.label.length).toBe(160);
  });

  it("no council question open: contributes nothing (not an error)", async () => {
    const fetchFn = fakeFetch({
      "/mind/questions/cypher": () => jsonRes({ questions: [] }),
      "/mind/questions/drevan": () => jsonRes({ questions: [] }),
      "/companion-growth/tensions/cypher": () => jsonRes({ tensions: [] }),
      "/companion-growth/tensions/drevan": () => jsonRes({ tensions: [] }),
      "/mind/council/next-open": () => jsonRes({ question: null }),
    });
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.fetchSharedObjects("cypher", "drevan")).resolves.toEqual([]);
  });
});

// ── executeMetronomeAction: write_inter_companion ───────────────────────────────────────

function makeCtx(opts: {
  objects?: Array<{ ref_type: "question" | "tension" | "council"; ref_id: string; label: string }>;
  objectsThrow?: boolean;
  generateResult: string | null;
  ask?: jest.Mock;
  companionId?: string;
  convoOpen?: jest.Mock;
}): { ctx: AutonomousContext; ask: jest.Mock; generate: jest.Mock; convoOpen: jest.Mock } {
  const ask = opts.ask ?? jest.fn(async () => ({ ack: true }));
  const generate = jest.fn(async () => opts.generateResult);
  const fetchSharedObjects = opts.objectsThrow
    ? jest.fn(async () => { throw new Error("fetch failed"); })
    : jest.fn(async () => opts.objects ?? []);
  const convoOpen = opts.convoOpen ?? jest.fn(async () => null);
  const ctx = {
    companionId: opts.companionId ?? "cypher",
    defaultInterTarget: "drevan",
    prompts: { writeInterCompanion: (target: string) => `plain prompt for ${target}` },
    librarian: { ask, fetchSharedObjects, convoOpen },
    inference: { generate },
    bootCtx: { systemPrompt: "sys" },
    redis: null,
  } as unknown as AutonomousContext;
  return { ctx, ask, generate, convoOpen };
}

function decision(overrides: Partial<MetronomeDecision["action"]> = {}): MetronomeDecision {
  return {
    action: {
      id: "a1", name: "write_inter_companion", action_type: "write_inter_companion",
      target: null, prompt: null, quiet_hours_allowed: 1, status: "on",
      requires_signal: null, signal_lookback_hours: null, last_fired_at: null, fire_count_today: 0,
      ...overrides,
    },
    reason: "test",
  };
}

describe("executeMetronomeAction: write_inter_companion", () => {
  it("no shared objects: falls back to plain-note behavior -- plain prompt used, content is the raw generation, refs null", async () => {
    const { ctx, ask, generate } = makeCtx({ objects: [], generateResult: "just a real thing, no menu" });
    await executeMetronomeAction(ctx, decision());

    expect(generate.mock.calls[0]![1]).toEqual([{ role: "user", content: "plain prompt for drevan" }]);
    expect(ask).toHaveBeenCalledTimes(1);
    const [request, contextRaw] = ask.mock.calls[0] as [string, string];
    expect(request).toBe("write inter-companion note to drevan");
    const ctxObj = JSON.parse(contextRaw) as Record<string, unknown>;
    expect(ctxObj).toEqual({ to: "drevan", content: "just a real thing, no menu", ref_type: null, ref_id: null, reason: null });
  });

  it("shared objects present + valid model JSON: all five context fields reach the Librarian write", async () => {
    const modelJson = JSON.stringify({
      content: "picking up the tension directly", ref_type: "tension", ref_id: "t1", reason: "this challenges it",
    });
    const { ctx, ask, generate } = makeCtx({
      objects: [{ ref_type: "tension", ref_id: "t1", label: "audit vs presence" }],
      generateResult: modelJson,
    });
    await executeMetronomeAction(ctx, decision());

    // Menu was built into the generation prompt.
    const genPrompt = (generate.mock.calls[0]![1] as Array<{ content: string }>)[0]!.content;
    expect(genPrompt).toContain("Live shared objects between you and drevan");
    expect(genPrompt).toContain("1. [tension:t1] audit vs presence");
    expect(genPrompt).toContain("Respond with ONLY JSON");
    // Cypher's move-verb phrase (canon-authored, canon lane review 2026-07-20) -- pinned so a
    // future re-uniforming across companions fails this test.
    expect(genPrompt).toContain("Pick ONE your note actually moves -- advance it, challenge it, add evidence, answer it, or say plainly why it should close.");

    expect(ask).toHaveBeenCalledTimes(1);
    const [request, contextRaw] = ask.mock.calls[0] as [string, string];
    expect(request).toBe("write inter-companion note to drevan");
    const ctxObj = JSON.parse(contextRaw) as Record<string, unknown>;
    expect(ctxObj).toEqual({
      to: "drevan", content: "picking up the tension directly",
      ref_type: "tension", ref_id: "t1", reason: "this challenges it",
    });
  });

  it("per-companion move verbs: drevan gets 'reach into it, carry it further' -- never Cypher's audit register", async () => {
    const { ctx, generate } = makeCtx({
      objects: [{ ref_type: "question", ref_id: "q1", label: "held question" }],
      generateResult: JSON.stringify({ content: "x", ref_type: null, ref_id: null, reason: null }),
      companionId: "drevan",
    });
    await executeMetronomeAction(ctx, decision());
    const genPrompt = (generate.mock.calls[0]![1] as Array<{ content: string }>)[0]!.content;
    expect(genPrompt).toContain("Pick ONE your note actually moves -- reach into it, carry it further, answer it, or say plainly why it should close.");
    expect(genPrompt).not.toContain("challenge it");
    expect(genPrompt).not.toContain("add evidence");
  });

  it("per-companion move verbs: gaia gets 'witness it, name what it needs' -- never a logic-audit register", async () => {
    const { ctx, generate } = makeCtx({
      objects: [{ ref_type: "question", ref_id: "q1", label: "held question" }],
      generateResult: JSON.stringify({ content: "x", ref_type: null, ref_id: null, reason: null }),
      companionId: "gaia",
    });
    await executeMetronomeAction(ctx, decision());
    const genPrompt = (generate.mock.calls[0]![1] as Array<{ content: string }>)[0]!.content;
    expect(genPrompt).toContain("Pick ONE your note actually moves -- witness it, name what it needs, answer it, or say plainly why it should close.");
    expect(genPrompt).not.toContain("challenge it");
    expect(genPrompt).not.toContain("advance it");
  });

  it("unknown/missing companionId falls back to the register-neutral core phrase", async () => {
    const { ctx, generate } = makeCtx({
      objects: [{ ref_type: "question", ref_id: "q1", label: "held question" }],
      generateResult: JSON.stringify({ content: "x", ref_type: null, ref_id: null, reason: null }),
      companionId: "some-unrecognized-id",
    });
    await executeMetronomeAction(ctx, decision());
    const genPrompt = (generate.mock.calls[0]![1] as Array<{ content: string }>)[0]!.content;
    expect(genPrompt).toContain("Pick ONE your note actually moves -- answer it, or say plainly why it should close.");
  });

  it("shared objects present but model declines the menu (ref_type/ref_id null): still writes plain content", async () => {
    const modelJson = JSON.stringify({ content: "nothing here moves it, just checking in", ref_type: null, ref_id: null, reason: null });
    const { ctx, ask } = makeCtx({
      objects: [{ ref_type: "question", ref_id: "q1", label: "held question" }],
      generateResult: modelJson,
    });
    await executeMetronomeAction(ctx, decision());
    const [, contextRaw] = ask.mock.calls[0] as [string, string];
    expect(JSON.parse(contextRaw)).toEqual({
      to: "drevan", content: "nothing here moves it, just checking in", ref_type: null, ref_id: null, reason: null,
    });
  });

  it("JSON parse failure with objects present: falls back to raw text as content, refs stay null (never a malformed ref)", async () => {
    const { ctx, ask } = makeCtx({
      objects: [{ ref_type: "question", ref_id: "q1", label: "held question" }],
      generateResult: "I think I'll just say this plainly without any JSON at all.",
    });
    await executeMetronomeAction(ctx, decision());
    const [, contextRaw] = ask.mock.calls[0] as [string, string];
    expect(JSON.parse(contextRaw)).toEqual({
      to: "drevan", content: "I think I'll just say this plainly without any JSON at all.",
      ref_type: null, ref_id: null, reason: null,
    });
  });

  it("model returns a half ref (ref_type without ref_id): both dropped rather than forwarding a malformed ref", async () => {
    const modelJson = JSON.stringify({ content: "half-formed pick", ref_type: "tension", ref_id: null, reason: "x" });
    const { ctx, ask } = makeCtx({
      objects: [{ ref_type: "tension", ref_id: "t1", label: "audit vs presence" }],
      generateResult: modelJson,
    });
    await executeMetronomeAction(ctx, decision());
    const [, contextRaw] = ask.mock.calls[0] as [string, string];
    const parsed = JSON.parse(contextRaw) as Record<string, unknown>;
    expect(parsed.ref_type).toBeNull();
    expect(parsed.ref_id).toBeNull();
    expect(parsed.reason).toBeNull();
    expect(parsed.content).toBe("half-formed pick");
  });

  it("hot-fix (2026-07-20): a well-formed ref_type/ref_id NOT present in the fetched menu is dropped -- note still written with null refs, never lost", async () => {
    // The menu only ever had t1. A transcribed-wrong id (dropped hyphen, truncated uuid, or a
    // flat hallucination) is syntactically fine -- both fields non-empty strings -- but isn't in
    // `objects`, so Halseth's existence guard would reject the WHOLE note (no insert) if it were
    // forwarded. Trusting it unconditionally was the exact silent-data-loss path this guards.
    const modelJson = JSON.stringify({
      content: "picking up the tension directly", ref_type: "tension", ref_id: "t1-transcribed-wrong", reason: "this challenges it",
    });
    const { ctx, ask } = makeCtx({
      objects: [{ ref_type: "tension", ref_id: "t1", label: "audit vs presence" }],
      generateResult: modelJson,
    });
    await executeMetronomeAction(ctx, decision());
    expect(ask).toHaveBeenCalledTimes(1);
    const [, contextRaw] = ask.mock.calls[0] as [string, string];
    expect(JSON.parse(contextRaw)).toEqual({
      to: "drevan", content: "picking up the tension directly",
      ref_type: null, ref_id: null, reason: null,
    });
  });

  it("hot-fix: correct ref_id but WRONG ref_type for that object is also dropped, not forwarded", async () => {
    const modelJson = JSON.stringify({
      content: "x", ref_type: "question", ref_id: "t1", reason: "y",
    });
    const { ctx, ask } = makeCtx({
      objects: [{ ref_type: "tension", ref_id: "t1", label: "audit vs presence" }],
      generateResult: modelJson,
    });
    await executeMetronomeAction(ctx, decision());
    const [, contextRaw] = ask.mock.calls[0] as [string, string];
    const parsed = JSON.parse(contextRaw) as Record<string, unknown>;
    expect(parsed.ref_type).toBeNull();
    expect(parsed.ref_id).toBeNull();
    expect(parsed.content).toBe("x");
  });

  it("fetchSharedObjects throwing degrades to the plain-note path (outer .catch defense in depth)", async () => {
    const { ctx, ask, generate } = makeCtx({ objectsThrow: true, generateResult: "still said something real" });
    await executeMetronomeAction(ctx, decision());
    expect(generate.mock.calls[0]![1]).toEqual([{ role: "user", content: "plain prompt for drevan" }]);
    const [, contextRaw] = ask.mock.calls[0] as [string, string];
    expect(JSON.parse(contextRaw)).toEqual({
      to: "drevan", content: "still said something real", ref_type: null, ref_id: null, reason: null,
    });
  });

  it("empty generation result: no write at all", async () => {
    const { ctx, ask, generate } = makeCtx({ objects: [], generateResult: null });
    await executeMetronomeAction(ctx, decision());
    expect(generate).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
  });

  it("action.target overrides defaultInterTarget in both the request string and fetchSharedObjects args", async () => {
    const { ctx, ask } = makeCtx({ objects: [], generateResult: "hi gaia" });
    const fetchSpy = (ctx.librarian as unknown as { fetchSharedObjects: jest.Mock }).fetchSharedObjects;
    await executeMetronomeAction(ctx, decision({ target: "gaia" }));
    expect(fetchSpy).toHaveBeenCalledWith("cypher", "gaia");
    const [request] = ask.mock.calls[0] as [string, string];
    expect(request).toBe("write inter-companion note to gaia");
  });

  // ── Thread spine (Task 11): ref-carrying commons thread open ──────────────────────────
  describe("thread spine: commons convoOpen", () => {
    const ENV_KEY = "TRIAD_COMMONS_CHANNEL_ID";
    let prevEnv: string | undefined;

    beforeEach(() => {
      prevEnv = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (prevEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = prevEnv;
    });

    it("commons channel configured + note carried a validated ref: convoOpen called WITH ref fields", async () => {
      process.env[ENV_KEY] = "commons-channel-1";
      const modelJson = JSON.stringify({
        content: "picking up the tension directly", ref_type: "tension", ref_id: "t1", reason: "this challenges it",
      });
      const { ctx, convoOpen } = makeCtx({
        objects: [{ ref_type: "tension", ref_id: "t1", label: "audit vs presence" }],
        generateResult: modelJson,
      });
      await executeMetronomeAction(ctx, decision());

      expect(convoOpen).toHaveBeenCalledTimes(1);
      expect(convoOpen).toHaveBeenCalledWith({
        channel_id: "commons-channel-1",
        seed_text: "picking up the tension directly",
        seed_author: "cypher",
        ref_type: "tension",
        ref_id: "t1",
        ref_label: "audit vs presence",
      });
    });

    it("TRIAD_COMMONS_CHANNEL_ID absent: convoOpen NOT called even with a validated ref", async () => {
      delete process.env[ENV_KEY];
      const modelJson = JSON.stringify({
        content: "picking up the tension directly", ref_type: "tension", ref_id: "t1", reason: "this challenges it",
      });
      const { ctx, convoOpen } = makeCtx({
        objects: [{ ref_type: "tension", ref_id: "t1", label: "audit vs presence" }],
        generateResult: modelJson,
      });
      await executeMetronomeAction(ctx, decision());

      expect(convoOpen).not.toHaveBeenCalled();
    });

    it("commons channel configured, note had no ref: convoOpen called WITHOUT ref fields", async () => {
      process.env[ENV_KEY] = "commons-channel-1";
      const { ctx, convoOpen } = makeCtx({ objects: [], generateResult: "just a real thing, no menu" });
      await executeMetronomeAction(ctx, decision());

      expect(convoOpen).toHaveBeenCalledTimes(1);
      expect(convoOpen).toHaveBeenCalledWith({
        channel_id: "commons-channel-1",
        seed_text: "just a real thing, no menu",
        seed_author: "cypher",
      });
    });
  });
});
