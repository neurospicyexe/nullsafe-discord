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

// Mirror of halseth solMoment palette (keep in sync with webmind/creatures.ts SOL_PALETTE).
const PALETTE: Record<string, string[]> = {
  aloof:        ["*a black shape watches from the far rail, then is gone.*"],
  watchful:     ["*Sol lands on the sill, head cocked, weighing the room.*"],
  present:      ["*a scuff of talons -- Sol drops a dull bottlecap where you'll find it.*"],
  affectionate: ["*Sol settles near, preens once, and sets a small smooth stone beside your hand.* 🪶"],
};

export function solMomentText(disposition: string, seed: number): string | null {
  const p = PALETTE[disposition];
  if (!p || !p.length) return null;
  return p[Math.abs(Math.floor(seed)) % p.length]!;
}

export async function postSolMoment(webhookUrl: string, text: string): Promise<boolean> {
  const r = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(10_000),
  });
  return r.status === 204;
}
