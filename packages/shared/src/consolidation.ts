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

  // 2026-08-03 flow audit. Two defects here, one causing the other, live since 2026-06-30:
  //
  // 1. The request was the bare phrase "my state". It matches NO fast-path trigger (triggerMatches
  //    requires the trigger to appear INSIDE the input, and every read phrasing is longer --
  //    "show my state", "check my state", "current state"), so it fell through to the DeepSeek
  //    classifier, which routed it to `state_update` -- a WRITE. That executor returned
  //    {"error":"state_update_failed","reason":"no fields provided..."} as a 200, so the catch
  //    below never fired and the ERROR STRING was handed to the companion as its own interior
  //    state. 315/318/317 runs, every one of them, not one with real state.
  // 2. Because that error string was byte-identical every time, the prompt was byte-identical, so
  //    Hermes's api_server derived the SAME session hash on every run and 34 days of consolidations
  //    piled into one synthetic session (1403/1229/1686 messages) holding up to 58% of a
  //    companion's entire Halseth traffic.
  //
  // The result: handoffs narrated from an error, written up to 12x/day, displacing the real
  // narrative in the slot the boot header reads. The companions were not malfunctioning -- handed
  // an error as their own state, all three declined to invent motion and said so.
  //
  // The read had to satisfy three things at once, and only one candidate does:
  //   * exact fast-path trigger, so it never reaches the classifier that caused this;
  //   * NO session INSERT -- "show my state" routes to session_open, which would have this cron
  //     opening a session up to 12x/day/companion onto a backlog already 167 rows deep. Surface
  //     scoping bounds that to one row per day rather than fixing it; a close-handoff writer has
  //     no business opening anything;
  //   * NO consuming side effects -- bot_orient marks inter-companion notes delivered and warms
  //     heat, so calling it here would eat mail meant for the live channel turn.
  // `triad_state_read` ("companion states") is three plain SELECTs: SOMA floats, relational state
  // toward Raziel, last outgoing note. Read-only, cheap, and it carries sibling context, which is
  // better material for a close narrative than this path has ever had.
  let stateContext: string;
  try {
    const result = await librarian.ask("companion states");
    // A 200 with an {error, reason} body is a DECLINE, not state. Narrating it is what caused the
    // whole defect above, so abort here -- and abort BEFORE inference.generate, deliberately: the
    // agent turn writes its own handoff row via ask_librarian mid-turn (source=system), so a fix
    // that only skipped our own write would leave the agent's terse row landing every two hours.
    // Killing the turn kills both writers. See librarian.ts assertWriteAck for the same shape on
    // the write path.
    if (result && typeof result === "object" && "error" in result) {
      const reason = typeof (result as Record<string, unknown>)["reason"] === "string"
        ? ` -- ${(result as Record<string, unknown>)["reason"] as string}`
        : "";
      console.error(
        `[consolidation] ${companionId}: state read DECLINED by librarian: ` +
        `${String((result as Record<string, unknown>)["error"])}${reason} -- skipping handoff ` +
        `rather than narrating the error as state`,
      );
      return { written: false, reason: "state_declined" };
    }
    stateContext = result == null ? "" : typeof result === "string" ? result : JSON.stringify(result);
    // An empty read is not state either. Better no handoff than a confident one about nothing.
    if (!stateContext.trim() || stateContext.trim() === "{}") {
      console.warn(`[consolidation] ${companionId}: state read came back empty -- skipping handoff`);
      return { written: false, reason: "state_empty" };
    }
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
    // Pin the gateway session (5th arg -> X-Hermes-Session-Id). Without it the api_server falls
    // back to _derive_chat_session_id(system_prompt, first_user), which hashed our byte-identical
    // prompt into ONE session that accumulated 34 days of consolidations. Naming the lane keeps
    // this transcript out of the channel sessions AND out of everyone else's.
    //
    // The DATE SUFFIX is the 2026-08-07 half of the fix. A static lane name is a rail with no
    // decay: pinning solved the hash-collision problem and then became the same problem slower,
    // because nothing ever ended the lane. Measured that day: ONE stored user message of 3.24 MB
    // holding 713 nested copies of this very prompt (~4.7 KB each) -- 713 five-minute ticks, about
    // 2.5 days of accumulation, in a run where every call was failing 402 so nothing ever
    // succeeded to break the chain. Our side sends ~5 KB; the gateway grew the rest.
    //
    // Hermes' own `session_reset: idle` (idle_minutes 1440) CANNOT rescue this lane -- a job on a
    // 5-minute cron is never idle for 24h, so the only reset that can ever fire here is one we
    // spend ourselves. Rotating daily keeps the lane separation the pin was for AND bounds it.
    // UTC deliberately: the VPS logs in CDT, and a local-time boundary would rotate at a different
    // instant than every other date-keyed thing in the suite.
    `consolidation:${companionId}:${new Date().toISOString().slice(0, 10)}`,
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
