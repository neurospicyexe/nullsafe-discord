// sb-live-ingest.ts -- streaming indexer client (real-time Discord recall, 2026-06-09).
//
// Fire-and-forget POST to Second Brain's /ingest/discord so companions can recall the
// CURRENT thread via sb_search without waiting for the 20-minute ingestion cron.
// This is a recall-enrichment layer, not a continuity-critical write: failures are
// logged and dropped (the durable record still arrives via session synthesis).
//
// Env (bots' .env):
//   SB_LIVE_INGEST=true            -- feature gate, off by default
//   SECOND_BRAIN_URL=http://127.0.0.1:<port>  -- SB binds localhost on the same VPS
//   SB_INGEST_KEY=<key>            -- must match SB's env; empty disables auth SB-side
//
// All three bots see every human message, so the same message arrives up to 3x;
// SB dedups by message_id (existsByPath check before embedding) -- cheap.

const SB_URL = (process.env["SECOND_BRAIN_URL"] ?? "").replace(/\/$/, "");
const SB_KEY = process.env["SB_INGEST_KEY"] ?? "";
const ENABLED = process.env["SB_LIVE_INGEST"] === "true";

/**
 * Minimum human message length to index (2026-08-10: 50 -> 12).
 *
 * 50 was protecting the wrong thing. Its stated purpose was keeping "lol"-tier messages out of the corpus,
 * but the reason that MATTERED is that Second Brain's pools 2 and 3 rank by novelty over the whole store and
 * every new row starts at maximum novelty -- so a continuous stream of chatter would have owned both
 * query-blind pools permanently, and the commons seed would be handed this afternoon's chat as its
 * "unfamiliar material to think about".
 *
 * That is now handled at the right layer: `discord-live` rows are excluded from those pools store-side
 * (NOT_CHATTER_SQL in vector-store.ts) while staying fully findable by relevance. So the length gate no
 * longer has to stand in for pool discipline, and its real cost can come off.
 *
 * That cost was continuity. Raziel's report: telling Drevan "I'll meet you in the Fargo watch party channel"
 * in one channel and having it not carry to another. That message is 43 characters -- under the old gate, the
 * single most continuity-critical class of message (short logistics: where, when, what next) was the class
 * most reliably discarded. Long emotional messages were never the problem; they always got through.
 *
 * 12 still drops the true no-ops ("lol", "ok", "yeah", a bare emoji) while keeping "meet me in #fargo" and
 * "we're watching at 8". Companion replies are unaffected -- they have always been indexed regardless.
 */
const MIN_HUMAN_CHARS = 12;

export interface LiveIngestMessage {
  companion: string | null; // null = human/shared; companion id for bot replies
  author: string;
  content: string;
  channel_id: string;
  message_id: string;
}

export function liveIngest(msg: LiveIngestMessage): void {
  if (!ENABLED || !SB_URL) return;
  if (msg.companion === null && msg.content.trim().length < MIN_HUMAN_CHARS) return;
  fetch(`${SB_URL}/ingest/discord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SB_KEY ? { "Authorization": `Bearer ${SB_KEY}` } : {}),
    },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(5_000),
  }).then(res => {
    if (!res.ok) console.warn(`[sb-live] ingest non-2xx: ${res.status}`);
  }).catch(e => {
    console.warn(`[sb-live] ingest failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
