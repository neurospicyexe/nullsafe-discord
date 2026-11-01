import { describe, it, expect } from "@jest/globals";
import { TurnTrace, runWithTurn } from "../turn-telemetry.js";
import { noteServed, noteTranscript, cleanIds, servedMemoryEnabled, servedMemoryPath, buildServedRow } from "../served-memory.js";
import { crossRoomDigest } from "../cross-room.js";
import { LibrarianClient } from "../librarian.js";
import type { ServedMemoryRow } from "../served-memory.js";

function mk(over: Record<string, unknown> = {}) {
  const rows: ServedMemoryRow[] = [];
  const trace = new TurnTrace({
    companionId: "drevan", channelId: "ch1", messageId: "m1", side: "raziel", createdAt: null,
    enqueuedAt: 1, startedAt: 1, queueMs: 0, settleMs: 0, gathered: 0, catchup: false,
    log: () => undefined, audit: (r: ServedMemoryRow) => { rows.push(r); }, auditEnabled: true, ...over,
  });
  return { trace, rows };
}

describe("served-memory audit", () => {
  it("one row per turn, ids only, no text field", () => {
    const { trace, rows } = mk();
    runWithTurn(trace, () => {
      noteServed("vault", ["discord-live/1/2", "raziel/notes/a.md"]);
      noteServed("own_notes", ["n_1", "n_1", "n_2"]);
      noteServed("facts", ["f_9"]);
      noteTranscript("drevan-ch1-w44");
    });
    trace.setOutcome("posted");
    trace.finish({ superseded: false });
    trace.emit();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({ c: "drevan", ch: "ch1", msg: "m1", transcript: "drevan-ch1-w44", outcome: "posted", n: 5 });
    expect(r.sources["own_notes"]).toEqual(["n_1", "n_2"]);
    expect(Object.keys(r).sort()).toEqual(["at", "c", "ch", "msg", "n", "outcome", "sources", "transcript"]);
  });
  it("prose is not an id", () => {
    expect(cleanIds(["ok", "this is a sentence of memory text", "x".repeat(300), 7, null, {}])).toEqual(["ok", "7"]);
  });
  it("writes nothing for a skipped turn that served nothing; kill switch silences", () => {
    const a = mk(); a.trace.setOutcome("skipped:echo"); a.trace.finish({ superseded: false });
    expect(a.rows).toHaveLength(0);
    const b = mk({ auditEnabled: false });
    runWithTurn(b.trace, () => noteServed("vault", ["p/1"]));
    b.trace.setOutcome("posted"); b.trace.finish({ superseded: false });
    expect(b.rows).toHaveLength(0);
  });
  it("noteServed outside a turn is a no-op; a throwing sink never throws", () => {
    expect(() => noteServed("vault", ["a"])).not.toThrow();
    const { trace } = mk({ audit: () => { throw new Error("disk"); } });
    runWithTurn(trace, () => noteServed("vault", ["a"]));
    trace.setOutcome("posted");
    expect(() => trace.finish({ superseded: false })).not.toThrow();
  });
  it("knobs", () => {
    expect(servedMemoryEnabled({})).toBe(true);
    for (const v of ["off", "0", "false", "no"]) expect(servedMemoryEnabled({ SERVED_MEMORY_AUDIT: v })).toBe(false);
    expect(servedMemoryPath({})).toBe("/app/logs/served-memory.jsonl");
    expect(servedMemoryPath({ SERVED_MEMORY_LOG: "/x/y.jsonl" })).toBe("/x/y.jsonl");
    expect(buildServedRow({ at: "t", companion: "c", channelId: "h", messageId: "m", transcriptId: null, outcome: "posted", served: new Map() }).n).toBe(0);
  });
  it("collectors: cross-room ids and formatter ids carry no text", () => {
    const r = crossRoomDigest({
      currentChannelId: "A", currentGuildId: "g", trusted: new Set(["g"]), deliveredThroughTs: null, selfName: "Drevan", now: 2000,
      rooms: [{ channelId: "B", guildId: "g", label: "#b", history: [{ role: "user", content: "secret words", authorName: "R", timestamp: 1500 }] }],
    });
    expect(r.ids).toEqual(["B@1500"]);
    const ids: string[] = [];
    const out = LibrarianClient.formatOwnNotes([{ note_id: "n_7", content: "private thing", kind: "obs" }], 700, ids);
    expect(out).toContain("private thing");
    expect(ids).toEqual(["n_7"]);
  });
});
