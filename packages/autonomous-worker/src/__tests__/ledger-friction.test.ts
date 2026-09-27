// Gaia's friction at the quote (2026-09-26): Halseth answers a companion's commons / sibling write
// with 422 {error, rule} when it restates a ledger line (`ledger_restated`) or names a health value
// without a human-row pointer (`health_pointer`). The worker logs ONE loud line naming the rule (never
// the content), does not retry, and never throws out of the tick.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../config.js", () => ({ HALSETH_URL: "https://halseth.test", HALSETH_SECRET: "s" }));

import { postCommonsPost, sendSiblingNote, ledgerFrictionRule } from "../halseth-client.js";

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ledger friction (422 ledger_restated / health_pointer)", () => {
  it("parses only the two friction rules out of a 422 hFetch error", () => {
    expect(ledgerFrictionRule(new Error('Halseth POST /mind/commons → 422: {"error":"x","rule":"ledger_restated"}'))).toBe("ledger_restated");
    expect(ledgerFrictionRule(new Error('Halseth POST /mind/commons → 422: {"error":"x","rule":"health_pointer"}'))).toBe("health_pointer");
    expect(ledgerFrictionRule(new Error('Halseth POST /mind/commons → 422: {"error":"x","rule":"health"}'))).toBeNull();
    expect(ledgerFrictionRule(new Error('Halseth POST /mind/commons → 500: {"rule":"ledger_restated"}'))).toBeNull();
  });

  for (const rule of ["ledger_restated", "health_pointer"]) {
    it(`commons post: ${rule} -> one console.error naming the rule, one fetch (no retry), null, no throw`, async () => {
      const fetch = reply(422, { error: "refused", rule });
      vi.stubGlobal("fetch", fetch);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(postCommonsPost("drevan", "global", "the secret words")).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain(`rule=${rule}`);
      expect(String(err.mock.calls[0]![0])).not.toContain("the secret words");
      expect(warn).not.toHaveBeenCalled();
    });

    it(`sibling send: ${rule} -> false, logged once without content, no retry, no throw`, async () => {
      const fetch = reply(422, { error: "refused", rule });
      vi.stubGlobal("fetch", fetch);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(sendSiblingNote("drevan", "gaia", "sealed words")).resolves.toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain(`rule=${rule}`);
      expect(String(err.mock.calls[0]![0])).not.toContain("sealed words");
    });
  }

  it("any other sibling-send failure still throws (the caller's catch owns it, unchanged)", async () => {
    vi.stubGlobal("fetch", reply(500, { error: "boom" }));
    await expect(sendSiblingNote("drevan", "gaia", "x")).rejects.toThrow(/500/);
  });
});
