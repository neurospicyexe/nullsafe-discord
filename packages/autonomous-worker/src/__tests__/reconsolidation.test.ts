import { describe, it, expect } from "vitest";
import { buildReconsolidationEntry } from "../phases/reflect.js";

describe("buildReconsolidationEntry", () => {
  const sampled = new Set(["canon-1", "canon-2"]);

  it("builds a pending reconsolidation entry from a valid proposal", () => {
    const entry = buildReconsolidationEntry(
      { reconsolidation: { target_id: "canon-1", revision: "Updated take that stands alone.", reason: "context shifted" } },
      sampled,
      "cypher",
      "run-9",
    );
    expect(entry).not.toBeNull();
    expect(entry!.entry_type).toBe("reconsolidation");
    expect(entry!.supersedes_id).toBe("canon-1");
    expect(entry!.source).toBe("autonomous");
    expect(entry!.tags).toContain("reconsolidation");
    expect(entry!.run_id).toBe("run-9");
    expect(entry!.content).toContain("Updated take that stands alone.");
    expect(entry!.content).toContain("context shifted");
  });

  it("returns null when reconsolidation is null or absent", () => {
    expect(buildReconsolidationEntry({ reconsolidation: null }, sampled, "cypher", "run-9")).toBeNull();
    expect(buildReconsolidationEntry({}, sampled, "cypher", "run-9")).toBeNull();
  });

  it("drops a hallucinated target_id not in the sampled canon", () => {
    const entry = buildReconsolidationEntry(
      { reconsolidation: { target_id: "ghost-id", revision: "Anything.", reason: "x" } },
      sampled,
      "cypher",
      "run-9",
    );
    expect(entry).toBeNull();
  });

  it("drops a proposal with an empty revision", () => {
    const entry = buildReconsolidationEntry(
      { reconsolidation: { target_id: "canon-1", revision: "   ", reason: "x" } },
      sampled,
      "cypher",
      "run-9",
    );
    expect(entry).toBeNull();
  });

  it("survives a missing reason", () => {
    const entry = buildReconsolidationEntry(
      { reconsolidation: { target_id: "canon-2", revision: "Solid revision." } },
      sampled,
      "drevan",
      "run-3",
    );
    expect(entry).not.toBeNull();
    expect(entry!.supersedes_id).toBe("canon-2");
  });
});
