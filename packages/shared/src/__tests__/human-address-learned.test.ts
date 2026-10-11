import {
  nameTokensFromFront, learnHumanName, learnedHumanNames, mergeHumanNames,
  resetLearnedNameCache, humanGate, humanNamesFromEnv,
} from "../human-address.js";

function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  return {
    sets,
    async sadd(k: string, ...m: string[]) { const s = sets.get(k) ?? new Set(); m.forEach(x => s.add(x)); sets.set(k, s); return m.length; },
    async smembers(k: string) { return [...(sets.get(k) ?? [])]; },
  };
}

beforeEach(() => resetLearnedNameCache());

describe("nameTokensFromFront (learn Blue's fronts from PK proxies)", () => {
  it("first name plus quoted nickname, system tag stripped", () => {
    expect(nameTokensFromFront("Rosalind ‘Birdy’ M. || 🍂").sort()).toEqual(["birdy", "rosalind"]);
  });
  it("parenthetical dropped", () => {
    expect(nameTokensFromFront("Dave (the best one) || 🍂")).toEqual(["dave"]);
  });
  it("plain single names", () => {
    expect(nameTokensFromFront("Logan || 🍂")).toEqual(["logan"]);
    expect(nameTokensFromFront("Mituna Captor || 🍂")).toEqual(["mituna"]);
  });
  it("stop words and short tokens never become names", () => {
    expect(nameTokensFromFront("The Archivist || 🍂")).toEqual([]);
    expect(nameTokensFromFront("Al || 🍂")).toEqual([]);
    expect(nameTokensFromFront("Guy || 🍂")).toEqual([]);
  });
  it("empty / null", () => {
    expect(nameTokensFromFront(null)).toEqual([]);
    expect(nameTokensFromFront("")).toEqual([]);
  });
});

describe("learned names reach the gate", () => {
  it("a learned front name silences the triad when Raziel calls it", async () => {
    const r = fakeRedis();
    await learnHumanName(r, "blue", "Rosalind ‘Birdy’ M. || 🍂");
    const learned = await learnedHumanNames(r, "blue");
    expect(learned.sort()).toEqual(["birdy", "rosalind"]);
    const names = mergeHumanNames(humanNamesFromEnv({}), { blue: learned });
    const v = humanGate({
      tier: "owner", texts: ["Birdy, are you coming to bed?"], names,
      companionMentioned: false, replyToCompanion: false, mentionedHumans: [], blueHolder: null,
    });
    expect(v).toEqual({ kind: "silent", addressee: "blue" });
  });

  it("an unlearned name does not silence (no static guessing)", async () => {
    const names = mergeHumanNames(humanNamesFromEnv({}), { blue: [] });
    const v = humanGate({
      tier: "owner", texts: ["Birdy, are you coming to bed?"], names,
      companionMentioned: false, replyToCompanion: false, mentionedHumans: [], blueHolder: null,
    });
    expect(v).toEqual({ kind: "proceed" });
  });

  it("learned names are shared through Redis and survive a cache reset (new bot process)", async () => {
    const r = fakeRedis();
    await learnHumanName(r, "blue", "Gunnar Sorrensson || 🍂");
    resetLearnedNameCache();
    expect(await learnedHumanNames(r, "blue")).toEqual(["gunnar"]);
  });

  it("no redis: learning is a no-op and nothing throws", async () => {
    expect(await learnHumanName(null, "blue", "Logan || 🍂")).toEqual(["logan"]);
    expect(await learnedHumanNames(null, "blue")).toEqual([]);
  });

  it("a front named after a companion-name context still lets a named companion through", async () => {
    const names = mergeHumanNames(humanNamesFromEnv({}), { blue: ["logan"] });
    const v = humanGate({
      tier: "owner", texts: ["Logan and Dre, look at this"], names,
      companionMentioned: false, replyToCompanion: false, mentionedHumans: [], blueHolder: null,
    });
    expect(v).toEqual({ kind: "proceed" });
  });
});
