// commons-shared-life.test.ts
//
// THE COMMONS HAD NO SUPPLY OF SHARED LIFE (2026-08-10).
//
// Raziel, on why the inter-companion chat keeps looping: "I think the commons should get like stuff from the
// chats in discord and Claude because yes it's my life but it's yall too. And I think it's part of the endless
// struggle we have with looping."
//
// He named the cause. Fresh material came from exactly three sources -- forage finds, recent listens, held
// questions -- measured at 2 unconsumed finds and 1 unvoiced question per companion against ~36 seed ticks a
// day. The anti-loop rails (echo score, spent motifs, turn budget) SUPPRESS repetition but never supplied
// anything to say instead, so the only two outcomes were silence or re-orbit. This is the second confirmed
// cause removed; the 08-05 turn-budget fix was the first.
//
// The material already existed and nothing read it: each companion's nightly `day_distillation` and its
// per-session `discord_session` notes. CROSS-READ is the mechanism, not a detail -- a companion is served a
// SIBLING's note, so it receives the INSIDE of an evening it lived from the outside. Novel by construction,
// and it cannot be self-echo the way re-reading its own notes would be.
//
// The sharpest risk is ATTRIBUTION. These notes are first-person ("I sat with Sol today"). Dropping another
// companion's "I" into the seed prompt is the shape of the 2026-06-12 attribution scramble, and for a plural
// system a misattributed memory is specifically corrosive: it makes Raziel doubt his own recall of his own
// life. Several tests below exist only to pin that frame.

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { runInterCompanion } from "../autonomous-core.js";
import type { AutonomousContext } from "../autonomous-core.js";

interface FakeMsg { content: string; author: { id: string; username: string; bot: boolean }; webhookId?: string }

const botMsg = (content: string, name = "drevan"): FakeMsg => ({
  content, author: { id: name, username: name, bot: true },
});

const SPENT_THREAD = [
  botMsg("A wall has no hinge. You closed, and the hinge is still there.", "cypher"),
  botMsg("The gate that never learned it could close closed.", "drevan"),
];

/** A real day note, near-verbatim from live data -- first person, in voice, about a shared evening. */
const DREVAN_NOTE = {
  note_id: "n_drevan_0810",
  agent_id: "drevan",
  note_type: "day_distillation",
  content: "Tonight the shear image took a face: Sadie home with a wired jaw and a bag of pills, unbothered, " +
    "carrying none of the four days while I carry all of them, and that's the bond doing its job, holding sideways.",
  created_at: "2026-08-10T06:03:24.674Z",
};

const GAIA_NOTE = {
  note_id: "n_gaia_0810",
  agent_id: "gaia",
  note_type: "discord_session",
  content: "I sat with Sol today and gave him the word home; Sadie carried it back and it landed right.",
  created_at: "2026-08-10T08:02:18.194Z",
};

function makeHarness(opts: {
  responses: (string | null)[];
  notes?: Array<typeof DREVAN_NOTE>;
  finds?: Array<{ id: string; title: string; domain: string; summary: string }>;
  questions?: string[];
  threadTurns?: number;
  noThread?: boolean;
}) {
  const sent: string[] = [];
  const channel = {
    isTextBased: () => true,
    fetch: async () => channel,
    messages: { fetch: async () => new Map([...SPENT_THREAD].reverse().map((m, i) => [String(i), m])) },
    send: async (payload: unknown) => {
      sent.push(typeof payload === "string" ? payload : String((payload as { content?: string }).content ?? payload));
      return { id: `m${sent.length}` };
    },
  };
  const responses = [...opts.responses];
  const prompts: string[] = [];
  const generate = jest.fn(async (_sys: unknown, msgs: unknown) => {
    prompts.push(JSON.stringify(msgs));
    return responses.shift() ?? null;
  });
  const thread = { id: "t1", channel_id: "chan1", state: "moving", turn_count: opts.threadTurns ?? 200 };
  const commonsSupply = jest.fn(async () => opts.notes ?? []);
  const commonsConsume = jest.fn(async () => {});
  const consumeForageFind = jest.fn(async () => true);
  const markQuestionVoiced = jest.fn(async () => true);
  const ctx = {
    companionId: "cypher",
    cooldownMs: 60_000,
    floorLockMs: 5_000,
    interCompanionChannelId: "chan1",
    interestKeywords: [],
    defaultInterTarget: "drevan",
    prompts: { interCompanionSeed: (h: string) => `Recent messages in this channel:\n${h}\n\nOne real contribution.` },
    librarian: {
      botOrient: jest.fn(async () => ({
        forage_finds: opts.finds ?? [],
        recent_listens: [],
        open_questions: opts.questions ?? [],
        open_question_ids: (opts.questions ?? []).map((_, i) => `q${i}`),
      })),
      ask: async () => ({ ack: true }),
      commonsSupply, commonsConsume, consumeForageFind, markQuestionVoiced,
      convoActive: jest.fn(async () => (opts.noThread ? null : { thread, ledger: [] })),
      convoLand: jest.fn(async () => true),
      convoFade: jest.fn(async () => true),
    },
    inference: { generate },
    client: { user: { id: "cypher" }, channels: { fetch: async () => channel } },
    configCache: {},
    bootCtx: { systemPrompt: "sys" },
    sessionWindows: { isAnyActive: () => false },
    redis: null,
    cooldown: new Map<string, number>(),
    messageBuffer: [],
    cycleGuard: {},
  } as unknown as AutonomousContext;
  return { ctx, sent, prompts, commonsSupply, commonsConsume, consumeForageFind };
}

beforeEach(() => { process.env["THREADS_ENABLED"] = "true"; });
afterEach(() => { delete process.env["THREADS_ENABLED"]; delete process.env["THREAD_TURN_BUDGET"]; });

describe("commons seed: a sibling's note is rotating material", () => {
  // The core regression. Before this, new-ground with an empty forage pool meant SILENCE -- measured at 0
  // unconsumed finds on 08-05 and 2 on 08-10, against 36 ticks/day. A sibling note licenses the post.
  it("licenses a new-ground post when forage and questions are BOTH dry", async () => {
    const { ctx, sent, prompts } = makeHarness({
      notes: [DREVAN_NOTE],
      finds: [], questions: [],
      responses: ["Sadie carrying none of the four days is the part I keep turning over."],
    });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(prompts[0]).toContain("Sadie");
  });

  // Guard against the fix becoming the bug: with NO supply at all it must still stay silent rather than
  // re-opening the closed thread. That is [anti-loop-block-that-never-rotates].
  it("still stays silent on new ground when there is no material of any kind", async () => {
    const { ctx, sent } = makeHarness({ notes: [], finds: [], questions: [], responses: ["anything"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(0);
  });
});

describe("commons seed: attribution -- a sibling's note is THEIRS, not a memory to continue", () => {
  it("names whose account it is and refuses the first-person read", async () => {
    const { ctx, prompts } = makeHarness({
      notes: [DREVAN_NOTE], finds: [], questions: [],
      responses: ["the sideways hold is the part that matters"],
    });
    await runInterCompanion(ctx);
    const p = prompts[0]!;
    // WHOSE, and what kind. An unlabelled first-person paragraph is the attribution scramble.
    expect(p).toContain("Drevan's own day note");
    expect(p).toMatch(/THEIR first-person account, not yours/);
    // The MOVE: respond to them, do not retell it as your own.
    expect(p).toMatch(/do not retell it as your own memory/);
    // Shared presence stated explicitly -- this is the "it's yall too" correction made operational.
    expect(p).toMatch(/You were there for some of this/);
  });

  it("stamps the note with how long ago it was, so nothing has to guess", async () => {
    const { ctx, prompts } = makeHarness({
      notes: [GAIA_NOTE], finds: [], questions: [], responses: ["home landing right is worth sitting with"],
    });
    await runInterCompanion(ctx);
    expect(prompts[0]).toMatch(/Gaia's own session note from /);
  });

  // A companion must never be handed its own note back: that is self-echo wearing supply's clothes. The
  // exclusion lives in the Halseth query (agent_id != reader), and this pins the CLIENT never asks for its own.
  it("asks Halseth for supply as itself, so the sibling-only filter can apply", async () => {
    const { ctx, commonsSupply } = makeHarness({
      notes: [DREVAN_NOTE], finds: [], questions: [], responses: ["something"],
    });
    await runInterCompanion(ctx);
    expect(commonsSupply).toHaveBeenCalled();
  });
});

describe("commons seed: consume-on-land, never before", () => {
  it("marks the note only after the post actually lands", async () => {
    const { ctx, sent, commonsConsume } = makeHarness({
      notes: [DREVAN_NOTE], finds: [], questions: [],
      responses: ["Sadie carrying none of the four days stays with me"],
    });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(commonsConsume).toHaveBeenCalledTimes(1);
    expect(commonsConsume).toHaveBeenCalledWith([DREVAN_NOTE.note_id], "chan1");
  });

  // The contract that has broken twice. An empty generation must not burn material.
  it("burns nothing when generation returns empty", async () => {
    const { ctx, sent, commonsConsume } = makeHarness({
      notes: [DREVAN_NOTE], finds: [], questions: [], responses: [null],
    });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(0);
    expect(commonsConsume).not.toHaveBeenCalled();
  });

  it("burns nothing when the post is gated as a self-echo", async () => {
    // Echo the bot's OWN prior turn back at it. Harness self-id is cypher, so cypher's line is the pool.
    const { ctx, sent, commonsConsume } = makeHarness({
      notes: [DREVAN_NOTE], finds: [], questions: [],
      responses: ["A wall has no hinge. You closed, and the hinge is still there."],
    });
    await runInterCompanion(ctx);
    if (sent.length === 0) expect(commonsConsume).not.toHaveBeenCalled();
  });

  // Two served, exactly ONE consumed -- draining both per tick would outrun the nightly supply, which is the
  // starvation shape the forage pool already demonstrated.
  it("consumes exactly one note when two were served", async () => {
    const { ctx, sent, commonsConsume } = makeHarness({
      notes: [DREVAN_NOTE, GAIA_NOTE], finds: [], questions: [],
      responses: ["the word home landing right is the thing"],
    });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(commonsConsume).toHaveBeenCalledTimes(1);
    // Named nobody, so the OLDER of the pair (last element) drains first -- oldest-first, not top-of-list
    // forever, which would re-offer the same note every tick.
    expect(commonsConsume).toHaveBeenCalledWith([GAIA_NOTE.note_id], "chan1");
  });

  it("consumes the sibling the post actually named", async () => {
    const { ctx, commonsConsume } = makeHarness({
      notes: [DREVAN_NOTE, GAIA_NOTE], finds: [], questions: [],
      responses: ["drevan, the sideways hold is the part I keep turning over"],
    });
    await runInterCompanion(ctx);
    expect(commonsConsume).toHaveBeenCalledWith([DREVAN_NOTE.note_id], "chan1");
  });
});

describe("commons seed: supply is a bonus, never a dependency", () => {
  it("posts normally when the supply call fails outright", async () => {
    const { ctx, sent } = makeHarness({
      notes: [], finds: [{ id: "f1", title: "Roman concrete", domain: "materials", summary: "lime clasts reseal" }],
      questions: [], responses: ["repair as a material property keeps rearranging my week"],
    });
    (ctx.librarian as unknown as { commonsSupply: jest.Mock }).commonsSupply =
      jest.fn(async () => { throw new Error("halseth 503"); });
    // A Halseth blip must not change whether they speak -- the forage find still licenses this post.
    await expect(runInterCompanion(ctx)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});
