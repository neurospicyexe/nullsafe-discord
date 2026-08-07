import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { consolidateSession } from "../consolidation.js";

const mockState = "SOMA: present. Tensions: none. Recent: a session of code and presence.";

const validHandoffJson = JSON.stringify({
  title: "A session of code and presence.",
  summary: "We worked through the consolidation bridge. Something settled.",
  state_hint: "at_rest",
});

const mockLibrarian = {
  ask: jest.fn<() => Promise<string>>().mockResolvedValue(mockState),
  writeHandoff: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

const mockInference = {
  generate: jest.fn<() => Promise<string | null>>().mockResolvedValue(validHandoffJson),
};

describe("consolidateSession", () => {
  beforeEach(() => jest.clearAllMocks());

  test("reads state then writes handoff on happy path", async () => {
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result.written).toBe(true);
    // "companion states" is an EXACT triad_state_read trigger: three plain SELECTs, no session
    // INSERT, no note consumption. The old bare "my state" matched no fast-path trigger at all
    // (triggerMatches needs the trigger inside the input) so the classifier routed it to
    // state_update -- a WRITE -- which returned an error for 34 days.
    // Asserted as a single argument on purpose: passing a surface here would mean this call opens
    // a session, and a handoff writer running 12x/day must not.
    expect(mockLibrarian.ask).toHaveBeenCalledWith("companion states");
    expect(mockInference.generate).toHaveBeenCalledTimes(1);
    // The gateway session must be pinned, or api_server hashes our near-identical prompt into one
    // shared synthetic session (it accumulated 1403 messages before this) -- AND the pin must carry
    // a UTC date so the lane rotates daily (2026-08-07; see the rotation test below for why).
    expect(mockInference.generate).toHaveBeenCalledWith(
      expect.any(String), expect.any(Array), expect.any(Number), expect.any(Number),
      `consolidation:cypher:${new Date().toISOString().slice(0, 10)}`,
    );
    expect(mockLibrarian.writeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String), summary: expect.any(String) }),
    );
  });

  // ── The 2026-08-07 unbounded-lane regression ────────────────────────────────
  //
  // The pin was correct and incomplete: a STATIC lane name is a rail with no decay. It solved the
  // hash-collision problem and became the same problem slower, because nothing ever ended the lane.
  // Measured on the VPS that day: one stored user message of 3.24 MB containing 713 nested copies
  // of this prompt (~4.7 KB each) -- 713 five-minute ticks, ~2.5 days, during a stretch where every
  // call 402'd so nothing ever succeeded to break the chain. Our side sent ~5 KB; the gateway grew
  // the rest. Three of those, one per companion, were a meaningful slice of a disk that hit 100%
  // and took the whole triad offline for two days.
  //
  // Hermes' own `session_reset: idle` (idle_minutes 1440) cannot rescue THIS lane specifically: a
  // job on a 5-minute cron is never idle for 24h. Channel sessions do go idle and are covered by
  // the config; this one has to spend its own reset. Same family as [[rails-need-decay]].
  it("rotates the gateway lane daily -- a cron that never goes idle must end its own session", () => {
    const key = (d: Date) => `consolidation:cypher:${d.toISOString().slice(0, 10)}`;
    const day1 = new Date("2026-08-07T23:59:00Z");
    const day2 = new Date("2026-08-08T00:01:00Z");
    // Two minutes apart, but a different lane -- the accumulation cannot cross the boundary.
    expect(key(day1)).not.toBe(key(day2));
    // Same day, twelve hours apart -- SAME lane, so a day's consolidations still share context
    // and the pin keeps doing the job it was added for.
    expect(key(new Date("2026-08-07T00:05:00Z"))).toBe(key(new Date("2026-08-07T12:05:00Z")));
    // Companion separation survives rotation -- lanes must never merge across companions.
    expect(key(day1)).not.toBe(`consolidation:drevan:${day1.toISOString().slice(0, 10)}`);
    // UTC, not local: the VPS logs in CDT, and a local boundary would rotate at a different
    // instant than every other date-keyed thing in the suite.
    expect(key(new Date("2026-08-08T02:00:00Z"))).toContain("2026-08-08");
  });

  // ── The 2026-08-03 flow-audit regression ────────────────────────────────────
  // librarian.ask resolves (HTTP 200) on application-level declines, so `{error, reason}` sailed
  // past the try/catch and was handed to the companion as "Current companion state:". Every one of
  // 315/318/317 runs since 2026-06-30 narrated that error, and the resulting handoff displaced the
  // real one in the slot the boot header reads.
  test("ABORTS on a declined state read instead of narrating the error as state", async () => {
    mockLibrarian.ask.mockResolvedValueOnce({
      error: "state_update_failed",
      reason: "no fields provided; pass at least one of: soma_float_1/acuity/stillness, ...",
    } as never);

    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });

    expect(result).toEqual({ written: false, reason: "state_declined" });
    // Abort must happen BEFORE inference: the agent turn writes its own handoff row mid-turn via
    // ask_librarian (source=system), so skipping only our write would leave that one landing.
    expect(mockInference.generate).not.toHaveBeenCalled();
    expect(mockLibrarian.writeHandoff).not.toHaveBeenCalled();
  });

  test.each([["", "empty string"], ["   ", "blank"], ["{}", "empty object"]])(
    "skips the handoff when the state read returns %p (%s) rather than inventing one",
    async (state) => {
      mockLibrarian.ask.mockResolvedValueOnce(state as never);
      const result = await consolidateSession({
        companionId: "gaia",
        librarian: mockLibrarian as any,
        inference: mockInference as any,
      });
      expect(result).toEqual({ written: false, reason: "state_empty" });
      expect(mockInference.generate).not.toHaveBeenCalled();
      expect(mockLibrarian.writeHandoff).not.toHaveBeenCalled();
    },
  );

  test("returns state_error when librarian.ask throws", async () => {
    mockLibrarian.ask.mockRejectedValueOnce(new Error("network"));
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("state_error");
    expect(mockInference.generate).not.toHaveBeenCalled();
  });

  test("returns inference_empty when inference returns null", async () => {
    mockInference.generate.mockResolvedValueOnce(null);
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("inference_empty");
  });

  test("returns parse_error when inference returns invalid JSON", async () => {
    mockInference.generate.mockResolvedValueOnce("not json");
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("parse_error");
  });

  test("prose reply (the live crash class) skips gracefully: parse_error, no throw, no write", async () => {
    mockInference.generate.mockResolvedValueOnce("I know you asked for a handoff, and I want to honor that properly...");
    const result = await consolidateSession({
      companionId: "drevan",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result).toEqual({ written: false, reason: "parse_error" });
    expect(mockLibrarian.writeHandoff).not.toHaveBeenCalled();
  });

  test("JSON embedded in prose still writes the handoff", async () => {
    mockInference.generate.mockResolvedValueOnce(`Handoff written. Here it is:\n${validHandoffJson}\nRest well.`);
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result.written).toBe(true);
    expect(mockLibrarian.writeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ title: "A session of code and presence.", state_hint: "at_rest" }),
    );
  });

  test("truncated JSON (max_tokens cutoff) skips gracefully: parse_error, no write", async () => {
    mockInference.generate.mockResolvedValueOnce('{"title":"A session of code","summary":"We worked through');
    const result = await consolidateSession({
      companionId: "gaia",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result).toEqual({ written: false, reason: "parse_error" });
    expect(mockLibrarian.writeHandoff).not.toHaveBeenCalled();
  });

  test("non-string state_hint is dropped, not written", async () => {
    mockInference.generate.mockResolvedValueOnce('{"title":"T","summary":"S","state_hint":{"weird":true}}');
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result.written).toBe(true);
    // `source: "consolidation"` rides every consolidation write (2026-08-01). It marks a machine summary
    // of an idle window so a reader can prefer a real session close over it -- consolidations fire on
    // quiet, so they were almost always the most recent handoff, which made "last session" at orient mean
    // a note about silence rather than a conversation with Raziel.
    expect(mockLibrarian.writeHandoff).toHaveBeenCalledWith({
      title: "T", summary: "S", state_hint: undefined, source: "consolidation",
    });
  });

  test("strips markdown fences before parsing", async () => {
    mockInference.generate.mockResolvedValueOnce("```json\n" + validHandoffJson + "\n```");
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result.written).toBe(true);
  });

  test("returns librarian_error when writeHandoff throws", async () => {
    mockLibrarian.writeHandoff.mockRejectedValueOnce(new Error("write failed"));
    const result = await consolidateSession({
      companionId: "cypher",
      librarian: mockLibrarian as any,
      inference: mockInference as any,
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("librarian_error");
  });
});
