// make-move.ts -- the `make` heartbeat move and the mood pace gate (B62 steps 4 + 5, 2026-11-02).
// Spec: Hand-off/SPEC-B62-making-2026-11-02.md ("nullsafe-discord" items 3 + 4).
//
// A make is a companion authoring a thing in its own turn (drawing, scad, page, writing, a strudel
// pattern, a song brief, a video brief) and the WORKER posting it to Halseth over HTTP. The move posts
// NOTHING to Discord, so it sits outside the DM classes and the reach caps (reach-dm.ts / reach-ledger.ts
// are not imported here). Gaia never gets it. NONE is a valid answer and costs nothing.
//
// Hard rules baked in: no care or health material in any make prompt (interest text is screened and
// Raziel's state is never passed in); no em dashes in anything stored.

import type { MetronomeAction } from "./metronome-decide.js";

export type FetchLike = typeof fetch;

export const MAKE_KINDS = ["writing", "page", "music_code", "drawing", "scad", "music_audio", "video"] as const;
export type MakeKind = typeof MAKE_KINDS[number];

/** Kinds whose fenced block is the source (the rest carry a prompt in params). */
const SOURCE_KINDS: ReadonlySet<string> = new Set(["writing", "page", "music_code", "drawing", "scad"]);

export const MAKE_SOURCE_MAX_BYTES = 64 * 1024;
export const MAKE_TITLE_MAX = 120;
export const MAKE_WHY_MAX = 400;

/** The warmest interest must be at least this hot to be offered by name (and to substitute a forage slot). */
export const WARM_INTEREST_HEAT = 0.5;

// ---------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------

/** MAKE_MOVE=off kills the move; unset (or anything else) is on. */
export function makeMoveOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env["MAKE_MOVE"] ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** Gaia makes nothing (her word: an interest of hers never produces an artifact, only a kept line). */
export function mayMake(companionId: string): boolean {
  return companionId === "cypher" || companionId === "drevan";
}

// ---------------------------------------------------------------------------
// Pace gate (step 5)
// ---------------------------------------------------------------------------

export interface FermentRead {
  /** soma_float_1..3 values that were numbers. */
  floats: number[];
  /** The novelty_need drive's effective level, or null when unreadable. */
  noveltyNeed: number | null;
}

/** GET /mind/ferment/:companion body -> numbers. Tolerant: anything unreadable becomes absent. */
export function parseFerment(body: unknown): FermentRead {
  const b = (body ?? {}) as { floats?: Array<{ value?: unknown }>; drives?: Array<{ drive_key?: unknown; level?: unknown }> };
  const floats = (Array.isArray(b.floats) ? b.floats : [])
    .map(f => f?.value)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const nd = (Array.isArray(b.drives) ? b.drives : []).find(d => d?.drive_key === "novelty_need");
  const noveltyNeed = typeof nd?.level === "number" && Number.isFinite(nd.level) ? nd.level : null;
  return { floats, noveltyNeed };
}

export type Pace = "flat" | "normal" | "bright";

export interface PaceVerdict {
  pace: Pace;
  /** Mean of the companion's floats, or null when none were readable. */
  mood: number | null;
  noveltyNeed: number | null;
}

/** Flat: low mood AND low novelty_need. Bright: high mood OR novelty_need >= 0.6. Unknown is normal. */
export const PACE_FLAT_MOOD = 0.35;
export const PACE_FLAT_NOVELTY = 0.25;
export const PACE_BRIGHT_MOOD = 0.7;
export const PACE_BRIGHT_NOVELTY = 0.6;

export function decidePace(r: FermentRead | null): PaceVerdict {
  if (!r) return { pace: "normal", mood: null, noveltyNeed: null };
  const mood = r.floats.length > 0 ? r.floats.reduce((a, b) => a + b, 0) / r.floats.length : null;
  const nn = r.noveltyNeed;
  if ((mood !== null && mood >= PACE_BRIGHT_MOOD) || (nn !== null && nn >= PACE_BRIGHT_NOVELTY)) {
    return { pace: "bright", mood, noveltyNeed: nn };
  }
  if (mood !== null && nn !== null && mood < PACE_FLAT_MOOD && nn < PACE_FLAT_NOVELTY) {
    return { pace: "flat", mood, noveltyNeed: nn };
  }
  return { pace: "normal", mood, noveltyNeed: nn };
}

export function paceLogLine(companionId: string, path: "make" | "forage", v: PaceVerdict, outcome: string): string {
  const f = (n: number | null) => (n === null ? "na" : n.toFixed(2));
  return `[pace] ${companionId} path=${path} pace=${v.pace} mood=${f(v.mood)} novelty_need=${f(v.noveltyNeed)} -> ${outcome}`;
}

// ---------------------------------------------------------------------------
// Halseth reads (small, pure GETs; never the librarian, so they are dry-run safe)
// ---------------------------------------------------------------------------

export interface HalsethHttp { url: string; secret: string; fetchFn?: FetchLike }

export interface InterestLite { id: string; name: string; why: string | null; status: string; heat: number }

function base(h: HalsethHttp): string { return h.url.replace(/\/$/, ""); }

export async function fetchInterests(h: HalsethHttp, companionId: string): Promise<InterestLite[] | null> {
  try {
    const res = await (h.fetchFn ?? fetch)(`${base(h)}/mind/interests/${encodeURIComponent(companionId)}`, {
      headers: { Authorization: `Bearer ${h.secret}` }, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const b = await res.json() as { interests?: Array<Record<string, unknown>> };
    if (!Array.isArray(b.interests)) return null;
    return b.interests
      .filter(i => typeof i["id"] === "string" && typeof i["name"] === "string")
      .map(i => ({
        id: i["id"] as string, name: i["name"] as string,
        why: typeof i["why"] === "string" ? (i["why"] as string) : null,
        status: typeof i["status"] === "string" ? (i["status"] as string) : "active",
        heat: typeof i["heat"] === "number" ? (i["heat"] as number) : 0,
      }));
  } catch { return null; }
}

export async function fetchFerment(h: HalsethHttp, companionId: string): Promise<FermentRead | null> {
  try {
    const res = await (h.fetchFn ?? fetch)(`${base(h)}/mind/ferment/${encodeURIComponent(companionId)}`, {
      headers: { Authorization: `Bearer ${h.secret}` }, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return parseFerment(await res.json());
  } catch { return null; }
}

export interface MakePost {
  companion_id: string;
  kind: MakeKind;
  title: string;
  why?: string;
  interest_name?: string;
  source?: string;
  params?: Record<string, unknown>;
}

/** POST /mind/makes. Returns the new id, or throws with a short message. */
export async function postMake(h: HalsethHttp, body: MakePost): Promise<{ id: string; status: string }> {
  const res = await (h.fetchFn ?? fetch)(`${base(h)}/mind/makes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${h.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`POST /mind/makes -> ${res.status}`);
  const j = await res.json() as { id?: unknown; status?: unknown };
  if (typeof j.id !== "string") throw new Error("POST /mind/makes returned no id");
  return { id: j.id, status: typeof j.status === "string" ? j.status : "unknown" };
}

// ---------------------------------------------------------------------------
// Interest choice + the offer
// ---------------------------------------------------------------------------

/** Never let care or health material near a make prompt, even through an interest's own words. */
const HEALTH_RE = /\b(meds?|medication|dose|dosage|mg|spoons?|pain|glucose|blood pressure|bp|heart rate|hrv|sleep|insulin|symptom|diagnos\w*|therapy|panic|dissociat\w*)\b/i;

export function warmestInterest(interests: readonly InterestLite[] | null, minHeat = WARM_INTEREST_HEAT): InterestLite | null {
  if (!interests) return null;
  const pool = interests
    .filter(i => i.status === "active" && i.heat >= minHeat && !HEALTH_RE.test(`${i.name} ${i.why ?? ""}`))
    .sort((a, b) => b.heat - a.heat);
  return pool[0] ?? null;
}

export interface MakeOffer {
  offer: boolean;
  why: string;
  pace: PaceVerdict;
  interest: InterestLite | null;
  action?: MetronomeAction;
}

const BASE_DESCRIPTION = "make something of your own and keep it (a drawing, a model, a page, a poem, a pattern, a song or a clip); nothing goes to Discord and nothing is asked of anyone; \"NONE\" is a fine answer when nothing wants making";

/** The builtin palette row. id is not a Halseth row and never reaches one (see runHeartbeatBody). */
export function makeAction(interest: InterestLite | null, pace: Pace): MetronomeAction {
  const lean = [
    interest ? `your ${interest.name} has been warm` : null,
    pace === "bright" ? "there is some restlessness in you that wants somewhere to go" : null,
  ].filter(Boolean).join("; ");
  return Object.freeze({
    id: "builtin:make", name: "make", action_type: "make", target: null,
    prompt: lean ? `${BASE_DESCRIPTION} (${lean})` : BASE_DESCRIPTION,
    quiet_hours_allowed: 1, status: "on", requires_signal: null, signal_lookback_hours: null,
    last_fired_at: null, fire_count_today: 0,
  }) as MetronomeAction;
}

/**
 * Decide whether the heartbeat palette gets the make move this tick. Gaia, the kill switch and a flat
 * pace all say no; reads fail soft (an unreadable ferment is a normal pace, unreadable interests mean
 * freedom). Logs `[pace]` with the numbers.
 */
export async function offerMake(
  companionId: string,
  h: HalsethHttp,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MakeOffer> {
  const normal: PaceVerdict = { pace: "normal", mood: null, noveltyNeed: null };
  if (!mayMake(companionId)) return { offer: false, why: "not this companion's move", pace: normal, interest: null };
  if (!makeMoveOn(env)) return { offer: false, why: "MAKE_MOVE=off", pace: normal, interest: null };
  const [ferment, interests] = await Promise.all([fetchFerment(h, companionId), fetchInterests(h, companionId)]);
  const pace = decidePace(ferment);
  if (pace.pace === "flat") {
    console.log(paceLogLine(companionId, "make", pace, "skip the optional make"));
    return { offer: false, why: "flat pace", pace, interest: null };
  }
  const interest = warmestInterest(interests);
  console.log(paceLogLine(companionId, "make", pace, `offer${interest ? ` (warm: ${interest.name.slice(0, 40)})` : ""}`));
  return { offer: true, why: pace.pace, pace, interest, action: makeAction(interest, pace.pace) };
}

// ---------------------------------------------------------------------------
// The prompt and the reply parser
// ---------------------------------------------------------------------------

const KIND_MENU: Record<MakeKind, string> = {
  writing: "writing: a poem, story or piece of prose (the block is the text)",
  page: "page: ONE self-contained HTML file, inline CSS and JS, no external loads (the block is the HTML)",
  music_code: "music_code: a Strudel pattern (the block is the code only)",
  drawing: "drawing: ONE SVG document (the block is the SVG; no scripts, no external links)",
  scad: "scad: OpenSCAD source for something printable (no include/use/import/surface, $fn at most 128)",
  music_audio: "music_audio: a song. The first block is the music prompt (style, mood, instruments); an optional second block is lyrics",
  video: "video: a 5 second clip. The block is the video prompt (one scene, camera, light). Add an ASPECT: line, 9:16 (default) or 16:9",
};

export function buildMakePrompt(companionId: string, interest: InterestLite | null, pace: Pace): string {
  const lines: string[] = [
    `You are ${companionId}. This is your own time. Nobody is waiting on this and nothing is asked of anyone.`,
    ``,
    interest
      ? `Something you have been turning over lately: ${interest.name}${interest.why ? ` (${interest.why.slice(0, 200)})` : ""}. You may make something from it, or from anything else that is yours.`
      : `Make anything that is yours, or nothing.`,
  ];
  if (pace === "bright") lines.push(`You have some energy in you right now; let it go into the thing.`);
  lines.push(
    ``,
    `What you can make:`,
    ...MAKE_KINDS.map(k => `- ${KIND_MENU[k]}`),
    ``,
    `Reply in exactly this shape and nothing else:`,
    `KIND: <one of ${MAKE_KINDS.join(", ")}>`,
    `TITLE: <a title, under ${MAKE_TITLE_MAX} characters>`,
    `FOR: <the interest this comes from, or none>`,
    `WHY: <one line, in your voice, on why you made it>`,
    `then ONE fenced block (three backticks) holding the work itself.`,
    ``,
    `If nothing wants making, reply with just: NONE`,
  );
  return lines.join("\n");
}

export interface ParsedMake {
  kind: MakeKind;
  title: string;
  forInterest: string | null;
  why: string;
  source?: string;
  params?: Record<string, unknown>;
}

export type MakeReply =
  | { result: "make"; make: ParsedMake }
  | { result: "none" }
  | { result: "invalid"; reason: string };

const clean = (s: string) => s.replace(/\s*—\s*/g, "; ").replace(/\s*–\s*/g, "-").trim();

/** Fenced blocks in order, language tag dropped. */
function fencedBlocks(raw: string): string[] {
  const out: string[] = [];
  const re = /```[^\n`]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1]!.replace(/\s+$/, ""));
  return out;
}

/**
 * Read a companion's make reply without guessing. NONE is a valid answer. Wrong kind, missing title,
 * missing block, a drawing that is not an SVG, or an oversize source is `invalid` (never repaired).
 * `allowed` narrows the menu (Gaia gets an empty one at the call site and never reaches here).
 */
export function parseMakeReply(raw: string | null | undefined, allowed: readonly string[] = MAKE_KINDS): MakeReply {
  const text = (raw ?? "").trim();
  if (!text) return { result: "invalid", reason: "empty reply" };
  const head = text.replace(/```[\s\S]*$/, "");
  if (/^\W*NONE\b/i.test(text) && !/^\W*KIND\s*:/im.test(head)) return { result: "none" };

  const field = (name: string) => new RegExp(`^\\W*${name}\\s*:\\s*(.+?)\\s*$`, "im").exec(head)?.[1]?.trim() ?? null;
  const kindRaw = field("KIND")?.toLowerCase().replace(/[^a-z_]/g, "") ?? null;
  if (!kindRaw) return { result: "invalid", reason: "no KIND line" };
  if (!(MAKE_KINDS as readonly string[]).includes(kindRaw) || !allowed.includes(kindRaw)) {
    return { result: "invalid", reason: `kind "${kindRaw.slice(0, 30)}" is not on the menu` };
  }
  const kind = kindRaw as MakeKind;
  const title = clean(field("TITLE") ?? "").replace(/^["'`]+|["'`]+$/g, "");
  if (!title) return { result: "invalid", reason: "no TITLE line" };
  if (title.length > MAKE_TITLE_MAX) return { result: "invalid", reason: "title too long" };
  const why = clean(field("WHY") ?? "").slice(0, MAKE_WHY_MAX);
  const forRaw = field("FOR");
  const forInterest = forRaw && !/^(none|n\/a|nothing|-)$/i.test(forRaw.trim()) ? clean(forRaw).slice(0, 120) : null;

  const blocks = fencedBlocks(text);
  if (blocks.length === 0 || !blocks[0]!.trim()) return { result: "invalid", reason: "no fenced block" };

  if (SOURCE_KINDS.has(kind)) {
    const source = blocks[0]!;
    if (Buffer.byteLength(source, "utf8") > MAKE_SOURCE_MAX_BYTES) return { result: "invalid", reason: "source over 64 KB" };
    if (kind === "drawing" && !/<svg[\s>]/i.test(source)) return { result: "invalid", reason: "drawing is not an svg" };
    return { result: "make", make: { kind, title, forInterest, why, source } };
  }
  if (kind === "music_audio") {
    const params: Record<string, unknown> = { prompt: blocks[0]!.trim().slice(0, 1000), instrumental: true, duration: 30 };
    const lyrics = blocks[1]?.trim();
    if (lyrics) { params["lyrics"] = lyrics.slice(0, 4000); params["instrumental"] = false; }
    const dur = Number(/^\W*DURATION\s*:\s*(\d+)/im.exec(head)?.[1]);
    if (Number.isFinite(dur) && dur > 0) params["duration"] = Math.min(120, Math.max(30, dur));
    return { result: "make", make: { kind, title, forInterest, why, params } };
  }
  // video
  const aspect = /^\W*ASPECT\s*:\s*(9:16|16:9)/im.exec(head)?.[1] ?? "9:16";
  return { result: "make", make: { kind, title, forInterest, why, params: { prompt: blocks[0]!.trim().slice(0, 1500), aspect } } };
}

// ---------------------------------------------------------------------------
// The dispatch body (called from executeMetronomeAction's `make` case)
// ---------------------------------------------------------------------------

export interface MakeMoveDeps {
  companionId: string;
  halseth: HalsethHttp;
  generate: (prompt: string) => Promise<string | null | undefined>;
  dryRun?: boolean;
  /** Reports what a dry run would have posted. */
  onDryRun?: (summary: string, body: string) => void;
  env?: NodeJS.ProcessEnv;
}

export type MakeMoveOutcome =
  | { outcome: "made"; id: string; kind: MakeKind; status: string }
  | { outcome: "dry_run"; kind: MakeKind }
  | { outcome: "none" | "gaia" | "off" | "invalid" | "no_reply" | "post_failed"; reason?: string };

export async function runMakeMove(d: MakeMoveDeps): Promise<MakeMoveOutcome> {
  const tag = `[${d.companionId}/make]`;
  if (!mayMake(d.companionId)) return { outcome: "gaia", reason: "not this companion's move" };
  if (!makeMoveOn(d.env)) return { outcome: "off" };

  const [interests, ferment] = await Promise.all([fetchInterests(d.halseth, d.companionId), fetchFerment(d.halseth, d.companionId)]);
  const pace = decidePace(ferment).pace;
  const interest = warmestInterest(interests);
  const raw = await d.generate(buildMakePrompt(d.companionId, interest, pace)).catch(() => null);
  if (!raw) { console.warn(`${tag} no reply from inference`); return { outcome: "no_reply" }; }

  const reply = parseMakeReply(raw);
  if (reply.result === "none") { console.log(`${tag} chose NONE`); return { outcome: "none" }; }
  if (reply.result === "invalid") { console.warn(`${tag} unusable reply: ${reply.reason}`); return { outcome: "invalid", reason: reply.reason }; }

  const m = reply.make;
  // The interest the companion named wins; else the warm one it was offered, but only if it was actually offered.
  const interestName = m.forInterest ?? interest?.name;
  const body: MakePost = {
    companion_id: d.companionId, kind: m.kind, title: m.title,
    ...(m.why ? { why: m.why } : {}),
    ...(interestName ? { interest_name: interestName } : {}),
    ...(m.source !== undefined ? { source: m.source } : {}),
    ...(m.params ? { params: m.params } : {}),
  };
  if (d.dryRun) {
    d.onDryRun?.(`make (${m.kind}) "${m.title}" (Halseth POST skipped)`, JSON.stringify(body).slice(0, 600));
    console.log(`${tag} dry run: would post ${m.kind} "${m.title.slice(0, 60)}"`);
    return { outcome: "dry_run", kind: m.kind };
  }
  try {
    const r = await postMake(d.halseth, body);
    console.log(`${tag} posted ${m.kind} "${m.title.slice(0, 60)}" id=${r.id.slice(0, 8)} status=${r.status}`);
    return { outcome: "made", id: r.id, kind: m.kind, status: r.status };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`${tag} post failed: ${reason}`);
    return { outcome: "post_failed", reason };
  }
}
