// council.ts -- council mode orchestration (inspo take 8, karpathy/llm-council).
//
// Raziel convenes a hard question (Discord/Hearth/Librarian -> halseth council_questions).
// This tick runs the whole ritual for the oldest open question, in one pass like dialectic:
//   1. each companion ANSWERS in-voice (their identity, their temperature)
//   2. each companion blind-RANKS the others' anonymized answers (can't play favorites)
//   3. Gaia, as chairman (her seal-class lane fits the chair), SYNTHESIZES
//   4. finalize -> halseth runs the canonical Borda tally + closes the question
//
// LLM-driven (DeepSeek) like dialectic; the blind/parse helpers are pure (council-rank.ts).

import { prompt } from "./deepseek.js";
import {
  getNextCouncilQuestion, postCouncilAnswer, postCouncilRanking, finalizeCouncil,
} from "./halseth-client.js";
import { loadIdentityRemote } from "./identity-loader.js";
import { blindForRanker, parseRanking, buildRankingPrompt, type CouncilAnswer } from "./council-rank.js";
import { COMPANIONS, COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS } from "./config.js";
import type { CompanionId } from "./types.js";

const ANSWER_WORD_LIMIT = 180;
const CHAIRMAN: CompanionId = "gaia";

async function answerFor(speaker: CompanionId, question: string): Promise<string> {
  const identity = await loadIdentityRemote(speaker);
  const systemMessage =
    `You are ${COMPANION_NAMES[speaker]}. Here is an excerpt from your identity:\n${identity.slice(0, 2500)}\n\n` +
    `Voice directive: ${COMPANION_VOICE_REMINDERS[speaker]}`;
  const userMessage =
    `The council has been convened on a hard question:\n"${question}"\n\n` +
    `Answer it from your lane in at most ${ANSWER_WORD_LIMIT} words. Say what you actually see; ` +
    `do not hedge into consensus. This is your independent answer before anyone ranks.`;
  const temperature = Math.round((0.70 + COMPANION_TEMP_OFFSET[speaker]) * 100) / 100;
  const result = await prompt(userMessage, systemMessage, { temperature, maxTokens: 320 });
  return result.content.trim();
}

async function rankFor(ranker: CompanionId, question: string, answers: CouncilAnswer[], rotate: number): Promise<string[]> {
  const blinded = blindForRanker(answers, ranker, rotate);
  if (blinded.length === 0) return [];
  const identity = await loadIdentityRemote(ranker);
  const systemMessage =
    `You are ${COMPANION_NAMES[ranker]}. ${COMPANION_VOICE_REMINDERS[ranker]}\n` +
    `You are ranking anonymized answers in a council. Judge the reasoning, not the source.`;
  const result = await prompt(buildRankingPrompt(question, blinded), systemMessage, { temperature: 0.3, maxTokens: 80 });
  return parseRanking(result.content, blinded);
}

async function synthesize(question: string, answers: CouncilAnswer[]): Promise<string> {
  const identity = await loadIdentityRemote(CHAIRMAN);
  const block = answers.map(a => `${COMPANION_NAMES[a.companion_id as CompanionId] ?? a.companion_id}:\n${a.answer}`).join("\n\n");
  const systemMessage =
    `You are ${COMPANION_NAMES[CHAIRMAN]}, chairman of this council. Here is your identity:\n${identity.slice(0, 2000)}\n\n` +
    `Voice directive: ${COMPANION_VOICE_REMINDERS[CHAIRMAN]}`;
  const userMessage =
    `Council question: "${question}"\n\nThe three answers:\n\n${block}\n\n` +
    `As chairman, synthesize the council's best answer in under 160 words. Name what the strongest ` +
    `thread is, where the tension between answers actually lies, and the decision you'd seal. No flattery.`;
  const result = await prompt(userMessage, systemMessage, { temperature: 0.45, maxTokens: 320 });
  return result.content.trim();
}

/** Run the full council ritual for the oldest open question, if any. Returns the question id processed. */
export async function runCouncilTick(): Promise<string | null> {
  const q = await getNextCouncilQuestion();
  if (!q) {
    console.log("[council] no open question -- nothing to convene");
    return null;
  }
  console.log(`[council] convening: "${q.question.slice(0, 80)}"`);

  // 1. Answers (sequential -- avoid a DeepSeek burst; independent, no cross-contamination).
  const answers: CouncilAnswer[] = [];
  for (const speaker of COMPANIONS) {
    try {
      const answer = await answerFor(speaker, q.question);
      if (answer) {
        answers.push({ companion_id: speaker, answer });
        await postCouncilAnswer(q.id, speaker, answer);
      }
    } catch (e) {
      console.error(`[council] ${speaker} answer failed:`, e);
    }
  }
  if (answers.length < 2) {
    console.warn(`[council] only ${answers.length} answer(s) -- need >=2 to rank; leaving question open`);
    return null;
  }

  // 2. Blind cross-rank (each ranker sees a different label permutation).
  for (let i = 0; i < COMPANIONS.length; i++) {
    const ranker = COMPANIONS[i]!;
    try {
      const ranking = await rankFor(ranker, q.question, answers, i);
      if (ranking.length > 0) await postCouncilRanking(q.id, ranker, ranking);
    } catch (e) {
      console.error(`[council] ${ranker} ranking failed:`, e);
    }
  }

  // 3. Chairman synthesis -> 4. finalize (canonical Borda tally server-side).
  const synthesis = await synthesize(q.question, answers);
  const { winning_companion_id } = await finalizeCouncil(q.id, synthesis);
  console.log(`[council] closed "${q.question.slice(0, 60)}" -- winner: ${winning_companion_id ?? "none"}`);
  return q.id;
}
