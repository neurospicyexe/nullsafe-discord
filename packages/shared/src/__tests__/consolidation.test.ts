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
    expect(mockLibrarian.ask).toHaveBeenCalledWith("my state");
    expect(mockInference.generate).toHaveBeenCalledTimes(1);
    expect(mockLibrarian.writeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String), summary: expect.any(String) }),
    );
  });

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
