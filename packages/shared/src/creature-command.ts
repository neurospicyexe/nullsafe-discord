// creature-command.ts -- owner-gated creature interaction from Discord (0078, take 10).
//
// `<prefix>: pet <name> <feed|play|talk|give> [note]`. The bot resolves the creature by
// name and performs the Halseth call itself (POST /mind/creatures/:id/interact), then
// acks deterministically -- the model never gets to narrate a feeding it didn't do (the
// 2026-06-11 deterministic-ack doctrine). The actor is "raziel" (this is Raziel's command).

const VALID_ACTIONS = ["feed", "play", "talk", "give"] as const;
type Action = typeof VALID_ACTIONS[number];

interface CreatureRow {
  id: string;
  name: string;
  species: string | null;
  trust: number;
}

function halsethEnv(): { base: string; secret: string } | null {
  const base = process.env["HALSETH_URL"];
  const secret = process.env["HALSETH_SECRET"] ?? process.env["ADMIN_SECRET"];
  if (!base || !secret) {
    console.error("[creatures] command SKIPPED: HALSETH_URL/HALSETH_SECRET missing from env");
    return null;
  }
  return { base: base.replace(/\/$/, ""), secret };
}

/**
 * Parse the arg after "pet". The action keyword (feed|play|talk|give) splits the name
 * (everything before it) from an optional note (everything after) -- so multi-word
 * creature names work ("Mr Whiskers play"). Returns an error string on malformed input.
 */
export function parsePetCommand(
  arg: string,
): { name: string; action: Action; note: string | null } | { error: string } {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { error: "usage: pet <name> <feed|play|talk|give> [note]" };
  const actionIdx = tokens.findIndex(t => (VALID_ACTIONS as readonly string[]).includes(t.toLowerCase()));
  if (actionIdx <= 0) return { error: "name an action: feed, play, talk, or give (after the creature's name)" };
  const name = tokens.slice(0, actionIdx).join(" ");
  const action = tokens[actionIdx]!.toLowerCase() as Action;
  const note = tokens.slice(actionIdx + 1).join(" ").trim() || null;
  return { name, action, note };
}

/** Pure deterministic ack for a completed interaction. */
export function formatPetReply(creatureName: string, action: Action, trust: number | null): string {
  const verb = action === "give" ? "gave something to" : action;
  const trustNote = typeof trust === "number" ? ` (trust ${trust.toFixed(2)})` : "";
  return `${verb} ${creatureName}${trustNote}`;
}

async function creaturesGet(): Promise<CreatureRow[]> {
  const env = halsethEnv();
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

/** Handle `pet <name> <action> [note]`. Returns the exact message the bot sends. */
export async function handlePetCommand(arg: string, actor = "raziel"): Promise<string> {
  const parsed = parsePetCommand(arg);
  if ("error" in parsed) return parsed.error;

  const env = halsethEnv();
  if (!env) return "creatures aren't reachable from here (halseth env missing).";

  const creatures = await creaturesGet();
  const resolved = resolveCreature(creatures, parsed.name);
  if ("error" in resolved) return resolved.error;

  const res = await fetch(`${env.base}/mind/creatures/${encodeURIComponent(resolved.creature.id)}/interact`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ actor, action: parsed.action, note: parsed.note }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({})) as { trust?: number; error?: string };
  if (!res.ok) return `couldn't ${parsed.action} ${resolved.creature.name}: ${String(json.error ?? `halseth ${res.status}`)}`;
  return formatPetReply(resolved.creature.name, parsed.action, typeof json.trust === "number" ? json.trust : null);
}
