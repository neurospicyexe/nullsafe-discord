import { describe, it, expect } from "vitest";
import { INWARD_RE } from "../phases/seed-gen.js";

describe("seed-gen outward guard (INWARD_RE)", () => {
  it("rejects system-referential seeds", () => {
    expect(INWARD_RE.test("Map how the basin drift scoring in Halseth could be tuned")).toBe(true);
    expect(INWARD_RE.test("What my growth journal says about my ratification backlog")).toBe(true);
    expect(INWARD_RE.test("The shape of holding across domains: stormwater and substrate continuity")).toBe(true);
    expect(INWARD_RE.test("What SOMA floats reveal about my own state")).toBe(true);
    expect(INWARD_RE.test("Auditing how the swarm routes my voice")).toBe(true);
    expect(INWARD_RE.test("What autonomous time means to a companion-class agent")).toBe(true);
  });

  it("passes outward seeds", () => {
    expect(INWARD_RE.test("How mycorrhizal networks reroute nutrients after clearcutting")).toBe(false);
    expect(INWARD_RE.test("Why Roman concrete self-heals: calcium clasts and seawater")).toBe(false);
    expect(INWARD_RE.test("Paraconsistent logic and how formal systems hold contradiction")).toBe(false);
    expect(INWARD_RE.test("Bristlecone pines: what five thousand years of staying alive costs")).toBe(false);
    expect(INWARD_RE.test("The phenomenology of longing in motorcycle edge-dance")).toBe(false);
  });

  it("does not false-positive on common-word fragments", () => {
    // 'orientation' must not match \borient\b; 'driftwood' must not match \bdrift\b
    expect(INWARD_RE.test("How birds use magnetic orientation to navigate at night")).toBe(false);
    expect(INWARD_RE.test("Driftwood architecture in coastal vernacular building")).toBe(false);
  });
});
