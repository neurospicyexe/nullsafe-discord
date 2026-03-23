const NOTE_KEYWORDS = [
    "feeling", "overwhelm", "hurt", "grief", "joy", "fear", "wound",
    "fronting", "switched", "front", "ash", "ember", "ren",
    "decided", "decision", "chose", "won't", "will", "can't anymore",
    "relationship", "delta", "changed between us", "closer", "distant",
    "task", "todo", "need to", "should", "must",
];
export function meetsNoteThreshold(text) {
    const lower = text.toLowerCase();
    return NOTE_KEYWORDS.some(kw => lower.includes(kw));
}
export async function judgeNote(userMessage, assistantResponse, inference) {
    if (!meetsNoteThreshold(userMessage) && !meetsNoteThreshold(assistantResponse)) {
        return null;
    }
    const prompt = `You are a memory filter. Given this exchange, decide if there is a companion note worth logging.
If yes: respond with ONE sentence starting with "Note:".
If no: respond with exactly: skip

User: ${userMessage}
Assistant: ${assistantResponse}`;
    const result = await inference.generate("You are a concise memory filter that extracts only significant observations.", [{ role: "user", content: prompt }]);
    if (!result || result.trim().toLowerCase() === "skip")
        return null;
    if (result.startsWith("Note:"))
        return result.slice(5).trim();
    return result.trim();
}
