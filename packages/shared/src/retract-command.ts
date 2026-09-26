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
 *   Halseth  POST /admin/retract   journal rows keyed `discord:<reply id>` (speech) and
 *                                  `judge:<user message id>` (the judge's note); wm notes keyed
 *                                  `judge:<user message id>`. Archived + one memory_releases row
 *                                  each, so "restore release <id>" undoes it within 30 days.
 *   Second Brain POST /retract     the discord-live doc for the reply, with its vectors. Not
 *                                  reversible (it is the 7-day recency lane, never the vault proper).
 *   Halseth stm_entries            (rotate-on-retract, 2026-09-26) the bot's persisted STM window
 *                                  rows carrying the reply, hard-deleted in the same /admin/retract
 *                                  call when `stm` is passed. The window is a rolling transcript,
 *                                  not memory; without this the retracted reply was re-sent to the
 *                                  gateway on every turn until the 19:00 CDT rotation. The
 *                                  in-memory window and the gateway transcript are the caller's
 *                                  (StmStore.retract + the hermes session bump).
 *
 * The ack is literal and itemised. A retraction that says "done" while one store still carries
 * the mistake is worse than none, so every half reports separately.
 */

export interface RetractArgs {
  companionId: string;
  channelId: string;
  /** The bot's own message being retracted (the reply Raziel replied to). */
  botMessageId: string;
  /** The human message that reply answered, when known: the judge keyed its note on this. */
  userMessageId: string | null;
  halseth: { base: string; secret: string };
  secondBrain: { base: string; key: string } | null;
  /** The retracted reply's channel + text, so Halseth can drop its stm_entries window rows too. */
  stm?: { channelId: string; content: string };
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export function retractKeys(botMessageId: string, userMessageId: string | null): { external_ids: string[]; correlation_ids: string[] } {
  const external_ids = [`discord:${botMessageId}`];
  const correlation_ids: string[] = [];
  if (userMessageId) {
    external_ids.push(`judge:${userMessageId}`);
    correlation_ids.push(`judge:${userMessageId}`);
  }
  return { external_ids, correlation_ids };
}

type HalsethRetract = { archived: { journal: string[]; notes: string[] }; release_ids: string[]; stm_deleted?: number };
type SbRetract = { removed?: number; existed?: boolean };

export async function handleRetractCommand(a: RetractArgs): Promise<string> {
  const f = a.fetchFn ?? fetch;
  const when = (a.now ?? (() => new Date))().toISOString().slice(0, 16).replace("T", " ");
  const keys = retractKeys(a.botMessageId, a.userMessageId);
  const parts: string[] = [];

  // Halseth half.
  let releaseIds: string[] = [];
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
    } else {
      const j = await res.json() as HalsethRetract;
      const nj = j.archived?.journal?.length ?? 0;
      const nn = j.archived?.notes?.length ?? 0;
      releaseIds = j.release_ids ?? [];
      const ns = j.stm_deleted ?? 0;
      // The window count is a third number only when the caller asked for the window: without
      // `stm` the ack keeps its original shape.
      const window = a.stm ? `, dropped ${ns} window row${ns === 1 ? "" : "s"}` : "";
      parts.push(nj + nn === 0
        ? `halseth: nothing to archive under that reply (no journal row or note carried its key)${window}`
        : `halseth: archived ${nj} journal row${nj === 1 ? "" : "s"} and ${nn} note${nn === 1 ? "" : "s"}${window}`);
    }
  } catch (e) {
    parts.push(`halseth: FAILED (${String(e instanceof Error ? e.message : e).slice(0, 80)})`);
  }

  // Vault half.
  if (!a.secondBrain) {
    parts.push("vault: not configured on this box, the discord-live copy stays until its 7-day TTL");
  } else {
    try {
      const res = await f(`${a.secondBrain.base.replace(/\/$/, "")}/retract`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${a.secondBrain.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: a.channelId, message_id: a.botMessageId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        parts.push(`vault: FAILED (${res.status})`);
      } else {
        const j = await res.json() as SbRetract;
        parts.push(j.existed ? "vault: dropped" : "vault: nothing there (already aged out or never indexed)");
      }
    } catch (e) {
      parts.push(`vault: FAILED (${String(e instanceof Error ? e.message : e).slice(0, 80)})`);
    }
  }

  const undo = releaseIds.length
    ? ` Undo within 30 days: ask me to "restore release ${releaseIds[0]}"${releaseIds.length > 1 ? ` (and ${releaseIds.length - 1} more, listed under "my releases")` : ""}.`
    : "";
  return `retracted. ${parts.join("; ")}.${undo}`;
}
