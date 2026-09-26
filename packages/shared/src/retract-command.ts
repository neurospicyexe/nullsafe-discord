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
 * reconstructed from Discord and the ack says so.
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
  judgeKeySource?: "recorded" | "reconstructed" | "unknown";
  halseth: { base: string; secret: string };
  secondBrain: { base: string; key: string } | null;
  /** The retracted reply's channel + text, so Halseth can drop its stm_entries window rows too. */
  stm?: { channelId: string; content: string };
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export function retractKeys(botMessageId: string, userMessageIds: readonly string[]): { external_ids: string[]; correlation_ids: string[] } {
  const users = [...new Set(userMessageIds.filter(Boolean))];
  return {
    external_ids: [`discord:${botMessageId}`, ...users.map(u => `judge:${u}`)],
    correlation_ids: users.map(u => `judge:${u}`),
  };
}

type HalsethRetract = { archived: { journal: string[]; notes: string[] }; release_ids: string[]; stm_deleted?: number };
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
  try {
    const res = await f(`${a.halseth.base.replace(/\/$/, "")}/admin/retract`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${a.halseth.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: a.companionId,
        ...keys,
        reason: `Raziel retracted my reply ${a.botMessageId} on Discord (${when} UTC)`,
        ...(a.stm ? { stm: { channel_id: a.stm.channelId, content: a.stm.content } } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as Record<string, unknown>;
      parts.push(`halseth: FAILED (${String(j["error"] ?? res.status)})`);
      incomplete.push("halseth failed");
    } else {
      const j = await res.json() as HalsethRetract;
      journalIds = j.archived?.journal ?? [];
      noteIds = j.archived?.notes ?? [];
      const nj = journalIds.length;
      const nn = noteIds.length;
      releaseIds = j.release_ids ?? [];
      const ns = j.stm_deleted ?? 0;
      // The window count is a third number only when the caller asked for the window: without
      // `stm` the ack keeps its original shape.
      const window = a.stm ? `, dropped ${ns} window row${ns === 1 ? "" : "s"}` : "";
      parts.push(nj + nn === 0
        ? `halseth: nothing to archive under that reply (no journal row or note carried its key)${window}`
        : `halseth: archived ${nj} journal row${nj === 1 ? "" : "s"} and ${nn} note${nn === 1 ? "" : "s"}${window}`);
      // Every reply is journaled as speech under `discord:<head>`, so zero journal rows means the
      // write had not landed (writeQueue retries) or this was already retracted. Either way the
      // headline must not say done.
      if (nj === 0) incomplete.push("no journal row found yet (the speech write may still be queued; retry in a minute)");
    }
  } catch (e) {
    parts.push(`halseth: FAILED (${errText(e)})`);
    incomplete.push("halseth failed");
  }

  // The judge half is only as good as its key.
  if (a.judgeKeySource === "reconstructed") {
    parts.push(`judge note: keyed on ${a.userMessageIds.join(", ")}, reconstructed from Discord (no send-time record of what this answered)`);
  } else if (!a.userMessageIds.length || a.judgeKeySource === "unknown") {
    parts.push("judge note: could not locate the message this answered; not searched");
    incomplete.push("judge note not located");
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
 * Rebuild a reply's chunk group and its likely trigger from Discord alone, for when the send-time
 * record is gone (a restart without Redis, a reply older than the index). Pure.
 *
 * Chunks: contiguous messages of mine within CHUNK_GAP_MS of each other around the target.
 * Trigger candidates: the head's reply reference (companion-triggered turns and spine channels
 * always carry one), and the nearest earlier message if a human sent it (PK proxies count: they
 * are bot users with a webhook). The walk stops at an earlier message of MINE: the human message
 * behind that one answered that reply, not this one. Over-including costs nothing -- `judge:` keys
 * are agent-scoped, and a message with no judge note of mine matches no row.
 */
export function reconstructReply(target: RetractMsg, n: RetractNeighbours, ownUserId: string): {
  headId: string; chunkIds: string[]; triggerCandidates: string[];
} {
  const chunks: RetractMsg[] = [target];
  let i = 0;
  for (; i < n.before.length; i++) {
    const m = n.before[i]!;
    if (m.authorId !== ownUserId || chunks[0]!.createdTimestamp - m.createdTimestamp > CHUNK_GAP_MS) break;
    chunks.unshift(m);
  }
  for (const m of n.after) {
    const last = chunks[chunks.length - 1]!;
    if (m.authorId !== ownUserId || m.createdTimestamp - last.createdTimestamp > CHUNK_GAP_MS) break;
    chunks.push(m);
  }
  const head = chunks[0]!;
  const candidates: string[] = [];
  if (head.referenceId) candidates.push(head.referenceId);
  const prior = n.before[i];
  if (prior && prior.authorId !== ownUserId && isHuman(prior)) candidates.push(prior.id);
  return { headId: head.id, chunkIds: chunks.map(c => c.id), triggerCandidates: [...new Set(candidates)] };
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
  let judgeKeySource: RetractArgs["judgeKeySource"] = "unknown";

  const rec = await d.replyIndex.resolve(d.target.id).catch(() => null);
  if (rec) {
    headId = rec.headId;
    content = rec.content || content;
    userMessageIds = [rec.triggerMessageId];
    judgeKeySource = "recorded";
  } else {
    const n = d.fetchNeighbours ? await d.fetchNeighbours(d.target.id).catch(() => null) : null;
    if (n) {
      const r = reconstructReply(d.target, n, d.ownUserId);
      headId = r.headId;
      userMessageIds = r.triggerCandidates;
    } else if (d.target.referenceId) {
      userMessageIds = [d.target.referenceId];
    }
    // Reconstructed content stays the one chunk Raziel replied to: every chunk is a substring of
    // the full reply, and both window drops match by containment.
    judgeKeySource = userMessageIds.length ? "reconstructed" : "unknown";
  }

  const stores = await retractFromStores({
    companionId: d.companionId,
    channelId: d.channelId,
    botMessageId: headId,
    userMessageIds,
    judgeKeySource,
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
