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
const MIN_HUMAN_CHARS = 50; // skip "lol"-tier human messages; companion replies always go

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
