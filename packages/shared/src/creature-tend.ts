type TendAction = "feed" | "play" | "talk" | "give";
const ACTIONS: TendAction[] = ["feed", "play", "talk", "give"];

// Gaia is monastic -- she witnesses (talk) rather than playing with the crow.
export function pickTendAction(companionId: string, seed: number): TendAction {
  if (companionId === "gaia") return "talk";
  return ACTIONS[Math.abs(Math.floor(seed)) % ACTIONS.length]!;
}

const VERB: Record<TendAction, (n: string) => string> = {
  feed: n => `sets out a scrap for ${n}`,
  play: n => `dangles a bit of bright wire for ${n}`,
  talk: n => `says something low to ${n}`,
  give: n => `leaves ${n} a small found thing`,
};
// Deterministic fallback line if inference is unavailable; the executor prefers
// generateOutward when it can (companion voice), this is the floor.
export function tendLine(companionId: string, action: TendAction, name: string): string {
  return `*${companionId} ${VERB[action](name)}.*`;
}
