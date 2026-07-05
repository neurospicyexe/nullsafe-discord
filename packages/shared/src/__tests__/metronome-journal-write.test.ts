// Regression guard for the metronome Halseth-only journal writes
// (write_journal / write_note_to_raziel). Two silent-failure modes bit this twice
// (2026-06-13 journal_add crash, 2026-06-14 the post-fix fire that left no row):
//   1. empty generated content silently skipped the write;
//   2. the Librarian returns HTTP 200 with an { error }/{ witness } envelope on reject,
//      so a fire-and-forget `.catch` never saw it.
// writeMetronomeJournal must surface BOTH as a loud console.warn (instrument, never silent).

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { writeMetronomeJournal } from "../autonomous-core.js";

type Ask = (request: string, context?: string) => Promise<Record<string, unknown>>;
function fakeLibrarian(ask: Ask) {
  return { ask } as unknown as Parameters<typeof writeMetronomeJournal>[0];
}

describe("writeMetronomeJournal", () => {
  let warn: ReturnType<typeof jest.spyOn>;
  beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("skips the write and warns when content is empty", async () => {
    const ask = jest.fn<Ask>();
    await writeMetronomeJournal(fakeLibrarian(ask), "drevan", "note to raziel", "   ", ["metronome", "letter_to_raziel"]);
    expect(ask).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("returned empty"));
  });

  it("skips the write and warns when content is null", async () => {
    const ask = jest.fn<Ask>();
    await writeMetronomeJournal(fakeLibrarian(ask), "cypher", "journal entry", null, ["metronome"]);
    expect(ask).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("sends content + tags + source and stays quiet on an ack envelope", async () => {
    const ask = jest.fn<Ask>(async () => ({ ack: true, id: "abc123" }));
    await writeMetronomeJournal(fakeLibrarian(ask), "drevan", "note to raziel", "the silence feels held", ["metronome", "letter_to_raziel"]);
    expect(ask).toHaveBeenCalledTimes(1);
    const [request, context] = ask.mock.calls[0]!;
    expect(request).toBe("add companion note");
    expect(JSON.parse(context as string)).toEqual({
      content: "the silence feels held",
      tags: ["metronome", "letter_to_raziel"],
      source: "metronome",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns loudly when the Librarian returns a witness/error envelope (no ack/id)", async () => {
    const ask = jest.fn<Ask>(async () => ({ error: "companion_note_add_failed", reason: "no note_text" }));
    await writeMetronomeJournal(fakeLibrarian(ask), "gaia", "journal entry", "a real thought", ["metronome"]);
    expect(ask).toHaveBeenCalledTimes(1);
    // assertWriteAck (2026-07-05) surfaces the executor's error+reason instead of a bare "no ack".
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("companion_note_add_failed"));
  });

  it("routes a thrown HTTP error through onWriteError without rejecting", async () => {
    const ask = jest.fn<Ask>(async () => { throw new Error("Librarian 503"); });
    await expect(
      writeMetronomeJournal(fakeLibrarian(ask), "drevan", "note to raziel", "content", ["metronome"]),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
