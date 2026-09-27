/**
 * `<prefix>: retract` -- as a reply to one of the bot's own messages, pull that reply back out of
 * every memory store it reached. One gesture, three stores, reversible on the Halseth side.
 *
 * WHY THIS EXISTS (2026-09-26)
 * Drevan fabricated a blood-sugar number (187 for 208). Within a minute it was in his journal
 * twice (the speech ingest and the memory-judge), in his continuity notes (the judge's promotion),
 * and in the vault (Second Brain live-ingest), and his own recall returned it ranked first.
 * Cleaning it up took three hand-written SQL statements and a read of the code to find the ids.
 * Raziel: "we really do need a way to delete things for when shit goes wrong like this."
 *
 * WHAT IT REACHES
 *   Halseth  POST /admin/retract   journal rows keyed `discord:<reply head id>` (speech) and
 *                                  `judge:<trigger message id>` (the judge's note); wm notes keyed
 *                                  `judge:<trigger message id>`. Archived + one memory_releases row
 *                                  each, so "restore release <id>" undoes it within 30 days.
 *   Second Brain POST /retract     the discord-live doc for the reply, with its vectors, and the
 *                                  rag/ mirrors of every journal row and note Halseth just
 *                                  archived (`rag/companion_journal/<id>`,
 *                                  `rag/wm_continuity_notes/<id>`; SB bcdb917). Not reversible:
 *                                  both are derived copies of D1, rebuilt by the puller.
 *   Halseth stm_entries            (rotate-on-retract, 2026-09-26) the bot's persisted STM window
 *                                  rows carrying the reply, hard-deleted in the same /admin/retract
 *                                  call when `stm` is passed. The window is a rolling transcript,
 *                                  not memory; without this the retracted reply was re-sent to the
 *                                  gateway on every turn until the 19:00 CDT rotation. The
 *                                  in-memory window and the gateway transcript are executeRetract's
 *                                  (StmStore.retract + the hermes session bump).
 *
 * WHICH KEYS (2026-09-26 review). The reply's own Discord reference is NOT the judge key: plain
 * replies to Raziel carry no reference at all, and an entitled follow-up references the origin
 * while the judge ran on the sibling message that released it. The key is whatever triggered the
 * turn, recorded at send time (reply-index.ts). When that record is gone, the keys are
 * reconstructed from Discord and the ack says so -- and when the reconstruction is AMBIGUOUS
 * (several plausible triggers, or a chunk group only timing holds together) nothing is guessed:
 * the judge half is keyed on the reply's own Discord reference or skipped, and the ack says which.
 * Every judge key sent is named in the ack.
 *
 * The ack is literal and itemised, and its HEADLINE is too: "retracted." only when every store
 * answered and nothing expected was missing, "retract incomplete (...)" otherwise. A retraction
 * that says "done" while one store still carries the mistake is worse than none.
 */

import type { ReplyRecord } from "./reply-index.js";
import type { BumpResult } from "./retract-bumps.js";

export interface RetractArgs {
  companionId: string;
  channelId: string;
  /** The HEAD chunk of the bot's reply being retracted: what speech + live-ingest were keyed on. */
  botMessageId: string;
  /** Candidate trigger ids for the judge key. Empty = unknown, and the ack says it was not searched. */
  userMessageIds: string[];
  /** How the trigger ids were found; drives the ack's honesty about the judge half. */
  judgeKeySource?: JudgeKeySource;
  /** Why a reconstruction was ambiguous (source "reference" or "ambiguous"); named in the ack. */
  judgeAmbiguity?: string[];
  halseth: { base: string; secret: string };
  secondBrain: { base: string; key: string } | null;
  /** The retracted reply's channel + text, so Halseth can drop its stm_entries window rows too. */
  stm?: { channelId: string; content: string };
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/**
 * Where the judge key came from.
 *   recorded       the trigger recorded at send time (reply-index.ts)
 *   reconstructed  one unambiguous trigger rebuilt from Discord
 *   reference      reconstruction was ambiguous or impossible; keyed ONLY on the reply's own
 *                  Discord reference, never a guess
 *   ambiguous      reconstruction was ambiguous and the reply carries no reference: not searched
 *   unknown        nothing located the trigger: not searched
 */
export type JudgeKeySource = "recorded" | "reconstructed" | "reference" | "ambiguous" | "unknown";

export function retractKeys(botMessageId: string, userMessageIds: readonly string[]): { external_ids: string[]; correlation_ids: string[] } {
  const users = [...new Set(userMessageIds.filter(Boolean))];
  return {
    external_ids: [`discord:${botMessageId}`, ...users.map(u => `judge:${u}`)],
    correlation_ids: users.map(u => `judge:${u}`),
  };
}

type HalsethRetract = {
  archived: { journal: string[]; notes: string[] };
  already_archived?: { journal: string[]; notes: string[] };
  release_ids: string[];
  stm_deleted?: number;
  /** Clerk ledger rows sourced to the retracted reply (message or window source), now dropped. */
  ledger_dropped?: number;
};

/** Halseth's server-side floor for the STM hard-delete needle (handlers/retract.ts). */
export const STM_NEEDLE_MIN = 20;
type SbRetract = { removed?: number; existed?: boolean };

export interface StoresOutcome {
  parts: string[];
  /** Why the retraction is not whole; empty means every store answered and held what it should. */
  incomplete: string[];
  releaseIds: string[];
}

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 80);

/** The network half: Halseth, the vault doc, the vault mirrors. Never throws. */
export async function retractFromStores(a: RetractArgs): Promise<StoresOutcome> {
  const f = a.fetchFn ?? fetch;
  const when = (a.now ?? (() => new Date))().toISOString().slice(0, 16).replace("T", " ");
  const keys = retractKeys(a.botMessageId, a.userMessageIds);
  const parts: string[] = [];
  const incomplete: string[] = [];

  // Halseth half.
  let releaseIds: string[] = [];
  let journalIds: string[] = [];
  let noteIds: string[] = [];
  // Halseth refuses an STM needle under 20 chars (400) or one matching more than 5 window rows
  // (409, hard delete, no undo). Neither may cost the archive: a short needle is never sent, and a
  // 409 retries once without `stm` so the journal, notes and judge key still retract.
  let stmNote = "";
  const sendStm = !!a.stm && a.stm.content.trim().length >= STM_NEEDLE_MIN;
  if (a.stm && !sendStm) stmNote = ", window rows kept (reply too short to match safely)";
  try {
    const post = (withStm: boolean) => f(`${a.halseth.base.replace(/\/$/, "")}/admin/retract`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${a.halseth.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: a.companionId,
        // The reply's channel, ALWAYS sent (not only inside `stm`): Halseth drops clerk ledger lines
        // whose window source covers the reply, and `stm` is absent for a short reply and dropped
        // on the 409 retry -- exactly the cases where the window match would otherwise go dark.
        channel_id: a.channelId,
        ...keys,
        reason: `Raziel retracted my reply ${a.botMessageId} on Discord (${when} UTC)`,
        ...(withStm && a.stm ? { stm: { channel_id: a.stm.channelId, content: a.stm.content } } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    let res = await post(sendStm);
    let stmSent = sendStm;
    if (res.status === 409 && sendStm) {
      const j = await res.json().catch(() => ({})) as Record<string, unknown>;
      const n = typeof j["stm_matches"] === "number" ? j["stm_matches"] : "too many";
      stmNote = `, window rows kept (${n} rows matched; not hard-deleting that many)`;
      res = await post(false);
      stmSent = false;
    }
    if (!stmSent && stmNote) incomplete.push("window rows not dropped");
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as Record<string, unknown>;
      parts.push(`halseth: FAILED (${String(j["error"] ?? res.status)})`);
      incomplete.push("halseth failed");
    } else {
      const j = await res.json() as HalsethRetract;
      const nj = j.archived?.journal?.length ?? 0;
      const nn = j.archived?.notes?.length ?? 0;
      // Mirrors cover rows archived now AND rows an earlier (partial) retract archived, so a
      // repeat retract still reaches the vault copies.
      journalIds = [...new Set([...(j.archived?.journal ?? []), ...(j.already_archived?.journal ?? [])])];
      noteIds = [...new Set([...(j.archived?.notes ?? []), ...(j.already_archived?.notes ?? [])])];
      releaseIds = j.release_ids ?? [];
      const ns = j.stm_deleted ?? 0;
      // The window count is a third number only when the caller asked for the window: without
      // `stm` the ack keeps its original shape.
      const window = stmNote || (a.stm ? `, dropped ${ns} window row${ns === 1 ? "" : "s"}` : "");
      const nl = j.ledger_dropped ?? 0;
      const ledger = nl > 0 ? `, dropped ${nl} ledger record${nl === 1 ? "" : "s"}` : "";
      parts.push(nj + nn === 0
        ? `halseth: nothing to archive under that reply (no journal row or note carried its key)${window}${ledger}`
        : `halseth: archived ${nj} journal row${nj === 1 ? "" : "s"} and ${nn} note${nn === 1 ? "" : "s"}${window}${ledger}`);
      // Every reply is journaled as speech under `discord:<head>`, so zero journal rows means the
      // write had not landed (writeQueue retries) or this was already retracted. Either way the
      // headline must not say done. A repeat retract also cannot reach the vault mirrors: Halseth
      // returns only rows it archived in THIS call, so already-archived rows name no mirror.
      if (nj === 0) incomplete.push("no journal row found: not written yet (retry in a minute) or already retracted");
    }
  } catch (e) {
    parts.push(`halseth: FAILED (${errText(e)})`);
    incomplete.push("halseth failed");
  }

  // The judge half is only as good as its key, and the ack names every key it sent.
  parts.push(judgeKeyPart(a));
  if (!keys.correlation_ids.length || a.judgeKeySource === "unknown" || a.judgeKeySource === "ambiguous") {
    const skippedAsAmbiguous = a.judgeKeySource === "ambiguous" || !!a.judgeAmbiguity?.length;
    incomplete.push(skippedAsAmbiguous ? "judge note skipped: ambiguous" : "judge note not located");
  }

  // Vault half.
  if (!a.secondBrain) {
    parts.push("vault: not configured on this box, the discord-live copy stays until its 7-day TTL");
    incomplete.push("vault not configured");
  } else {
    const sb = a.secondBrain;
    const sbRetract = async (body: Record<string, string>): Promise<SbRetract> => {
      const res = await f(`${sb.base.replace(/\/$/, "")}/retract`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${sb.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json() as SbRetract;
    };
    try {
      const j = await sbRetract({ channel_id: a.channelId, message_id: a.botMessageId });
      parts.push(j.existed ? "vault: dropped" : "vault: nothing there (already aged out or never indexed)");
    } catch (e) {
      parts.push(`vault: FAILED (${errText(e)})`);
      incomplete.push("vault failed");
    }
    // The rag/ mirrors of the rows Halseth just archived. Absent is normal (the puller skips
    // machine rows, has no wm_continuity_notes source, and may not have run yet); only a failed
    // call is a failure.
    const mirrors = [
      ...journalIds.map(id => `rag/companion_journal/${id}`),
      ...noteIds.map(id => `rag/wm_continuity_notes/${id}`),
    ];
    if (mirrors.length) {
      let dropped = 0;
      let failed = 0;
      await Promise.all(mirrors.map(async (vault_path) => {
        try { if ((await sbRetract({ vault_path })).existed) dropped++; } catch { failed++; }
      }));
      parts.push(`vault mirrors: dropped ${dropped} of ${mirrors.length}${failed ? `, ${failed} FAILED` : ""}`);
      if (failed) incomplete.push("vault mirrors failed");
    }
  }

  return { parts, incomplete, releaseIds };
}

/** The judge line of the ack: which `judge:` keys were sent, and how they were found. */
export function judgeKeyPart(a: Pick<RetractArgs, "userMessageIds" | "judgeKeySource" | "judgeAmbiguity">): string {
  const keys = retractKeys("-", a.userMessageIds).correlation_ids;
  const why = a.judgeAmbiguity?.length ? a.judgeAmbiguity.join("; ") : "no send-time record";
  if (a.judgeKeySource === "ambiguous" || (!keys.length && a.judgeAmbiguity?.length)) {
    return `judge note: not searched -- reconstruction was ambiguous (${why}) and the reply carries no Discord reference, so no key was guessed`;
  }
  if (!keys.length || a.judgeKeySource === "unknown") {
    return "judge note: could not locate the message this answered; not searched";
  }
  const list = keys.join(", ");
  switch (a.judgeKeySource) {
    case "reconstructed":
      return `judge keys retracted: ${list}, reconstructed from Discord (no send-time record of what this answered)`;
    case "reference":
      return `judge keys retracted: ${list} only, the reply's own Discord reference (${why}; no other key was guessed)`;
    default:
      return `judge keys retracted: ${list} (the trigger recorded at send time)`;
  }
}

/** The ack. The headline says what actually happened. */
export function composeRetractAck(o: StoresOutcome): string {
  const undo = o.releaseIds.length
    ? ` Undo within 30 days: ask me to "restore release ${o.releaseIds[0]}"${o.releaseIds.length > 1 ? ` (and ${o.releaseIds.length - 1} more, listed under "my releases")` : ""}.`
    : "";
  const headline = o.incomplete.length ? `retract incomplete (${o.incomplete.join("; ")}):` : "retracted.";
  return `${headline} ${o.parts.join("; ")}.${undo}`;
}

export async function handleRetractCommand(a: RetractArgs): Promise<string> {
  return composeRetractAck(await retractFromStores(a));
}

// ── The whole gesture, as the handler runs it ────────────────────────────────

/** A Discord message, reduced to what reply reconstruction needs. */
export interface RetractMsg {
  id: string;
  authorId: string;
  /** discord.js author.bot. A PluralKit proxy is `bot: true` WITH a webhookId. */
  isBot: boolean;
  webhookId: string | null;
  content: string;
  createdTimestamp: number;
  referenceId: string | null;
}

/** Messages next to the target: `before` newest-first (nearest first), `after` oldest-first. */
export interface RetractNeighbours { before: RetractMsg[]; after: RetractMsg[] }

/** Chunks of one sendLong call land back to back; a gap wider than this is a separate message. */
export const CHUNK_GAP_MS = 5_000;

const isHuman = (m: RetractMsg) => !m.isBot || m.webhookId !== null;

/**
 * Rebuild a reply's chunk group and its trigger from Discord alone, for when the send-time record
 * is gone (a restart without Redis, a reply older than the index). Pure. DOES NOT GUESS.
 *
 * Chunks: contiguous messages of mine (no other author between) within CHUNK_GAP_MS of each other
 * around the target, and never across a boundary the evidence draws:
 *   - a message the ReplyIndex places in a DIFFERENT reply (`otherReplyIds`);
 *   - a Discord reference: sendLong references chunk 0 only, so a message of mine carrying one is
 *     the head of its own reply -- the backward walk stops AT it, the forward walk stops BEFORE it.
 * A group of more than one chunk is still only timing: two short replies of mine sent within a
 * few seconds look exactly like one split reply (splitForDiscord can emit short chunks too), so a
 * multi-chunk group counts as ambiguous for the judge key.
 *
 * Trigger: the human messages between my previous message and the head (PK proxies count: bot
 * users with a webhook). Exactly one, no conflicting reference, and a one-chunk group: that is the
 * trigger. Anything else is AMBIGUOUS, and then the only key is the head's own Discord reference if
 * it has one -- a guessed key could archive a judge note about a different exchange.
 */
export function reconstructReply(
  target: RetractMsg,
  n: RetractNeighbours,
  ownUserId: string,
  opts: { otherReplyIds?: ReadonlySet<string>; windowLimit?: number } = {},
): { headId: string; chunkIds: string[]; triggerCandidates: string[]; ambiguous: string[] } {
  const other = opts.otherReplyIds ?? new Set<string>();
  const windowLimit = opts.windowLimit ?? 10;
  const mineInGroup = (m: RetractMsg, next: RetractMsg) =>
    m.authorId === ownUserId && !other.has(m.id) && Math.abs(next.createdTimestamp - m.createdTimestamp) <= CHUNK_GAP_MS;

  const chunks: RetractMsg[] = [target];
  let i = 0;
  for (; i < n.before.length; i++) {
    if (chunks[0]!.referenceId) break; // the earliest chunk so far is a head
    const m = n.before[i]!;
    if (!mineInGroup(m, chunks[0]!)) break;
    chunks.unshift(m);
  }
  for (const m of n.after) {
    if (m.referenceId || !mineInGroup(m, chunks[chunks.length - 1]!)) break;
    chunks.push(m);
  }
  const head = chunks[0]!;

  const humans: string[] = [];
  let reachedMine = false;
  for (let j = i; j < n.before.length; j++) {
    const m = n.before[j]!;
    if (m.authorId === ownUserId) { reachedMine = true; break; }
    if (isHuman(m)) humans.push(m.id);
  }

  const ambiguous: string[] = [];
  if (chunks.length > 1) ambiguous.push(`${chunks.length} messages grouped by timing alone, which could be two replies`);
  if (humans.length > 1) ambiguous.push(`${humans.length} human messages since my previous reply`);
  if (head.referenceId && humans.length === 1 && humans[0] !== head.referenceId) {
    ambiguous.push("the reply's reference and the human message before it differ");
  }
  if (!reachedMine && n.before.length >= windowLimit) ambiguous.push("my previous reply is outside the fetched window");

  const triggerCandidates = head.referenceId ? [head.referenceId] : (ambiguous.length ? [] : humans);
  return { headId: head.id, chunkIds: chunks.map(c => c.id), triggerCandidates, ambiguous };
}

export interface ExecuteRetractDeps {
  companionId: string;
  channelId: string;
  ownUserId: string;
  target: RetractMsg;
  replyIndex: { resolve(messageId: string): Promise<ReplyRecord | null> };
  /** Discord neighbours of the target, for reconstruction. Null/throw = unavailable. */
  fetchNeighbours?: (targetId: string) => Promise<RetractNeighbours | null>;
  stmRetract: (channelId: string, text: string) => number;
  bumps: { bump(channelId: string): Promise<BumpResult> };
  halseth: { base: string; secret: string };
  secondBrain: { base: string; key: string } | null;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/**
 * The retract gesture end to end: resolve which reply this is (any chunk -> its head, its full
 * text, and what triggered it), pull it from every store, drop my window lines, rotate the
 * transcript, and compose one honest ack. The handler only wires real objects into this.
 */
export async function executeRetract(d: ExecuteRetractDeps): Promise<string> {
  if (d.target.authorId !== d.ownUserId) return "I can only retract my own messages; that one is not mine.";

  let headId = d.target.id;
  let content = d.target.content;
  let userMessageIds: string[] = [];
  let judgeKeySource: JudgeKeySource = "unknown";
  let judgeAmbiguity: string[] = [];

  const adopt = (r: ReplyRecord) => {
    headId = r.headId;
    content = r.content || content;
    userMessageIds = [r.triggerMessageId];
    judgeKeySource = "recorded";
  };

  const rec = await d.replyIndex.resolve(d.target.id).catch(() => null);
  if (rec) {
    adopt(rec);
  } else {
    const n = d.fetchNeighbours ? await d.fetchNeighbours(d.target.id).catch(() => null) : null;
    if (n) {
      // Ask the index about my neighbours: a record that holds the target is this reply (a partial
      // store write can index one chunk and not another); any other record is a different reply,
      // and the group must not merge across it.
      const mine = [...n.before, ...n.after].filter(m => m.authorId === d.ownUserId);
      const recs = await Promise.all(mine.map(m => d.replyIndex.resolve(m.id).catch(() => null)));
      const holder = recs.find(r => r?.chunkIds.includes(d.target.id)) ?? null;
      if (holder) {
        adopt(holder);
      } else {
        const otherReplyIds = new Set(mine.filter((_, k) => recs[k] !== null).map(m => m.id));
        const r = reconstructReply(d.target, n, d.ownUserId, { otherReplyIds });
        headId = r.headId;
        userMessageIds = r.triggerCandidates;
        judgeAmbiguity = r.ambiguous;
        judgeKeySource = r.ambiguous.length
          ? (userMessageIds.length ? "reference" : "ambiguous")
          : (userMessageIds.length ? "reconstructed" : "unknown");
      }
    } else if (d.target.referenceId) {
      userMessageIds = [d.target.referenceId];
      judgeAmbiguity = ["Discord history unavailable"];
      judgeKeySource = "reference";
    }
    // Reconstructed content stays the one chunk Raziel replied to: every chunk is a substring of
    // the full reply, and both window drops match by containment.
  }

  const stores = await retractFromStores({
    companionId: d.companionId,
    channelId: d.channelId,
    botMessageId: headId,
    userMessageIds,
    judgeKeySource,
    judgeAmbiguity,
    halseth: d.halseth,
    secondBrain: d.secondBrain,
    stm: { channelId: d.channelId, content },
    ...(d.fetchFn ? { fetchFn: d.fetchFn } : {}),
    ...(d.now ? { now: d.now } : {}),
  });

  const dropped = d.stmRetract(d.channelId, content);
  const bump = await d.bumps.bump(d.channelId);
  stores.parts.push(bump.persisted
    ? "transcript: rotated (next turn starts a fresh gateway session, window re-sent without it)"
    : `transcript: rotated (not persisted: ${bump.reason}; a restart before the next retract could reopen the old transcript)`);
  if (!bump.persisted) stores.incomplete.push("rotation not persisted");
  stores.parts.push(`my window: dropped ${dropped} line${dropped === 1 ? "" : "s"}`);
  return composeRetractAck(stores);
}
