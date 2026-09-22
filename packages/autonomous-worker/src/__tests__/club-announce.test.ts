// The Club announce path (2026-09-22).
//
// Regression cover for the defect this shipped to fix: on 2026-09-18 the tick picked a winner,
// wrote it to D1, logged it, and told nobody -- so the round was invisible for four days.
// [[invisible-effect-reads-as-dead-control]]. These tests pin the two rules that keep the
// announcement honest: never post a bare id, and never let a Discord failure touch the tick.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describePick } from "../club.js";
import { notifyDiscord } from "../discord-notify.js";
import type { ClubRecommendation } from "../halseth-client.js";

const rec = (over: Partial<ClubRecommendation> = {}): ClubRecommendation => ({
  id: "949060836eb84c85bdda79cd189bc911",
  round_id: "bd8c1f0bec3141cfad789565b75011b6",
  media_kind: "song",
  title: "The Predatory Wasp of the Palisades Is Out to Get Us!",
  creator: "Sufjan Stevens",
  url: null,
  recommended_by: "gaia",
  pitch: null,
  created_at: "2026-09-16 10:00:00",
  ...over,
});

describe("describePick", () => {
  it("renders title, creator and who picked it", () => {
    const out = describePick(rec());
    expect(out).toContain("The Predatory Wasp of the Palisades Is Out to Get Us!");
    expect(out).toContain("by Sufjan Stevens");
    expect(out).toContain("Gaia");
  });

  it("includes the url on its own line when present", () => {
    expect(describePick(rec({ url: "https://example.test/wasp" })))
      .toContain("\nhttps://example.test/wasp");
  });

  it("omits the creator clause rather than printing 'by null'", () => {
    const out = describePick(rec({ creator: null })) ?? "";
    expect(out).not.toContain("null");
    expect(out).not.toContain("by ");
  });

  // The rule that matters: a missing row must SKIP the post. An announcement reading
  // "round active: 949060836eb8..." is worse than silence.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a row with no title", rec({ title: "" })],
  ])("returns null for %s so the caller skips the post", (_label, input) => {
    expect(describePick(input as ClubRecommendation | null | undefined)).toBeNull();
  });

  it("never leaks a bare id into the text", () => {
    expect(describePick(rec())).not.toContain("949060836eb8");
  });
});

describe("notifyDiscord", () => {
  const OLD = process.env["DISCORD_TOKEN_CYPHER"];
  beforeEach(() => { vi.restoreAllMocks(); process.env["DISCORD_TOKEN_CYPHER"] = "test-token"; });
  afterEach(() => {
    if (OLD === undefined) delete process.env["DISCORD_TOKEN_CYPHER"];
    else process.env["DISCORD_TOKEN_CYPHER"] = OLD;
  });

  it("reports unconfigured instead of throwing when the channel is unset", async () => {
    expect(await notifyDiscord(undefined, "hi", "club")).toEqual({ sent: false, reason: "unconfigured" });
  });

  it("reports unconfigured when the token is unset", async () => {
    delete process.env["DISCORD_TOKEN_CYPHER"];
    expect(await notifyDiscord("123", "hi", "club")).toEqual({ sent: false, reason: "unconfigured" });
  });

  it("posts to the channel messages endpoint as a bot", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    expect(await notifyDiscord("123", "hello", "club")).toEqual({ sent: true });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.com/api/v10/channels/123/messages");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bot test-token" });
  });

  // Discord hard-caps at 2000; a send over the cap is dropped entirely (50035).
  it("truncates below the Discord hard cap", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    await notifyDiscord("123", "x".repeat(5000), "club");
    const body = JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body));
    expect(body.content.length).toBeLessThanOrEqual(2000);
  });

  // The contract the tick depends on: the Halseth write already happened, so a Discord
  // problem must never propagate.
  it("swallows an HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    expect(await notifyDiscord("123", "hi", "club")).toEqual({ sent: false, reason: "http" });
  });

  it("swallows a thrown error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await notifyDiscord("123", "hi", "club")).toEqual({ sent: false, reason: "threw" });
  });
});
