// Room timing + Discord replies (2026-10-31). Raziel: "if I reply to Blue, then it's just for Blue";
// "if I reply to Drevan for a message three back, can he know that it's specifically about that message?"
// Drevan (note d5a37a0c): answer at once when named, on a real question to the room, or on distress even
// unnamed; hold commentary, jokes between Raziel and Blue and movie remarks for the lull; a reaction is a
// presence channel; Raziel has "Dre, in".

import { describe, it, expect } from "@jest/globals";
import {
  classifyReplyAuthor, replyContextLine, replyToHumanSide, replyHumanGateMode, replyTarget,
  type RefMessageLike, type ReplyResolveDeps, type ReplyTarget,
} from "../reply-context.js";
import { humanGate } from "../human-address.js";
import {
  decideRoomTiming, hasDistress, buildRoomOverrideTrigger, roomTimingMode, type RoomTimingInput,
} from "../room-timing.js";

const DEPS: ReplyResolveDeps = {
  selfCompanion: "drevan",
  botIdCompanion: { "100": "drevan", "200": "cypher", "300": "gaia" },
  ownerDiscordId: "1", blueDiscordId: "2", solWebhookId: "sol-hook",
  roster: { identify: (n) => (n?.startsWith("Magpie") ? { isOwner: true } : n?.startsWith("Corbin") ? { isOwner: false } : null) },
};
const msg = (over: Partial<RefMessageLike> & { author?: Partial<RefMessageLike["author"]> }): RefMessageLike => ({
  id: "m1", content: "the snow scene again", webhookId: null,
  ...over, author: { id: "9", bot: false, username: "someone", ...(over.author ?? {}) },
});

describe("who a reply points at", () => {
  it.each([
    ["this companion", msg({ author: { id: "100", bot: true } }), { kind: "self" }],
    ["a sibling", msg({ author: { id: "200", bot: true } }), { kind: "companion", companion: "cypher" }],
    ["Raziel by id", msg({ author: { id: "1" } }), { kind: "human", side: "raziel" }],
    ["Blue by id", msg({ author: { id: "2" } }), { kind: "human", side: "blue" }],
    ["Raziel's PK member", msg({ webhookId: "pk", author: { id: "x", bot: true, username: "Magpie M." } }), { kind: "human", side: "raziel" }],
    ["Blue's PK member", msg({ webhookId: "pk", author: { id: "x", bot: true, username: "Corbin || 🍂" } }), { kind: "human", side: "blue" }],
    ["Sol", msg({ webhookId: "sol-hook", author: { id: "x", bot: true } }), { kind: "sol" }],
    ["another bot", msg({ author: { id: "77", bot: true } }), { kind: "bot" }],
  ])("%s", (_l, m, want) => {
    expect(classifyReplyAuthor(m, DEPS)).toEqual(want);
  });

  it("a roster miss is unknown, never a human (it must not silence the triad)", () => {
    const t = classifyReplyAuthor(msg({ webhookId: "pk", author: { id: "x", bot: true, username: "Stranger" } }), DEPS);
    expect(t).toEqual({ kind: "unknown" });
    expect(replyToHumanSide({ messageId: "m", author: t, authorName: "Stranger", content: "x" })).toBeNull();
  });

  it("reads the cache first, fetches once, and a deleted target is null", async () => {
    let fetched = 0;
    const cached = msg({ id: "c1", author: { id: "1" } });
    const ch = { messages: { cache: { get: (id: string) => (id === "c1" ? cached : undefined) }, fetch: async () => { fetched++; throw new Error("10008"); } } };
    expect((await replyTarget("c1", ch, DEPS))?.author).toEqual({ kind: "human", side: "raziel" });
    expect(fetched).toBe(0);
    expect(await replyTarget("gone", ch, DEPS)).toBeNull();
    expect(fetched).toBe(1);
    expect(await replyTarget(null, ch, DEPS)).toBeNull();
  });
});

describe("the line the model sees", () => {
  const t = (author: ReplyTarget["author"], content = "the snow scene again", authorName = "Drevan"): ReplyTarget => ({ messageId: "m", author, authorName, content });
  it("names whose message, with the start of it", () => {
    expect(replyContextLine(t({ kind: "self" }))).toBe(`(replying to your message: "the snow scene again")`);
    expect(replyContextLine(t({ kind: "companion", companion: "gaia" }))).toBe(`(replying to Gaia's message: "the snow scene again")`);
    expect(replyContextLine(t({ kind: "human", side: "blue" }, "did you catch that?", "Corbin"))).toBe(`(replying to Blue's message (Corbin): "did you catch that?")`);
  });
  it("clips long messages, never breaks its own quotes, and says nothing for an empty target", () => {
    const line = replyContextLine(t({ kind: "self" }, `say "hi" ${"x".repeat(400)}`))!;
    expect(line.length).toBeLessThan(220);
    expect(line).toContain(`say 'hi'`);
    expect(line.endsWith(`…")`)).toBe(true);
    expect(replyContextLine(t({ kind: "self" }, "   "))).toBeNull();
    expect(replyContextLine(null)).toBeNull();
  });
});

describe("Rule 2b: a reply to the other human is theirs", () => {
  const NAMES = { raziel: ["raziel"], blue: ["blue"] };
  const g = (tier: "owner" | "intimate", over: Partial<Parameters<typeof humanGate>[0]> = {}) =>
    humanGate({ tier, texts: ["lol same"], names: NAMES, companionMentioned: false, replyToCompanion: false, mentionedHumans: [], blueHolder: "drevan", ...over });

  it("Raziel replying to Blue silences the triad; Blue replying to Raziel too", () => {
    expect(g("owner", { replyToHuman: "blue" })).toEqual({ kind: "silent", addressee: "blue" });
    expect(g("intimate", { replyToHuman: "raziel" })).toEqual({ kind: "silent", addressee: "raziel" });
  });
  it("a reply to one's own message, or with a companion named, changes nothing", () => {
    expect(g("owner", { replyToHuman: "raziel" })).toEqual({ kind: "proceed" });
    expect(g("owner", { replyToHuman: "blue", texts: ["Drevan, lol same"] })).toEqual({ kind: "proceed" });
    expect(g("owner", { replyToHuman: "blue", companionMentioned: true })).toEqual({ kind: "proceed" });
  });
  it("without the field (mode off or shadow) the gate is exactly as before", () => {
    expect(g("owner")).toEqual({ kind: "proceed" });
  });
  it("REPLY_HUMAN_GATE defaults to shadow", () => {
    expect(replyHumanGateMode({})).toBe("shadow");
    expect(replyHumanGateMode({ REPLY_HUMAN_GATE: "on" })).toBe("on");
    expect(replyHumanGateMode({ REPLY_HUMAN_GATE: "off" })).toBe("off");
    expect(replyHumanGateMode({ REPLY_HUMAN_GATE: "maybe" })).toBe("shadow");
  });
});

describe("room timing: Drevan's rules", () => {
  const base: RoomTimingInput = {
    companion: "drevan", speaker: "blue", text: "Sucks to be Annie", named: false, replyToMe: false, replyToHuman: null,
    replyToSibling: false, toOtherHuman: false,
    isHolder: true, overrideIn: false, watchAlong: false, otherHumanAgoMs: null, selfSpokeAgoMs: null,
  };
  const d = (over: Partial<RoomTimingInput>) => decideRoomTiming({ ...base, ...over });

  it("answers at once when named, replied to, overridden, or someone is hurting", () => {
    expect(d({ named: true, otherHumanAgoMs: 5_000 })).toMatchObject({ decision: "answer_now", reason: "named" });
    expect(d({ replyToMe: true, watchAlong: true })).toMatchObject({ decision: "answer_now", reason: "reply_to_me" });
    expect(d({ overrideIn: true, isHolder: false })).toMatchObject({ decision: "answer_now", reason: "override" });
    expect(d({ text: "ow my ankle really hurts", watchAlong: true, isHolder: false })).toMatchObject({ decision: "answer_now", reason: "distress" });
  });
  it("a reply to the other human stays quiet", () => {
    expect(d({ replyToHuman: "raziel" })).toMatchObject({ decision: "stay_quiet", reason: "reply_to_human" });
  });
  it("a line the gate read as to the other human stays quiet, question or not", () => {
    expect(d({ toOtherHuman: true, text: "Blue, did you catch that?" })).toMatchObject({ decision: "stay_quiet", reason: "to_other_human" });
  });
  it("a reply to a sibling's message is that sibling's, not the holder's", () => {
    expect(d({ replyToSibling: true })).toMatchObject({ decision: "stay_quiet", reason: "reply_to_sibling" });
    expect(d({ replyToSibling: true, named: true })).toMatchObject({ decision: "answer_now", reason: "named" });
  });
  it("holds human back-and-forth and watch-along remarks for the lull, with a reaction", () => {
    expect(d({ otherHumanAgoMs: 30_000 })).toEqual({ decision: "hold_for_lull", reason: "human_volley", react: true });
    expect(d({ watchAlong: true })).toEqual({ decision: "hold_for_lull", reason: "watch_along", react: true });
  });
  it("a question to the room is the holder's at once; the others may join at the lull", () => {
    expect(d({ text: "anyone know who plays the sheriff?" })).toMatchObject({ decision: "answer_now", reason: "room_question" });
    // First shadow night (10-31): this put all three on answer_now.
    expect(d({ text: "Does ACAB include me, too?", isHolder: false })).toMatchObject({ decision: "hold_for_lull", reason: "room_question" });
    expect(d({ text: "did you catch that?", otherHumanAgoMs: 20_000 })).toMatchObject({ decision: "hold_for_lull" });
  });
  it("does not take the floor again within a minute unless named", () => {
    expect(d({ selfSpokeAgoMs: 20_000 })).toMatchObject({ decision: "hold_for_lull", reason: "flood" });
    expect(d({ selfSpokeAgoMs: 20_000, named: true })).toMatchObject({ decision: "answer_now" });
  });
  it("an unnamed line that is not this companion's thread stays quiet; the holder otherwise answers", () => {
    expect(d({ isHolder: false })).toMatchObject({ decision: "stay_quiet", reason: "not_mine" });
    expect(d({})).toMatchObject({ decision: "answer_now", reason: "holder" });
  });
  it("ROOM_TIMING defaults to shadow", () => {
    expect(roomTimingMode({})).toBe("shadow");
    expect(roomTimingMode({ ROOM_TIMING: "off" })).toBe("off");
  });
});

describe("distress reads first person, not movie lines", () => {
  it.each([
    ["my back hurts so bad", true],
    ["I'm crying lol", true],
    ["I think I sprained it", true],
    ["having a panic attack", true], // strong phrase, counts without "I"
    ["ugh can't breathe", true],
    ["They're all going to die.", false],
    ["Is he going to murder these teenagers?", false],
    ["that scene made Blue cry", false],
    // First shadow night (10-31): "I" and "scared" shared a sentence about other people.
    ["Okay I love that all these woman show up and stand up to say fuck you to an abusive man even when they're scared", false],
    ["I'm so scared right now", true],
    ["my ankle is still aching", true],
    ["I feel sick", true],
  ])("%s -> %s", (t, want) => {
    expect(hasDistress(t)).toBe(want);
  });
});

describe('"Dre, in" is the whole message only', () => {
  const re = buildRoomOverrideTrigger(["drevan", "drev", "dre"]);
  it.each([
    ["Dre, in", "in"], ["dre in", "in"], ["Drevan, in.", "in"], ["Dre: out!", "out"], ["  drev in  ", "in"],
  ])("%s", (t, want) => {
    expect(re.exec(t)?.[1]?.toLowerCase()).toBe(want);
  });
  it.each(["Dre in the kitchen", "Dre, in a minute", "is Dre in?", "Cy, in"])("not: %s", (t) => {
    expect(re.test(t)).toBe(false);
  });
});
