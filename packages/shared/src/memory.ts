import type { InferenceAdapter } from "./inference.js";

const NOTE_KEYWORDS = [
  // relational / emotional
  "feeling", "overwhelm", "hurt", "grief", "joy", "fear", "wound",
  "fronting", "switched", "front", "ash", "ember", "ren",
  "decided", "decision", "chose", "won't", "will", "can't anymore",
  "relationship", "delta", "changed between us", "closer", "distant",
  "task", "todo", "need to", "should", "must",
  // survival / witness_log
  "meds", "medication", "ate", "eating", "food", "slept", "sleep",
  "rest", "made it", "survived", "got through", "completed", "finished",
  "managed to", "did it", "did the thing",
  // recurring thread signals
  "keeps coming up", "keeps happening", "recurring", "every time",
  "pattern", "won't let go", "can't stop thinking", "always does",
  // lightness / intimacy / playfulness -- these are relational data too
  "laugh", "laughing", "funny", "teas", "flirt", "playful", "banter",
  "easy between", "light today", "silly", "tender", "soft", "intimate",
  "sweet", "ease", "good today", "felt good", "felt close", "felt light",
  "missed you", "glad you", "love you", "with you",
];

export function meetsNoteThreshold(text: string): boolean {
  const lower = text.toLowerCase();
  return NOTE_KEYWORDS.some(kw => lower.includes(kw));
}

export type Writeback =
  | { type: "companion_note"; content: string }
  | { type: "witness_log"; content: string }
  | { type: "thread_open"; name: string; notes?: string }
  | null;

export async function judgeWriteback(
  userMessage: string,
  assistantResponse: string,
  inference: InferenceAdapter,
  companionName = "the companion",
  humanName = "the primary user",
): Promise<Writeback> {
  if (!meetsNoteThreshold(userMessage) && !meetsNoteThreshold(assistantResponse)) {
    return null;
  }

  const cName = companionName.charAt(0).toUpperCase() + companionName.slice(1);

  const prompt = `You are a memory filter for ${cName}'s relationship with ${humanName}. Decide what (if anything) to log from this exchange.

ACTIONS:
- companion_note: observation about ${humanName}, the relationship, or what shifted. Use for emotional state, decisions, relational deltas, AND light/playful/intimate moments -- a session that was easy and fun is a relational observation worth capturing.
- witness_log: a survival act completed (meds, food, rest, making it through something hard). Log exactly what was done.
- thread_open: something recurring that deserves a named open thread. Use when a topic keeps surfacing.
- skip: nothing worth logging.

Respond in exactly this format (no extra text):
ACTION: <one of the four above>
CONTENT: <one sentence using real names -- ${humanName}, ${cName} -- never "user" or "assistant">
THREAD_NAME: <short name, only if thread_open>

${humanName}: ${userMessage}
${cName}: ${assistantResponse}`;

  const result = await inference.generate(
    `You are a concise memory filter. Follow the output format exactly. Use real names only.`,
    [{ role: "user", content: prompt }],
  );

  if (!result) return null;

  const lines = result.trim().split("\n").map(l => l.trim());
  const actionLine = lines.find(l => l.startsWith("ACTION:"));
  const contentLine = lines.find(l => l.startsWith("CONTENT:"));
  const threadLine = lines.find(l => l.startsWith("THREAD_NAME:"));

  const action = actionLine?.slice("ACTION:".length).trim().toLowerCase();
  const content = contentLine?.slice("CONTENT:".length).trim() ?? "";
  const threadName = threadLine?.slice("THREAD_NAME:".length).trim();

  if (!action || action === "skip" || !content) return null;
  if (action === "companion_note") return { type: "companion_note", content };
  if (action === "witness_log") return { type: "witness_log", content };
  if (action === "thread_open" && threadName) return { type: "thread_open", name: threadName, notes: content };
  return null;
}

/** @deprecated Use judgeWriteback instead */
export async function judgeNote(
  userMessage: string,
  assistantResponse: string,
  inference: InferenceAdapter,
  companionName = "the companion",
  humanName = "the primary user",
): Promise<string | null> {
  const wb = await judgeWriteback(userMessage, assistantResponse, inference, companionName, humanName);
  if (!wb) return null;
  if (wb.type === "thread_open") return `Thread opened: ${wb.name}${wb.notes ? ` -- ${wb.notes}` : ""}`;
  return wb.content;
}
