// creature-command.ts -- owner-gated creature interaction from Discord (0078, take 10).
//
// `<prefix>: pet <name> <feed|play|talk|give> [note]`. The bot resolves the creature by
// name and performs the Halseth call itself (POST /mind/creatures/:id/interact), then
// acks deterministically -- the model never gets to narrate a feeding it didn't do (the
// 2026-06-11 deterministic-ack doctrine). The actor is "raziel" (this is Raziel's command).

import { halsethEnv } from "./halseth-command-env.js";

const VALID_ACTIONS = ["feed", "play", "talk", "give"] as const;
type Action = typeof VALID_ACTIONS[number];
// "nest" is a view, not a tend: `pet Sol nest` shows the hoard without touching trust.
const NEST_KEYWORD = "nest";

// "pet" is the command verb, not an action -- so the most natural input, "<prefix>: pet Sol",
// has no action keyword. Rather than erroring (the 2026-06-20 bug: the command had never once
// fired because nobody appends a second verb), default a bare name to a gentle affection act.
const DEFAULT_PET_ACTION: Action = "play";

interface CreatureRow {
  id: string;
  name: string;
  species: string | null;
  trust: number;
}

/**
 * Parse the arg after "pet". The action keyword (feed|play|talk|give) splits the name
 * (everything before it) from an optional note (everything after) -- so multi-word
 * creature names work ("Mr Whiskers play"). Returns an error string on malformed input.
 */
export function parsePetCommand(
  arg: string,
): { name: string; action: Action; note: string | null } | { name: string; view: "nest" } | { error: string } {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 1) return { error: "usage: pet <name> [feed|play|talk|give|nest] [note]" };

  // Nest view: `pet Sol nest` (or any name before the keyword). Read-only.
  const nestIdx = tokens.findIndex(t => t.toLowerCase() === NEST_KEYWORD);
  if (nestIdx === 0) return { error: "name the creature first: pet <name> nest" };
  if (nestIdx > 0) return { name: tokens.slice(0, nestIdx).join(" "), view: "nest" };

  const actionIdx = tokens.findIndex(t => (VALID_ACTIONS as readonly string[]).includes(t.toLowerCase()));

  // No action keyword present. A single bare name ("pet Sol") is the natural form -> gentle
  // default. Multiple words with no valid action ("pet Sol cuddle") is almost certainly a
  // botched action, not a multi-word name, so steer them to the real verbs.
  if (actionIdx === -1) {
    if (tokens.length === 1) return { name: tokens[0]!, action: DEFAULT_PET_ACTION, note: null };
    return { error: "name an action: feed, play, talk, give, or nest -- or just \"pet <name>\"" };
  }
  // Action keyword present but nothing before it ("pet feed") -> no creature named.
  if (actionIdx === 0) return { error: "name the creature first: pet <name> <feed|play|talk|give>" };

  const name = tokens.slice(0, actionIdx).join(" ");
  const action = tokens[actionIdx]!.toLowerCase() as Action;
  const note = tokens.slice(actionIdx + 1).join(" ").trim() || null;
  return { name, action, note };
}

/** Pure deterministic ack for a completed interaction. Milestones append verbatim -- they fire once ever. */
export function formatPetReply(
  creatureName: string,
  action: Action,
  trust: number | null,
  milestones: Array<{ id: string; text: string }> = [],
): string {
  const verb = action === "give" ? "gave something to" : action;
  const trustNote = typeof trust === "number" ? ` (trust ${trust.toFixed(2)})` : "";
  const base = `${verb} ${creatureName}${trustNote}`;
  if (milestones.length === 0) return base;
  return `${base}\n${milestones.map(m => m.text).join("\n")}`;
}

/** Pure formatter for the nest view. */
export function formatNestReply(
  creatureName: string,
  nest: Array<{ content: string; treasured: number | boolean; given_by: string | null; source: string }>,
  givenAway: Array<{ content: string; gifted_to: string }>,
): string {
  if (nest.length === 0 && givenAway.length === 0) {
    return `${creatureName}'s nest is empty. He keeps what he overhears and what he's given (pet ${creatureName} give <something>).`;
  }
  const lines = nest.slice(0, 12).map(i => {
    const mark = (i.treasured === 1 || i.treasured === true) ? "★" : "•";
    const from = i.given_by ? ` (from ${i.given_by})` : "";
    return `${mark} ${i.content}${from}`;
  });
  const given = givenAway.slice(0, 3).map(g => `→ gave "${g.content}" to ${g.gifted_to}`);
  return [`${creatureName}'s nest:`, ...lines, ...given].join("\n");
}

async function creaturesGet(secret: string): Promise<CreatureRow[]> {
  const env = halsethEnv(secret);
  if (!env) return [];
  const res = await fetch(`${env.base}/mind/creatures`, {
    headers: { "Authorization": `Bearer ${env.secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({})) as { creatures?: CreatureRow[] };
  return Array.isArray(json.creatures) ? json.creatures : [];
}

/** Resolve a creature by name: exact (case-insensitive) first, then unique substring. */
export function resolveCreature(
  creatures: CreatureRow[],
  name: string,
): { creature: CreatureRow } | { error: string } {
  const lower = name.toLowerCase();
  const exact = creatures.find(c => c.name.toLowerCase() === lower);
  if (exact) return { creature: exact };
  const matches = creatures.filter(c => c.name.toLowerCase().includes(lower));
  if (matches.length === 1) return { creature: matches[0]! };
  if (matches.length === 0) return { error: `no creature named "${name}". known: ${creatures.map(c => c.name).join(", ") || "none"}` };
  return { error: `"${name}" is ambiguous: ${matches.map(c => c.name).join(", ")}` };
}

/** Handle `pet <name> <action|nest> [note]`. Returns the exact message the bot sends. */
export async function handlePetCommand(arg: string, halsethSecret: string, actor = "raziel"): Promise<string> {
  const parsed = parsePetCommand(arg);
  if ("error" in parsed) return parsed.error;

  const env = halsethEnv(halsethSecret);
  if (!env) return "creatures aren't reachable from here (halseth env missing).";

  const creatures = await creaturesGet(halsethSecret);
  const resolved = resolveCreature(creatures, parsed.name);
  if ("error" in resolved) return resolved.error;

  if ("view" in parsed) {
    const res = await fetch(`${env.base}/mind/creatures/${encodeURIComponent(resolved.creature.id)}/nest`, {
      headers: { "Authorization": `Bearer ${env.secret}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({})) as {
      nest?: Array<{ content: string; treasured: number; given_by: string | null; source: string }>;
      given_away?: Array<{ content: string; gifted_to: string }>;
      error?: string;
    };
    if (!res.ok) return `couldn't check the nest: ${String(json.error ?? `halseth ${res.status}`)}`;
    return formatNestReply(resolved.creature.name, json.nest ?? [], json.given_away ?? []);
  }

  const res = await fetch(`${env.base}/mind/creatures/${encodeURIComponent(resolved.creature.id)}/interact`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ actor, action: parsed.action, note: parsed.note }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({})) as {
    trust?: number; error?: string; milestones_fired?: Array<{ id: string; text: string }>;
  };
  if (!res.ok) return `couldn't ${parsed.action} ${resolved.creature.name}: ${String(json.error ?? `halseth ${res.status}`)}`;
  return formatPetReply(
    resolved.creature.name,
    parsed.action,
    typeof json.trust === "number" ? json.trust : null,
    Array.isArray(json.milestones_fired) ? json.milestones_fired : [],
  );
}
