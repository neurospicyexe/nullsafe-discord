// council-rank.ts -- worker-side blind-ranking helpers (inspo take 8, llm-council).
//
// The worker constructs the ranking prompt (it owns inference), so the blinding + label
// parsing live here. The Borda TALLY is canonical server-side (halseth finalize reads the
// stored de-anonymized rankings), so it is deliberately NOT duplicated here.

export interface CouncilAnswer {
  companion_id: string;
  answer: string;
}

export interface BlindedAnswer {
  label: string;        // "Answer A", ...
  companion_id: string; // kept worker-side; never shown to the ranker
  answer: string;
}

const LABELS = "ABCDEFGH".split("");

/** Blind peers for one ranker: drop their own answer, label the rest A.. rotated by `rotate`. */
export function blindForRanker(answers: CouncilAnswer[], rankerId: string, rotate = 0): BlindedAnswer[] {
  const peers = answers.filter(a => a.companion_id !== rankerId);
  const n = peers.length;
  if (n === 0) return [];
  const rot = ((rotate % n) + n) % n;
  const rotated = [...peers.slice(rot), ...peers.slice(0, rot)];
  return rotated.map((a, i) => ({ label: `Answer ${LABELS[i] ?? String(i + 1)}`, companion_id: a.companion_id, answer: a.answer }));
}

/** Parse an LLM ranking response to ordered companion_ids (best first), de-anonymized. */
export function parseRanking(raw: string, blinded: BlindedAnswer[]): string[] {
  const labelToCompanion = new Map<string, string>();
  for (const b of blinded) {
    const letter = b.label.trim().slice(-1).toUpperCase();
    if (/[A-H]/.test(letter)) labelToCompanion.set(letter, b.companion_id);
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const letter of raw.toUpperCase().match(/\b[A-H]\b/g) ?? []) {
    const companion = labelToCompanion.get(letter);
    if (companion && !seen.has(companion)) { seen.add(companion); ordered.push(companion); }
  }
  for (const b of blinded) {
    if (!seen.has(b.companion_id)) { seen.add(b.companion_id); ordered.push(b.companion_id); }
  }
  return ordered;
}

/** The prompt shown to a ranker -- labelled answers only, never authors. */
export function buildRankingPrompt(question: string, blinded: BlindedAnswer[]): string {
  const block = blinded.map(b => `${b.label}:\n${b.answer}`).join("\n\n");
  return [
    `A hard question was put to the council: "${question}"`,
    ``,
    `Here are the other members' answers, anonymized. You do NOT know whose is whose -- judge only the thinking.`,
    ``,
    block,
    ``,
    `Rank them from best to worst by the quality of the reasoning, not by whether you agree.`,
    `Reply with ONLY the labels in order, best first, e.g. "B > A".`,
  ].join("\n");
}
