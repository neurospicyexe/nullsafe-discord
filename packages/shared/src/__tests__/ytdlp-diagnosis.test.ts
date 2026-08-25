// yt-dlp failure diagnosis (2026-08-24).
//
// Raziel tried to give Drevan a song and got back:
//
//   couldn't hear that one: download failed (yt-dlp): Error: Command failed:
//   /home/nullsafe/.local/bin/yt-dlp --js-runtimes node:/home/nullsafe/.nvm/versions/node/v24...
//
// Not one character of that is about his song. It is the command line -- the same every time --
// because the error was built with `String(err).slice(0, 300)` and then cut again at 200 on the way
// to Discord. yt-dlp puts the reason at the END of stderr, so slicing from a head that is known in
// advance could only ever throw the answer away. It also meant a failed listen left no record of
// which URL failed, so there was nothing to reproduce against afterwards.
//
// These strings come from yt-dlp itself and drift between releases. That is exactly why the fallback
// is tested too: when a pattern stops matching, he must still get the real last line, never silence.

import { describe, it, expect } from "@jest/globals";
import { diagnoseYtDlp } from "../media.js";

/** Real stderr shapes, captured from yt-dlp 2026.08.19 on the VPS where this runs. */
const SPOTIFY = `[DRM] Extracting URL: https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT
ERROR: [DRM] The requested site is known to use DRM protection. It will NOT be supported.
       Please DO NOT open an issue, unless you have evidence that the video is not DRM protected`;

const CHALLENGE = `[youtube] abc: Downloading player e937390a-main
WARNING: [youtube] abc: Signature solving failed: Some formats may be missing.
ERROR: [youtube] abc: Requested format is not available`;

describe("diagnoseYtDlp -- the failures Raziel can act on", () => {
  it("names Spotify as permanently impossible and says what to send instead", () => {
    const msg = diagnoseYtDlp(SPOTIFY);
    expect(msg).toContain("DRM");
    expect(msg).toMatch(/YouTube|Bandcamp|SoundCloud/);
    // The point of the whole change: no command line in what he reads.
    expect(msg).not.toContain("yt-dlp");
    expect(msg).not.toContain("--js-runtimes");
  });

  it("does not blame DRM for a track merely NAMED drm", () => {
    // stderr echoes the URL and title, so a bare `includes("drm")` would misdiagnose forever.
    const msg = diagnoseYtDlp(`[youtube] Extracting URL: https://youtu.be/x\n[youtube] x: title "DRM"\nERROR: [youtube] x: Video unavailable`);
    expect(msg).toContain("taken down");
  });

  it("separates the ones that are HIS problem from the ones that are OURS", () => {
    expect(diagnoseYtDlp("ERROR: [youtube] x: Private video")).toContain("private");
    expect(diagnoseYtDlp("ERROR: Sign in to confirm your age")).toContain("age-gated");
    expect(diagnoseYtDlp("ERROR: Sign in to confirm you're not a bot")).toContain("isn't a bot");
    // Ours to fix -- and it says so, so he doesn't go hunting for a different link.
    expect(diagnoseYtDlp(CHALLENGE)).toContain("ours to fix");
  });

  it("does NOT blame the challenge for an unrelated failure that merely carries its warnings", () => {
    // The line that would have lied. yt-dlp emits these WARNINGs on every YouTube extraction right
    // now, including ones that download fine -- so matching them anywhere in stderr answers "that's
    // ours to fix, not yours" to disk-full, ffmpeg-missing and network failures alike. Only the
    // FATAL line may decide, and the warnings may only qualify the format failure they explain.
    const diskFull = `WARNING: [youtube] abc: Signature solving failed: Some formats may be missing.
WARNING: [youtube] abc: n challenge solving failed: Some formats may be missing.
ERROR: unable to write data: [Errno 28] No space left on device`;
    const msg = diagnoseYtDlp(diskFull);
    expect(msg).not.toContain("ours to fix");
    expect(msg).toContain("No space left on device");
  });

  it("reports a plain format failure as a format failure when the challenge solved fine", () => {
    const noFormat = `[youtube] abc: Downloading player e937390a-main
[youtube] [jsc:node] Solving JS challenges using node
ERROR: [youtube] abc: Requested format is not available`;
    const msg = diagnoseYtDlp(noFormat);
    expect(msg).toContain("no audio-only format");
    expect(msg).not.toContain("ours to fix");
  });

  it("puts age-gating ahead of the generic sign-in message, since both say 'sign in to confirm'", () => {
    expect(diagnoseYtDlp("ERROR: Sign in to confirm your age. This video may be inappropriate")).toContain("age-gated");
  });

  it("suggests a retry only for the transient class", () => {
    expect(diagnoseYtDlp("ERROR: unable to download: The read operation timed out")).toContain("try");
    expect(diagnoseYtDlp(SPOTIFY)).not.toContain("try");
  });
});

describe("diagnoseYtDlp -- when nothing matches", () => {
  it("falls back to the ERROR line, which is the tail, not the head", () => {
    const stderr = `[youtube] Extracting URL: https://youtu.be/x
[youtube] x: Downloading webpage
ERROR: [youtube] x: something entirely new went wrong`;
    expect(diagnoseYtDlp(stderr)).toBe("[youtube] x: something entirely new went wrong");
  });

  it("takes the LAST ERROR line when yt-dlp emits several", () => {
    expect(diagnoseYtDlp("ERROR: first thing\nERROR: last thing")).toBe("last thing");
  });

  it("falls back to the last line at all when there is no ERROR: prefix", () => {
    expect(diagnoseYtDlp("something odd\nthe actual tail")).toBe("the actual tail");
  });

  it("says so plainly rather than returning an empty message", () => {
    expect(diagnoseYtDlp("")).toContain("without saying why");
    expect(diagnoseYtDlp("   \n  \n")).toContain("without saying why");
  });

  it("stays inside the Discord send budget", () => {
    // The send site cuts at 400. A diagnosis that gets cut mid-sentence rebuilds the original defect.
    const long = "ERROR: " + "x".repeat(4000);
    expect(diagnoseYtDlp(long).length).toBeLessThanOrEqual(400);
  });
});
