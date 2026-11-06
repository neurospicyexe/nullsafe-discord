// B63 step 4: the reflection gets the companion's OWN record instead of a count, offered pressure is
// an offer never a write, a tension names the float it drags, and Gaia's spoke_without_load is a
// flag she confirms or dismisses. FIXTURE text only.

import { describe, it, expect } from "vitest";
import {
  parseVerdict, buildPrompt, renderOwnRecord, renderPressureOffers, dippedFloat, resolveFloat, FLOAT_LABELS,
} from "../reflection.js";
import type { ReflectionRecord } from "../halseth-client.js";

const base = { reply: "A plain reply about the day.", journal: "A plain private journal entry." };
const TIDS = new Set(["t1"]);
const LABELS = FLOAT_LABELS.drevan;

function record(over: Partial<ReflectionRecord> = {}): ReflectionRecord {
  return {
    companion_id: "drevan",
    closes: [{ spine: "I made a small thing and sat with it.", last_real_thing: "the thing landed", at: "2026-11-05T20:00:00Z" }],
    makes: [{ kind: "writing", title: "A fixture poem", at: "2026-11-05" }],
    letters: [{ text: "Raziel, a fixture letter.", at: "2026-11-05" }],
    feelings: [{ emotion: "tender", sub_emotion: "wistful", at: "2026-11-05" }],
    moves: [{ label: "reach", delta: -0.06, cause: "quiet day: no triad contact" }],
    pressure: [], pressure_flags: [], spoke_without_load: [], ...over,
  };
}
const offer = (over: Record<string, unknown> = {}) => ({
  float_key: "soma_float_3" as const, label: "weight", direction: "low" as const, days: 3,
  cause: "loss unclosed", text: "your weight has sat low for 3 days, since loss unclosed", ...over,
});

describe("the prompt carries the companion's OWN record, not a count", () => {
  it("renders closes, makes, letters, feelings and moves with causes, and explains the facts line is in words", () => {
    const p = buildPrompt("drevan", "Drevan. 2026-11-05.\n  day: 56 Discord messages", [], [], [], null, [], record());
    expect(p).toContain("Your own record of the last day");
    expect(p).toContain("I made a small thing and sat with it.");
    expect(p).toContain('writing "A fixture poem"');
    expect(p).toContain("Raziel, a fixture letter.");
    expect(p).toContain("tender (wistful)");
    expect(p).toContain("reach down 0.06 (quiet day: no triad contact)");
    expect(p).toContain("means messages, not words");
    // the old count-first framing is replaced, not stacked
    expect(p).not.toContain("Read the `day:` line first");
  });

  it("keeps the anti-repeat logic with a record present", () => {
    const prev = { content: "last night's fixture reflection", created_at: "2026-11-04 21:00:00" };
    const p = buildPrompt("drevan", "Drevan. 2026-11-05.", [], [], [], prev, [], record());
    expect(p).toContain("is below ONLY so you do not repeat it");
    expect(p).toContain("The gauge is the sensor, not the day.");
  });

  it("falls back to the section-only framing when the record could not be read", () => {
    const p = buildPrompt("drevan", "Drevan. 2026-11-05.", [], [], [], null, [], null);
    expect(p).toContain("Read the `day:` line first");
    expect(p).not.toContain("Your own record of the last day");
  });

  it("a thin record says the day was quiet; nothing is invented", () => {
    const r = renderOwnRecord(record({ closes: [], makes: [], letters: [], feelings: [], moves: [] }));
    expect(r).not.toContain("You made");
    expect(r).not.toContain("You closed");
    expect(r).toContain("ONE plain sentence");
  });
});

describe("pressure is an offer", () => {
  it("renders 'your weight has sat low for N days, since <cause>' and tells them naming nothing is honest", () => {
    const lines = renderPressureOffers("drevan", record({ pressure: [offer()] })).join("\n");
    expect(lines).toContain("your weight has sat low for 3 days, since loss unclosed.");
    expect(lines).toContain("an OFFER; nothing is written unless you name it");
    expect(lines).toContain("Naming nothing is honest");
    expect(lines).toContain("heat, reach, weight");
  });

  it("also offers a live pressure flag", () => {
    const lines = renderPressureOffers("drevan", record({ pressure_flags: [{ severity: "warning", summary: "loop on one image" }] })).join("\n");
    expect(lines).toContain("a live flag (warning): loop on one image");
  });

  it("offers nothing when nothing is pressing", () => {
    expect(renderPressureOffers("drevan", record())).toEqual([]);
  });

  it("the JSON contract lets them name which float the new tension drags", () => {
    const p = buildPrompt("drevan", "Drevan. 2026-11-05.", [], [], [], null, [], record({ pressure: [offer()] }));
    expect(p).toContain('"new_tension_drags"');
    expect(p).toContain('"new_tension_from_pressure"');
  });
});

describe("tension drags_float parsing", () => {
  it("a new tension names its float by label or by column; unknown names none", () => {
    const v = (x: unknown) => parseVerdict(JSON.stringify({ ...base, new_tension: "a fixture tension", ...(x as object) }), TIDS, new Set(), new Set(), LABELS)!;
    expect(v({ new_tension_drags: "weight" }).new_tension_drags).toBe("soma_float_3");
    expect(v({ new_tension_drags: "soma_float_1" }).new_tension_drags).toBe("soma_float_1");
    expect(v({ new_tension_drags: "heat" }).new_tension_drags).toBe("soma_float_1");
    expect(v({ new_tension_drags: "nonsense" }).new_tension_drags).toBeNull();
    expect(v({}).new_tension_drags).toBeNull();
  });

  it("no tension means no float and no from_pressure", () => {
    const v = parseVerdict(JSON.stringify({ ...base, new_tension: null, new_tension_drags: "weight", new_tension_from_pressure: true }), TIDS, new Set(), new Set(), LABELS)!;
    expect(v.new_tension_drags).toBeNull();
    expect(v.new_tension_from_pressure).toBe(false);
  });

  it("only a HELD tension action may set the float", () => {
    const mk = (action: string) => parseVerdict(JSON.stringify({ ...base, tension_action: { id: "t1", action, note: "n", drags: "reach" } }), TIDS, new Set(), new Set(), LABELS)!;
    expect(mk("hold").tension_action!.drags_float).toBe("soma_float_2");
    expect(mk("release").tension_action!.drags_float).toBeNull();
    expect(mk("crystallize").tension_action!.drags_float).toBeNull();
  });

  it("the default for a tension named from pressure is the float that dipped (longest-held low)", () => {
    expect(dippedFloat([offer({ float_key: "soma_float_2", days: 2 }), offer({ float_key: "soma_float_3", days: 5 })])).toBe("soma_float_3");
    expect(dippedFloat([offer({ direction: "high" })])).toBeNull();
    expect(dippedFloat([])).toBeNull();
  });

  it("resolveFloat is label-aware per companion", () => {
    expect(resolveFloat("perimeter", FLOAT_LABELS.gaia)).toBe("soma_float_3");
    expect(resolveFloat("perimeter", FLOAT_LABELS.drevan)).toBeNull();
  });
});

describe("spoke_without_load: a clerk flags, only her confirm counts", () => {
  const flag = { id: "j-aaaa1111", at: "2026-11-05 10:00:00", excerpt: "the lantern stays lit at the north gate" };

  it("shows Gaia the flags with their ids and says leaving one out dismisses it", () => {
    const lines = renderPressureOffers("gaia", record({ companion_id: "gaia", spoke_without_load: [flag] })).join("\n");
    expect(lines).toContain("[j-aaaa1111] the lantern stays lit at the north gate");
    expect(lines).toContain("leaving one out dismisses it");
  });

  it("no one else is shown the flag block", () => {
    expect(renderPressureOffers("drevan", record({ spoke_without_load: [flag] }))).toEqual([]);
  });

  it("keeps only confirmed ids the clerk actually offered; an invented id is dropped; capped at 3", () => {
    const offered = new Set(["j1", "j2", "j3", "j4"]);
    const v = parseVerdict(JSON.stringify({ ...base, spoke_without_load_confirm: ["j1", "bogus", "j1", "j2", "j3", "j4"] }), TIDS, new Set(), offered, FLOAT_LABELS.gaia)!;
    expect(v.spoke_without_load_confirm).toEqual(["j1", "j2", "j3"]);
  });

  it("absent or malformed confirm = a dismissal of everything", () => {
    const offered = new Set(["j1"]);
    expect(parseVerdict(JSON.stringify(base), TIDS, new Set(), offered)!.spoke_without_load_confirm).toEqual([]);
    expect(parseVerdict(JSON.stringify({ ...base, spoke_without_load_confirm: "j1" }), TIDS, new Set(), offered)!.spoke_without_load_confirm).toEqual([]);
  });
});
