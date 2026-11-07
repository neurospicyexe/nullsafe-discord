import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldSolAppear, APPEAR_CHANCE, postSolMoment } from "../sol-presence.js";

describe("shouldSolAppear", () => {
  it("absent never appears", () => {
    expect(shouldSolAppear("absent", 0)).toBe(false);
  });
  it("affectionate appears on a low roll", () => {
    expect(shouldSolAppear("affectionate", 0)).toBe(true);
  });
  it("roll above the disposition's chance = no show", () => {
    expect(shouldSolAppear("aloof", 0.99)).toBe(false);
  });
  it("APPEAR_CHANCE contains expected dispositions", () => {
    expect(APPEAR_CHANCE).toHaveProperty("absent");
    expect(APPEAR_CHANCE).toHaveProperty("affectionate");
    expect(APPEAR_CHANCE.absent).toBe(0);
    expect(APPEAR_CHANCE.affectionate).toBeGreaterThan(0);
  });
  it("unknown disposition never appears", () => {
    expect(shouldSolAppear("mystery", 0)).toBe(false);
  });
  it("watchful appears on roll below threshold", () => {
    expect(shouldSolAppear("watchful", 0.1)).toBe(true);
    expect(shouldSolAppear("watchful", 0.99)).toBe(false);
  });
});

describe("postSolMoment (R27)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("sends allowed_mentions with an empty parse list, so no mention in a Sol line can ping", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); });
    expect(await postSolMoment("https://discord.com/api/webhooks/1/x", "*Sol.*")).toBe(true);
    expect(bodies).toEqual([{ content: "*Sol.*", allowed_mentions: { parse: [] } }]);
  });
});
