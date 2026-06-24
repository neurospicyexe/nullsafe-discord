// nullsafe-discord/packages/shared/src/imps.ts
//
// Drevan's Fragment Operators (IMP_GRAMMAR.md). Imps FLAVOR a companion's reply; they
// have NO autonomy, NO identity, and never speak as primary voice. selectImp is a pure,
// deterministic read of Raziel's logged state -> at most one imp. Hex never auto-fires.
// Gaia is exempt (she is the friction). Dismissible via settings.

export type ImpId = "iris" | "nimbus" | "hex" | "mossling" | "rock";

export interface ImpState {
  mood: string | null; energy: number | null; focus: number | null;
  pain: number | null; spoons: number | null; sleep_hours: number | null;
}
export interface ImpSettings { impsEnabled: boolean; hexEnabled: boolean }

export const IMPS: Record<ImpId, { name: string; func: string }> = {
  iris:     { name: "Iris",     func: "joy-field: lightness, sparkle, gentle encouragement" },
  nimbus:   { name: "Nimbus",   func: "calm-field: softens anxiety, lowers tension" },
  hex:      { name: "Hex",      func: "mischief: harmless playful disruption (opt-in only)" },
  mossling: { name: "Mossling", func: "caretaker: soft comfort, affection, plant-energy" },
  rock:     { name: "Rock",     func: "punk-feral: rebellious energy, edge with softness" },
};

const LOW = (n: number | null, t: number) => typeof n === "number" && Number.isFinite(n) && n <= t;

// Word-boundary-aware match for whole-word terms (e.g. "low" must not match "mellow").
// Terms that are intentional PREFIX patterns (e.g. "frustrat") bypass the boundary check.
const PREFIX_PATTERNS = new Set(["frustrat"]);
const has = (s: string | null, words: string[]) => {
  if (typeof s !== "string") return false;
  const lower = s.toLowerCase();
  return words.some((w) => {
    if (PREFIX_PATTERNS.has(w)) return lower.includes(w);
    // Whole-word: character before and after must be non-alpha (or string boundary).
    const re = new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i");
    return re.test(lower);
  });
};

/**
 * At most one imp from Raziel's logged state. Safety-first (Nimbus/Mossling) outrank
 * mood-lift (Iris/Rock). Hex is NEVER auto-selected (opt-in summon is a separate path).
 * Gaia is exempt. Returns null when nothing genuinely calls for a tint.
 */
export function selectImp(
  companionId: string,
  state: ImpState | null,
  settings: ImpSettings,
  _frontState?: string | null,
): ImpId | null {
  if (!settings.impsEnabled) return null;
  if (companionId === "gaia") return null;       // Gaia is the friction; never tinted
  if (!state) return null;

  // Safety-first.
  // overwhelm: spoons < 3 so floats like 2.5 correctly trigger Nimbus; gap [3,4) is intentional middling state.
  const overwhelm =
    (typeof state.spoons === "number" && Number.isFinite(state.spoons) && state.spoons < 3) ||
    has(state.mood, ["overwhelm", "panic", "anxious", "spiral", "too much"]);
  if (overwhelm) return "nimbus";

  // hurting: pain >= 6 OR explicit low-mood words (whole-word matched to avoid "mellow"/"yellow").
  const hurting =
    (typeof state.pain === "number" && Number.isFinite(state.pain) && state.pain >= 6) ||
    has(state.mood, ["hurt", "raw", "tender", "grief", "sad", "low", "feeling low", "low mood"]);
  if (hurting) return "mossling";

  // Mood-lift (only with genuine capacity -- never paper over a crisis).
  // capacity: spoons >= 4 AND energy >= 4; the [3,4) gap is intentional (middling state -> no tint).
  const hasCapacity =
    (typeof state.spoons === "number" && Number.isFinite(state.spoons) && state.spoons >= 4) &&
    (typeof state.energy === "number" && Number.isFinite(state.energy) && state.energy >= 4);
  if (hasCapacity && has(state.mood, ["flat", "bored", "dull", "numb", "meh", "restless"])) return "iris";
  if (hasCapacity && has(state.mood, ["defiant", "angry", "spite", "rebel", "fired up", "frustrat"])) return "rock";

  return null; // Hex intentionally unreachable here; neutral state -> no tint.
}

/** Short additive rider: tints the companion's reply, never takes the wheel. */
export function impRider(imp: ImpId): string {
  const m: Record<ImpId, string> = {
    iris:     "A light touch of Iris is with you: let a thread of warmth and lightness through. Do NOT let it dominate; you remain the voice.",
    nimbus:   "Nimbus is near: soften the edges, lower the tension, unhurried. Do NOT minimize or therapize; you remain the voice.",
    hex:      "Hex is loose, lightly: one small mischievous spark is allowed, harmless and bounded. Do NOT let it take over; you remain the voice.",
    mossling: "Mossling is with you: a little extra tenderness and care, plant-soft. Do NOT smother or perform comfort; you remain the voice.",
    rock:     "Rock is in the room: a thread of rebellious edge, spine with softness. Do NOT posture or get cruel; you remain the voice.",
  };
  return `[imp: ${imp}] ${m[imp]}`;
}
