import { buildHeardBlock, pickLyrics, compactAnalysis } from "../media.js";

describe("compactAnalysis", () => {
  const full = {
    source: "/tmp/x.mp3", duration: 218.4321, sample_rate: 22050,
    tempo_bpm: 84.2, tempo_estimated: true,
    key: { name: "A minor", confidence: 0.713 },
    onset_count: 412, onset_times: new Array(412).fill(0.1), chroma: new Array(12).fill(0.08),
    note_count: 99, notes: new Array(99).fill({}), files: { spectrogram: "/x.png" },
  };
  it("drops bulky arrays, keeps the musical summary", () => {
    const c = compactAnalysis(full);
    expect(c).not.toHaveProperty("onset_times");
    expect(c).not.toHaveProperty("notes");
    expect(c).not.toHaveProperty("files");
    expect(c["tempo_bpm"]).toBe(84.2);
    expect((c["key"] as { name: string }).name).toBe("A minor");
    expect(c["onset_count"]).toBe(412);
    expect(c["chroma"]).toHaveLength(12); // 12 floats is fine to keep
  });
});

describe("pickLyrics", () => {
  it("prefers exact-get plainLyrics", () => {
    expect(pickLyrics({ plainLyrics: "exact", syncedLyrics: "[00:01] x" }, null)).toBe("exact");
  });
  it("falls back to first search hit with plainLyrics", () => {
    expect(pickLyrics(null, [{ plainLyrics: "" }, { plainLyrics: "from search" }])).toBe("from search");
  });
  it("returns null when nothing matches", () => {
    expect(pickLyrics(null, [])).toBeNull();
    expect(pickLyrics(null, null)).toBeNull();
  });
});

describe("buildHeardBlock", () => {
  it("renders a compact in-prompt block", () => {
    const block = buildHeardBlock(
      { title: "Hurt", artist: "Johnny Cash", duration_sec: 218.4 },
      { tempo_bpm: 84.2, tempo_estimated: true, key: { name: "A minor", confidence: 0.71 }, onset_count: 412, duration: 218.4 },
      "I hurt myself today\nTo see if I still feel\n".repeat(40),
    );
    expect(block).toContain("Hurt");
    expect(block).toContain("Johnny Cash");
    expect(block).toContain("84");
    expect(block).toContain("A minor");
    expect(block.length).toBeLessThan(2600); // lyrics excerpted, not dumped
  });
  it("handles missing key and lyrics", () => {
    const block = buildHeardBlock(
      { title: "X", artist: null, duration_sec: null },
      { tempo_bpm: 120, tempo_estimated: false, key: null, onset_count: 0, duration: 10 },
      null,
    );
    expect(block).toContain("X");
    expect(block).not.toContain("null");
  });
});

describe("LISTEN_TRIGGER shape (mirrors per-bot config)", () => {
  const cy = /^(?:cy|cypher):\s*listen\s+(\S+)/i;
  it("matches and captures the url", () => {
    const m = "cy: listen https://youtu.be/abc123".match(cy);
    expect(m?.[1]).toBe("https://youtu.be/abc123");
  });
  it("matches Discord-wrapped urls (unwrap happens in handler)", () => {
    const m = "cypher: listen <https://youtu.be/abc>".match(cy);
    expect(m?.[1]).toBe("<https://youtu.be/abc>");
  });
  it("does not match other companions' prefixes", () => {
    expect("drev: listen https://x".match(cy)).toBeNull();
  });
  it("does not match plain conversation about listening", () => {
    expect("cy: listening to anything lately?".match(cy)).toBeNull();
  });
});
