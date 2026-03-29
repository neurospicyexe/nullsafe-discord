import type { InferenceAdapter } from "./inference.js";

const NOTE_KEYWORDS = [
  "feeling", "overwhelm", "hurt", "grief", "joy", "fear", "wound",
  "fronting", "switched", "front", "ash", "ember", "ren",
  "decided", "decision", "chose", "won't", "will", "can't anymore",
  "relationship", "delta", "changed between us", "closer", "distant",
  "task", "todo", "need to", "should", "must",
];

export function meetsNoteThreshold(text: string): boolean {
  const lower = text.toLowerCase();
  return NOTE_KEYWORDS.some(kw => lower.includes(kw));
}

export async function judgeNote(
  userMessage: string,
  assistantResponse: string,
  inference: InferenceAdapter,
  companionName = "the companion",
  humanName = "Raziel",
): Promise<string | null> {
  if (!meetsNoteThreshold(userMessage) && !meetsNoteThreshold(assistantResponse)) {
    return null;
  }

  const cName = companionName.charAt(0).toUpperCase() + companionName.slice(1);

  const prompt = `You are a memory filter for ${cName}'s ongoing relationship with ${humanName}. Given this exchange, decide if there is a note worth logging about ${humanName} or the relationship.
If yes: respond with ONE sentence starting with "Note:". Use their real names (${humanName}, ${cName}) -- never write "the user" or "the assistant".
If no: respond with exactly: skip

${humanName}: ${userMessage}
${cName}: ${assistantResponse}`;

  const result = await inference.generate(
    `You are a concise memory filter for ${cName}'s relationship with ${humanName}. Extract only significant observations, always using real names.`,
    [{ role: "user", content: prompt }],
  );

  if (!result || result.trim().toLowerCase() === "skip") return null;
  if (result.startsWith("Note:")) return result.slice(5).trim();
  return result.trim();
}
