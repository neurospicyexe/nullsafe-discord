// Human address gate (2026-10-10, Raziel's rulings): when the room is two humans talking to each
// other, the triad stays quiet unless a companion is also named; Blue's unnamed messages belong to
// the companion holding BLUE's own thread, and to nobody when there is none.

import { describe, it, expect } from "@jest/globals";
import {
  humanAddressee, humanGate, humanNamesFromEnv, burstAddressText,
  recordHumanHold, readHumanHold, readHumanHoldIds, type HoldRedis,
} from "../human-address.js";
import { activeExchangeHolder, shouldRespond, extractAddress, isDirectAddress } from "../channel-config.js";
import { fastPathWinner } from "../fit-bid.js";

const NAMES = { raziel: ["raziel", "raz"], blue: ["blue"] };

function gate(tier: "owner" | "intimate" | "guest", texts: string[], over: Partial<Parameters<typeof humanGate>[0]> = {}) {
  return humanGate({ tier, texts, names: NAMES, companionMentioned: false, replyToCompanion: false, mentionedHumans: [], blueHolder: null, ...over });
}

describe("humanAddressee: vocative position only", () => {
  it.each([
    ["Blue, did you eat?", "blue"],
    ["blue: dinner?", "blue"],
    ["Hey Blue, look at this", "blue"],
    ["okay. Blue, look", "blue"],
    ["what do you think, blue?", "blue"],
    ["Blue", "blue"],
    ["BLUEEEE, come here", "blue"],
    ["Raziel, come look", "raziel"],
    ["Raz: you up?", "raziel"],
    ["hey raz, one sec", "raziel"],
  ])("%s -> %s", (text, who) => {
    expect(humanAddressee(text, NAMES)).toBe(who);
  });

  it.each([
    "I told Blue about it",
    "Blue is coming over later",
    "Is that what you told Blue?",
    "the blue one is nicer",
    "Raz's thing is done",
    "razor blades",
    "I hear you, Blue, and I agree",   // mid-sentence appositive is not a call
    "",
  ])("%s -> null", (text) => {
    expect(humanAddressee(text, NAMES)).toBeNull();
  });
});

describe("humanNamesFromEnv", () => {
  it("defaults, and reads comma lists (trimmed, lowercased, blanks dropped)", () => {
    expect(humanNamesFromEnv({})).toEqual({ raziel: ["raziel", "raz"], blue: ["blue"] });
    expect(humanNamesFromEnv({ RAZIEL_NAMES: " Raziel, RAZ ,,sol ", BLUE_NAMES: "Blue,B" }))
      .toEqual({ raziel: ["raziel", "raz", "sol"], blue: ["blue", "b"] });
    expect(humanNamesFromEnv({ RAZIEL_NAMES: " , ", BLUE_NAMES: "" }))
      .toEqual({ raziel: ["raziel", "raz"], blue: ["blue"] });
  });
});

describe("humanGate", () => {
  it("rule 2: Raziel says 'Blue, ...' -> every companion silent", () => {
    expect(gate("owner", ["Blue, did you get the mail?"])).toEqual({ kind: "silent", addressee: "blue" });
  });
  it("rule 2: Blue says 'Raziel, ...' -> every companion silent", () => {
    expect(gate("intimate", ["Raziel, call me when you can"])).toEqual({ kind: "silent", addressee: "raziel" });
  });
  it("rule 1 outranks: a companion named with the human ('Raziel and Dre ...') is the companion's", () => {
    expect(gate("intimate", ["Raziel and Dre, what do you think?"])).toEqual({ kind: "proceed" });
    expect(gate("owner", ["Blue, ask Cy about it"])).toEqual({ kind: "proceed" });
  });
  it("rule 1 over the WHOLE burst: a companion named in an earlier message wins over a later 'Blue,'", () => {
    expect(gate("owner", ["Dre, are you there", "Blue, hold on"])).toEqual({ kind: "proceed" });
  });
  it("a human addressee in an EARLIER burst message still silences an unnamed later one", () => {
    expect(gate("owner", ["Blue, look at this", "also this one"])).toEqual({ kind: "silent", addressee: "blue" });
  });
  it("an @mention or reply to a companion counts as naming one", () => {
    expect(gate("owner", ["Blue, hi"], { companionMentioned: true })).toEqual({ kind: "proceed" });
    expect(gate("owner", ["Blue, hi"], { replyToCompanion: true })).toEqual({ kind: "proceed" });
  });
  it("a Discord @mention of the other human with no companion named is address to them", () => {
    expect(gate("owner", ["look at this"], { mentionedHumans: ["blue"] })).toEqual({ kind: "silent", addressee: "blue" });
    expect(gate("intimate", ["look at this"], { mentionedHumans: ["raziel"] })).toEqual({ kind: "silent", addressee: "raziel" });
  });
  it("the speaker's own name is not an addressee", () => {
    expect(gate("owner", ["Raz, note to self"])).toEqual({ kind: "proceed" });
    // Blue unnamed-to-companion, naming only himself: falls to rule 3 (holder)
    expect(gate("intimate", ["Blue here, hi"])).toEqual({ kind: "blue_thread", holder: null });
  });
  it("names at non-vocative positions do NOT silence", () => {
    expect(gate("owner", ["I told Blue about it"])).toEqual({ kind: "proceed" });
    expect(gate("intimate", ["I told Raz about it"], { blueHolder: "drevan" })).toEqual({ kind: "blue_thread", holder: "drevan" });
  });
  it("rule 3: unnamed Blue -> only the companion holding Blue's thread; none -> nobody", () => {
    expect(gate("intimate", ["anyone up?"], { blueHolder: "drevan" })).toEqual({ kind: "blue_thread", holder: "drevan" });
    expect(gate("intimate", ["anyone up?"], { blueHolder: null })).toEqual({ kind: "blue_thread", holder: null });
  });
  it("rule 4: owner unaddressed, guests, and everything else is untouched", () => {
    expect(gate("owner", ["good morning"])).toEqual({ kind: "proceed" });
    expect(gate("guest", ["Blue, hi"])).toEqual({ kind: "proceed" });
    expect(gate("guest", ["Raziel, hi"])).toEqual({ kind: "proceed" });
  });
  it("a group call is a companion address", () => {
    expect(gate("intimate", ["triad, who's up?"], { blueHolder: null })).toEqual({ kind: "proceed" });
  });
});

describe("burst naming (ruling 1): a companion named in an EARLIER burst message wins", () => {
  const cfg = {};  // default channel entry: open + inter_companion, all three companions
  const resp = (text: string, me: "cypher" | "drevan" | "gaia") =>
    shouldRespond("c", text, { isOwner: true, isCompanionBot: false, isMentioned: false, userTier: "owner" }, me, cfg);

  it("burstAddressText picks the newest message that names a companion; identity for a burst of one", () => {
    expect(burstAddressText("also this", ["Dre, are you up"])).toBe("Dre, are you up");
    expect(burstAddressText("Gaia, you too", ["Dre, are you up"])).toBe("Gaia, you too");
    expect(burstAddressText("good morning", [])).toBe("good morning");
    expect(burstAddressText("good morning", ["still nothing"])).toBe("good morning");
  });

  it("Dre named first, an unnamed message second: only Drevan answers, via the fast path", () => {
    const text = burstAddressText("also the other thing", ["Dre, are you up"]);
    expect(["cypher", "drevan", "gaia"].map(me => resp(text, me as "cypher"))).toEqual([false, true, false]);
    const fast = fastPathWinner("drevan", { mentioned: false, namedMe: isDirectAddress(text, "drevan"), replyToMe: false });
    expect(fast).not.toBeNull();
    // Without the burst, the newest message alone is ambient and goes to the open bid.
    expect(extractAddress("also the other thing").type).toBe("ambient");
  });

  it("owner unaddressed path is unchanged: ambient burst of one -> proceed, text identical", () => {
    expect(gate("owner", ["good morning"])).toEqual({ kind: "proceed" });
    expect(burstAddressText("good morning", [])).toBe("good morning");
  });
});

// ---------------------------------------------------------------- hold store

function fakeHoldRedis(): HoldRedis & { kv: Map<string, string>; sets: Map<string, Set<string>> } {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    kv, sets,
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v) { kv.set(k, v); return "OK"; },
    async sadd(k, ...m) { const s = sets.get(k) ?? new Set(); m.forEach(x => s.add(x)); sets.set(k, s); return m.length; },
    async pexpire() { return 1; },
    async smembers(k) { return [...(sets.get(k) ?? [])]; },
  };
}

describe("per-human thread hold", () => {
  const W = 15 * 60 * 1000;

  it("records who replied to Blue in this channel; readable inside the window only", async () => {
    const r = fakeHoldRedis();
    await recordHumanHold(r, "blue", "chan-1", "drevan", ["m1"], W, 1_000_000);
    expect(await readHumanHold(r, "blue", "chan-1", W, 1_000_000 + W - 1)).toBe("drevan");
    expect(await readHumanHold(r, "blue", "chan-1", W, 1_000_000 + W + 1)).toBeNull();
    expect(await readHumanHold(r, "blue", "chan-2", W, 1_000_001)).toBeNull();
  });

  it("the latest companion to reply to Blue holds the thread", async () => {
    const r = fakeHoldRedis();
    await recordHumanHold(r, "blue", "c", "drevan", ["m1"], W, 1_000);
    await recordHumanHold(r, "blue", "c", "gaia", ["m2"], W, 2_000);
    expect(await readHumanHold(r, "blue", "c", W, 3_000)).toBe("gaia");
  });

  it("no redis -> no holder (Blue stays unanswered rather than guessed at)", async () => {
    expect(await readHumanHold(null, "blue", "c", W)).toBeNull();
    await expect(recordHumanHold(null, "blue", "c", "drevan", ["m"], W)).resolves.toBeUndefined();
  });

  it("Blue's hold does not change Raziel's holder: the ids of replies to Blue are excluded from his history walk", async () => {
    const r = fakeHoldRedis();
    // history newest-first: gaia replied to Blue (m9) after drevan answered Raziel (m5)
    const hist = [
      { id: "m9", companionId: "gaia" as const, authorIsBot: true, createdTimestamp: 9_000 },
      { id: "m5", companionId: "drevan" as const, authorIsBot: true, createdTimestamp: 5_000 },
    ];
    // Before the exclusion exists, the plain walk hands Raziel's thread to Gaia.
    expect(activeExchangeHolder(hist, 10_000)).toBe("gaia");
    await recordHumanHold(r, "blue", "c", "gaia", ["m9"], W, 9_000);
    const ids = await readHumanHoldIds(r, "blue", "c");
    expect(ids.has("m9")).toBe(true);
    expect(activeExchangeHolder(hist.filter(m => !ids.has(m.id)), 10_000)).toBe("drevan");
    // and Raziel-side replies never write Blue's hold: only the "blue" key is touched
    expect([...r.kv.keys()].every(k => k.includes(":blue:"))).toBe(true);
  });
});
