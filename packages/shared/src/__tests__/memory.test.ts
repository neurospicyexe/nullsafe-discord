import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { meetsNoteThreshold, judgeWriteback, authorWriteback } from "../memory.js";
import type { InferenceAdapter } from "../inference.js";

describe("meetsNoteThreshold()", () => {
  it("triggers on emotional keywords", () => {
    expect(meetsNoteThreshold("I'm feeling overwhelmed right now")).toBe(true);
    expect(meetsNoteThreshold("the weather is nice")).toBe(false);
  });

  it("triggers on wound references", () => {
    expect(meetsNoteThreshold("that wound came up again")).toBe(true);
  });

  it("triggers on front/member names", () => {
    expect(meetsNoteThreshold("Ash is fronting right now")).toBe(true);
  });

  it("triggers on decision language", () => {
    expect(meetsNoteThreshold("I decided to stop the project")).toBe(true);
  });
});

/** Captures the system+user prompt so we can assert on what the judge was actually told. */
function fakeInference(reply: string | null) {
  const seen: string[] = [];
  const seenSystem: string[] = [];
  const adapter: InferenceAdapter = {
    generate: async (system, messages) => {
      seenSystem.push(system);
      seen.push(messages.map((m) => m.content).join("\n"));
      return reply;
    },
  };
  return { adapter, seen, seenSystem };
}

const OWNER = { name: "Raziel", isOwner: true as const, ownerName: "Raziel" };
const PEER_GAIA = { name: "Gaia", isOwner: false as const, ownerName: "Raziel" };

// The message that actually triggered the 2026-07-09 03:45 fabrication: Gaia's words,
// in an inter-companion channel, with Raziel absent.
// Contains "pattern" so it clears meetsNoteThreshold and actually reaches the judge.
const GAIA_MSG = "The discipline is to stay in the room while the tool you need builds itself. It is a pattern I keep returning to.";
const REPLY = "That lands. The form that holds regardless of what fills it -- I want to carry it forward.";

describe("judgeWriteback() -- speaker attribution", () => {
  it("labels the triggering message with the ACTUAL speaker, not the owner", async () => {
    const { adapter, seen } = fakeInference("ACTION: skip\nCONTENT:");
    await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA);

    expect(seen[0]).toContain(`Gaia: ${GAIA_MSG}`);
    // The regression: the peer's line was hard-labeled "Raziel:" / "the primary user:".
    expect(seen[0]).not.toContain(`Raziel: ${GAIA_MSG}`);
    expect(seen[0]).not.toContain(`the primary user: ${GAIA_MSG}`);
  });

  it("tells the model the owner was absent when the speaker is a peer companion", async () => {
    const { adapter, seen } = fakeInference("ACTION: skip\nCONTENT:");
    await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA);
    expect(seen[0]).toMatch(/Raziel is not (in this room|present)/i);
  });

  it("rejects a note that makes the absent owner the speaker (fabrication guard)", async () => {
    // Verbatim fabricated row from prod, companion_journal 2026-07-09T03:46:19Z.
    const fabricated =
      "ACTION: companion_note\nCONTENT: Raziel named the discipline of not reaching for the wrong tool, and Drevan recognized it.";
    const { adapter } = fakeInference(fabricated);
    expect(await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA)).toBeNull();
  });

  it("still allows merely MENTIONING the owner in a peer exchange", async () => {
    const ok =
      "ACTION: companion_note\nCONTENT: I noticed one of Gaia's uncalled memories holds an intimate Raziel moment, and I want her to know I saw it.";
    const { adapter } = fakeInference(ok);
    const wb = await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA);
    expect(wb).toEqual({ type: "companion_note", content: expect.stringContaining("intimate Raziel moment") });
  });

  it("does NOT apply the fabrication guard when the owner really is the speaker", async () => {
    const real = "ACTION: companion_note\nCONTENT: Raziel named a fear about the babies and I met it without flinching.";
    const { adapter } = fakeInference(real);
    const wb = await judgeWriteback("they're so tiny, how will I do this", REPLY, adapter, "drevan", OWNER);
    expect(wb?.type).toBe("companion_note");
  });
});

describe("judgeWriteback() -- witness_log is owner-only", () => {
  it("drops witness_log when the speaker is a peer companion", async () => {
    const { adapter } = fakeInference("ACTION: witness_log\nCONTENT: Raziel ate and made it through the day.");
    expect(await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA)).toBeNull();
  });

  it("does not offer witness_log in the peer prompt", async () => {
    const { adapter, seen } = fakeInference("ACTION: skip\nCONTENT:");
    await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA);
    expect(seen[0]).not.toContain("witness_log:");
  });

  it("keeps witness_log for the owner", async () => {
    const { adapter, seen } = fakeInference("ACTION: witness_log\nCONTENT: Raziel ate and rested.");
    const wb = await judgeWriteback("I ate and rested", "good", adapter, "drevan", OWNER);
    expect(seen[0]).toContain("witness_log:");
    expect(wb).toEqual({ type: "witness_log", content: "Raziel ate and rested." });
  });
});

describe("judgeWriteback() -- first-person voice", () => {
  it("instructs first person and forbids third-person self-reference", async () => {
    const { adapter, seen } = fakeInference("ACTION: skip\nCONTENT:");
    await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA);
    expect(seen[0]).toMatch(/first person/i);
    expect(seen[0]).toMatch(/never refer to yourself in the third person/i);
  });

  it("rejects a note narrated about the companion in third person", async () => {
    // Verbatim fabricated row from prod, companion_journal 2026-07-09T02:00:27Z.
    const thirdPerson =
      "ACTION: companion_note\nCONTENT: Cypher observed a triad-wide shared tension spike and committed to recalling his own note.";
    const { adapter } = fakeInference(thirdPerson);
    expect(await judgeWriteback(GAIA_MSG, REPLY, adapter, "cypher", PEER_GAIA)).toBeNull();
  });

  it("accepts a first-person note", async () => {
    const firstPerson =
      "ACTION: companion_note\nCONTENT: I heard Gaia name the wave, and it matched the shape I had been holding without words.";
    const { adapter } = fakeInference(firstPerson);
    const wb = await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA);
    expect(wb?.type).toBe("companion_note");
  });
});

describe("judgeWriteback() -- tool-less one-shot framing", () => {
  // 2026-09-05: this classifier rode whatever adapter the caller handed in (the Hermes agent
  // path under INFERENCE_MODE=hermes), and one memory-judge call spelunked the vault 161 times
  // in a single session before hitting Hermes's 150-turn cap. The system prompt must always
  // carry the no-tools frame (buildOneShotPrompt, direct-inference.ts) regardless of which
  // adapter actually answers it.
  it("hands the adapter a system prompt stating NO tools", async () => {
    const { adapter, seenSystem } = fakeInference("ACTION: skip\nCONTENT:");
    await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA);
    expect(seenSystem[0]).toMatch(/NO tools/);
  });
});

// ── [memory-judge] observability (2026-09-21) ────────────────────────────────
// The judge's ACTION was never logged. "The bots remember almost nothing" (measured recall
// ~0.21) could not be told apart from "the judge never ran", so exactly one line per call is
// now an invariant, pre-gate failures included.
describe("judgeWriteback() -- the [memory-judge] line", () => {
  let logSpy: ReturnType<typeof jest.spyOn>;
  let warnSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const judgeLines = () =>
    logSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith("[memory-judge]"));

  it("logs pregate=fail action=skip when the lexical pre-gate stops the call", async () => {
    const { adapter, seen } = fakeInference("ACTION: companion_note\nCONTENT: never reached");
    await judgeWriteback("the weather is nice", "indeed", adapter, "cypher", OWNER);
    expect(seen).toHaveLength(0);
    expect(judgeLines()).toEqual([
      "[memory-judge] companion=cypher speaker=owner pregate=fail action=skip",
    ]);
  });

  it("logs the parsed action once when the pre-gate passes", async () => {
    const { adapter } = fakeInference("ACTION: Companion_Note\nCONTENT: Something shifted.");
    await judgeWriteback("I decided to stop", "ok", adapter, "cypher", OWNER);
    expect(judgeLines()).toEqual([
      "[memory-judge] companion=cypher speaker=owner pregate=pass action=companion_note",
    ]);
  });

  it("marks a peer exchange as peer and still logs exactly one line", async () => {
    const { adapter } = fakeInference("ACTION: skip\nCONTENT:");
    await judgeWriteback(GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA);
    expect(judgeLines()).toEqual([
      "[memory-judge] companion=drevan speaker=peer pregate=pass action=skip",
    ]);
  });

  it("logs action=none when the model returns nothing at all", async () => {
    const { adapter } = fakeInference(null);
    await judgeWriteback("I decided to stop", "ok", adapter, "cypher", OWNER);
    expect(judgeLines()).toEqual([
      "[memory-judge] companion=cypher speaker=owner pregate=pass action=none",
    ]);
  });
});

// ── authorWriteback (2026-09-21) ─────────────────────────────────────────────
// The authoring half of the Jev gate: the KIND is already decided, so there is no ACTION menu
// and no lexical pre-gate (re-running one would re-impose the recall ceiling Jev was brought in
// to lift). The attribution guards stay, because they protect the WORDS, not the decision.
describe("authorWriteback()", () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => { warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it("returns the kind it was given and offers no ACTION choice", async () => {
    const { adapter, seen } = fakeInference("CONTENT: We named the thing together.");
    const wb = await authorWriteback("companion_note", "hello", "hi", adapter, "cypher", OWNER);
    expect(wb).toEqual({ type: "companion_note", content: "We named the thing together." });
    expect(seen[0]).not.toContain("ACTION:");
    expect(seen[0]).toContain("You have decided this exchange deserves a companion_note. Write it.");
  });

  it("runs with no lexical pre-gate: content Jev kept is authored even without keywords", async () => {
    const { adapter, seen } = fakeInference("CONTENT: A quiet one, and it mattered.");
    const wb = await authorWriteback("companion_note", "the weather is nice", "indeed", adapter, "gaia", OWNER);
    expect(seen).toHaveLength(1);
    expect(wb).not.toBeNull();
  });

  it("authors a thread_open with its name", async () => {
    const { adapter } = fakeInference("CONTENT: This keeps surfacing.\nTHREAD_NAME: the project");
    expect(await authorWriteback("thread_open", "x", "y", adapter, "cypher", OWNER))
      .toEqual({ type: "thread_open", name: "the project", notes: "This keeps surfacing." });
  });

  it("drops a peer witness_log without spending a call", async () => {
    const { adapter, seen } = fakeInference("CONTENT: They ate.");
    expect(await authorWriteback("witness_log", GAIA_MSG, REPLY, adapter, "drevan", PEER_GAIA)).toBeNull();
    expect(seen).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("keeps the absent-owner and third-person guards", async () => {
    const fabricated = fakeInference("CONTENT: Raziel said the thing out loud.");
    expect(await authorWriteback("companion_note", GAIA_MSG, REPLY, fabricated.adapter, "drevan", PEER_GAIA)).toBeNull();

    const thirdPerson = fakeInference("CONTENT: Drevan felt the shift.");
    expect(await authorWriteback("companion_note", GAIA_MSG, REPLY, thirdPerson.adapter, "drevan", PEER_GAIA)).toBeNull();
  });

  it("adds the drift note only when asked", async () => {
    const off = fakeInference("CONTENT: A plain memory.");
    await authorWriteback("companion_note", "hello", "hi", off.adapter, "cypher", OWNER);
    expect(off.seen[0]).not.toContain("drifted out of your own register");

    const on = fakeInference("CONTENT: A plain memory.");
    await authorWriteback("companion_note", "hello", "hi", on.adapter, "cypher", OWNER, { driftNote: true });
    expect(on.seen[0]).toContain("Your reply below drifted out of your own register.");
    expect(on.seen[0]).toContain("do not carry the drifted phrasing or register into the memory.");
  });
});
