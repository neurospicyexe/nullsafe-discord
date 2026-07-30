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

import {
  SlashCommandBuilder,
  MessageFlags,
  type Client,
  type Interaction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { ALL_MODELS, type ModelEntry } from "./models.js";
import { selectableModels } from "./hermes-model-map.js";

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
export function filterModelChoices(
  query: string,
  hermesKeys?: Set<string> | null,
): { name: string; value: string }[] {
  const q = (query ?? "").trim().toLowerCase();
  // Autocomplete must offer only what can actually be applied; suggesting a key the live hermes
  // watcher cannot resolve is how a switch acks success and changes nothing. Undefined/null keys
  // (direct or brain mode, or an unreadable map) fall back to the full registry.
  const offered = selectableModels(hermesKeys ?? null);
  const all = [
    { key: "list", label: "list — show every model" },
    ...Object.entries(offered).map(([k, e]) => ({ key: k, label: `${k} — ${e.label}` })),
  ];
  return all
    .filter((c) => !q || c.key.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((c) => ({ name: c.label.slice(0, 100), value: c.key }));
}

/** What the bot process is ACTUALLY running.
 *
 *  "Brain swarm" was the third value and is gone (2026-07-29) with brain mode. Worth noting what it
 *  cost: the expression producing it could only ever return "direct/fallback", because brainClient
 *  was always null -- so `/status` reported "direct/fallback" on all three bots while every reply
 *  actually came from the Hermes agent. A label that cannot be right is worse than no label. */
export type Substrate = "hermes" | "direct/fallback";

export interface StatusInput {
  companionLabel: string;
  modelKey: string | null; // active_model setting (null = env default)
  modelLabel: string | null;
  provider: string | null;
  substrate: Substrate;
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

// ── Interaction handler (shared by all three bots) ────────────────────────────
//
// The pure pieces above are framework-light; this part touches discord.js + bot
// state. It lives in shared (not per-bot) so cypher/drevan/gaia stay byte-identical
// in behaviour -- the only per-bot difference is the SlashHandlerContext they pass.

export interface ModelCacheClient {
  invalidateModelCache(companionId: string): Promise<boolean>;
  getModelStatus(companionId: string): Promise<{ active_model: string | null } | null>;
}

export interface SlashHandlerContext {
  client: Client;
  companionLabel: string; // "Cypher"
  companionId: string; // "cypher"
  ownerDiscordId: string;
  /** Whether Brain or the local adapter actually answers right now. */
  substrate: () => Substrate;
  /** The live active-model setting. Mutated by applyModel; read by /status. */
  activeModel: { key: string | null; label: string | null };
  /** Swap the live inference adapter + update the activeModel refs. */
  applyModel: (key: string, entry: ModelEntry) => void;
  /** Persist the selection to Halseth (fire-and-forget). */
  persistModel: (key: string) => void;
  /** Keys the live hermes-model-map.json can apply. null/absent = not hermes mode or unreadable
   *  map; both fall back to the full registry. Keeps /model from offering keys that cannot land. */
  hermesModelKeys?: Set<string> | null;
  voice: {
    /** Join the invoking member's current VC. Returns channel name, or null if they're not in one. */
    join: (interaction: ChatInputCommandInteraction) => Promise<string | null>;
    /** Leave the guild's VC. Returns the channel name left, or null if not connected. */
    leave: (guildId: string | null) => string | null;
    /** Name of the VC the bot is currently in for this guild, or null. */
    currentChannelName: (guildId: string | null) => string | null;
  };
}

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

async function handleModel(
  ctx: SlashHandlerContext,
  interaction: ChatInputCommandInteraction,
  substrate: Substrate,
): Promise<void> {
  // Caller has already deferred (ephemeral); every reply below is editReply.
  const arg = (interaction.options.getString("key") ?? "").trim().toLowerCase();
  const offered = selectableModels(ctx.hermesModelKeys ?? null);
  if (arg === "list") {
    const list = Object.entries(offered).map(([k, e]) => `\`${k}\` — ${e.label}`).join("\n");
    await interaction.editReply({ content: `available models:\n${list}` });
    return;
  }
  const entry = offered[arg];
  if (!entry) {
    // A real registry model that this runtime cannot apply is a deploy gap, not a typo. Say which.
    if (ALL_MODELS[arg]) {
      await interaction.editReply({
        content: `\`${arg}\` is a real model but the live hermes map can't apply it, so switching would ack and change nothing. add it to hermes-model-map.json on the VPS first.`,
      });
      return;
    }
    await interaction.editReply({
      content: "not a model I can switch to. run `/model` and pick from autocomplete.",
    });
    return;
  }
  ctx.applyModel(arg, entry);
  ctx.persistModel(arg);

  // Applied in-process, so it is live on the next reply. The Brain cache-invalidation branch that
  // used to sit here went with brain mode (2026-07-29) -- there is no second cache to clear.
  const note = substrate === "hermes"
    ? "live now (the hermes agent picks it up on the next reply)."
    : "live now.";
  await interaction.editReply({
    content: `now live: \`${arg}\` — ${entry.label} · substrate: ${substrate}\n${note}`,
  });
}

async function handleStatus(
  ctx: SlashHandlerContext,
  interaction: ChatInputCommandInteraction,
  substrate: Substrate,
): Promise<void> {
  const key = ctx.activeModel.key;
  const lines = buildStatusLines({
    companionLabel: ctx.companionLabel,
    modelKey: key,
    modelLabel: ctx.activeModel.label,
    provider: key && ALL_MODELS[key] ? ALL_MODELS[key].provider : null,
    substrate,
    voiceChannel: ctx.voice.currentChannelName(interaction.guildId),
  });
  await interaction.editReply({ content: lines });
}

async function handleVoice(ctx: SlashHandlerContext, interaction: ChatInputCommandInteraction): Promise<void> {
  // Caller has already deferred (ephemeral); replies below are editReply.
  const action = interaction.options.getString("action");
  if (action === "join") {
    const name = await ctx.voice.join(interaction);
    await interaction.editReply({ content: name ? `joined ${name}.` : "you're not in a voice channel." });
    return;
  }
  if (action === "leave") {
    const left = ctx.voice.leave(interaction.guildId);
    await interaction.editReply({ content: left ? `left ${left}.` : "I'm not in a voice channel." });
    return;
  }
}

/**
 * Wire the InteractionCreate listener. Owner-gated, ephemeral, fail-soft. Register
 * the command DEFS separately (registerGuildCommands on ClientReady).
 */
export function installSlashCommandHandler(ctx: SlashHandlerContext): void {
  ctx.client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === "model") {
          await interaction.respond(filterModelChoices(interaction.options.getFocused(), ctx.hermesModelKeys ?? null));
        }
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.user.id !== ctx.ownerDiscordId) {
        await interaction.reply({ content: "not your dial.", ...EPHEMERAL });
        return;
      }
      // Defer immediately (instant ACK, ephemeral). The handlers below await Brain
      // calls that can take up to 5s; Discord kills the interaction token after 3s
      // if nothing has responded, so we MUST defer before any awaited work. After
      // deferReply, all responses are editReply (ephemerality is inherited).
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const substrate = ctx.substrate();
      if (interaction.commandName === "model") await handleModel(ctx, interaction, substrate);
      else if (interaction.commandName === "status") await handleStatus(ctx, interaction, substrate);
      else if (interaction.commandName === "voice") await handleVoice(ctx, interaction);
    } catch (e) {
      console.warn(`[${ctx.companionId}] slash handler error:`, e);
      if (interaction.isChatInputCommand() && interaction.deferred && !interaction.replied) {
        // Already deferred -> editReply, or the "thinking…" state hangs forever.
        await interaction.editReply({ content: "command failed -- check logs." }).catch(() => {});
      } else if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "command failed -- check logs.", ...EPHEMERAL }).catch(() => {});
      }
    }
  });
}
