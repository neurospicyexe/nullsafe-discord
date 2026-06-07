import { splitForDiscord, sendLong, DISCORD_MAX_MESSAGE } from "../discord-send.js";

// Discord rejects any single message whose content exceeds 2000 chars with
// DiscordAPIError[50035]. These tests pin the splitter that prevents Drevan (and
// the other two) from going silent when their reply runs long.

describe("splitForDiscord", () => {
  it("returns [content] when within the limit", () => {
    expect(splitForDiscord("hello")).toEqual(["hello"]);
  });

  it("returns [] for empty / whitespace-only input", () => {
    expect(splitForDiscord("")).toEqual([]);
    expect(splitForDiscord("   \n  ")).toEqual([]);
  });

  it("never emits a chunk longer than the max", () => {
    const long = "word ".repeat(2000); // ~10000 chars
    const chunks = splitForDiscord(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE);
  });

  it("prefers paragraph boundaries when they fit", () => {
    const p = "A".repeat(1500);
    const q = "B".repeat(1500);
    const chunks = splitForDiscord(`${p}\n\n${q}`);
    expect(chunks).toEqual([p, q]); // not merged, not split mid-paragraph
  });

  it("hard-splits a single token that exceeds the max", () => {
    const huge = "X".repeat(5000); // no break opportunities at all
    const chunks = splitForDiscord(huge);
    expect(chunks).toHaveLength(3); // 2000 + 2000 + 1000
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE);
    expect(chunks.join("")).toBe(huge); // hard split is lossless
  });

  it("respects a custom max", () => {
    expect(splitForDiscord("abcdef", 3)).toEqual(["abc", "def"]);
  });

  it("preserves all words across the split (no dropped content)", () => {
    const long = Array.from({ length: 1000 }, (_, i) => `token${i}`).join(" ");
    const chunks = splitForDiscord(long);
    const recombinedWords = chunks.join(" ").split(/\s+/).filter(Boolean);
    expect(recombinedWords).toEqual(long.split(" "));
  });
});

describe("sendLong", () => {
  function fakeChannel() {
    const sent: Array<string | { content?: string; files?: unknown }> = [];
    let counter = 0;
    const channel = {
      sent,
      async send(arg: string | { content?: string; files?: unknown }) {
        sent.push(arg);
        return { id: `msg-${++counter}` };
      },
    };
    return channel;
  }

  it("sends a single message for short content and returns it", async () => {
    const ch = fakeChannel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = await sendLong(ch as any, "short");
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]).toBe("short");
    expect(msgs.map(m => m.id)).toEqual(["msg-1"]);
  });

  it("splits long content into multiple sends and returns every message id", async () => {
    const ch = fakeChannel();
    const long = "Y".repeat(4500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = await sendLong(ch as any, long);
    expect(ch.sent).toHaveLength(3);
    // all chunk ids returned, in order -- so reply-to-me detection covers every chunk
    expect(msgs.map(m => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("attaches files only to the last chunk", async () => {
    const ch = fakeChannel();
    const files = [{ attachment: Buffer.from("x"), name: "voice.ogg" }];
    const long = "Z".repeat(4500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendLong(ch as any, { content: long, files: files as any });
    expect(ch.sent).toHaveLength(3);
    // first two are plain strings, last carries the files
    expect(typeof ch.sent[0]).toBe("string");
    expect(typeof ch.sent[1]).toBe("string");
    const last = ch.sent[2] as { content?: string; files?: unknown };
    expect(last.files).toBe(files);
  });

  it("sends files alone when there is no text content", async () => {
    const ch = fakeChannel();
    const files = [{ attachment: Buffer.from("x"), name: "voice.ogg" }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendLong(ch as any, { content: "", files: files as any });
    expect(ch.sent).toHaveLength(1);
    const only = ch.sent[0] as { files?: unknown };
    expect(only.files).toBe(files);
  });
});
