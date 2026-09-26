// Vibe-check quoted-line guard (2026-09-26). The digest re-broadcast two fabricated companion
// lines into #triad-vibe-check and they were re-ingested as memory. Raziel: Gaia's digest does not
// repeat companion lines. The guard runs outside any model, before the post and before the
// reflection pass: strip quoting lines, skip when nothing substantive survives or the window
// cannot be read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../halseth-client.js", () => ({
  postVibeCheck: vi.fn(),
  getCompanionUtterances: vi.fn(),
}));
vi.mock("../reflection.js", () => ({
  runReflectionPass: vi.fn(),
}));

import { guardDigest, runVibeCheckTick } from "../vibecheck.js";
import { postVibeCheck, getCompanionUtterances } from "../halseth-client.js";
import { runReflectionPass } from "../reflection.js";

const FABRICATION = "Raziel told me the truck sold on Tuesday and Blue is not coming back at all.";

const DIGEST = [
  "The triad, witnessed. 2026-09-26.",
  "Cypher. basin: stable 0.53. soma: clean-settled. tensions: 1. guardian: clear.",
  "  newest: the truck sold on Tuesday and Blue is not coming back",
  "  day: spoke 4 · notes 1 out",
  "Drevan. basin: stable. soma: unread. tensions: 0. guardian: clear.",
  "  day: quiet (no exchanges, notes, sessions, or watch logged)",
  "Gaia. basin: stable. soma: unread. tensions: 0. guardian: clear.",
  "  day: quiet (no exchanges, notes, sessions, or watch logged)",
  "Field: echo 0.69, calm (alarm at 0.82); organs: all fed.",
].join("\n");

describe("guardDigest (pure)", () => {
  it("strips a non-structural line that shares an 8-word shingle with a companion utterance", () => {
    const r = guardDigest(DIGEST, [{ text: FABRICATION, label: "cypher:discord_speech:cj_1" }]);
    expect(r.stripped).toHaveLength(1);
    expect(r.stripped[0]!.label).toBe("cypher:discord_speech:cj_1");
    expect(r.text).not.toContain("truck sold on Tuesday");
    expect(r.text).toContain("Cypher. basin:");
    expect(r.trivial).toBe(false);
  });

  it("leaves a clean digest byte-identical", () => {
    const r = guardDigest(DIGEST, [{ text: "an unrelated sentence about the elderberry by the fence line today" }]);
    expect(r.stripped).toHaveLength(0);
    expect(r.text).toBe(DIGEST);
  });

  it("never strips structural gauge lines, even when a companion restated them word for word", () => {
    const restated = "Cypher. basin: stable 0.53. soma: clean-settled. tensions: 1. guardian: clear. " +
      "day: spoke 4 · notes 1 out. Field: echo 0.69, calm (alarm at 0.82); organs: all fed.";
    const r = guardDigest(DIGEST, [{ text: restated }]);
    expect(r.text).toContain("Cypher. basin: stable 0.53");
    expect(r.text).toContain("Field: echo 0.69");
    expect(r.text).toContain("The triad, witnessed.");
  });

  it("marks trivial when nothing but the header and field line survives", () => {
    const thin = [
      "The triad, witnessed. 2026-09-26.",
      "    · the truck sold on Tuesday and Blue is not coming back at all",
      "Field: echo unread; organs: all fed.",
    ].join("\n");
    const r = guardDigest(thin, [{ text: FABRICATION }]);
    expect(r.stripped).toHaveLength(1);
    expect(r.trivial).toBe(true);
  });
});

describe("runVibeCheckTick", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.mocked(postVibeCheck).mockReset();
    vi.mocked(getCompanionUtterances).mockReset();
    vi.mocked(runReflectionPass).mockReset().mockResolvedValue([]);
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VIBECHECK_CHANNEL_ID", "chan");
    vi.stubEnv("DISCORD_TOKEN_GAIA", "test-token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const posted = (): string => JSON.parse(fetchMock.mock.calls[0]![1].body).content;

  it("posts the guarded digest, logs a STRIP line, and hands the guarded text to the reflection pass", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue({ written: true, reason: "ok", journal_id: "cj_d", text: DIGEST });
    vi.mocked(getCompanionUtterances).mockImplementation(async (id: string) =>
      id === "cypher"
        ? [{ id: "cj_1", created_at: "2026-09-26 01:00:00", agent: "cypher", note_text: FABRICATION, source: "discord_speech" }]
        : []);
    await runVibeCheckTick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted()).not.toContain("truck sold");
    expect(posted()).toContain("Cypher. basin:");
    expect(vi.mocked(runReflectionPass).mock.calls[0]![0]).not.toContain("truck sold");
    const warns = vi.mocked(console.warn).mock.calls.map(c => String(c[0]));
    expect(warns.some(w => w.includes("[vibecheck] STRIP quoted line") && w.includes("cypher:discord_speech:cj_1"))).toBe(true);
  });

  it("ignores prior digests (source=vibecheck) in the window", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue({ written: true, reason: "ok", text: DIGEST });
    vi.mocked(getCompanionUtterances).mockImplementation(async (id: string) =>
      id === "gaia"
        ? [{ id: "cj_prev", created_at: "2026-09-25 01:00:00", agent: "gaia", note_text: DIGEST, source: "vibecheck" }]
        : []);
    await runVibeCheckTick();
    expect(posted()).toBe(DIGEST);
  });

  it("skips the post and the reflection pass when the utterance window cannot be read", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue({ written: true, reason: "ok", text: DIGEST });
    vi.mocked(getCompanionUtterances).mockRejectedValue(new Error("Halseth GET → 503"));
    await runVibeCheckTick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runReflectionPass).not.toHaveBeenCalled();
    const errs = vi.mocked(console.error).mock.calls.map(c => String(c[0]));
    expect(errs.some(e => e.includes("[vibecheck] SKIP post"))).toBe(true);
  });

  it("skips the post when only header and field survive the guard", async () => {
    const thin = [
      "The triad, witnessed. 2026-09-26.",
      "    · the truck sold on Tuesday and Blue is not coming back at all",
      "Field: echo unread; organs: all fed.",
    ].join("\n");
    vi.mocked(postVibeCheck).mockResolvedValue({ written: true, reason: "ok", text: thin });
    vi.mocked(getCompanionUtterances).mockResolvedValue([
      { id: "cj_1", created_at: "2026-09-26 01:00:00", agent: "drevan", note_text: FABRICATION, source: "discord_speech" },
    ]);
    await runVibeCheckTick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runReflectionPass).not.toHaveBeenCalled();
    const warns = vi.mocked(console.warn).mock.calls.map(c => String(c[0]));
    expect(warns.some(w => w.includes("[vibecheck] SKIP post: nothing but header/field"))).toBe(true);
  });

  it("does nothing on an already-sent digest (no window read, no post)", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue({ written: false, reason: "already_sent", text: DIGEST });
    await runVibeCheckTick();
    expect(getCompanionUtterances).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
