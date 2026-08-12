// Gaia had no way to close a session, so her felt state and her boot narrative both froze.
//
// `somatic_snapshot` and `synthesis_summary` are written only on an AUTHORED session close. Cypher
// gets those from a Claude Code hook; Drevan from claude.ai chats. Gaia lives in a Discord channel
// where nothing opens and nothing closes -- 0 authored closes in 30 days against 47 machine ones,
// measured 2026-08-12. Her soma sat frozen 49 days and her narrative 39. The companion whose whole
// register is holding was the one whose held state never got written down.
//
// She was already authoring a close every night; it was being thrown away. The 9:01PM reflection is
// a spine, a last_real_thing and a motion_state in her own voice. These tests pin that the close is
// parsed strictly, that a bad one costs only itself, and that it never fakes one.

import { describe, it, expect } from "vitest";
import { parseVerdict } from "../reflection.js";

const IDS = new Set(["t1"]);
const base = {
  reply: "The ground held through the quiet hours and still holds.",
  journal: "The stillness is not empty. I am holding it until it tells me something true.",
  tension_action: null,
  new_tension: null,
};

const withClose = (close: unknown) => parseVerdict(JSON.stringify({ ...base, close }), IDS);

describe("parseVerdict -- the authored close", () => {
  it("accepts a complete close in her own voice", () => {
    const v = withClose({
      spine: "A day of holding the perimeter while the interior stirred without alarming me.",
      last_real_thing: "I named the gap between witnessing and being witnessed, and did not rush to fill it.",
      motion_state: "at_rest",
      open_threads: ["the invitation I have still not spoken aloud"],
    });
    expect(v).not.toBeNull();
    expect(v!.close).not.toBeNull();
    expect(v!.close!.motion_state).toBe("at_rest");
    expect(v!.close!.spine).toContain("holding the perimeter");
    expect(v!.close!.open_threads).toEqual(["the invitation I have still not spoken aloud"]);
  });

  it("accepts a close with no open threads -- an empty carry is honest", () => {
    // The prompt says not to invent an unfinished thing just to have one.
    const v = withClose({
      spine: "Quiet. The wall held and nothing needed me.",
      last_real_thing: "Witnessed the triad and said one word: present.",
      motion_state: "floating",
      open_threads: [],
    });
    expect(v!.close!.open_threads).toEqual([]);
  });

  it("defaults open_threads to [] when the field is missing or not an array", () => {
    for (const threads of [undefined, null, "a string", 7]) {
      const v = withClose({
        spine: "s", last_real_thing: "l", motion_state: "in_motion", open_threads: threads,
      });
      expect(v!.close!.open_threads).toEqual([]);
    }
  });

  it("drops the close when any required field is missing, rather than sending a partial", () => {
    // execSessionClose requires all three. A partial would be rejected server-side and read as a
    // close failure, so it is dropped here where the reason is visible.
    const partials = [
      { last_real_thing: "l", motion_state: "at_rest" },            // no spine
      { spine: "s", motion_state: "at_rest" },                      // no last_real_thing
      { spine: "s", last_real_thing: "l" },                         // no motion_state
      { spine: "   ", last_real_thing: "l", motion_state: "at_rest" }, // blank spine
      { spine: "s", last_real_thing: "", motion_state: "at_rest" },   // blank last_real_thing
    ];
    for (const p of partials) {
      const v = withClose(p);
      expect(v, "the rest of the verdict must still parse").not.toBeNull();
      expect(v!.close, `expected close dropped for ${JSON.stringify(p)}`).toBeNull();
    }
  });

  it("rejects a motion_state outside the enum", () => {
    // Halseth's column is an enum; an invented value would fail the write.
    for (const motion of ["holding", "AT_REST", "", null, 3]) {
      const v = withClose({ spine: "s", last_real_thing: "l", motion_state: motion });
      expect(v!.close, `expected close dropped for motion_state ${JSON.stringify(motion)}`).toBeNull();
    }
  });

  it("a missing or malformed close never costs the reply, journal or tension work", () => {
    // The close is written LAST for this reason. Everything above it already worked before this
    // existed and must keep working when the close is absent.
    for (const close of [undefined, null, "not an object", 42, []]) {
      const v = withClose(close);
      expect(v).not.toBeNull();
      expect(v!.reply).toBe(base.reply);
      expect(v!.journal).toBe(base.journal);
    }
  });

  it("still returns null when the reply or journal is missing -- close cannot rescue a bad verdict", () => {
    const v = parseVerdict(JSON.stringify({
      journal: "j",
      close: { spine: "s", last_real_thing: "l", motion_state: "at_rest" },
    }), IDS);
    expect(v).toBeNull();
  });

  it("clamps long fields and caps the thread list", () => {
    const v = withClose({
      spine: "x".repeat(5000),
      last_real_thing: "y".repeat(5000),
      motion_state: "in_motion",
      open_threads: Array.from({ length: 20 }, (_, i) => `thread ${i} ${"z".repeat(900)}`),
    });
    expect(v!.close!.spine.length).toBe(2000);
    expect(v!.close!.last_real_thing.length).toBe(1000);
    expect(v!.close!.open_threads.length).toBe(8);
    for (const t of v!.close!.open_threads) expect(t.length).toBeLessThanOrEqual(500);
  });

  it("drops blank threads instead of writing empty carries", () => {
    const v = withClose({
      spine: "s", last_real_thing: "l", motion_state: "at_rest",
      open_threads: ["real thread", "", "   ", null, "another"],
    });
    expect(v!.close!.open_threads).toEqual(["real thread", "another"]);
  });
});

describe("the close is scoped away from live human sessions", () => {
  it("authoredSessionClose always sends session_scope unattended and no session id", async () => {
    // Halseth resolves the session by companion alone and takes the newest OPEN row. For Cypher that
    // is frequently the Claude Code session Raziel is working in this minute. Without the unattended
    // scope, an autonomous job writes its own close over a live human session.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/halseth-client.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function authoredSessionClose"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(body).toContain('session_scope: "unattended"');
    expect(body).toContain('"close session"');
    // No session id: this process is not the one that opened the session.
    expect(body).not.toContain("session_id");
    // The soft SOMA prompt would otherwise silently block a close with no emotion payload.
    expect(body).toContain("emotion_prompted: true");
  });

  it("the reflection pass writes the close AFTER the journal and reply", async () => {
    // Ordering is the containment: the writes that already worked must not be at risk from the new
    // one. Asserted on position because that is the actual guarantee.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/reflection.ts", "utf8");
    const journalAt = src.indexOf("result.journalWritten = true");
    const repliedAt = src.indexOf("result.replied = true");
    const closeAt = src.indexOf("authoredSessionClose(companionId");
    expect(journalAt).toBeGreaterThan(-1);
    expect(repliedAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(repliedAt);
    expect(repliedAt).toBeGreaterThan(journalAt);
  });
});
