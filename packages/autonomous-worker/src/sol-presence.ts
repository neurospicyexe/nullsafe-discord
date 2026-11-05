// Sol's self-initiated presence in the heartbeat channel.
// Frequency of Sol's self-initiated channel moments, by disposition (probability per daily tick).
export const APPEAR_CHANCE: Record<string, number> = {
  absent:       0,
  aloof:        0.15,
  watchful:     0.35,
  present:      0.55,
  affectionate: 0.75,
};

export function shouldSolAppear(disposition: string, roll: number): boolean {
  return roll < (APPEAR_CHANCE[disposition] ?? 0);
}

// The moment TEXT now comes from Halseth (POST /mind/creatures/:id/moment) --
// composed server-side from live drives x trust tier, sometimes a gift from the
// nest. The palette mirror that used to live here (with its "keep in sync"
// comment) is gone on purpose: one author, no drift.

/**
 * Post a Sol moment to the webhook. Never throws. One retry (after `retryDelayMs`) on a network
 * error, a timeout, 429 or 5xx; every failed attempt logs the status or error name (never the
 * text). Before 2026-11-05 a failure here was swallowed by callers' `.catch(() => false)` and the
 * moment (including one-time milestones) vanished without a trace.
 */
export async function postSolMoment(webhookUrl: string, text: string, retryDelayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let retryable = true;
    try {
      const r = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 204) return true;
      retryable = r.status === 429 || r.status >= 500;
      console.warn(`[sol] moment post failed: status ${r.status} (attempt ${attempt}/2, ${text.length} chars)`);
    } catch (e) {
      console.warn(`[sol] moment post failed: ${e instanceof Error ? e.name : "error"} (attempt ${attempt}/2, ${text.length} chars)`);
    }
    if (!retryable || attempt === 2) break;
    await new Promise((res) => setTimeout(res, retryDelayMs));
  }
  console.warn(`[sol] moment dropped after retry (${text.length} chars)`);
  return false;
}
