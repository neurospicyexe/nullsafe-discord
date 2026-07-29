// The live hermes-model-map.json is the authority for what `cy: model` can apply (2026-07-29).
//
// Measured drift when this was written: the Discord command validated against ALL_MODELS (23 keys)
// while the watcher resolved against the live map (19 keys on the VPS). 9 keys acked SUCCESS and
// could never land; 5 keys the watcher could serve were rejected as invalid. Root cause was not
// code drift -- `nullsafe-triad-skills` has no git remote by design, so the VPS copy and the
// workstation copy are unrelated repos with no sync path and `ops/` is untracked there.
//
// These tests pin the two properties that matter: never offer what cannot land, and never lock
// Raziel out of switching when the map is missing or wrong.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHermesModelKeys, selectableModels, diagnoseHermesMap } from "../hermes-model-map.js";
import { ALL_MODELS } from "../models.js";

function writeMap(contents: unknown | string): string {
  const dir = mkdtempSync(join(tmpdir(), "hermes-map-"));
  const file = join(dir, "hermes-model-map.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return file;
}

describe("readHermesModelKeys", () => {
  it("returns the model keys and drops the `_`-prefixed prose notes", () => {
    const file = writeMap({
      _comment: "not a model",
      _local_note: "also not a model",
      flash: { default: "deepseek-v4-flash" },
      pro: { default: "deepseek-v4-pro" },
    });
    const keys = readHermesModelKeys(file);
    expect(keys && [...keys].sort()).toEqual(["flash", "pro"]);
  });

  it("returns null for a missing file, so callers fail open", () => {
    expect(readHermesModelKeys(join(tmpdir(), "definitely-not-here-91827.json"))).toBeNull();
  });

  it("returns null for malformed JSON rather than throwing at boot", () => {
    expect(readHermesModelKeys(writeMap("{ this is not json"))).toBeNull();
  });

  it("treats an empty or notes-only map as unreadable, not as `nothing is selectable`", () => {
    // A truncated write would otherwise lock out model switching entirely.
    expect(readHermesModelKeys(writeMap({}))).toBeNull();
    expect(readHermesModelKeys(writeMap({ _comment: "only notes" }))).toBeNull();
  });

  it("returns null for a JSON array, which is a wrong-shape file", () => {
    expect(readHermesModelKeys(writeMap(["flash", "pro"]))).toBeNull();
  });
});

describe("selectableModels", () => {
  it("intersects the registry with the live map", () => {
    const offered = selectableModels(new Set(["flash", "pro", "claude-opus"]));
    expect(Object.keys(offered).sort()).toEqual(["claude-opus", "flash", "pro"]);
  });

  it("never offers a key the watcher cannot apply", () => {
    // gpt-5.5 was in ALL_MODELS but absent from the live VPS map: the exact live defect.
    const offered = selectableModels(new Set(["flash", "pro"]));
    expect(offered["gpt-5.5"]).toBeUndefined();
    expect(ALL_MODELS["gpt-5.5"]).toBeDefined(); // still a real registry entry
  });

  it("carries the registry's own entry through, so labels and providers stay canonical", () => {
    const offered = selectableModels(new Set(["flash"]));
    expect(offered["flash"]).toEqual(ALL_MODELS["flash"]);
  });

  it("falls back to the FULL registry when the map is unreadable (null)", () => {
    // Fail-open is deliberate: a bad map must not leave him unable to switch models at all.
    expect(selectableModels(null)).toBe(ALL_MODELS);
  });

  it("falls back to the full registry when the intersection is empty", () => {
    // A real file describing a different world (wrong deploy) -- offering nothing is worse.
    expect(selectableModels(new Set(["some-model-from-another-system"]))).toBe(ALL_MODELS);
  });

  it("ignores map keys the bot build does not know", () => {
    const offered = selectableModels(new Set(["flash", "gemini-3"]));
    expect(Object.keys(offered)).toEqual(["flash"]);
  });
});

describe("diagnoseHermesMap", () => {
  it("reports both directions of the gap", () => {
    const diag = diagnoseHermesMap(new Set(["flash", "pro", "gemini-pro"]));
    expect(diag).not.toBeNull();
    // Reachable by the watcher but not offered by this build.
    expect(diag!.unofferedByBot).toContain("gemini-pro");
    // Offered by this build but not applicable -- would ack and change nothing.
    expect(diag!.unapplicableByWatcher).toContain("gpt-5.5");
    expect(diag!.unapplicableByWatcher).not.toContain("flash");
    expect(diag!.selectableCount).toBe(2);
  });

  it("returns null when there is no map to compare against", () => {
    expect(diagnoseHermesMap(null)).toBeNull();
  });

  it("reports a clean bill when the map covers the whole registry", () => {
    const diag = diagnoseHermesMap(new Set(Object.keys(ALL_MODELS)));
    expect(diag!.unapplicableByWatcher).toEqual([]);
    expect(diag!.unofferedByBot).toEqual([]);
    expect(diag!.selectableCount).toBe(Object.keys(ALL_MODELS).length);
  });
});

describe("a stored active_model is adopted only if this runtime can apply it", () => {
  // Both the boot read and the periodic refresh in bot-core gate on selectableModels(), not
  // ALL_MODELS. Otherwise a key set before this guard shipped, edited straight into D1, or orphaned
  // when the map shrank would make the companion REPORT a model the watcher never switched it to --
  // the same divergence this module exists to close, surviving in the place that decides what it
  // thinks it is running.
  const liveMap = new Set(["flash", "pro"]);

  it("adopts a stored key the live map can apply", () => {
    expect(selectableModels(liveMap)["flash"]).toBeDefined();
  });

  it("refuses a stored key that is real but unapplicable, so the label cannot lie", () => {
    expect(ALL_MODELS["qwen-local"]).toBeDefined();
    expect(selectableModels(liveMap)["qwen-local"]).toBeUndefined();
  });

  it("still adopts anything when there is no live map to check against", () => {
    expect(selectableModels(null)["qwen-local"]).toBeDefined();
  });
});

describe("keys, never model id strings", () => {
  it("does not compare model ids, because one key legitimately differs per provider", () => {
    // mistral-large is `mistral-large-latest` on the Mistral API (bots/Brain) and
    // `mistralai/mistral-large` through OpenRouter (how hermes routes it). Both are correct; an
    // id-level comparison would report that as a conflict and invite someone to "fix" it.
    const offered = selectableModels(new Set(["mistral-large"]));
    expect(offered["mistral-large"].model).toBe("mistral-large-latest");
  });
});
