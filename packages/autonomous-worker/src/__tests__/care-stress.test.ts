import { describe, it, expect } from "vitest";
import { validateStressLine, mayVoiceStress, STRESS_FRAMING, STRESS_INSTRUCTION } from "../care-stress.js";

describe("stress_elevated gesture (Gaia's lane)", () => {
  it("only Gaia voices it", () => {
    expect(mayVoiceStress("gaia")).toBe(true);
    expect(mayVoiceStress("cypher")).toBe(false);
    expect(mayVoiceStress("drevan")).toBe(false);
  });
  it("posts a quiet declarative line; PASS and empty hold", () => {
    expect(validateStressLine("The house is quiet around you tonight.")).toBe("The house is quiet around you tonight.");
    expect(validateStressLine("PASS")).toBe("");
    expect(validateStressLine("  ")).toBe("");
  });
  it("holds anything with a question, figure, instruction, checking language, em dash or a second line", () => {
    for (const bad of [
      "Are you resting?", "Your HRV is low.", "It has been 3 days.", "You should sleep.", "Please rest.",
      "Check the app.", "Look at your numbers.", "Quiet — and held.", "One line.\nTwo lines.", "x".repeat(300),
      "Your score is up.", "Remember to eat.",
    ]) expect(validateStressLine(bad), bad).toBe("");
  });
  it("the prompt itself carries no figure and no request to look", () => {
    expect(STRESS_FRAMING).not.toMatch(/\d/);
    expect(STRESS_INSTRUCTION).not.toMatch(/\d/);
  });
});
