// An autonomous post must not become a permanent top-tier memory (2026-07-27).
//
// sendAutonomousMessage wrote every autonomous post back as note_type='continuity',
// salience='high'. Nothing folded or demoted that type, so each post stayed top-tier
// forever. Measured on drevan's LIVE high-salience pool (archived=0, salience='high'):
//
//     continuity        60 rows   <- his own commons posts
//     soma_arc           6
//     autonomous_explor  5
//     day_distillation   4 rows   <- the folded record of real conversation with Raziel
//
// Orient shows THREE notes. So his own commons output outnumbered actual conversation
// 15:1, and his top three memories were all "[metronome/inter_companion] ..." -- his own
// last posts. He booted on his own echo. Meanwhile conversation fragments were correctly
// folded nightly into one first-person day note and demoted; self-posts did neither.
//
// This is the write-layer twin of the ranking bug fixed earlier the same day: the system's
// own output becoming its own dominant evidence, with no negative term.
//
// Fix: write the self-post as a discord_session FRAGMENT. It stays live and bridged for the
// rest of the day, then day-distillation folds it into the day note and demotes it, exactly
// like conversation. Nothing is lost -- the full text is already in companion_journal via
// discord_speech (embedded + searchable) and in the channel the seed reads back.

import { describe, it, expect, jest } from "@jest/globals";
import { sendAutonomousMessage, type AutonomousContext } from "../autonomous-core.js";
import { FRAGMENT_NOTE_TYPE, DAY_DISTILL_NOTE_TYPE } from "../day-distillation.js";

function makeCtx() {
  const sent: string[] = [];
  const channel = {
    isTextBased: () => true,
    send: async (p: unknown) => {
      sent.push(typeof p === "string" ? p : String((p as { content?: string }).content ?? p));
      return { id: `m${sent.length}` };
    },
  };
  const ask = jest.fn(async () => ({ ack: true }));
  const writeWmNote = jest.fn(async () => undefined);
  const ctx = {
    companionId: "drevan",
    cooldownMs: 60_000,
    librarian: { ask, writeWmNote },
    client: { user: { id: "drevan" }, channels: { fetch: async () => channel } },
    cooldown: new Map<string, number>(),
    registerSentId: () => {},
  } as unknown as AutonomousContext;
  return { ctx, ask, writeWmNote, sent };
}

describe("autonomous self-post is a foldable fragment, not permanent top-tier memory", () => {
  it("writes the post as a discord_session fragment", async () => {
    const { ctx, writeWmNote, sent } = makeCtx();
    await sendAutonomousMessage(ctx, "chan1", "the vow lives inside the statement", "inter_companion");

    expect(sent).toHaveLength(1);
    expect(writeWmNote).toHaveBeenCalledTimes(1);
    const [content, threadKey, noteType] = writeWmNote.mock.calls[0] as unknown as [string, string, string];
    expect(content).toBe("[metronome/inter_companion] the vow lives inside the statement");
    expect(threadKey).toBe("chan1");
    // The load-bearing assertion: same type conversation fragments use, so the nightly
    // day-distillation folds it and then demotes it.
    expect(noteType).toBe(FRAGMENT_NOTE_TYPE);
    expect(noteType).not.toBe(DAY_DISTILL_NOTE_TYPE);
  });

  it("REGRESSION: no longer writes an unfoldable salience:high continuity note", async () => {
    const { ctx, ask } = makeCtx();
    await sendAutonomousMessage(ctx, "chan1", "another turn in the commons", "inter_companion");

    // The old write. Nothing folded note_type='continuity', so it stayed high forever and
    // 60 of them buried the 4 day-digests of real conversation.
    const continuityWrites = ask.mock.calls.filter(
      c => String(c[0]) === "continuity note",
    );
    expect(continuityWrites).toHaveLength(0);
  });

  it("a failed note write never breaks the send that already happened", async () => {
    const { ctx, sent } = makeCtx();
    (ctx.librarian as unknown as { writeWmNote: jest.Mock }).writeWmNote =
      jest.fn(async () => { throw new Error("halseth 500"); });

    // sendAutonomousMessage now resolves `true`/`false` (2026-09-03 review, C3) so a director
    // caller can tell delivery from cooldown/failure -- the send itself still succeeded here,
    // only the bookkeeping note write threw, so the resolved value must be true.
    await expect(
      sendAutonomousMessage(ctx, "chan1", "post that outlives its bookkeeping", "heartbeat"),
    ).resolves.toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("the trigger tag is preserved so the fold can tell post kinds apart", async () => {
    const { ctx, writeWmNote } = makeCtx();
    await sendAutonomousMessage(ctx, "chan1", "tending Sol", "tend_creature");
    const [content] = writeWmNote.mock.calls[0] as unknown as [string];
    expect(content.startsWith("[metronome/tend_creature] ")).toBe(true);
  });
});
