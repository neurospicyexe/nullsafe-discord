import { bootSession } from "../bot-core.js";
import { SECTION_SEP } from "../prompt-assembly.js";
import type { LibrarianClient } from "../librarian.js";

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
