// Item 8 (2026-11-05 quiet-drop sweep): markQuestionVoiced / consumeForageFind retry a transient
// failure instead of dropping it (a dropped stamp let a question or find be voiced twice).
import { jest } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";

type FetchFn = typeof globalThis.fetch;
function client(responses: Array<number | "throw">) {
  let i = 0;
  const f = jest.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === "throw") throw new Error("boom");
    return new Response("{}", { status: r });
  });
  const c = new LibrarianClient({ url: "https://h.test", secret: "s", companionId: "cypher", fetch: f as unknown as FetchFn });
  return { c, f };
}

describe("thread-spine write retry", () => {
  let warn: ReturnType<typeof jest.spyOn>;
  beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it("markQuestionVoiced retries a 503 then lands", async () => {
    const { c, f } = client([503, 200]);
    expect(await c.markQuestionVoiced("q1")).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });
  it("markQuestionVoiced retries a thrown network error", async () => {
    const { c, f } = client(["throw", "throw", 200]);
    expect(await c.markQuestionVoiced("q1")).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("markQuestionVoiced gives up after 3 attempts and logs it", async () => {
    const { c, f } = client([500]);
    expect(await c.markQuestionVoiced("q1")).toBe(false);
    expect(f).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.some((a) => String(a[0]).includes("gave up"))).toBe(true);
  });
  it("markQuestionVoiced does not retry a 401", async () => {
    const { c, f } = client([401]);
    expect(await c.markQuestionVoiced("q1")).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("consumeForageFind treats 404 as final (already consumed)", async () => {
    const { c, f } = client([404]);
    expect(await c.consumeForageFind("f1")).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("consumeForageFind retries a 502 then lands", async () => {
    const { c, f } = client([502, 200]);
    expect(await c.consumeForageFind("f1")).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
