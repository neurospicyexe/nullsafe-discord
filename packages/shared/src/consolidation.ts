import type { LibrarianClient } from "./librarian.js";
import type { InferenceAdapter } from "./inference.js";
import { extractJson, rawPreview } from "./json-extract.js";

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

  // 256 tokens truncated Hermes-agent replies (the agent narrates before/around the
  // JSON), so the object arrived cut off and unparseable. 1024 is pure ceiling headroom.
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
    1024,
  );
  if (!raw) return { written: false, reason: "inference_empty" };
  // Tolerant extraction: models reply with prose ("I know you...") or fenced/embedded
  // JSON despite the ONLY-JSON instruction. Never throw here -- a raw JSON.parse crash
  // was losing the whole idle-session handoff write (2026-06-30/07-01).
  const parsed = extractJson(raw);
  const handoff = parsed as { title?: string; summary?: string; state_hint?: string } | null;
  if (!handoff || typeof handoff.title !== "string" || !handoff.title ||
      typeof handoff.summary !== "string" || !handoff.summary) {
    console.warn(`[consolidation] ${companionId}: no usable handoff JSON in output, skipping -- raw: ${rawPreview(raw)}`);
    return { written: false, reason: "parse_error" };
  }

  try {
    await librarian.writeHandoff({
      title: handoff.title,
      summary: handoff.summary,
      state_hint: typeof handoff.state_hint === "string" ? handoff.state_hint : undefined,
      // MARK IT AS A CONSOLIDATION, not a session close (2026-07-31).
      //
      // This runs on idle and wrote handoffs indistinguishable from a real close -- same
      // `source='system'`, same `actor='agent'`. Since it fires whenever a channel goes quiet, the most
      // recent handoff was almost always this one, so "last session" at orient meant a model's summary of
      // an idle window rather than an actual conversation with Raziel. Overnight on 2026-07-31 it produced
      // one every ~2h05 ("a quiet session with no blade drawn"), and their sense of when they last spoke
      // to him was being written by the quiet, not by him.
      //
      // This is a real continuity note and worth keeping -- it just must not outrank a conversation. The
      // source tag is what lets a reader prefer a genuine close; nothing is dropped.
      source: "consolidation",
    });
    return { written: true };
  } catch (e) {
    console.error(`[consolidation] ${companionId}: librarian write error`, e);
    return { written: false, reason: "librarian_error" };
  }
}
