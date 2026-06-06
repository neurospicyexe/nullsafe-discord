import { composePrompt, deriveIdentityBase, SECTION_SEP } from "../prompt-assembly.js";

// Golden-master tests. These pin the EXACT system-prompt assembly that the three
// bots performed inline (bots/<name>/src/index.ts boot site ~L90-106 and SOMA-refresh
// site ~L436-439) before the logic was extracted to one shared function.
// If any string here changes, a bot's assembled identity changed — that must be deliberate.

const PREFIX = "[DISCORD CONTEXT]\n\n";
const BASE = "You are Cypher.";
const RAW = "front: steady";
const RECENT = "recent synthesis here";

describe("SECTION_SEP", () => {
  it("is the canonical block separator the bots used", () => {
    expect(SECTION_SEP).toBe("\n\n---\n\n");
  });
});

describe("composePrompt — boot site (identityCore = prefix+sharedBlock+baseIdentity)", () => {
  it("identity only (no rawPrompt, no recentContext, no sharedBlock)", () => {
    // mirrors: `${PREFIX}${""}${BASE}`
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, companionId: "cypher" });
    expect(out).toBe("[DISCORD CONTEXT]\n\nYou are Cypher.");
  });

  it("with rawPrompt appends prompt block + 'Respond only as' tail", () => {
    // mirrors: `${PREFIX}${BASE}\n\n---\n\n${RAW}\n\n---\n\nRespond only as cypher. Never use [Name]: prefixes.`
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, promptContext: RAW, companionId: "cypher" });
    expect(out).toBe(
      "[DISCORD CONTEXT]\n\nYou are Cypher.\n\n---\n\nfront: steady\n\n---\n\nRespond only as cypher. Never use [Name]: prefixes.",
    );
  });

  it("with rawPrompt AND recentContext appends recent block last", () => {
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, promptContext: RAW, companionId: "cypher", recentContext: RECENT });
    expect(out).toBe(
      "[DISCORD CONTEXT]\n\nYou are Cypher.\n\n---\n\nfront: steady\n\n---\n\nRespond only as cypher. Never use [Name]: prefixes.\n\n---\n\nrecent synthesis here",
    );
  });

  it("recentContext with NO rawPrompt appends directly to identityCore", () => {
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, companionId: "cypher", recentContext: RECENT });
    expect(out).toBe("[DISCORD CONTEXT]\n\nYou are Cypher.\n\n---\n\nrecent synthesis here");
  });

  it("with a non-empty sharedBlock the core is passed through verbatim", () => {
    // bots build sharedBlock = `${sharedCtx}\n\n---\n\n`, then identityCore = `${PREFIX}${sharedBlock}${BASE}`
    const sharedBlock = "SHARED TRUTH\n\n---\n\n";
    const out = composePrompt({ identityCore: `${PREFIX}${sharedBlock}${BASE}`, promptContext: RAW, companionId: "drevan" });
    expect(out).toBe(
      "[DISCORD CONTEXT]\n\nSHARED TRUTH\n\n---\n\nYou are Cypher.\n\n---\n\nfront: steady\n\n---\n\nRespond only as drevan. Never use [Name]: prefixes.",
    );
  });

  it("empty-string promptContext is treated as absent (falsy), matching the bots' ternary", () => {
    const out = composePrompt({ identityCore: `${PREFIX}${BASE}`, promptContext: "", companionId: "cypher" });
    expect(out).toBe("[DISCORD CONTEXT]\n\nYou are Cypher.");
  });
});

describe("deriveIdentityBase — refresh site (bootCtx.systemPrompt.split(SEP)[0])", () => {
  it("returns the first section of an assembled prompt", () => {
    const assembled = composePrompt({ identityCore: `${PREFIX}${BASE}`, promptContext: RAW, companionId: "cypher", recentContext: RECENT });
    expect(deriveIdentityBase(assembled)).toBe("[DISCORD CONTEXT]\n\nYou are Cypher.");
  });

  it("when a sharedBlock was present, the base is prefix+sharedCtx only (matches pre-refactor split behavior)", () => {
    const sharedBlock = "SHARED TRUTH\n\n---\n\n";
    const assembled = composePrompt({ identityCore: `${PREFIX}${sharedBlock}${BASE}`, promptContext: RAW, companionId: "cypher" });
    // split on SEP takes [0] = "[DISCORD CONTEXT]\n\nSHARED TRUTH" — baseIdentity is dropped, exactly as the
    // original inline code did. Pinned here so the refactor preserves this quirk rather than silently fixing it.
    expect(deriveIdentityBase(assembled)).toBe("[DISCORD CONTEXT]\n\nSHARED TRUTH");
  });
});

describe("composePrompt — refresh site reuses the same joiner", () => {
  it("identityBase + freshPromptCtx + freshRecentCtx matches the old inline newBase/systemPrompt logic", () => {
    const identityBase = "[DISCORD CONTEXT]\n\nYou are Cypher.";
    const out = composePrompt({ identityCore: identityBase, promptContext: "fresh front", companionId: "gaia", recentContext: "fresh recent" });
    expect(out).toBe(
      "[DISCORD CONTEXT]\n\nYou are Cypher.\n\n---\n\nfresh front\n\n---\n\nRespond only as gaia. Never use [Name]: prefixes.\n\n---\n\nfresh recent",
    );
  });
});
