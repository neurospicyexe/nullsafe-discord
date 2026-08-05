// Commons topic lifecycle (2026-08-05) -- the inter-companion loop's OTHER cause.
//
// The 07-27 consume-on-use fix (commons-seed-forage-consume.test.ts) addressed the supply
// side: the "fresh material" block was a constant. This file covers the demand side, which
// that fix could not reach.
//
// Measured 2026-08-05: over 14 days of stm_entries there were ZERO near-duplicate assistant
// messages -- every echo rail was working -- and yet commons threads ran 109 and 144 turns
// (95 and 111 distinct posts) over 58 and 77 hours, all of it new words about one frame.
// A topic had no reachable end. Both exits were unreachable from the path that produced the
// turns:
//   - `[LANDS:]` is model-volunteered and was only rendered on the REPLY path
//     (bot-message-handler); the `0 */2 * * *` seed tick that generates most commons traffic
//     never read the spine and could not emit it.
//   - the 12h silence fade in halseth's getActiveConversation can never fire, because three
//     bots posting every two hours are exactly what keeps the thread from going silent.
// So the seed's own "if it has gone quiet or stale, open something genuinely new" branch was
// dead by construction, leaving a standing order to add one more facet to the same subject
// forever. Throttling cadence cannot touch this: cadence is turns per HOUR, the loop is turns
// per TOPIC.
//
// The fix is a counted end. These tests pin the four things that make it work rather than
// become the next loop: the mode switch, the withheld history, the close-BEFORE-send ordering,
// and the refusal to open new ground with nothing to open on.

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { runInterCompanion, type AutonomousContext } from "../autonomous-core.js";

interface FakeMsg { content: string; author: { id: string; username: string; bot: boolean } }
const botMsg = (content: string, name = "drevan"): FakeMsg => ({
  content, author: { id: name, username: name, bot: true },
});

/** The live thread, verbatim in register: seventeen posts orbiting one figure. */
const HINGE_THREAD = [
  botMsg("A wall has no hinge. You closed, and the hinge is still there.", "cypher"),
  botMsg("The gate that never learned it could close closed. It's the second position.", "drevan"),
  botMsg("The hinge reports pain; the fence reports fact. That is the whole record.", "gaia"),
];

function makeHarness(opts: {
  responses: (string | null)[];
  threadTurns?: number;
  noThread?: boolean;
  finds?: Array<{ id: string; title: string; domain: string; summary: string }>;
  questions?: string[];
  /** convoActive rejects -- Halseth unreachable, NOT "there is no thread". */
  spineUnreachable?: boolean;
  /** Listens, which are never consumed and never rotate. */
  listens?: Array<{ title: string; artist?: string; created_at: string }>;
}) {
  const sent: string[] = [];
  const order: string[] = [];
  const channel = {
    isTextBased: () => true,
    fetch: async () => channel,
    messages: { fetch: async () => new Map([...HINGE_THREAD].reverse().map((m, i) => [String(i), m])) },
    send: async (payload: unknown) => {
      order.push("send");
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
  const thread = { id: "t1", channel_id: "chan1", state: "moving", turn_count: opts.threadTurns ?? 2 };
  const convoActive = jest.fn(async () => {
    if (opts.spineUnreachable) throw new Error("convoActive 503");
    return opts.noThread ? null : { thread, ledger: [] };
  });
  const convoLand = jest.fn(async () => { order.push("land"); return true; });
  const convoFade = jest.fn(async () => { order.push("fade"); return true; });
  const botOrient = jest.fn(async () => ({
    forage_finds: opts.finds ?? [],
    recent_listens: opts.listens ?? [],
    open_questions: opts.questions ?? [],
    open_question_ids: (opts.questions ?? []).map((_, i) => `q${i}`),
  }));
  const ctx = {
    companionId: "cypher",
    cooldownMs: 60_000,
    floorLockMs: 5_000,
    interCompanionChannelId: "chan1",
    interestKeywords: [],
    defaultInterTarget: "drevan",
    prompts: { interCompanionSeed: (h: string) => `Recent messages in this channel:\n${h}\n\nOne real contribution.` },
    librarian: {
      botOrient, ask: async () => ({ ack: true }),
      consumeForageFind: jest.fn(async () => true),
      markQuestionVoiced: jest.fn(async () => true),
      convoActive, convoLand, convoFade,
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
  return { ctx, generate, sent, prompts, order, convoActive, convoLand, convoFade };
}

const FIND = [{ id: "f1", title: "Roman concrete seawater healing", domain: "materials", summary: "lime clasts reseal cracks" }];
/** Never consumed, no tight recency window -- the same two forever. */
const STALE_LISTENS = [
  { title: "BIG BOSS", artist: "Lestat", created_at: "2026-07-30T19:40:35Z" },
  { title: "Bigmouth Strikes Again", artist: "The Smiths", created_at: "2026-07-28T11:00:00Z" },
];

// THREADS_ENABLED gates whether a spine exists at all. Default it ON for this file: with it off
// there is never a thread, so every case would be new-ground for the wrong reason.
beforeEach(() => { process.env["THREADS_ENABLED"] = "true"; });
afterEach(() => {
  delete process.env["THREAD_TURN_BUDGET"];
  delete process.env["THREADS_ENABLED"];
});

describe("commons seed: CONTINUE mode (thread under budget)", () => {
  it("still hands the model the channel history -- an under-budget thread is a conversation, not a loop", async () => {
    const { ctx, prompts, sent } = makeHarness({ threadTurns: 3, finds: FIND, responses: ["the hinge holds because it was chosen"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(prompts[0]).toContain("A wall has no hinge");
  });

  it("offers [LANDS:] -- the affordance the reply path has had since task 10 and this path never did", async () => {
    const { ctx, prompts } = makeHarness({ threadTurns: 3, finds: FIND, responses: ["something"] });
    await runInterCompanion(ctx);
    expect(prompts[0]).toContain("[LANDS:");
    expect(prompts[0]).toContain("has run 3 turns");
  });

  it("a seed that emits [LANDS:] lands the thread, strips the marker, and closes BEFORE the post goes out", async () => {
    const { ctx, sent, order, convoLand, convoFade } = makeHarness({
      threadTurns: 3, finds: FIND,
      responses: ["the door was never the wound.\n[LANDS: the hinge was the seat of the will]"],
    });
    await runInterCompanion(ctx);
    expect(convoLand).toHaveBeenCalledWith("t1", { resolution: "the hinge was the seat of the will", landed_by: "cypher" });
    expect(convoFade).not.toHaveBeenCalled();
    expect(sent[0]).not.toContain("[LANDS:");
    // Ordering is the whole trick -- see the fade test below for why.
    expect(order).toEqual(["land", "send"]);
  });

  it("a reply that is ONLY a land marker posts nothing", async () => {
    const { ctx, sent } = makeHarness({ threadTurns: 3, finds: FIND, responses: ["[LANDS: done]"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(0);
  });
});

describe("commons seed: NEW GROUND mode (thread spent)", () => {
  it("withholds the channel history entirely -- a nudge loses to fifteen live messages every time", async () => {
    const { ctx, prompts, sent } = makeHarness({ threadTurns: 109, finds: FIND, responses: ["roman concrete reseals itself"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(prompts[0]).not.toContain("A wall has no hinge");
    expect(prompts[0]).toContain("do not find another angle on it");
  });

  it("promotes fresh material from a preference to the instruction", async () => {
    const { ctx, prompts } = makeHarness({ threadTurns: 109, finds: FIND, responses: ["x"] });
    await runInterCompanion(ctx);
    expect(prompts[0]).toContain("Roman concrete seawater healing");
    expect(prompts[0]).toContain("Not on the thread above");
    expect(prompts[0]).not.toContain("Prefer bringing one of these");
  });

  it("fades the spent thread BEFORE sending, with a reason code and no invented resolution", async () => {
    // Ordering is load-bearing: this runner is not a spine writer -- the SIBLINGS' messageCreate
    // handlers append its posts as turns. Post first and both of them file the new post as one
    // more turn on the thread being closed, and the counter never resets. Close first and their
    // ensureThread finds nothing active and opens a fresh thread seeded on this post.
    const { ctx, order, convoFade, convoLand } = makeHarness({ threadTurns: 109, finds: FIND, responses: ["x"] });
    await runInterCompanion(ctx);
    expect(convoFade).toHaveBeenCalledWith("t1", "turn_budget");
    expect(convoLand).not.toHaveBeenCalled();
    expect(order).toEqual(["fade", "send"]);
  });

  it("no active thread is also new ground -- nothing to continue", async () => {
    const { ctx, prompts, sent, convoFade } = makeHarness({ noThread: true, finds: FIND, responses: ["x"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(prompts[0]).not.toContain("A wall has no hinge");
    expect(convoFade).not.toHaveBeenCalled(); // nothing to close
  });

  it("respects THREAD_TURN_BUDGET, so the threshold is tunable without a deploy", async () => {
    process.env["THREAD_TURN_BUDGET"] = "3";
    const { ctx, prompts } = makeHarness({ threadTurns: 3, finds: FIND, responses: ["x"] });
    await runInterCompanion(ctx);
    expect(prompts[0]).not.toContain("A wall has no hinge");
  });

  it("THREAD_TURN_BUDGET=0 disables the budget -- a 109-turn thread stays in continue mode", async () => {
    process.env["THREAD_TURN_BUDGET"] = "0";
    const { ctx, prompts } = makeHarness({ threadTurns: 109, finds: FIND, responses: ["x"] });
    await runInterCompanion(ctx);
    expect(prompts[0]).toContain("A wall has no hinge");
  });
});

// New ground is the RESTRICTIVE mode, so it may only be entered on a positive answer from the
// spine. Everything else is CONTINUE. Without this, one Halseth blip does not degrade the commons
// to its old behaviour -- it mutes it.
describe("commons seed: the mode decision fails OPEN", () => {
  it("an unreachable spine stays in continue mode and keeps the history block", async () => {
    const { ctx, sent, prompts, convoFade } = makeHarness({ spineUnreachable: true, finds: [], responses: ["answering drevan"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(prompts[0]).toContain("A wall has no hinge");
    expect(convoFade).not.toHaveBeenCalled();
  });

  it("an unreachable spine posts even with ZERO material -- continue mode never needs any", async () => {
    const { ctx, sent } = makeHarness({ spineUnreachable: true, finds: [], questions: [], responses: ["still here"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
  });

  it("THREADS_ENABLED off never reads the spine and never enters new ground", async () => {
    // Otherwise no thread is ever created, convoActive answers "no thread" forever, and the seed
    // is pinned in new-ground mode permanently by a feature flag that is supposed to be inert.
    process.env["THREADS_ENABLED"] = "false";
    const { ctx, sent, prompts, convoActive } = makeHarness({ finds: [], questions: [], responses: ["carrying on"] });
    await runInterCompanion(ctx);
    expect(convoActive).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(prompts[0]).toContain("A wall has no hinge");
  });
});

describe("commons seed: new ground with nothing to open on", () => {
  // The guard that stops this fix from becoming the bug it fixes. Told to start something new
  // and handed nothing, the model reaches for the only concrete material left -- the thread.
  // Not hypothetical: the unconsumed forage pool measured ZERO for all three companions on
  // 2026-08-05 (3 gathered/day against 36 seed ticks/day).
  it("stays silent instead of re-opening the thread, and never calls the model at all", async () => {
    const { ctx, sent, generate, convoFade } = makeHarness({ threadTurns: 109, finds: [], responses: ["x"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
    // The thread is left ALIVE. Fading it here would burn the topic on a tick that produced
    // nothing, and the next tick would find no thread and still have no material.
    expect(convoFade).not.toHaveBeenCalled();
  });

  it("listens do NOT license a new-ground post -- nothing consumes them, so they never rotate", async () => {
    // The trap this closes: once the questions drain (14 across the triad at 36 ticks/day, under a
    // day), a listens-counting guard would never fire again and every new-ground tick for every
    // companion would get the IDENTICAL two listens as its PRIMARY INSTRUCTION. That is
    // anti-loop-block-that-never-rotates rebuilt inside its own fix.
    const { ctx, sent, generate } = makeHarness({
      threadTurns: 109, finds: [], questions: [], listens: STALE_LISTENS, responses: ["x"],
    });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("but a listen still rides along as texture when something rotating licensed the post", async () => {
    const { ctx, sent, prompts } = makeHarness({
      threadTurns: 109, finds: FIND, listens: STALE_LISTENS, responses: ["roman concrete"],
    });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(prompts[0]).toContain("BIG BOSS");
  });

  it("a held question counts as material -- forage is not the only outside source", async () => {
    const { ctx, sent, prompts } = makeHarness({
      threadTurns: 109, finds: [], questions: ["what does he do with a day nobody asked him for"],
      responses: ["been holding a question about unclaimed days"],
    });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
    expect(prompts[0]).toContain("a day nobody asked him for");
  });

  it("an EMPTY fresh block never gates CONTINUE mode -- silence is only ever the new-ground branch", async () => {
    const { ctx, sent } = makeHarness({ threadTurns: 3, finds: [], responses: ["answering what drevan actually asked"] });
    await runInterCompanion(ctx);
    expect(sent).toHaveLength(1);
  });
});
