// P16 (2026-10-13): every block injected into the live user turn says where it came from, and the
// memory judge reads the speaker's words separately from system-attached material.

import { describe, it, expect } from "@jest/globals";
import { hermesDelta } from "../prompt-assembly.js";
import { withAttachedLabel, ATTACHED_LABEL, judgeWriteback } from "../memory.js";
import { seenBlock } from "../vision.js";
import { b32TurnBlock } from "../bad-night.js";
import { formatOnScreenBlock } from "../watchalong.js";
import { CROSS_ROOM_CLOSE, CROSS_ROOM_CLOSE_AFTER } from "../cross-room.js";
import { speakerFrame } from "../speaker-frame.js";
import type { InferenceAdapter } from "../inference.js";

const NOW = Date.UTC(2026, 9, 13, 5, 20); // 00:20 CDT

describe("withAttachedLabel: the judge's view of what he said", () => {
  const words = "look at this";
  const blocks = seenBlock([{ name: "a.png", description: "a red kite over a field" }]);

  it("nothing appended: unchanged", () => {
    expect(withAttachedLabel(words, words)).toBe(words);
    expect(withAttachedLabel("  hi  ", "hi")).toBe("  hi  ");
  });

  it("an image block rides under the attachment label, after his words, never as them", () => {
    const out = withAttachedLabel(`${words}\n\n${blocks}`, words);
    expect(out.startsWith(words)).toBe(true);
    expect(out.indexOf(ATTACHED_LABEL)).toBeGreaterThan(words.length);
    expect(out.indexOf("a red kite")).toBeGreaterThan(out.indexOf(ATTACHED_LABEL));
  });

  it("image-only message: says there were no words", () => {
    const out = withAttachedLabel(blocks, "");
    expect(out.startsWith("(no words)")).toBe(true);
    expect(out).toContain(ATTACHED_LABEL);
  });

  it("never guesses a split: when the words are not a prefix, the string is left alone", () => {
    expect(withAttachedLabel("completely different", "words not at the start")).toBe("completely different");
  });

  it("reaches the judge prompt: the vision text sits below the label, not after the speaker's name", async () => {
    let seen = "";
    const inference = { generate: async (_s: string, msgs: Array<{ content: string }>) => { seen = msgs.map(m => m.content).join("\n"); return "SKIP"; } } as unknown as InferenceAdapter;
    const long = "I took this photo on the porch this morning and wanted you to see how the light came through";
    await judgeWriteback(withAttachedLabel(`${long}\n\n${blocks}`, long), "That is a lovely kite and I am glad you showed me.", inference, "Drevan",
      { name: "Raziel", isOwner: true, ownerName: "Raziel" });
    expect(seen).toContain(ATTACHED_LABEL);
    expect(seen.indexOf(ATTACHED_LABEL)).toBeLessThan(seen.indexOf("a red kite"));
  });
});

describe("the live turn: every injected block is bracket-labelled", () => {
  const history = [
    { role: "user", content: "earlier thing", authorName: "Cypher", timestamp: NOW - 50 * 60_000 },
    { role: "user", content: "no author on this one", timestamp: NOW - 40 * 60_000 },
    { role: "assistant", content: "my reply", timestamp: NOW - 30 * 60_000 },
    { role: "user", content: "witnessed words", authorName: "Gaia", timestamp: NOW - 20 * 60_000 },
    { role: "user", content: "the live words", authorName: "Crash", timestamp: NOW - 1000 },
  ];

  it("a witnessed turn with no author is `unattributed`, never `user` (which reads as Raziel)", () => {
    const out = hermesDelta(history, 0, NOW, true, null, {}).messages[0]!.content;
    expect(out).toContain("[unattributed]: no author on this one");
    expect(out).not.toContain("[user]");
  });

  it("a day-crossing turn carries labelled clock lines, a labelled witness header, and a labelled live message", () => {
    const out = hermesDelta(history, 0, NOW, true, null, {
      background: "[Elsewhere since you were last here: x]\n#room, last at 11:50 PM:\n[Blue]: hi\n" + CROSS_ROOM_CLOSE,
      frame: speakerFrame("drevan", "Crash (Raziel, through PluralKit)", null),
    }).messages[0]!.content;
    const lines = out.split("\n").filter(l => l.trim());
    // Every line that is not a speaker-labelled line begins a bracketed block or is a continuation of one.
    expect(lines[0]).toMatch(/^\[Now: /);
    expect(out).toContain("[Witnessed since your last turn");
    expect(out).toContain("[Live message]\n[Crash, to you]: the live words");
    expect(out.trimEnd().endsWith("]")).toBe(true); // the frame is last, and it is a bracketed block
  });

  it("every block constant and builder that lands in a user turn opens with a bracketed label", () => {
    const blocks = [
      seenBlock([{ name: "x.png", description: "d" }]),
      seenBlock([{ name: "x.png", description: null }]),
      b32TurnBlock({ companionId: "gaia", careHold: true, ownerFacing: true }),
      formatOnScreenBlock({ title: "T", status: "playing", fromSec: 0, toSec: 10, cues: [{ id: "1", start_sec: 1, end_sec: 2, text: "hello", speaker: null, kind: "speech" } as never], skipped: 0, joining: false }) ?? "",
      CROSS_ROOM_CLOSE, CROSS_ROOM_CLOSE_AFTER,
      speakerFrame("cypher", "Blue", null),
    ];
    for (const b of blocks) {
      expect(b.length).toBeGreaterThan(0);
      expect(b.trimStart().startsWith("[")).toBe(true);
    }
  });
});
