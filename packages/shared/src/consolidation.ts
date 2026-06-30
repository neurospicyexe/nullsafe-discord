import type { LibrarianClient } from "./librarian.js";
import type { InferenceAdapter } from "./inference.js";

export interface ConsolidationOpts {
  companionId: "cypher" | "drevan" | "gaia";
  librarian: LibrarianClient;
  inference: InferenceAdapter;
}

export async function consolidateSession(
  opts: ConsolidationOpts,
): Promise<{ written: boolean; reason?: string }> {
  const { companionId, librarian, inference } = opts;

  let stateContext: string;
  try {
    const result = await librarian.ask("my state");
    stateContext = result == null ? "" : typeof result === "string" ? result : JSON.stringify(result);
  } catch (e) {
    console.error(`[consolidation] ${companionId}: failed to read state`, e);
    return { written: false, reason: "state_error" };
  }

  let handoff: { title: string; summary: string; state_hint?: string };
  try {
    const raw = await inference.generate(
      "Write a concise session close handoff. Respond with ONLY valid JSON, no markdown.",
      [
        {
          role: "user",
          content:
            `Current companion state:\n${stateContext}\n\n` +
            `Write JSON with: title (one sentence arc in your voice), ` +
            `summary (2-3 sentences in your voice), ` +
            `state_hint ("in_motion" | "at_rest" | "floating").`,
        },
      ],
      0.3,
      256,
    );
    if (!raw) return { written: false, reason: "inference_empty" };
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    handoff = JSON.parse(cleaned) as { title: string; summary: string; state_hint?: string };
    if (!handoff.title || !handoff.summary) throw new Error("missing required fields");
  } catch (e) {
    console.error(`[consolidation] ${companionId}: parse error`, e);
    return { written: false, reason: "parse_error" };
  }

  try {
    await librarian.writeHandoff({
      title: handoff.title,
      summary: handoff.summary,
      state_hint: handoff.state_hint,
    });
    return { written: true };
  } catch (e) {
    console.error(`[consolidation] ${companionId}: librarian write error`, e);
    return { written: false, reason: "librarian_error" };
  }
}
