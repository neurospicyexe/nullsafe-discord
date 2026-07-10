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

export async function postSolMoment(webhookUrl: string, text: string): Promise<boolean> {
  const r = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(10_000),
  });
  return r.status === 204;
}
