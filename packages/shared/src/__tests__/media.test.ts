import { buildHeardBlock, pickLyrics, compactAnalysis, cleanTrackTitle, cleanArtist } from "../media.js";

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

describe("cleanTrackTitle (2026-06-14: raw YouTube titles 404'd LRCLIB)", () => {
  it("strips the exact title that failed live", () => {
    expect(cleanTrackTitle('"All Fall Down" ft. Lestat de Lioncourt (Official Lyric Video) | The Vampire Lestat | AMC+'))
      .toBe("All Fall Down");
  });
  it("strips common production noise", () => {
    expect(cleanTrackTitle("Hurt (Official Music Video)")).toBe("Hurt");
    expect(cleanTrackTitle("Blinding Lights [Official Audio]")).toBe("Blinding Lights");
    expect(cleanTrackTitle("Song Title (Remastered 2011)")).toBe("Song Title");
    expect(cleanTrackTitle("Track feat. Someone Else")).toBe("Track");
  });
  it("leaves an already-clean title untouched (idempotent)", () => {
    expect(cleanTrackTitle("Mother Teresa")).toBe("Mother Teresa");
    expect(cleanTrackTitle(cleanTrackTitle("Hurt (Official Video)"))).toBe("Hurt");
  });
});

describe("cleanArtist", () => {
  it("takes the first artist and drops YouTube's - Topic suffix", () => {
    expect(cleanArtist("Victor Jones, Victor Jones")).toBe("Victor Jones");
    expect(cleanArtist("Johnny Cash - Topic")).toBe("Johnny Cash");
    expect(cleanArtist("amc+, Lakeshore Records")).toBe("amc+");
  });
});

describe("buildHeardBlock -- no-lyrics grounding", () => {
  it("does NOT let a fetch miss read as instrumental (2026-06-14 overclaim)", () => {
    const block = buildHeardBlock(
      { title: "All Fall Down", artist: "Lestat de Lioncourt", duration_sec: 83 },
      { tempo_bpm: 123, tempo_estimated: true, key: { tonic: "A", mode: "major", confidence: 0.68 }, onset_count: 88, duration: 83 },
      null,
    );
    expect(block).toMatch(/do not claim it has no lyrics/i);
    expect(block).not.toMatch(/none found on LRCLIB\.?$/i);
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
  it("renders hear-music's real key shape ({tonic, mode, confidence})", () => {
    const block = buildHeardBlock(
      { title: "Tone", artist: null, duration_sec: 5 },
      { tempo_bpm: 198.77, tempo_estimated: true, key: { tonic: "A", mode: "minor", confidence: 0.682 }, onset_count: 0, duration: 5 },
      null,
    );
    expect(block).toContain("Key: A minor");
    expect(block).toContain("0.682");
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
