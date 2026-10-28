// Bot journal writes carry the Halseth session they happened in (halseth STATUS B61 D4, 2026-10-28).
// journalSpeech / journalJudgeNote post raw to /companion-journal; until now they sent no session_id,
// so 98% of journal rows sat outside any session and the graph could not link speech to its talk.

import { describe, it, expect, jest } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";

function client(sessionResponse: Record<string, unknown>) {
  const bodies: Array<{ url: string; body: any }> = [];
  const fetchMock = jest.fn(async (url: unknown, init?: any) => {
    const u = String(url);
    bodies.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
    // The Librarian speaks MCP JSON-RPC at /librarian/mcp; the envelope rides result.content[0].text.
    const payload = u.endsWith("/librarian/mcp")
      ? { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(sessionResponse) }] } }
      : { ok: true };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
  });
  const c = new LibrarianClient({ url: "https://halseth.example", secret: "s", companionId: "drevan", fetch: fetchMock as unknown as typeof fetch });
  return { c, bodies };
}

const journalBodies = (bodies: Array<{ url: string; body: any }>) => bodies.filter((b) => b.url.endsWith("/companion-journal")).map((b) => b.body);

describe("journal writes stamp the open Halseth session", () => {
  it("no session before any open: nothing invented", async () => {
    const { c, bodies } = client({ session_id: "s-1" });
    await c.journalSpeech("hello", "chan", "m1");
    expect(journalBodies(bodies)[0]).not.toHaveProperty("session_id");
    expect(c.currentSessionId()).toBeNull();
  });

  it("after sessionOpen, speech and judge notes carry that session", async () => {
    const { c, bodies } = client({ session_id: "s-42", reused: false });
    await c.sessionOpen("work", "discord:drevan");
    await c.journalSpeech("the snow scene", "chan", "m1");
    await c.journalJudgeNote("he was proud of the bird", "chan", "m2");
    const [speech, judge] = journalBodies(bodies);
    expect(speech.session_id).toBe("s-42");
    expect(judge.session_id).toBe("s-42");
  });

  it("an 'unknown' placeholder is never stamped", async () => {
    const { c, bodies } = client({ session_id: "unknown" });
    await c.sessionOpen("work", "discord:drevan");
    await c.journalSpeech("hello", "chan", "m1");
    expect(journalBodies(bodies)[0]).not.toHaveProperty("session_id");
  });
});
