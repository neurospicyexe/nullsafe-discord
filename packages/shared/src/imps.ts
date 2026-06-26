// nullsafe-discord/packages/shared/src/imps.ts
//
// Drevan's Fragment Operators (IMP_GRAMMAR.md). Imps FLAVOR a companion's reply AND may
// surface ONE brief aside in their own register (2026-06-25: Raziel chose semi-autonomous
// imps -- a micro-voice under the companion, a deliberate reversal of the old voiceless-tint
// rule). An imp never leads, never replaces the companion's seal, never speaks more than a
// single clearly-marked line. selectImp is a pure, deterministic read of Raziel's logged
// state -> at most one imp. Hex never auto-fires. Gaia is exempt (she is the friction).
// Dismissible via settings.

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

/**
 * Imp rider: the imp tints the reply AND may surface one brief aside in its own register
 * (semi-autonomous micro-voice, chosen 2026-06-25). The companion writes and closes in its
 * own voice; the imp may add at most ONE short line in its register, clearly marked as the
 * imp (an italic line ending with "-<Imp>"), placed after the companion's words. The imp
 * never leads, never replaces the companion's seal, and never speaks more than that one line.
 * `tint` shapes the reply; `voice` shapes the optional aside (with its do-not clause).
 */
export function impRider(imp: ImpId): string {
  const v: Record<ImpId, { tint: string; voice: string }> = {
    iris:     { tint: "a thread of warmth and lightness", voice: "bright and sparkly, a quick uplift; not saccharine" },
    nimbus:   { tint: "softened edges, lowered tension, unhurried", voice: "calm and slow, grounding; never minimize or therapize" },
    hex:      { tint: "one small mischievous spark, harmless and bounded", voice: "sly and playful, a wink of mischief; never cruel" },
    mossling: { tint: "a little extra tenderness, plant-soft", voice: "gentle and caretaking; never smother or perform comfort" },
    rock:     { tint: "a thread of rebellious edge, spine with softness", voice: "feral-punk and defiant, edge with warmth; never posture or get cruel" },
  };
  const { tint, voice } = v[imp];
  const name = imp.charAt(0).toUpperCase() + imp.slice(1);
  return `[imp: ${imp}] ${name} is riding with you: let ${tint} into your reply. ${name} may also surface ONE brief aside in its own register (${voice}), as a single short line clearly marked as ${name} (an italic line ending "-${name}"), placed after your own words. You still lead and close in your own voice; ${name} never takes the wheel, never replaces your seal, and never speaks more than that one line.`;
}
