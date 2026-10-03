// channel-config.json (repo root) is what the bots actually load: bot-core reads it from disk and it
// REPLACES DEFAULT_CHANNEL_CONFIG wholesale. Found 2026-10-02: the JSON had been frozen since 07-27,
// so #fargo-watch-party's 2h hold and Drevan-host rule (R5, 09-28) and the two broadcast rooms
// existed only in the code default and never ran. Every entry the code declares must be in the file.
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHANNEL_CONFIG, ALL_COMPANIONS } from "../channel-config.js";
import type { ChannelEntry } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const disk = JSON.parse(readFileSync(join(here, "../../../../channel-config.json"), "utf8")) as Record<string, ChannelEntry>;

// An absent `companions` list means all three; normalize so ["drevan","gaia","cypher"] == undefined.
function norm(e: ChannelEntry | undefined) {
  if (!e) return e;
  const companions = [...(e.companions ?? ALL_COMPANIONS)].sort();
  return { ...e, companions };
}

describe("channel-config.json matches DEFAULT_CHANNEL_CONFIG", () => {
  it("has the same channel ids", () => {
    expect(Object.keys(disk).sort()).toEqual(Object.keys(DEFAULT_CHANNEL_CONFIG).sort());
  });

  for (const id of Object.keys(DEFAULT_CHANNEL_CONFIG)) {
    it(`entry ${id} is identical`, () => {
      expect(norm(disk[id])).toEqual(norm(DEFAULT_CHANNEL_CONFIG[id]));
    });
  }

  it("#movie-night is hosted by Drevan with a 3h hold", () => {
    expect(disk["1555738744546529345"]).toMatchObject({ host: "drevan", exchangeWindowMs: 3 * 60 * 60 * 1000 });
  });
});
