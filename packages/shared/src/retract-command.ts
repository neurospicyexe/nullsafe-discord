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

type HalsethRetract = { archived: { journal: string[]; notes: string[] }; release_ids: string[] };
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
      parts.push(nj + nn === 0
        ? "halseth: nothing to archive under that reply (no journal row or note carried its key)"
        : `halseth: archived ${nj} journal row${nj === 1 ? "" : "s"} and ${nn} note${nn === 1 ? "" : "s"}`);
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
