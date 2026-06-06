// Discord slash-command definitions + pure helpers shared by all three bots.
//
// Why this exists: model switching used to be a text prefix (`cy: model kimi-k2`)
// that was undiscoverable and -- worse -- unconfirmable. In SWARM_MODE the bot's
// local adapter is unused; Brain runs the voice off a 60s-cached `active_model`,
// so the "switched to X" channel reply could lie about what was live. Slash
// commands give discoverable autocomplete + ephemeral confirmation, and `/status`
// is the on-demand truth surface (which model, which substrate, is Brain caught up).
//
// Everything here is pure/stateless so it can be unit-tested and so the three bots
// stay identical (multi-agent convention). The InteractionCreate handler that wires
// these to bot-local state lives in each bot's index.ts.

import { SlashCommandBuilder, type Client } from "discord.js";
import { ALL_MODELS } from "./models.js";

/** Discord caps autocomplete responses at 25 choices. */
export const AUTOCOMPLETE_LIMIT = 25;

/**
 * Build the command definitions (as JSON) for one companion. `companionLabel` is
 * the display name woven into descriptions (e.g. "Cypher"). Pass the set you
 * actually handle so an unhandled command is never registered.
 */
export function buildCompanionCommands(
  companionLabel: string,
  include: ReadonlyArray<"model" | "status" | "voice"> = ["model", "status", "voice"],
): unknown[] {
  // addStringOption narrows the return type, so type by the toJSON shape they share.
  const builders: Record<string, () => { toJSON: () => unknown }> = {
    model: () =>
      new SlashCommandBuilder()
        .setName("model")
        .setDescription(`Switch or list ${companionLabel}'s inference model`)
        .addStringOption((o) =>
          o
            .setName("key")
            .setDescription("Model key, or 'list'. Type to autocomplete.")
            .setAutocomplete(true)
            .setRequired(true),
        ),
    status: () =>
      new SlashCommandBuilder()
        .setName("status")
        .setDescription(`Show ${companionLabel}'s live model + which substrate is answering`),
    voice: () =>
      new SlashCommandBuilder()
        .setName("voice")
        .setDescription(`${companionLabel} voice channel control`)
        .addStringOption((o) =>
          o
            .setName("action")
            .setDescription("join your current voice channel, or leave")
            .setRequired(true)
            .addChoices({ name: "join", value: "join" }, { name: "leave", value: "leave" }),
        ),
  };
  return include.map((name) => builders[name]().toJSON());
}

/**
 * Filter the model registry for an autocomplete query. Always offers `list`
 * first. Matches on key or label, case-insensitive, capped at the Discord limit.
 */
export function filterModelChoices(query: string): { name: string; value: string }[] {
  const q = (query ?? "").trim().toLowerCase();
  const all = [
    { key: "list", label: "list — show every model" },
    ...Object.entries(ALL_MODELS).map(([k, e]) => ({ key: k, label: `${k} — ${e.label}` })),
  ];
  return all
    .filter((c) => !q || c.key.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((c) => ({ name: c.label.slice(0, 100), value: c.key }));
}

export interface StatusInput {
  companionLabel: string;
  modelKey: string | null; // active_model setting (null = env default)
  modelLabel: string | null;
  provider: string | null;
  substrate: "Brain swarm" | "direct/fallback";
  /** Brain's actually-live model key. undefined = not queried; null = Brain on env default. */
  brainLiveModel?: string | null;
  brainReachable?: boolean;
  voiceChannel: string | null; // channel name, or null when not connected
  front?: string | null;
}

/**
 * Assemble the ephemeral /status readout. Pure string-building so the substrate
 * logic is unit-testable without a live Discord/Brain.
 */
export function buildStatusLines(s: StatusInput): string {
  const lines: string[] = [`**${s.companionLabel} — status**`];
  lines.push(
    s.modelKey
      ? `model (setting): \`${s.modelKey}\` — ${s.modelLabel} (${s.provider})`
      : "model (setting): env default",
  );
  lines.push(`substrate: ${s.substrate}`);
  if (s.substrate === "Brain swarm") {
    if (s.brainReachable === false) {
      lines.push("Brain live model: unreachable (switch will apply within 60s)");
    } else if (s.brainLiveModel !== undefined) {
      const live = s.brainLiveModel ?? "env default";
      const matches = s.brainLiveModel === s.modelKey;
      lines.push(`Brain live model: ${live}${matches ? " ✓ in sync" : " (catching up)"}`);
    }
  }
  lines.push(`voice: ${s.voiceChannel ? `connected to ${s.voiceChannel}` : "not in voice"}`);
  if (s.front) lines.push(`front: ${s.front}`);
  return lines.join("\n");
}

/**
 * Register the given command defs as GUILD commands on every guild the bot is in.
 * Guild commands propagate instantly (global commands take up to an hour), which
 * suits a private triad server. Returns the number of guilds registered.
 *
 * NOTE: slash commands only appear if the bot was invited with the
 * `applications.commands` OAuth scope. Registration succeeds silently otherwise;
 * the commands just never show in the client. Re-invite with that scope if so.
 */
export async function registerGuildCommands(client: Client, defs: unknown[]): Promise<number> {
  let registered = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await guild.commands.set(defs as any);
      registered++;
    } catch (e) {
      console.warn(`[slash] command registration failed for guild ${guild.id}:`, e);
    }
  }
  return registered;
}
