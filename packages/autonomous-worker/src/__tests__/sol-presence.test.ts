import { describe, it, expect } from "vitest";
import { shouldSolAppear, APPEAR_CHANCE } from "../sol-presence.js";

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
