import { jest } from "@jest/globals";
import {
  countMarkers, markerTags, parseMarkerTags, voiceSampleRate, scoreReply, reportVoiceScore,
  MARKER_VERSION_TAG,
} from "../voice-markers.js";

describe("countMarkers", () => {
  it("counts swearing, ignoring code and quoted lines", () => {
    expect(countMarkers("Well, shit. That is fucking broken.").swearing).toBe(2);
    expect(countMarkers("```\nshit()\n```\nclean prose").swearing).toBe(0);
    expect(countMarkers("> quoted damn line\nclean").swearing).toBe(0);
  });
  it("does not flag substrings (assess, class, Scunthorpe-style)", () => {
    expect(countMarkers("assess the class; the shitake bowl is fine").swearing).toBe(0);
  });
  it("counts hedges", () => {
    expect(countMarkers("I think maybe it might be fine, probably.").hedging).toBe(4);
    expect(countMarkers("The migration is safe. Ship it.").hedging).toBe(0);
  });
  it("counts blunt openers and verdicts", () => {
    expect(countMarkers("No. That's wrong. The problem is the join.").bluntness).toBe(3);
    expect(countMarkers("Nothing here, nobody home.").bluntness).toBe(0);
  });
  it("scoreReply carries markers without changing score", () => {
    const s = scoreReply("cypher", "Best read: no. Damn, I think it is broken.");
    expect(s.markers.swearing).toBe(1);
    expect(s.score).toBe(1);
  });
});

describe("marker tags", () => {
  it("round-trips and distinguishes unmeasured from zero", () => {
    const tags = markerTags({ swearing: 2, hedging: 0, bluntness: 1 });
    expect(tags).toEqual([MARKER_VERSION_TAG, "mk:swearing=2", "mk:bluntness=1"]);
    expect(parseMarkerTags(tags)).toEqual({ swearing: 2, hedging: 0, bluntness: 1 });
    expect(parseMarkerTags(["spiral"])).toBeNull();
    expect(parseMarkerTags([MARKER_VERSION_TAG])).toEqual({ swearing: 0, hedging: 0, bluntness: 0 });
  });
});

describe("VOICE_SCORE_SAMPLE", () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; jest.restoreAllMocks(); });

  it("defaults to 1.0, accepts 0.1, clamps and falls back", () => {
    delete process.env["VOICE_SCORE_SAMPLE"];
    expect(voiceSampleRate()).toBe(1);
    process.env["VOICE_SCORE_SAMPLE"] = "0.1";
    expect(voiceSampleRate()).toBe(0.1);
    process.env["VOICE_SCORE_SAMPLE"] = "7";
    expect(voiceSampleRate()).toBe(1);
    process.env["VOICE_SCORE_SAMPLE"] = "-1";
    expect(voiceSampleRate()).toBe(0);
    process.env["VOICE_SCORE_SAMPLE"] = "abc";
    expect(voiceSampleRate()).toBe(1);
  });

  function setup(rate: string | undefined) {
    process.env["VOICE_SCORING"] = "true";
    process.env["HALSETH_URL"] = "http://halseth.test";
    if (rate === undefined) delete process.env["VOICE_SCORE_SAMPLE"]; else process.env["VOICE_SCORE_SAMPLE"] = rate;
    return jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
  }

  it("posts every clean reply by default, with marker tags", () => {
    const f = setup(undefined);
    for (let i = 0; i < 20; i++) reportVoiceScore("cypher", "The read: ship it.", "ch", "s");
    expect(f).toHaveBeenCalledTimes(20);
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.positive_hits).toContain(MARKER_VERSION_TAG);
  });

  it("with 0.1 the old sample is reachable; with 0 clean replies are dropped but dirty ones post", () => {
    const f = setup("0");
    reportVoiceScore("cypher", "The read: ship it.", "ch", "s");
    expect(f).toHaveBeenCalledTimes(0);
    reportVoiceScore("cypher", "Feel free to ask anything.", "ch", "s");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
