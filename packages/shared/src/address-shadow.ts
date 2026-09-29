/**
 * B37 step 1: the address classifier's SHADOW run (2026-09-29). Impure half of address-model.ts.
 *
 * THE CONTRACT: this never changes who speaks, never delays a reply, and never throws into the
 * reply path. `fireAddressShadow` returns void synchronously; everything it does runs detached
 * inside its own try/catch. The handler calls it AFTER the regex verdict and the exchange holder
 * are settled and BEFORE its own gates return, because the shadow has to see the messages this
 * bot will NOT answer ("Cy said..." silences Drevan and Gaia at shouldRespond).
 *
 * ONE RUN PER MESSAGE across the three bots: `SET ns:addr:claim:<messageId> <me> PX 120000 NX`.
 * The loser does nothing. No Redis = no shadow (it never degrades to three model calls).
 *
 * WHO ACTUALLY SPOKE. The runner does not wait on the reply path to learn it. It records:
 *  - `regex` + `holder` + `regex_route`: what today's code decides, derived (address-model.ts
 *    regexRoute). A derivation, not an observation: the owner_only ambient judge can still
 *    silence the derived speaker.
 *  - `spoke_bid` + `bids`: read from Redis ~BID_WINDOW_MS + 1.5s after the message. `ns:spoke:<id>`
 *    is set only on the fit-bid path (claimSpoken), so it is empty for fast-path/named messages.
 *  - separate `kind:"spoke"` rows, appended by EVERY bot at send time (recordAddressSpoke) to the
 *    same JSONL, keyed by the origin message id. The report joins them. That is the observed
 *    outcome for every path, with no cross-process wait anywhere.
 *
 * Outputs: one `[address] {json}` stdout line per run (ids and verdicts, NO message text), and one
 * JSONL row with the text and recent turns for labelling, at ADDRESS_SHADOW_LOG (default
 * /app/logs/address-shadow.jsonl; same shape and no-rotation as jev-shadow.jsonl).
 *
 * DMs never reach here (the handler gates on !isOwnerDm), and this module asserts it again: a DM
 * flag or a sealed DM channel id returns before any Redis, model or file touch.
 */

import type { CompanionId } from "./types.js";
import type { InferenceAdapter } from "./inference.js";
import type { AddressType } from "./channel-config.js";
import { BID_KEY_PREFIX, BID_WINDOW_MS, COMMIT_KEY_PREFIX } from "./fit-bid.js";
import { isSealedRecallSource } from "./recall-context.js";
import {
  ADDRESS_SYSTEM, addressAgrees, addressFastPathDecided, addressModelMode, buildAddressPrompt,
  mentionMisreads, parseAddressVerdict, regexRoute, regexVerdictOf, shouldRunAddressModel,
  type AddressModelMode, type AddressTurn, type AddressVerdict,
} from "./address-model.js";

export const ADDRESS_CLAIM_PREFIX = "ns:addr:claim:";
export const ADDRESS_CLAIM_TTL_MS = 120_000;
export const ADDRESS_TIMEOUT_MS = 8_000;
export const ADDRESS_MAX_TOKENS = 150;
/** How long after the message the runner reads the bid outcome (the bid window plus slack). */
export const ADDRESS_WINNER_READ_AFTER_MS = BID_WINDOW_MS + 1_500;
export const ADDRESS_LOG_TAG = "[address]";
const LABEL_TEXT_CHARS = 2000;

/** The subset of the Redis client the shadow needs (fake-testable, like fit-bid's BidRedis). */
export interface AddressShadowRedis {
  set(key: string, val: string, mode: "PX", ms: number, nx: "NX"): Promise<string | null>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface AddressShadowCtx {
  /** Defaults to addressModelMode() (ADDRESS_MODEL). */
  mode?: AddressModelMode;
  /** The DM seal. True means nothing runs, ever. */
  isDm: boolean;
  companionId: CompanionId;
  messageId: string;
  channelId: string;
  createdTimestamp: number;
  content: string;
  /** "Raziel" or the PK front name. */
  speaker: string;
  /** An @mention of any companion bot (sync, from message.mentions). */
  mentionedCompanion: boolean;
  /** A reply to THIS bot's message (sync). A reply to a sibling is resolved lazily below. */
  replyToMe: boolean;
  /** Resolved only by the claim winner, only when the message is a reply at all. */
  replyToCompanion?: () => Promise<boolean>;
  regex: AddressType;
  /** The handler's holder, when it computed one (ambient owner messages only). */
  holder: CompanionId | null | undefined;
  redis: AddressShadowRedis | null;
  /** Already wrapped: withCaller(directAdapter, "address_model"). Null = skip (never Hermes). */
  adapter: InferenceAdapter | null;
  /** Recent turns oldest-first (excluding this message), plus the holder recomputed from them. */
  fetchRecent: () => Promise<{ turns: AddressTurn[]; holder: CompanionId | null }>;
  // Seams
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  append?: (row: Record<string, unknown>) => void;
}

export interface AddressShadowRow {
  kind: "shadow";
  at: string;
  msg_id: string;
  channel_id: string;
  runner: CompanionId;
  regex: { type: string; ids: CompanionId[] };
  holder: CompanionId | null;
  regex_route: CompanionId[] | null;
  spoke_bid: string | null;
  bids: Record<string, number> | null;
  model: AddressVerdict | null;
  failure: string | null;
  agree: boolean | null;
  misread: CompanionId[];
  latency_ms: number | null;
  text: string;
  turns: AddressTurn[];
}

// ---------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------

let warnedLog = false;

export function addressShadowLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["ADDRESS_SHADOW_LOG"]?.trim() || "/app/logs/address-shadow.jsonl";
}

/** Append one JSON line; an unwritable path warns once and never throws. Same idiom as the Jev
 *  shadow log (writeback-gate.ts appendShadowLine), with its own path. */
export function appendAddressLine(row: Record<string, unknown>): void {
  let payload: string;
  try { payload = `${JSON.stringify(row)}\n`; } catch { return; }
  const path = addressShadowLogPath();
  import("node:fs").then(({ appendFile }) => {
    appendFile(path, payload, (err) => {
      if (err && !warnedLog) { warnedLog = true; console.warn(`${ADDRESS_LOG_TAG} shadow log unwritable: ${String(err).slice(0, 200)}`); }
    });
  }).catch((e) => {
    if (!warnedLog) { warnedLog = true; console.warn(`${ADDRESS_LOG_TAG} shadow log unwritable: ${String(e).slice(0, 200)}`); }
  });
}

/** Test seam. */
export function __resetAddressLogWarning(): void { warnedLog = false; }

/**
 * Who actually spoke to a human message. Every bot calls this after a successful send for a human
 * origin (a sequential follow-up passes the ORIGIN id), whether or not it ran the shadow; the
 * report joins these rows to the shadow row by msg_id. Fire-and-forget, never throws, no-op
 * unless ADDRESS_MODEL=shadow, never for a DM.
 */
export function recordAddressSpoke(opts: {
  isDm: boolean; msgId: string; channelId: string; companionId: CompanionId;
  append?: (row: Record<string, unknown>) => void; now?: () => number; mode?: AddressModelMode;
}): void {
  try {
    if (opts.isDm || isSealedRecallSource(opts.channelId)) return;
    if ((opts.mode ?? addressModelMode()) !== "shadow") return;
    (opts.append ?? appendAddressLine)({
      kind: "spoke",
      at: new Date((opts.now ?? Date.now)()).toISOString(),
      msg_id: opts.msgId,
      channel_id: opts.channelId,
      companion: opts.companionId,
    });
  } catch { /* observational only */ }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Detached entry point. Returns void synchronously; nothing it does can throw into the caller or
 * reject unhandled. The caller must NOT await anything from it.
 */
export function fireAddressShadow(ctx: AddressShadowCtx): void {
  try {
    void runAddressShadow(ctx).catch(() => { /* runAddressShadow already swallows; belt and braces */ });
  } catch { /* a synchronous throw building the promise is swallowed too */ }
}

/**
 * The shadow itself. Resolves to the row it logged, or null when it skipped (off, DM, fast path,
 * nothing to judge, lost the claim, no Redis). Never rejects.
 */
export async function runAddressShadow(ctx: AddressShadowCtx): Promise<AddressShadowRow | null> {
  try {
    if ((ctx.mode ?? addressModelMode()) !== "shadow") return null;
    // The DM seal, asserted here as well as at the call site.
    if (ctx.isDm || isSealedRecallSource(ctx.channelId)) return null;

    const syncFast = addressFastPathDecided({
      content: ctx.content, mentionedCompanion: ctx.mentionedCompanion, replyToCompanion: ctx.replyToMe,
    });
    if (!shouldRunAddressModel({ content: ctx.content, fastPath: syncFast, holder: ctx.holder })) return null;
    if (!ctx.redis) return null;

    const claimed = await ctx.redis.set(ADDRESS_CLAIM_PREFIX + ctx.messageId, ctx.companionId, "PX", ADDRESS_CLAIM_TTL_MS, "NX")
      .catch(() => null);
    if (claimed !== "OK") return null;

    // A reply to a SIBLING is also a fast path; only the claim winner pays to find out.
    if (ctx.replyToCompanion && (await ctx.replyToCompanion().catch(() => false))) return null;

    const now = ctx.now ?? Date.now;
    const sleep = ctx.sleep ?? realSleep;
    const log = ctx.log ?? ((l: string) => console.log(l));
    const append = ctx.append ?? appendAddressLine;

    let turns: AddressTurn[] = [];
    let holder: CompanionId | null = ctx.holder ?? null;
    try {
      const recent = await ctx.fetchRecent();
      turns = recent.turns;
      if (ctx.holder === undefined) holder = recent.holder;
    } catch { /* judge on the message alone */ }

    let model: AddressVerdict | null = null;
    let failure: string | null = null;
    let latency: number | null = null;
    if (!ctx.adapter) {
      failure = "no_direct_adapter";
    } else {
      const prompt = buildAddressPrompt({ speaker: ctx.speaker, text: ctx.content }, turns);
      const started = now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"__timeout__">(r => { timer = setTimeout(() => r("__timeout__"), ctx.timeoutMs ?? ADDRESS_TIMEOUT_MS); });
      try {
        // DeepInfraAdapter ignores AbortSignal, so the race bounds OUR wait; the request itself may
        // finish underneath and is discarded.
        const raw = await Promise.race([
          ctx.adapter.generate(ADDRESS_SYSTEM, [{ role: "user", content: prompt }], 0, ADDRESS_MAX_TOKENS),
          timeout,
        ]);
        latency = now() - started;
        if (raw === "__timeout__") failure = "timeout";
        else if (raw === null) failure = "empty";
        else {
          model = parseAddressVerdict(raw);
          if (!model) failure = "parse";
        }
      } catch {
        latency = now() - started;
        failure = "error";
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // The bid outcome, read once the window has closed. Only the bid path writes these keys.
    let spokeBid: string | null = null;
    let bids: Record<string, number> | null = null;
    const waitMs = ctx.createdTimestamp + ADDRESS_WINNER_READ_AFTER_MS - now();
    if (waitMs > 0) await sleep(Math.min(waitMs, ADDRESS_WINNER_READ_AFTER_MS));
    try {
      spokeBid = (await ctx.redis.get(COMMIT_KEY_PREFIX + ctx.messageId).catch(() => null)) ?? null;
      const h = await ctx.redis.hgetall(BID_KEY_PREFIX + ctx.messageId).catch(() => null);
      if (h && Object.keys(h).length > 0) {
        bids = {};
        for (const [k, v] of Object.entries(h)) { const n = Number(v); if (Number.isFinite(n)) bids[k] = n; }
      }
    } catch { /* unknown stays null */ }

    const row: AddressShadowRow = {
      kind: "shadow",
      at: new Date(now()).toISOString(),
      msg_id: ctx.messageId,
      channel_id: ctx.channelId,
      runner: ctx.companionId,
      regex: regexVerdictOf(ctx.regex),
      holder,
      regex_route: regexRoute(ctx.regex, holder),
      spoke_bid: spokeBid,
      bids,
      model,
      failure,
      agree: model ? addressAgrees(ctx.regex, holder, model) : null,
      misread: model ? mentionMisreads(ctx.regex, model) : [],
      latency_ms: latency,
      text: ctx.content.slice(0, LABEL_TEXT_CHARS),
      turns,
    };
    // Stdout: ids and verdicts only. The text lives only in the labelling file.
    const meta: Record<string, unknown> = { ...row };
    delete meta.text;
    delete meta.turns;
    try { log(`${ADDRESS_LOG_TAG} ${JSON.stringify(meta)}`); } catch { /* never */ }
    try { append(row as unknown as Record<string, unknown>); } catch { /* never */ }
    return row;
  } catch {
    return null;
  }
}
