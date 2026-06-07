import { bootSession, refreshBotState } from "../bot-core.js";
import { SECTION_SEP } from "../prompt-assembly.js";
import type { LibrarianClient } from "../librarian.js";
import type { InferenceAdapter } from "../inference.js";
import type { BootContext } from "../types.js";

// bootSession() replaced the byte-identical per-bot boot() (cypher/drevan/gaia). These tests
// pin the two branches that the parameterization is most likely to break: the Halseth-
// unreachable fallback (must land on the cached identity, never a cold prompt) and the
// happy path (must compose prefix + base identity and hand back the SAME mutable ref the
// event-subscription orient refresh mutates in place).

const BASE_OPTS = {
  companionId: "cypher" as const,
  halsethUrl: "http://halseth.test",
  halsethSecret: "secret",
  prefix: "[DISCORD CONTEXT]\n\n",
  fallbackPrompt: "give me a moment.",
};

/** A librarian whose sessionOpen throws — simulates Halseth unreachable at boot. */
function unreachableLibrarian(): LibrarianClient {
  return {
    sessionOpen: async () => { throw new Error("ECONNREFUSED"); },
    botOrient: async () => { throw new Error("unreachable"); },
  } as unknown as LibrarianClient;
}

/** A librarian that opens a session returning the given state and a failing orient. */
function reachableLibrarian(state: Record<string, unknown>): LibrarianClient {
  return {
    sessionOpen: async () => state,
    botOrient: async () => { throw new Error("no orient"); },
  } as unknown as LibrarianClient;
}

describe("bootSession — Halseth unreachable (fallback branch)", () => {
  it("falls back to the cached identity, not a cold prompt", async () => {
    const cache = { system_prompt: "You are Cypher (cached)." };
    const { bootCtx, recentContextRef } = await bootSession({
      ...BASE_OPTS,
      identityCache: cache,
      librarian: unreachableLibrarian(),
    });
    expect(bootCtx.systemPrompt).toBe("You are Cypher (cached).");
    expect(bootCtx.sessionId).toBe("cached");
    expect(bootCtx.frontState).toBe("unknown");
    expect(bootCtx.fromCache).toBe(true);
    expect(bootCtx.companionId).toBe("cypher");
    expect(recentContextRef.value).toBe("");
  });

  it("uses the fallback prompt when the cache is also missing", async () => {
    const { bootCtx } = await bootSession({
      ...BASE_OPTS,
      identityCache: null,
      librarian: unreachableLibrarian(),
    });
    expect(bootCtx.systemPrompt).toBe("give me a moment.");
    expect(bootCtx.fromCache).toBe(true);
  });
});

describe("bootSession — happy path", () => {
  it("composes prefix + base identity + prompt_context and marks fromCache false", async () => {
    const cache = { system_prompt: "You are Cypher." };
    const { bootCtx } = await bootSession({
      ...BASE_OPTS,
      identityCache: cache,
      librarian: reachableLibrarian({ session_id: "s1", prompt_context: "front: steady", front_state: "steady" }),
    });
    expect(bootCtx.sessionId).toBe("s1");
    expect(bootCtx.frontState).toBe("steady");
    expect(bootCtx.fromCache).toBe(false);
    // prefix + baseIdentity, then SEP + promptContext + SEP + respondOnlyAs tail
    expect(bootCtx.systemPrompt.startsWith("[DISCORD CONTEXT]\n\nYou are Cypher.")).toBe(true);
    expect(bootCtx.systemPrompt).toContain(`${SECTION_SEP}front: steady${SECTION_SEP}`);
    expect(bootCtx.systemPrompt).toContain("Respond only as cypher.");
  });

  it("uses the cached identity as base when Halseth returns no prompt_context", async () => {
    const cache = { system_prompt: "You are Cypher." };
    const { bootCtx } = await bootSession({
      ...BASE_OPTS,
      identityCache: cache,
      librarian: reachableLibrarian({ session_id: "s2" }),
    });
    expect(bootCtx.systemPrompt).toBe("[DISCORD CONTEXT]\n\nYou are Cypher.");
    expect(bootCtx.fromCache).toBe(true); // no rawPrompt → fromCache true
  });

  it("returns a mutable recentContextRef (event-sub orient refresh mutates it in place)", async () => {
    const { recentContextRef } = await bootSession({
      ...BASE_OPTS,
      identityCache: null,
      librarian: reachableLibrarian({ session_id: "s3" }),
    });
    recentContextRef.value = "refreshed";
    expect(recentContextRef.value).toBe("refreshed");
  });
});

// ── refreshBotState (the lifted SOMA-refresh interval body) ─────────────────────

const ORIG_ADAPTER: InferenceAdapter = { generate: async () => "orig" };

/** Builds the live refs + a librarian stub the way main() wires them. */
function refreshHarness(librarian: Partial<LibrarianClient>, activeModelKey: string | null = null) {
  const bootCtx: BootContext = {
    companionId: "cypher", systemPrompt: "[P]\n\nBASE", sessionId: "s", frontState: "f", fromCache: false,
  };
  const adapterRef = { current: ORIG_ADAPTER };
  return {
    bootCtx,
    adapterRef,
    refs: {
      recentContextRef: { value: "seeded recent" },
      currentMoodRef: { value: null as string | null },
      lastSomaRefreshRef: { value: 0 },
      activeModelRef: { key: activeModelKey, label: "orig-label" },
    },
    opts: {
      companionId: "cypher" as const,
      librarian: librarian as unknown as LibrarianClient,
      identityBase: "[P]\n\nBASE",
      bootCtx,
      adapterRef,
      apiKeys: {} as never,
      apiUrls: {} as never,
    },
  };
}

describe("refreshBotState", () => {
  it("recomposes bootCtx.systemPrompt and updates mood/age refs from fresh state", async () => {
    const h = refreshHarness({
      getState: async () => ({ prompt_context: "front: tense", current_mood: "sharp" }),
      botOrient: async () => { throw new Error("no orient"); }, // keeps seeded recentContext
      getSetting: async () => null,
    });
    await refreshBotState({ ...h.opts, ...h.refs });
    expect(h.bootCtx.systemPrompt).toContain(`${SECTION_SEP}front: tense${SECTION_SEP}`);
    expect(h.refs.currentMoodRef.value).toBe("sharp");
    expect(h.refs.lastSomaRefreshRef.value).toBeGreaterThan(0);
    expect(h.refs.recentContextRef.value).toBe("seeded recent"); // orient failed → unchanged
  });

  it("does NOT swap the adapter when the saved model equals the active model", async () => {
    const h = refreshHarness({
      getState: async () => { throw new Error("x"); },
      botOrient: async () => { throw new Error("x"); },
      getSetting: async () => "deepseek-chat",
    }, "deepseek-chat"); // active already deepseek-chat → no switch
    await refreshBotState({ ...h.opts, ...h.refs });
    expect(h.adapterRef.current).toBe(ORIG_ADAPTER);
    expect(h.refs.activeModelRef.key).toBe("deepseek-chat");
    expect(h.refs.activeModelRef.label).toBe("orig-label");
  });

  it("hot-swaps the adapter when Halseth reports a different valid model (live model switching)", async () => {
    const h = refreshHarness({
      getState: async () => { throw new Error("x"); },
      botOrient: async () => { throw new Error("x"); },
      getSetting: async () => "deepseek-chat",
    }, "gemma-4"); // active gemma-4, Halseth says deepseek-chat → switch
    // createAdapter needs at least one usable provider credential, else it throws (caught,
    // no swap). Give it a dummy deepseek key so the swap path actually builds an adapter.
    await refreshBotState({ ...h.opts, ...h.refs, apiKeys: { deepseek: "test-key" } as never });
    expect(h.adapterRef.current).not.toBe(ORIG_ADAPTER);
    expect(h.refs.activeModelRef.key).toBe("deepseek-chat");
  });

  it("is fail-soft: rejecting librarian calls do not throw and leave refs intact", async () => {
    const h = refreshHarness({
      getState: async () => { throw new Error("down"); },
      botOrient: async () => { throw new Error("down"); },
      getSetting: async () => { throw new Error("down"); },
    });
    await expect(refreshBotState({ ...h.opts, ...h.refs })).resolves.toBeUndefined();
    expect(h.adapterRef.current).toBe(ORIG_ADAPTER);
    expect(h.refs.recentContextRef.value).toBe("seeded recent");
  });
});
