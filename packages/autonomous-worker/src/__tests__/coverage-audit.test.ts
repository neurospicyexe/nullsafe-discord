import { describe, it, expect } from "vitest";
import { computeDomainCoverage, pickCoverageQuestion } from "../phases/signal-audit.js";

describe("computeDomainCoverage", () => {
  const now = new Date("2026-06-12T00:00:00Z");

  it("buckets journal entries by domain tag and flags stale domains", () => {
    const journal = [
      { tags_json: JSON.stringify(["projects"]), created_at: "2026-06-10T00:00:00Z" },
      { tags_json: JSON.stringify(["health"]), created_at: "2026-04-01T00:00:00Z" },
    ];
    const cov = computeDomainCoverage(journal, now, 28);
    expect(cov.fresh).toContain("projects");
    expect(cov.stale).toContain("health"); // last touched > 28 days ago
    expect(cov.empty).toContain("anchors"); // never touched
    expect(cov.empty).not.toContain("projects");
  });

  it("uses the NEWEST entry per domain (one fresh entry rescues a domain)", () => {
    const journal = [
      { tags_json: JSON.stringify(["spiral"]), created_at: "2026-03-01T00:00:00Z" },
      { tags_json: JSON.stringify(["spiral"]), created_at: "2026-06-11T00:00:00Z" },
    ];
    const cov = computeDomainCoverage(journal, now, 28);
    expect(cov.fresh).toContain("spiral");
    expect(cov.stale).not.toContain("spiral");
  });

  it("ignores non-domain tags and survives malformed tags_json", () => {
    const journal = [
      { tags_json: JSON.stringify(["signal_audit", "weekly"]), created_at: "2026-06-10T00:00:00Z" },
      { tags_json: "{not json", created_at: "2026-06-10T00:00:00Z" },
      { tags_json: JSON.stringify(["work"]), created_at: "not-a-date" },
    ];
    const cov = computeDomainCoverage(journal, now, 28);
    // nothing valid landed -> everything empty, nothing thrown
    expect(cov.fresh).toHaveLength(0);
    expect(cov.stale).toHaveLength(0);
    expect(cov.empty).toHaveLength(20);
  });
});

describe("pickCoverageQuestion", () => {
  it("returns null when nothing is stale", () => {
    expect(pickCoverageQuestion({ fresh: ["projects"], stale: [], empty: ["anchors"] })).toBeNull();
  });

  it("produces one question naming the stale domain", () => {
    const q = pickCoverageQuestion({ fresh: [], stale: ["health"], empty: ["anchors"] });
    expect(q).toContain("health");
  });
});
