// B62 step 1 (2026-11-02): the self-loop rail fires the `repetition` stimulus with a short machine
// detail (rail + score). Halseth owns the mode (shadow by default), the deltas and the cooldown.
import { describe, it, expect } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";

function capture() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
  return { calls, fetchFn };
}

describe("fireStimulus detail", () => {
  it("sends the detail alongside the stimulus and this companion's id", async () => {
    const { calls, fetchFn } = capture();
    const c = new LibrarianClient({ url: "https://h", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await c.fireStimulus("repetition", "rail=loop_motif score=0.81");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://h/mind/ferment/stimulus");
    expect(calls[0]!.body).toEqual({ stimulus: "repetition", companion_id: "cypher", detail: "rail=loop_motif score=0.81" });
  });

  it("keeps the old body shape when no detail is given", async () => {
    const { calls, fetchFn } = capture();
    const c = new LibrarianClient({ url: "https://h", secret: "s", companionId: "gaia", fetch: fetchFn as never });
    await c.fireStimulus("sibling_exchange");
    expect(calls[0]!.body).toEqual({ stimulus: "sibling_exchange", companion_id: "gaia" });
  });

  it("caps the detail at 200 chars", async () => {
    const { calls, fetchFn } = capture();
    const c = new LibrarianClient({ url: "https://h", secret: "s", companionId: "drevan", fetch: fetchFn as never });
    await c.fireStimulus("repetition", "x".repeat(500));
    expect((calls[0]!.body["detail"] as string).length).toBe(200);
  });

  it("never throws when Halseth is down", async () => {
    const c = new LibrarianClient({ url: "https://h", secret: "s", companionId: "gaia", fetch: (async () => { throw new Error("down"); }) as never });
    await expect(c.fireStimulus("repetition", "rail=loop_motif score=0.9")).resolves.toBeUndefined();
  });
});
