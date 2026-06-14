import {
  buildHeardBlock, pickLyrics, compactAnalysis, cleanTrackTitle, cleanArtist, extractWebLyrics,
  lyricsSearchQuery, lyricsContextTokens, pickWebLyricsResult, type TrackMeta,
} from "../media.js";

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

describe("web-lyrics disambiguation (2026-06-14: grabbed a DIFFERENT band's song)", () => {
  // The real track: cleaned title loses the disambiguators, raw title keeps them.
  const amcTrack: TrackMeta = {
    title: "All Fall Down",
    rawTitle: '"All Fall Down" ft. Lestat de Lioncourt (Official Lyric Video) | The Vampire Lestat | AMC+',
    artist: "amc+, Lakeshore Records",
    duration_sec: 83,
  };
  // Real Tavily results observed live for query "All Fall Down ... lyrics".
  const fangclub = { url: "https://genius.com/Fangclub-all-fall-down-lyrics", content: "[ Verse 1 ] When the sky falls down. I'm alive. With a shotgun mouth. Over mind." };
  const vampireLestat = { url: "https://genius.com/The-vampire-lestat-all-fall-down-lyrics", content: "All Fall Down Lyrics: I'm the little killer / I'm the lonely one / I'm the chill creepin' up your spine" };

  it("search query keeps the disambiguators cleaning strips", () => {
    const q = lyricsSearchQuery(amcTrack).toLowerCase();
    expect(q).toContain("lestat");
    expect(q).toContain("vampire");
    expect(q).toContain("lyrics");
    expect(q).not.toContain("(official"); // bracket noise dropped
  });

  it("derives distinctive context tokens, not the generic song name", () => {
    const t = lyricsContextTokens(amcTrack);
    expect(t.context).toEqual(expect.arrayContaining(["lestat", "lioncourt", "vampire"]));
    expect(t.context).not.toContain("fall"); // bare song-name words excluded
    expect(t.context).not.toContain("down");
  });

  it("REJECTS the wrong-band page and picks the right one", () => {
    const tokens = lyricsContextTokens(amcTrack);
    // order as Tavily returned it: wrong song first
    const picked = pickWebLyricsResult([fangclub, vampireLestat], tokens);
    expect(picked?.url).toBe(vampireLestat.url);
  });

  it("refuses (null) when only a wrong-song page is available -- no lyrics beats wrong lyrics", () => {
    const tokens = lyricsContextTokens(amcTrack);
    expect(pickWebLyricsResult([fangclub], tokens)).toBeNull();
  });

  it("refuses when there is nothing to disambiguate on (generic title, no artist)", () => {
    const bare: TrackMeta = { title: "All Fall Down", artist: null, duration_sec: null };
    const tokens = lyricsContextTokens(bare);
    expect(tokens.context).toHaveLength(0);
    expect(pickWebLyricsResult([fangclub, vampireLestat], tokens)).toBeNull();
  });

  it("validates on artist tokens when there's no extra title context", () => {
    const clean: TrackMeta = { title: "Mother Teresa", artist: "Victor Jones", duration_sec: 155 };
    const tokens = lyricsContextTokens(clean);
    const hit = { url: "https://genius.com/Victor-jones-mother-teresa-lyrics", content: "Mother Teresa Lyrics: Left the oven on when I went to the salon, came back home and it was gone" };
    const wrong = { url: "https://genius.com/Someone-else-mother-teresa-lyrics", content: "a different mother teresa song entirely with its own unrelated words here" };
    expect(pickWebLyricsResult([wrong, hit], tokens)?.url).toBe(hit.url);
  });
});

describe("extractWebLyrics (Tavily fallback when LRCLIB misses)", () => {
  it("strips the '… Lyrics:' label and restores Genius ' / ' line breaks", () => {
    // The real Tavily snippet for the AMC+ track that LRCLIB lacked (2026-06-14).
    const snippet = "All Fall Down Lyrics: I'm the little killer / I'm the lonely one / I'm the chill creepin' up your spine / Tellin' you to run";
    const out = extractWebLyrics(snippet);
    expect(out.startsWith("I'm the little killer")).toBe(true);
    expect(out).not.toMatch(/lyrics:/i);
    expect(out.split("\n").length).toBeGreaterThanOrEqual(4);
  });
  it("handles Musixmatch ' ; ' separators", () => {
    const out = extractWebLyrics("Lyrics of All Fall Down by The Vampire Lestat ; I'm the little killer ; I'm the lonely one");
    expect(out.split("\n")).toContain("I'm the little killer");
  });
});

describe("buildHeardBlock -- web-sourced lyrics are flagged", () => {
  it("labels web lyrics as partial/approximate so they aren't taken as a full transcript", () => {
    const block = buildHeardBlock(
      { title: "All Fall Down", artist: "The Vampire Lestat", duration_sec: 83 },
      { tempo_bpm: 123, tempo_estimated: true, key: null, onset_count: 88, duration: 83 },
      "I'm the little killer\nI'm the lonely one",
      "web",
    );
    expect(block).toMatch(/web-sourced/i);
    expect(block).toMatch(/partial\/approximate/i);
    expect(block).toContain("I'm the little killer");
  });
  it("LRCLIB lyrics keep the plain 'excerpt' label (verbatim)", () => {
    const block = buildHeardBlock(
      { title: "Hurt", artist: "Johnny Cash", duration_sec: 218 },
      { tempo_bpm: 84, tempo_estimated: false, key: null, onset_count: 1, duration: 218 },
      "I hurt myself today",
      "lrclib",
    );
    expect(block).toContain("Lyrics (excerpt):");
    expect(block).not.toMatch(/web-sourced/i);
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
