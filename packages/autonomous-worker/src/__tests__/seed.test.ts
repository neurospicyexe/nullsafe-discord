import { describe, it, expect } from "vitest";
import { decideSeedSource } from "../phases/seed.js";

// SEED_THIN_THRESHOLD = 3 (sessionNoteCount + feelingCount must reach 3 for "session")
describe("decideSeedSource", () => {
  it("returns outward when both counts are zero", () => {
    expect(decideSeedSource(0, 0)).toBe("outward");
  });

  it("returns outward when combined count is below threshold", () => {
    expect(decideSeedSource(1, 1)).toBe("outward"); // sum = 2
    expect(decideSeedSource(2, 0)).toBe("outward"); // sum = 2
    expect(decideSeedSource(0, 2)).toBe("outward"); // sum = 2
  });

  it("returns session when combined count exactly meets threshold", () => {
    expect(decideSeedSource(1, 2)).toBe("session"); // sum = 3
    expect(decideSeedSource(3, 0)).toBe("session"); // sum = 3
    expect(decideSeedSource(0, 3)).toBe("session"); // sum = 3
  });

  it("returns session when combined count exceeds threshold", () => {
    expect(decideSeedSource(4, 4)).toBe("session"); // sum = 8
    expect(decideSeedSource(8, 0)).toBe("session"); // sum = 8 (full limit=8 fetch)
  });
});
