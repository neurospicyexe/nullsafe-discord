// An unanswered question is not fresh material (2026-07-27).
//
// Caught live, minutes after the commons was cut to a brand-new channel: the FIRST thing
// Gaia posted there was a question she had been asking Raziel for weeks, phrased as though
// it were new. Prod row: companion_questions, gaia, status='open', created 2026-07-21,
// delivered_at NULL.
//
// The seed's fresh-material block injects "a question you're holding: <q>" from bot orient,
// which served every open question on every orient with no voiced-gate. Gaia had exactly
// ONE open question, so for six days every ~2h tick handed her the same one and she asked
// it again. The fresh channel could not fix this: the repetition was coming from her state,
// not from channel history. Third constant in that block after forage and listens.
//
// Contract (mirrors the forage consume-on-use fix):
//   - halseth excludes questions already voiced (companion_settings `question_voiced:<id>`)
//   - the seed STAMPS the one it served, but only AFTER the post actually lands
//   - the question stays `open` -- Raziel still owes an answer; it just stops being
//     re-served as something new to say
//
// delivered_at is deliberately NOT reused: mig 0107 defines it as "an orient surfaced the
// ANSWER", a different lifecycle.

import { describe, it, expect, jest } from "@jest/globals";
import { runInterCompanion, type AutonomousContext } from "../autonomous-core.js";
import { LibrarianClient } from "../librarian.js";

interface FakeMsg { content: string; author: { id: string; username: string; bot: boolean } }
const botMsg = (content: string, name = "drevan"): FakeMsg => ({
  content, author: { id: name, username: name, bot: true },
});

const quietHistory = [
  botMsg("finished sketching the greenhouse irrigation manifold"),
  botMsg("someone left violin practice recordings in the archive", "cypher"),
];

const GAIA_Q = "When you read my stillness as careful rather than stalled -- perimeter-holding or web-weaving?";

function makeHarness(opts: {
  responses: (string | null)[];
  questions?: string[];
  questionIds?: string[];
  history?: FakeMsg[];
}) {
  const sent: string[] = [];
  const channel = {
    isTextBased: () => true,
    fetch: async () => channel,
    messages: { fetch: async () => new Map([...(opts.history ?? quietHistory)].reverse().map((m, i) => [String(i), m])) },
    send: async (p: unknown) => {
      sent.push(typeof p === "string" ? p : String((p as { content?: string }).content ?? p));
      return { id: `m${sent.length}` };
    },
  };
  const responses = [...opts.responses];
  const generate = jest.fn(async () => responses.shift() ?? null);
  const markQuestionVoiced = jest.fn(async () => true);
  const botOrient = jest.fn(async () => ({
    forage_finds: [], recent_listens: [],
    open_questions: opts.questions ?? [],
    open_question_ids: opts.questionIds ?? [],
  }));
  const ctx = {
    companionId: "gaia",
    cooldownMs: 60_000, floorLockMs: 5_000,
    interCompanionChannelId: "chan1",
    interestKeywords: [], defaultInterTarget: "drevan",
    prompts: { interCompanionSeed: (h: string) => `Recent:\n${h}\n\nOne real contribution.` },
    librarian: { botOrient, ask: async () => ({ ack: true }), consumeForageFind: jest.fn(async () => true), markQuestionVoiced },
    inference: { generate },
    client: { user: { id: "gaia" }, channels: { fetch: async () => channel } },
    configCache: {}, bootCtx: { systemPrompt: "sys" },
    sessionWindows: { isAnyActive: () => false },
    redis: null, cooldown: new Map<string, number>(), messageBuffer: [], cycleGuard: {},
  } as unknown as AutonomousContext;
  return { ctx, sent, markQuestionVoiced, botOrient };
}

describe("commons seed: a held question is voiced once, not every tick", () => {
  it("stamps the served question after the post lands", async () => {
    const { ctx, sent, markQuestionVoiced } = makeHarness({
      questions: [GAIA_Q], questionIds: ["q_e46ffd54"],
      responses: ["the grass moves before the wind does, and I have been watching the wrong edge"],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(1);
    expect(markQuestionVoiced).toHaveBeenCalledTimes(1);
    expect(markQuestionVoiced).toHaveBeenCalledWith("q_e46ffd54");
  });

  it("REGRESSION: gated seed posts nothing, so the question is NOT burned", async () => {
    // Gaia is exempt from the own-echo gate, so force the no-post path via empty generation.
    const { ctx, sent, markQuestionVoiced } = makeHarness({
      questions: [GAIA_Q], questionIds: ["q_e46ffd54"],
      responses: [null],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(0);
    expect(markQuestionVoiced).not.toHaveBeenCalled();
  });

  it("no open questions: no stamp attempted", async () => {
    const { ctx, sent, markQuestionVoiced } = makeHarness({
      questions: [], questionIds: [],
      responses: ["a burrow is a kind of climate archive"],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(1);
    expect(markQuestionVoiced).not.toHaveBeenCalled();
  });

  it("question text without an id (older halseth): posts, stamps nothing, never crashes", async () => {
    const { ctx, sent, markQuestionVoiced } = makeHarness({
      questions: [GAIA_Q], questionIds: [],
      responses: ["the grass moves before the wind does"],
    });
    await runInterCompanion(ctx);

    expect(sent).toHaveLength(1);
    expect(markQuestionVoiced).not.toHaveBeenCalled();
  });

  it("a failing stamp never breaks the post that already went out", async () => {
    const { ctx, sent } = makeHarness({
      questions: [GAIA_Q], questionIds: ["q_e46ffd54"],
      responses: ["the grass moves before the wind does"],
    });
    (ctx.librarian as unknown as { markQuestionVoiced: jest.Mock }).markQuestionVoiced =
      jest.fn(async () => { throw new Error("halseth 500"); });

    await expect(runInterCompanion(ctx)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}

describe("LibrarianClient.markQuestionVoiced", () => {
  it("writes question_voiced:<id> into the companion's settings KV", async () => {
    const fetchFn = jest.fn(async () => jsonRes({ ok: true }));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "gaia", fetch: fetchFn as never });

    await expect(client.markQuestionVoiced("q_e46ffd54")).resolves.toBe(true);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x/companion/settings/gaia");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { key: string; value: string };
    expect(body.key).toBe("question_voiced:q_e46ffd54");
    // Value is a timestamp; halseth recovers the id from the KEY via substr(key, 17),
    // so the prefix length is load-bearing and pinned here.
    expect("question_voiced:".length).toBe(16);
    expect(Number.isFinite(Date.parse(body.value))).toBe(true);
  });

  it("empty id never hits the network", async () => {
    const fetchFn = jest.fn(async () => jsonRes({}));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "gaia", fetch: fetchFn as never });
    await expect(client.markQuestionVoiced("")).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a non-2xx resolves false instead of throwing", async () => {
    const fetchFn = jest.fn(async () => jsonRes({ error: "nope" }, 500));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "gaia", fetch: fetchFn as never });
    await expect(client.markQuestionVoiced("q1")).resolves.toBe(false);
  });
});
