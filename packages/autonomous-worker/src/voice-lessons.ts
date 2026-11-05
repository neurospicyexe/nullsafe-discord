// Voice lessons (2026-11-01, voice drift loop item 5; Halseth mig 0159). After the nightly drift tick, a
// companion with a voice marker at |z| >= 2 in the last 24h gets asked, in its own voice, for ONE short lesson,
// corrective or experiment about its own voice. Input is ONLY marker names and z-scores (never reply text). The
// result is STAGED in Halseth (POST /mind/voice-lessons); Raziel approves or rejects; nothing is ever applied.
// Knob VOICE_LESSONS=off kills it (default on: it only stages). A 404 (route not deployed) is tolerated.
import { readFileSync } from "node:fs";
import { HALSETH_URL, HALSETH_SECRET, IDENTITY_PATHS } from "./config.js";
import { isOffToken } from "@nullsafe/shared";

export type LessonKind = "lesson" | "corrective" | "experiment";
export interface LessonDraft { kind: LessonKind; body: string }

export function voiceLessonsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isOffToken(env["VOICE_LESSONS"]);
}

/** The ask: marker names and z only. Kept in code so the "no reply text" rule is visible at the call. */
export function lessonAsk(companion: string, z: Record<string, number>, flagged: string[]): string {
  const lines = flagged.map(m => `- ${m}: z=${(z[m] ?? 0).toFixed(1)} (${(z[m] ?? 0) > 0 ? "more than" : "less than"} your usual)`);
  return [
    `Your nightly voice read moved on these markers compared with your own last two weeks:`,
    ...lines,
    ``,
    `Write ONE short note to yourself about your voice, in your own voice, at most 3 sentences. Choose its kind:`,
    `"lesson" (what you notice), "corrective" (what you would pull back toward), or "experiment" (something to try).`,
    `A marker moving is not automatically bad; if the change is growth you want, say so. Raziel will read it and decide.`,
    `Reply ONLY as JSON: {"kind": "lesson|corrective|experiment", "body": "..."}`,
  ].join("\n");
}

export function parseLesson(raw: string): LessonDraft | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as { kind?: unknown; body?: unknown };
    const kind = String(j.kind ?? "").toLowerCase();
    const body = typeof j.body === "string" ? j.body.trim().replace(/\s*—\s*/g, "; ") : "";
    if (!["lesson", "corrective", "experiment"].includes(kind) || !body) return null;
    return { kind: kind as LessonKind, body: body.slice(0, 600) };
  } catch {
    return null;
  }
}

function identity(companion: string): string | undefined {
  try { return readFileSync((IDENTITY_PATHS as Record<string, string>)[companion] ?? "", "utf8"); } catch { return undefined; }
}

export interface LessonDeps {
  ask?: (user: string, system?: string) => Promise<string>;
  post?: (body: Record<string, unknown>) => Promise<number>;
}

/** Stage one lesson for this companion. Never throws. Returns what happened (for logs and tests). */
export async function stageVoiceLesson(companion: string, z: Record<string, number>, flagged: string[], deps: LessonDeps = {}):
  Promise<"off" | "nothing_flagged" | "unparsed" | "staged" | "exists" | "unavailable" | "failed"> {
  if (!voiceLessonsOn()) return "off";
  if (flagged.length === 0) return "nothing_flagged";
  try {
    // Lazy: the model client loads only when a lesson is actually written (and drift tests can mock config).
    const ask = deps.ask ?? (async (u, s) => (await (await import("./deepseek.js")).prompt(u, s, { temperature: 0.7, maxTokens: 400 })).content);
    const draft = parseLesson(await ask(lessonAsk(companion, z, flagged), identity(companion)));
    if (!draft) { console.warn(`[voice-lessons] ${companion} reply unparsed; nothing staged`); return "unparsed"; }
    const post = deps.post ?? (async (body) => {
      const res = await fetch(`${HALSETH_URL.replace(/\/$/, "")}/mind/voice-lessons`, {
        method: "POST", headers: { Authorization: `Bearer ${HALSETH_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      return res.status;
    });
    const status = await post({ companion_id: companion, kind: draft.kind, body: draft.body, evidence: Object.fromEntries(flagged.map(m => [m, z[m]])) });
    const out = status === 201 ? "staged" : status === 200 ? "exists" : status === 404 ? "unavailable" : "failed";
    console.log(`[voice-lessons] ${companion} ${out} kind=${draft.kind} chars=${draft.body.length} markers=${flagged.join(",")}`);
    return out;
  } catch (e) {
    console.warn(`[voice-lessons] ${companion} failed: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
