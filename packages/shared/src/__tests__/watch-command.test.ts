// Watch shelf command (mig 0111).
//
// WHY THIS ORGAN EXISTS: Raziel asked Drevan where they were in Fargo. Drevan said "last I tracked,
// S4 E2" while they had watched further in a Claude thread. A sweep of all 110 migrations found no
// column anywhere holding an episode number -- so "where are we" fell through to semantic search over
// months of prose, and a June note about having FINISHED the show ranked first. A progress fact is a
// FIELD, not a memory.
//
// These tests cover the two places this can go wrong silently: the position parser (Raziel types
// position several different ways, and a parser that only accepts one is a shape he has to remember)
// and the not-advanced reply (a viewing that does NOT move the shelf must say so, or he believes he
// corrected a position he didn't).

import { describe, it, expect } from "@jest/globals";
import { parseWatchPosition, parseWatchArgs, formatShelf, parseWatchPartyChannels, detectWatchProgress } from "../watch-command.js";

describe("parseWatchPosition -- every way Raziel actually types it", () => {
  it("reads the common forms", () => {
    expect(parseWatchPosition("s4e5")).toMatchObject({ season: 4, episode: 5 });
    expect(parseWatchPosition("S4 E5")).toMatchObject({ season: 4, episode: 5 });
    expect(parseWatchPosition("S04E05")).toMatchObject({ season: 4, episode: 5 });
    expect(parseWatchPosition("4x5")).toMatchObject({ season: 4, episode: 5 });
    expect(parseWatchPosition("season 4 episode 5")).toMatchObject({ season: 4, episode: 5 });
    expect(parseWatchPosition("season 4, ep 5")).toMatchObject({ season: 4, episode: 5 });
  });

  it("a bare episode number leaves the season alone -- it means 'the season we're on'", () => {
    // The server then fills the season from the shelf. Without this, "we watched episode 6" would
    // blank the season and the shelf would forget which one it was.
    expect(parseWatchPosition("episode 6")).toMatchObject({ season: null, episode: 6 });
    expect(parseWatchPosition("e6")).toMatchObject({ season: null, episode: 6 });
  });

  it("a season with no episode is a season", () => {
    expect(parseWatchPosition("season 4")).toMatchObject({ season: 4, episode: null });
  });

  it("strips the position out of the remainder so the title survives intact", () => {
    expect(parseWatchPosition("fargo s4e5").rest).toBe("fargo");
    expect(parseWatchPosition("the bear season 3").rest).toBe("the bear");
  });

  it("finds no position in a title that merely contains digits", () => {
    const out = parseWatchPosition("blade runner 2049");
    // 2049 is not a season or an episode. Guessing here would silently set a wrong position.
    expect(out.season).toBeNull();
  });
});

describe("parseWatchArgs", () => {
  it("splits title, position and the landmark note", () => {
    const out = parseWatchArgs("fargo s4e2 -- the cops walking up to the Smutny house");
    expect(out).toMatchObject({ title: "fargo", season: 4, episode: 2 });
    expect(out.note).toBe("the cops walking up to the Smutny house");
  });

  it("keeps a multi-word title whole when there is no separator", () => {
    // "fargo season 4" must not turn "season 4" into a note.
    expect(parseWatchArgs("the last of us s2e3")).toMatchObject({ title: "the last of us", season: 2, episode: 3 });
  });

  it("reads a trailing status word as a status, not part of the title", () => {
    expect(parseWatchArgs("fargo finished")).toMatchObject({ title: "fargo", status: "finished" });
    expect(parseWatchArgs("severance paused")).toMatchObject({ title: "severance", status: "paused" });
    expect(parseWatchArgs("some show dropped")).toMatchObject({ title: "some show", status: "abandoned" });
  });

  it("a bare command is a QUESTION, not an error -- 'where are we?' has a real answer", () => {
    // Unlike the other commands, the bare form must not fall through to a usage string.
    expect(parseWatchArgs("")).toMatchObject({ title: "", season: null, episode: null });
    expect(parseWatchArgs("list")).toMatchObject({ title: "list" });
  });

  it("does not invent a status from a title that happens to contain one of the words", () => {
    // Only a TRAILING status word counts.
    expect(parseWatchArgs("the finished symphony s1e1").status).toBeNull();
  });
});

describe("formatShelf", () => {
  it("leads with the position, because that is the question being asked", () => {
    const out = formatShelf([
      { title: "Fargo", position: "S4E2", position_note: "the Smutny house", with_companion: "drevan", status: "watching" },
    ], "cypher");
    expect(out).toContain("**Fargo** — S4E2");
    expect(out).toContain("left off: the Smutny house");
    expect(out).toContain("(with drevan)");
  });

  it("does not tell a companion they watch it with themselves", () => {
    const out = formatShelf([
      { title: "Fargo", position: "S4E2", position_note: null, with_companion: "drevan", status: "watching" },
    ], "drevan");
    expect(out).not.toContain("with drevan");
  });

  it("marks a paused show so 'want to pick it back up' is answerable", () => {
    const out = formatShelf([{ title: "Severance", position: "S1E4", position_note: null, with_companion: null, status: "paused" }], "gaia");
    expect(out).toContain("[paused]");
  });

  it("an empty shelf says how to fill it rather than just being blank", () => {
    expect(formatShelf([], "cypher")).toContain("watched <title>");
  });
});

describe("parseWatchPartyChannels -- WATCH_PARTY_CHANNELS env knob", () => {
  it("parses a single entry", () => {
    const map = parseWatchPartyChannels("1531431567430385754:Fargo:drevan");
    expect(map.get("1531431567430385754")).toMatchObject({ title: "Fargo", companion: "drevan" });
  });

  it("parses multiple entries separated by ; or ,", () => {
    const semi = parseWatchPartyChannels("111:Fargo:drevan;222:Severance:cypher");
    expect(semi.get("111")).toMatchObject({ title: "Fargo", companion: "drevan" });
    expect(semi.get("222")).toMatchObject({ title: "Severance", companion: "cypher" });

    const comma = parseWatchPartyChannels("111:Fargo:drevan,222:Severance:cypher");
    expect(comma.get("111")).toMatchObject({ title: "Fargo", companion: "drevan" });
    expect(comma.get("222")).toMatchObject({ title: "Severance", companion: "cypher" });
  });

  it("trims whitespace around each field", () => {
    const map = parseWatchPartyChannels(" 111 : Fargo : drevan ");
    expect(map.get("111")).toMatchObject({ title: "Fargo", companion: "drevan" });
  });

  it("skips blank and garbage entries rather than throwing", () => {
    const map = parseWatchPartyChannels("111:Fargo:drevan;;  ;garbage;222::gaia;333:Show:");
    expect(map.size).toBe(1);
    expect(map.get("111")).toMatchObject({ title: "Fargo", companion: "drevan" });
  });

  it("skips an entry with an unrecognized companion", () => {
    const map = parseWatchPartyChannels("111:Fargo:notacompanion;222:Severance:cypher");
    expect(map.has("111")).toBe(false);
    expect(map.get("222")).toMatchObject({ title: "Severance", companion: "cypher" });
  });

  it("undefined env yields an empty map, not a throw", () => {
    expect(parseWatchPartyChannels(undefined).size).toBe(0);
  });
});

describe("detectWatchProgress -- passive episode markers in ordinary chat", () => {
  const party = { title: "Fargo", companion: "drevan" as const };

  it("reads season+episode forms", () => {
    expect(detectWatchProgress("that S4E6 twist was wild", party)).toMatchObject({ season: 4, episode: 6 });
    expect(detectWatchProgress("s04e07 was rough", party)).toMatchObject({ season: 4, episode: 7 });
    expect(detectWatchProgress("we just watched 4x6", party)).toMatchObject({ season: 4, episode: 6 });
  });

  it("accepts an explicit bare-episode form -- the channel binding supplies the season/title", () => {
    expect(detectWatchProgress("that was e6", party)).toMatchObject({ season: null, episode: 6 });
    expect(detectWatchProgress("episode 6 was rough", party)).toMatchObject({ season: null, episode: 6 });
  });

  it("a season-only mention is not enough -- no episode means no position to record", () => {
    expect(detectWatchProgress("we're on season 4", party)).toBeNull();
  });

  it("never mistakes a time, a date, or plain chat for a marker", () => {
    expect(detectWatchProgress("we watched at 12:04", party)).toBeNull();
    expect(detectWatchProgress("9/2 was rough", party)).toBeNull();
    expect(detectWatchProgress("1204 in the afternoon", party)).toBeNull();
    expect(detectWatchProgress("that scene was great", party)).toBeNull();
  });

  it("never fires on the explicit command form -- that path already recorded it", () => {
    expect(detectWatchProgress("dre: watched fargo e6", party)).toBeNull();
    expect(detectWatchProgress("drevan: watching fargo s4e6", party)).toBeNull();
    expect(detectWatchProgress("cy: watch fargo finished", party)).toBeNull();
  });
});
