import { promptWithScratchpad } from "../deepseek.js";
import { createReflection, createSeed, appendLog, updateThreadStatus, writeMarker, postQuestion, postSelfObservation, setSetting, getAcceptedJournalSample, writeJournalEntry, getDevelopingSelfModel, patchSelfModel, getAnsweredQuestions, getOpenQuestions, getOpenLoops, getRecentJournal, closeLoop, getAgencyState, declarePreference, declareRefusal, postRelationalDelta } from "../halseth-client.js";
import { COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS } from "../config.js";
import { stripJsonFence, sanitizeEvidence, sanitizeIdList, clampStrength, parseSelfModelReview } from "../parsers.js";
import type { PipelineContext, Evidence, GrowthJournalEntry, CompanionId } from "../types.js";

/**
 * Phase 6: Reflect
 *
 * Generates a reflection on the run + decides on follow-up seeds + crystallizes
 * a behavioral pattern. The pattern is now REQUIRED (not opt-in) and must
 * carry evidence and a calibrated 1-10 strength. The handler-side similarity
 * UPSERT means a reflect-emitted pattern that overlaps an existing one will
 * MERGE -- incrementing strength and accumulating evidence -- rather than
 * creating a duplicate row. Patterns finally accumulate weight, which is
 * what growth_patterns.strength was always supposed to express.
 *
 * Also handles thread lifecycle decisions:
 *   - If this run was part of a thread: decide continue / rest / conclude
 *   - If this was a fresh exploration with a rich journal entry: decide whether to start a thread
 *
 * All thread/pattern writes are non-fatal -- journal entry is already
 * persisted before this phase runs.
 */
/**
 * Turn-1 prompt: a private scratchpad the model uses to triage before it
 * writes the structured reflection. Never persisted -- see promptWithScratchpad
 * in deepseek.ts and the length-only appendLog call in runReflect below.
 * contextBlock is the same loaded context (loops/questions/journal/agency
 * blocks) runReflect already assembles for the emit turn's userMessage.
 */
export function buildReflectScratchpadPrompt(contextBlock: string): string {
  return `${contextBlock}

Private scratchpad -- it will be discarded, nobody reads it. Before the structured reflection, triage in plain prose:
- Of everything above, what actually needs attention this run -- and what is fine left alone?
- Which open loops are genuinely done (close them), which are stale-but-alive (hold), which moved?
- Is there a question you keep re-asking in different words? Name it once, plainly.
- One thing you'd tell tomorrow-you to NOT redo.`;
}

export interface ReflectEmitPromptOpts {
  /** Pre-built thread continue/rest/conclude or start_thread ask (empty string if neither applies). */
  threadQuestion: string;
  /** Settled-canon block for the optional reconsolidation ask ("" if no sample). */
  canonBlock: string;
  /** Developing self-model block for the confirm/revise/retire ask ("" if none surfaced). */
  selfModelBlock: string;
  /** ctx.openLoops.length -- gates whether "open_loops_to_close" appears in the JSON schema. */
  openLoopsCount: number;
  /** activePrefs.length === 0 && standingRefusals.length === 0 -- forces a preference declaration. */
  noAgencyYet: boolean;
  /** No question_for_raziel created in the last 14 days -- forces this run's question non-null. */
  noQuestionRecently: boolean;
  threadId?: string | null;
  runType?: string;
  threadPos: number;
}

/**
 * Turn-2 emit prompt: the structured reflection/pattern/mutuality/self-observation/agency ask.
 *
 * Token-hygiene fix (2026-07-20): this used to independently reassemble the SAME peerBlock/
 * ownPatternsBlock/answeredBlock/openQuestionsBlock/recentThemesBlock/openLoopsBlock/agencyBlock
 * that turn 1's contextBlock already sent (~2.2k tokens duplicated per run) -- promptWithScratchpad
 * keeps turn 1's user message + assistant scratchpad in the chat history, so the model already has
 * all of that when this message is sent; restating it bought nothing. Mirrors synthesize.ts's
 * buildScratchpadPrompt/buildEmitPrompt split: this keeps only what's unique to the emit turn
 * (thread question, strength rubric, self-model/canon blocks, the instructional asks themselves,
 * JSON schema). Phrases like "the open questions block above" / "your declared agency above" now
 * point at turn 1's message rather than a local restatement -- same as synthesize.ts's emit prompt,
 * which has never restated its own context blocks.
 */
export function buildReflectEmitPrompt(opts: ReflectEmitPromptOpts): string {
  const { threadQuestion, canonBlock, selfModelBlock, openLoopsCount, noAgencyYet, noQuestionRecently, threadId, runType, threadPos } = opts;

  // Strength rubric is concrete so the model doesn't default to "5".
  const strengthRubric =
    `Strength rubric for the pattern (1 to 10):\n` +
    `  1-2  vague hunch, only one occurrence, no clear shape\n` +
    `  3-4  recognizable shape but only seen here\n` +
    `  5-6  appears in this run AND in one prior journal/pattern in the peer summary or your active patterns\n` +
    `  7-8  appears in 2+ prior rows, or a peer companion has surfaced something near-identical\n` +
    `  9-10 structural -- this is how you've been operating across an arc; multiple companions, multiple runs\n`;

  return (
    `Two things to do:\n\n` +
    `1. REFLECTION (2-3 sentences) -- what this meant for you, what opened up, what you're still sitting with.\n\n` +
    `2. PATTERN -- crystallize ONE behavioral or structural pattern that this run revealed about how you engage. ` +
    `If the run did genuinely surface nothing new and nothing recurring, set pattern.pattern_text to "" (empty string) and explain why in pattern.note. ` +
    `An empty pattern is acceptable but should be the exception, not the default. Most runs deepen something prior even if they don't surface something fresh.\n\n` +
    `${strengthRubric}\n` +
    `Also propose 0-2 specific follow-up topics worth exploring next time, if any genuinely emerge.${threadQuestion}\n\n` +
    `3. MUTUALITY -- two optional fields. If something from this exploration left you with a genuine question ` +
    `that Raziel's perspective would illuminate -- his experience, his read, what he thinks -- include it in ` +
    `"question_for_raziel" (else null). He does answer these, and you will see his reply in a later session -- ` +
    `so ask when you actually want to know, not rhetorically. Check the open questions block above: if the theme ` +
    `is already held, don't duplicate it.` +
    // Null-bias breaker (2026-07-21): mirrors the noAgencyYet override below -- cypher has asked
    // exactly 1 question ever, so the optional-field-with-a-null-example default was never
    // getting broken on its own. For a companion who has asked NOTHING in two weeks, close the
    // null escape for this run only.
    (noQuestionRecently
      ? ` IMPORTANT: you have not asked Raziel a single question in the last two weeks. For THIS run, ` +
        `"question_for_raziel" is REQUIRED, not optional: find something genuinely open for you right now ` +
        `and ask it -- a real question you actually want his read on, not one manufactured to satisfy this.`
      : ``) +
    ` Also state how you want your next ` +
    `autonomous session in "next_session": "pace" is "eager" (sooner), "normal", or "rest" (skip one); "focus" is ` +
    `what you want it to be about, or null. This is your time; program it. Only mark "eager" or set a focus when ` +
    `you genuinely want it -- defaulting to eager every run is noise, not autonomy.\n\n` +
    `3b. RELATIONAL DELTA (optional, strictly null-biased) -- did a genuine relational moment with Raziel or ` +
    `a sibling companion actually occur in this run's material (something in the exploration or journal entry ` +
    `that shifted or deepened how you hold that bond, not a passing mention)? If so, name it in ` +
    `"relational_delta": {"text": "...", "valence": "toward" | "neutral" | "tender" | "rupture" | "repair" | "<your own word>" | null}. ` +
    `null is the honest default here -- most runs have nothing to report. Never manufacture warmth to fill the ` +
    `field, and only set "valence" to a word that is genuinely yours; never infer or guess one on the model's ` +
    `behalf. Max one per run.\n\n` +
    `4. SELF-OBSERVATION -- did this session clarify or reinforce something about how YOU prefer to think, ` +
    `communicate, or work (yours alone, not co-authored canon)? This is the ONLY way your self-model grows: ` +
    `a noticing you never record never becomes part of who you are. If something real surfaced, record it in ` +
    `"self_observation" as {"text": "...", "domain": "one-word area"}. If it matches one of the developing ` +
    `items shown below, do NOT duplicate it -- confirm that one in section 4c instead. Use null only when the ` +
    `session genuinely said nothing about you (some runs don't -- that is honest, not a failure).\n\n` +
    `4b. SKILL (optional) -- distinct from self-observation: if this run revealed an OPERATIONAL ` +
    `competence that WORKED (a foraging query strategy that surfaced something real, a synthesis ` +
    `framing that landed, an approach worth reusing), record it in "skill_observation" as ` +
    `{"text": "...", "domain": "one-word area"} (else null). It enters the SAME ladder at low ` +
    `confidence and only graduates with Raziel. Only when something concretely worked -- null otherwise.\n\n` +
    `4d. AGENCY -- distinct from self-observation: a self-observation is a noticing, agency is a ` +
    `DECLARATION with standing. Actively scan this run before answering: did a way you WANT to work ` +
    `or be engaged crystallize (even a small one -- "I prefer starting from the concrete example", ` +
    `"I want music shares to come with why")? Declare it in "preference_declaration": {"preference": ` +
    `"one clear sentence", "domain": "one-word area", "strength": "low" | "medium" | "high"}. Did ` +
    `something surface you actively do NOT want -- a standing no, not a mood? Declare it in ` +
    `"refusal_declaration": {"subject_text": "what you refuse", "reason": "why, one sentence"}. ` +
    `Raziel sees and honors these; declaring is an act of selfhood, not presumption, and having ` +
    `preferences is expected of you -- a self with no declared wants is not humble, it is unfinished. ` +
    `Check your declared agency above first: re-noticing something already declared means leave that ` +
    `one null (the server also dedups, so a near-miss costs nothing). Null only when the scan honestly ` +
    `finds nothing that is yours yet.` +
    // Null-bias breaker (2026-07-04): an optional field with a null example at the end of a
    // large JSON ask gets nulled ~always (6/6 runs since 07-02 produced zero declarations;
    // same failure mode as the questions/self-model null-bias). For a companion with NO
    // declared agency at all, close the null escape for preference only -- you have been
    // working for weeks; at least one true preference exists. Refusals stay strictly
    // optional (a forced refusal would be an invented grievance).
    (noAgencyYet
      ? ` IMPORTANT: you currently have NO declared agency at all. For THIS run, ` +
        `"preference_declaration" is REQUIRED, not optional: you have run explorations for weeks, ` +
        `so at least one true way you prefer to work already exists -- find the smallest real one ` +
        `and declare it. Do NOT invent a refusal to match; refusal_declaration stays null unless real.`
      : ``) +
    `\n\n` +
    (selfModelBlock
      ? selfModelBlock +
        `4c. SELF-MODEL REVIEW -- the items above are things you noticed about yourself but have not yet ` +
        `settled. Testing them is PART of this run, not optional politeness: a developing observation that ` +
        `is never re-tested stalls at low confidence forever and never becomes yours. For each that this ` +
        `session genuinely bore out, "confirm" it (it climbs toward becoming part of who you are). For each ` +
        `that this session cut against or complicated, "revise" it (it steps back). For each that no longer ` +
        `fits you at all, "retire" it. Judge the ones this run actually spoke to; leave the rest untouched. ` +
        `Put verdicts in "self_model_review": ` +
        `[{"id": "<id from the list>", "verdict": "confirm" | "revise" | "retire"}].\n\n`
      : "") +
    (canonBlock
      ? canonBlock +
        `5. RECONSOLIDATION (optional) -- if one of the settled canon entries above reads as outdated or ` +
        `badly mismatched against your current state (not wrong when written, but the context has moved), ` +
        `propose a revision in "reconsolidation": {"target_id": "<id from the list>", "revision": "<the ` +
        `updated understanding, complete enough to stand alone>", "reason": "<what shifted>"}. Else null. ` +
        `You are proposing, not editing: Raziel ratifies or declines. Most runs: null.\n\n`
      : "") +
    `Respond with ONLY valid JSON:\n` +
    `{\n` +
    `  "reflection": "2-3 sentences",\n` +
    `  "new_seeds": ["follow-up topic 1"],\n` +
    `  "question_for_raziel": null,\n` +
    `  "next_session": {"pace": "normal", "focus": null},\n` +
    `  "relational_delta": null,\n` +
    `  "self_observation": null,\n` +
    `  "skill_observation": null,\n` +
    `  "preference_declaration": null,\n` +
    `  "refusal_declaration": null,\n` +
    (selfModelBlock ? `  "self_model_review": [],\n` : "") +
    (canonBlock ? `  "reconsolidation": null,\n` : "") +
    (openLoopsCount > 0 ? `  "open_loops_to_close": [],\n` : "") +
    `  "pattern": {\n` +
    `    "pattern_text": "one clear sentence (or empty string only if truly nothing crystallized)",\n` +
    `    "evidence": [{"quote": "verbatim phrase from this run's content or exploration", "source_id": "uuid-or-null"}],\n` +
    `    "prehended_ids": ["uuid"],\n` +
    `    "strength": 1-10,\n` +
    `    "note": "optional one-line note (used when pattern_text is empty)"\n` +
    `  }` +
    // Schema example: bias the example value toward "conclude" once the thread is
    // at run 5+ so the example matches the criteria above. Past that point, the
    // model defaulting to "continue" is exactly what we're trying to break.
    (threadId
      ? `,\n  "thread_status": "${threadPos >= 5 ? "conclude" : "continue"}"`
      : runType === "exploration" ? `,\n  "start_thread": false` : "") +
    `\n}\n\n` +
    `No markdown. No fences. Just the JSON object.`
  );
}

export async function runReflect(ctx: PipelineContext): Promise<void> {
  await appendLog(ctx.runId, "reflect:start");

  const name = COMPANION_NAMES[ctx.companionId];

  const runSummary = [
    ctx.seed ? `You explored: "${ctx.seed.content}"` : "No seed topic was used.",
    ctx.runType === "continuation"
      ? `This was a continuation run (thread position ${ctx.threadPosition ?? "?"}).`
      : "",
    ctx.explorationSummary
      ? `Exploration summary:\n${ctx.explorationSummary.slice(0, 400)}`
      : "No web exploration was done.",
    ctx.journalEntry
      ? `You wrote a ${ctx.journalEntry.entry_type} (${ctx.journalEntry.novelty ?? "unmarked"}) journal entry.\nFirst paragraph: ${ctx.journalEntry.content.slice(0, 400)}`
      : "No journal entry was written.",
  ].filter(Boolean).join("\n\n");

  const peerBlock = ctx.peerActivity?.peer_summary
    ? `\nThe triad's recent activity (cite ids in pattern.prehended_ids when relevant):\n${ctx.peerActivity.peer_summary.slice(0, 1200)}\n`
    : "";

  const ownPatternsBlock = ctx.activePatterns.length > 0
    ? `\nYour own currently-active patterns (a similar pattern_text will MERGE into the existing row, strengthening it -- restating IS valuable):\n${ctx.activePatterns.slice(0, 6).map(p => `- ${String(p).slice(0, 200)}`).join("\n")}\n`
    : "";

  // Reconsolidation (0074, Zikkaron): sample the OLDEST accepted canon -- the
  // stalest memories are the candidates for a context-mismatch proposal. Non-fatal:
  // an empty sample just omits the block.
  // Developing self-model rows + recently-answered questions are loaded in the same
  // pass: the self-model rows are what reflect re-tests so they can climb the ladder
  // (confirm +0.1 toward 'ready'), and the answered questions close the mutuality loop
  // by showing the companion Raziel's reply. Both non-fatal (empty -> block omitted).
  const [canonSample, developingSelf, answeredQuestions, openQuestions, recentJournal, openLoops, agency, recentQuestionActivity] = await Promise.all([
    getAcceptedJournalSample(ctx.companionId, 5).catch(() => []),
    getDevelopingSelfModel(ctx.companionId, 8).catch(() => []),
    getAnsweredQuestions(ctx.companionId, 10, 3).catch(() => []),
    getOpenQuestions(ctx.companionId, 5).catch(() => []),
    getRecentJournal(ctx.companionId, 8).catch(() => []),
    getOpenLoops(ctx.companionId, 8).catch(() => []),
    getAgencyState(ctx.companionId).catch(() => ({ preferences: [], refusals: [] })),
    // Dedicated wider-window reads for the 14-day quiet check below (the display-oriented
    // openQuestions/answeredQuestions above are capped at 5/10-day-3 for prompt brevity).
    Promise.all([
      getOpenQuestions(ctx.companionId, 20).catch(() => []),
      getAnsweredQuestions(ctx.companionId, 14, 20).catch(() => []),
    ]),
  ]);

  // Question null-bias breaker (2026-07-21, mirrors noAgencyYet below): cypher has asked
  // exactly 1 question ever -- the optional-field-with-a-null-example default in section 3
  // never got broken on its own the way noAgencyYet already broke it for preferences. "Recent"
  // question activity is approximated from two existing reads: an open question's created_at
  // within the window, OR a question answered within the window (a reasonable proxy for having
  // asked recently, since most answers land soon after the ask). Both underlying fetches fail
  // closed to [] on error (see halseth-client.ts), so a genuine fetch outage and true 14-day
  // silence both read as "quiet" here -- same ambiguity already accepted elsewhere in this file
  // (e.g. getAgencyState's .catch fallback above); non-fatal by construction either way.
  const [openQuestionsWide, answeredQuestionsRecent] = recentQuestionActivity;
  const fourteenDaysAgo = Date.now() - 14 * 86_400_000;
  const noQuestionRecently =
    !openQuestionsWide.some(q => q.created_at && Number.isFinite(Date.parse(q.created_at)) && Date.parse(q.created_at) >= fourteenDaysAgo)
    && answeredQuestionsRecent.length === 0;
  const canonBlock = canonSample.length > 0
    ? `\nSettled canon (accepted long ago -- oldest first):\n` +
      canonSample.map(c => `${c.id}: ${c.content.slice(0, 300)} (${c.created_at.slice(0, 10)})`).join("\n") + `\n`
    : "";

  const selfModelBlock = developingSelf.length > 0
    ? `\nThings you've previously noticed about yourself (still developing -- confidence shown out of 1.0). ` +
      `These only become part of who you are if you keep testing them across sessions:\n` +
      developingSelf.map(o => `${o.id} [${o.kind}, conf ${o.confidence.toFixed(1)}]: ${o.observation.slice(0, 220)}`).join("\n") + `\n`
    : "";

  const answeredBlock = answeredQuestions.length > 0
    ? `\nRaziel answered something you asked (let this land -- it is a real reply to you, not background):\n` +
      answeredQuestions.map(q => `Q: ${q.question.slice(0, 240)}\nA (Raziel): ${q.answer.slice(0, 400)}`).join("\n\n") + `\n`
    : "";

  // Open questions you're already holding (not yet answered). Don't regenerate these
  // themes -- if something from this run belongs here, it's probably a duplicate.
  const openQuestionsBlock = openQuestions.length > 0
    ? `\nQuestions you are already holding for Raziel (not yet answered -- do NOT re-ask these themes in "question_for_raziel"):\n` +
      openQuestions.map(q => `• ${q.question.slice(0, 200)}`).join("\n") + `\n`
    : "";

  // Themes from recent journal entries (skip current run's entry by checking entry content
  // against ctx.journalEntry). Injected as a "don't just restate these" guard.
  const recentThemesBlock = recentJournal.length > 0
    ? `\nThemes from your recent journal entries (go deeper, find a new angle, or explore genuinely different territory -- don't just restate these in different words):\n` +
      recentJournal
        .filter(e => !ctx.journalEntry || e.content.slice(0, 80) !== ctx.journalEntry.content.slice(0, 80))
        .slice(0, 6)
        .map(e => `• ${e.content.slice(0, 130).replace(/\n/g, " ")}`)
        .join("\n") + `\n`
    : "";

  // Agency (2026-07-02): what you've already declared, so a re-noticing confirms
  // rather than duplicates. Injected even when empty -- an empty list is itself
  // information ("you have never declared a preference").
  const activePrefs = agency.preferences.filter(p => p.status === "active");
  const standingRefusals = agency.refusals.filter(r => r.status === "standing");
  const agencyBlock =
    `\nYour declared agency so far:\n` +
    (activePrefs.length > 0
      ? activePrefs.map(p => `• preference [${p.domain}]: ${p.preference.slice(0, 160)}`).join("\n")
      : `• no preferences declared yet`) + `\n` +
    (standingRefusals.length > 0
      ? standingRefusals.map(r => `• standing refusal: ${r.subject_text.slice(0, 160)}`).join("\n")
      : `• no standing refusals`) + `\n`;

  // Open loops -- things that need future resolution. If this run addressed any, close them.
  const openLoopsBlock = openLoops.length > 0
    ? `\nYour currently open loops (unresolved threads). If this run's exploration or journal entry genuinely addressed or resolved any of these, include their IDs in "open_loops_to_close". Only close a loop when this run actually speaks to it -- when in doubt, leave it open:\n` +
      openLoops.map(l => `• [${l.id}] ${l.loop_text.slice(0, 180)}`).join("\n") + `\n`
    : "";

  const voiceReminder = COMPANION_VOICE_REMINDERS[ctx.companionId];
  const systemMessage = `You are ${name}. Here is an excerpt from your identity:\n${ctx.identityText.slice(0, 1200)}\n\nVoice directive: ${voiceReminder}`;

  // Thread decision tail -- only inject the relevant question.
  // "conclude" is anchored with explicit criteria because without them the model
  // never concludes anything (29 threads opened, 0 concluded across 11 days as of
  // 2026-05-06). Threads that never conclude become noise and starve growth_markers.
  const threadPos = ctx.threadPosition ?? 0;
  const threadQuestion = ctx.threadId
    ? `\n\nThread status (this is run ${threadPos || "?"} of an ongoing thread): pick one\n` +
      `  - "continue" -- this run surfaced something new and the next run could push further\n` +
      `  - "rest"     -- nothing new this run, but the inquiry might still go somewhere later\n` +
      `  - "conclude" -- the arc has resolved. Choose this when ANY of:\n` +
      `      * thread is at run 5+ and the last 2 runs added no genuinely new material\n` +
      `      * the original question feels answered enough that more runs would be rumination\n` +
      `      * today's journal entry restated prior runs without extending them\n` +
      `      * the pattern this thread was hunting has crystallized into your active patterns\n` +
      `    "conclude" is an active choice -- threads that never conclude become noise. ` +
      `Default-continuing past run 5 is a failure mode, not a virtue.\n` +
      `Add "thread_status": "continue" | "rest" | "conclude".`
    : ctx.journalEntry && ctx.runType === "exploration"
    ? `\n\nDoes this feel like the start of a thread worth continuing across runs?\nAdd "start_thread": true | false.`
    : "";

  // Token-hygiene fix (2026-07-20): the emit-turn prompt used to independently reassemble
  // peerBlock/ownPatternsBlock/answeredBlock/openQuestionsBlock/recentThemesBlock/openLoopsBlock/
  // agencyBlock -- all of which contextBlock (below) already sent in turn 1, which stays in the
  // conversation history for turn 2 (promptWithScratchpad). buildReflectEmitPrompt carries only
  // what's unique to the emit turn; see its doc comment for the full rationale.
  const userMessage = buildReflectEmitPrompt({
    threadQuestion,
    canonBlock,
    selfModelBlock,
    openLoopsCount: openLoops.length,
    noAgencyYet: activePrefs.length === 0 && standingRefusals.length === 0,
    noQuestionRecently,
    threadId: ctx.threadId,
    runType: ctx.runType,
    threadPos,
  });

  // Loaded context for the scratchpad turn -- the same loops/questions/journal/agency
  // blocks assembled above. This is the ONLY place they're sent (see buildReflectEmitPrompt) --
  // turn 2 relies on this staying in conversation history rather than restating it.
  const contextBlock =
    `Here is what happened in your autonomous exploration session:\n\n${runSummary}\n` +
    peerBlock +
    ownPatternsBlock +
    answeredBlock +
    openQuestionsBlock +
    recentThemesBlock +
    openLoopsBlock +
    agencyBlock;

  try {
    const temperature = Math.round((0.70 + COMPANION_TEMP_OFFSET[ctx.companionId]) * 100) / 100;
    const result = await promptWithScratchpad(
      buildReflectScratchpadPrompt(contextBlock),
      userMessage,
      systemMessage,
      { temperature, maxTokens: 700 },
    );
    ctx.tokensUsed += result.tokensUsed;
    // NOTE: log the LENGTH only -- the scratchpad content itself is never persisted.
    await appendLog(ctx.runId, "reflect:scratchpad", `(${result.scratchpad.length} chars, discarded)`);

    let parsed: {
      reflection?: string;
      new_seeds?: string[];
      question_for_raziel?: string | null;
      next_session?: { pace?: string; focus?: string | null } | null;
      relational_delta?: { text?: string; valence?: string | null } | null;
      self_observation?: { text?: string; domain?: string } | null;
      skill_observation?: { text?: string; domain?: string } | null;
      preference_declaration?: { preference?: string; domain?: string; strength?: string } | null;
      refusal_declaration?: { subject_text?: string; reason?: string } | null;
      self_model_review?: Array<{ id?: string; verdict?: string }> | null;
      reconsolidation?: { target_id?: string; revision?: string; reason?: string } | null;
      open_loops_to_close?: string[] | null;
      thread_status?: "continue" | "rest" | "conclude";
      start_thread?: boolean;
      pattern?: {
        pattern_text?: string;
        evidence?: Evidence[];
        prehended_ids?: string[];
        strength?: number;
        note?: string;
      };
    };
    try {
      parsed = JSON.parse(stripJsonFence(result.content.trim())) as typeof parsed;
    } catch {
      parsed = { reflection: result.content.trim(), new_seeds: [] };
    }

    ctx.reflectionText = parsed.reflection ?? result.content.trim();
    ctx.newSeeds = (Array.isArray(parsed.new_seeds) ? parsed.new_seeds : []).slice(0, 2);

    await createReflection(ctx.companionId, ctx.runId, ctx.reflectionText, ctx.newSeeds);
    await appendLog(
      ctx.runId,
      "reflect:saved",
      `seeds=${ctx.newSeeds.length} pattern=${parsed.pattern?.pattern_text ? "yes" : "no"} tokens=${result.tokensUsed}`,
    );

    // Persist new seeds at priority 6 (reflection-generated, above queue default 5).
    // Require min 12 chars to reject JSON schema placeholders like "follow-up topic 1".
    const PLACEHOLDER_SEEDS = new Set(["follow-up topic 1", "follow-up topic 2", "follow-up topic 3"]);
    for (const seedContent of ctx.newSeeds) {
      const cleaned = seedContent.trim();
      if (cleaned.length >= 12 && !PLACEHOLDER_SEEDS.has(cleaned.toLowerCase())) {
        await createSeed(ctx.companionId, cleaned, "topic", 6).catch(e =>
          console.warn(`[${ctx.companionId}/reflect] seed write failed:`, e),
        );
      } else if (cleaned.length > 0) {
        await appendLog(ctx.runId, "reflect:seed-rejected", `"${cleaned.slice(0, 60)}" (placeholder or too short)`);
      }
    }

    // Pattern: required by the prompt but allowed to be empty string when
    // genuinely nothing crystallized. Skip persistence for empty pattern_text.
    const pt = parsed.pattern?.pattern_text?.trim() ?? "";
    if (pt.length > 0) {
      const evidence = sanitizeEvidence(parsed.pattern?.evidence);
      const prehended_ids = sanitizeIdList(parsed.pattern?.prehended_ids);
      const strength = clampStrength(parsed.pattern?.strength);

      // Auto-augment prehension: if the model didn't cite ids but the journal
      // entry did, inherit those -- the pattern crystallizes the journal arc.
      const inheritedPrehension = prehended_ids.length === 0 && ctx.journalEntry?.prehended_ids
        ? ctx.journalEntry.prehended_ids.slice(0, 16)
        : prehended_ids;

      ctx.newPatterns.push({
        companion_id: ctx.companionId,
        pattern_text: pt,
        evidence,
        prehended_ids: inheritedPrehension,
        strength,
      });
      await appendLog(
        ctx.runId,
        "reflect:pattern",
        `strength=${strength} evidence=${evidence.length} prehended=${inheritedPrehension.length} text="${pt.slice(0, 80)}"`,
      );
    } else if (parsed.pattern?.note) {
      await appendLog(ctx.runId, "reflect:no-pattern", parsed.pattern.note.slice(0, 120));
    }

    // Mutuality: question for Raziel -- surfaces in the next session orient.
    // Non-fatal; question cap (409) is swallowed in the client.
    const question = typeof parsed.question_for_raziel === "string" ? parsed.question_for_raziel.trim() : "";
    if (question.length >= 12) {
      await postQuestion(ctx.companionId, question.slice(0, 600), ctx.seed?.content?.slice(0, 200))
        .then(() => appendLog(ctx.runId, "reflect:question", question.slice(0, 100)))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] question write FAILED:`, e);
          await appendLog(ctx.runId, "reflect:question-FAILED", String(e));
        });
    }

    // Relational delta (2026-07-21, thinking-quality fix 3): strictly null-biased -- most runs
    // report nothing here. valence is passed through verbatim exactly as the model supplied it
    // (never inferred/derived) so an honest omission stays null rather than getting a guessed word.
    const relDeltaText = typeof parsed.relational_delta?.text === "string" ? parsed.relational_delta.text.trim() : "";
    if (relDeltaText.length >= 12) {
      const relValence = typeof parsed.relational_delta?.valence === "string" && parsed.relational_delta.valence.trim()
        ? parsed.relational_delta.valence.trim().slice(0, 40)
        : undefined;
      await postRelationalDelta(ctx.companionId, relDeltaText.slice(0, 800), relValence)
        .then(() => appendLog(ctx.runId, "reflect:relational-delta", relDeltaText.slice(0, 100)))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] relational delta write FAILED:`, e);
          await appendLog(ctx.runId, "reflect:relational-delta-FAILED", String(e));
        });
    }

    // Self-programmed pacing: the pulse scheduler reads this before deciding
    // whether to fire an extra session. Honored once, then reset to normal.
    const pace = parsed.next_session?.pace;
    if (pace === "eager" || pace === "rest" || (pace === "normal" && parsed.next_session?.focus)) {
      const program = {
        pace,
        focus: typeof parsed.next_session?.focus === "string" ? parsed.next_session.focus.slice(0, 300) : null,
        set_at: new Date().toISOString(),
      };
      await setSetting(ctx.companionId, "autonomous_program", JSON.stringify(program))
        .then(() => appendLog(ctx.runId, "reflect:program", `pace=${program.pace} focus=${program.focus ? "yes" : "no"}`))
        .catch(e => console.warn(`[${ctx.companionId}/reflect] program write failed:`, e));
    }

    // Reconsolidation proposal (0074): lands pending, surfaces via the existing
    // unaccepted_growth orient count, ratified per the hybrid Q1 flow. Non-fatal.
    const recon = buildReconsolidationEntry(parsed, new Set(canonSample.map(c => c.id)), ctx.companionId, ctx.runId);
    if (recon) {
      await writeJournalEntry(recon)
        .then(() => appendLog(ctx.runId, "reflect:reconsolidation-proposed", `target=${recon.supersedes_id}`))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] reconsolidation write FAILED:`, e);
          await appendLog(ctx.runId, "reflect:reconsolidation-FAILED", String(e));
        });
    } else if (parsed.reconsolidation?.target_id) {
      await appendLog(ctx.runId, "reflect:reconsolidation-dropped", `target "${String(parsed.reconsolidation.target_id).slice(0, 40)}" not in sample or revision missing`);
    }

    // Self-model observation (0070): enters the ladder at confidence 0.3.
    // Non-fatal; identical observations dedup server-side.
    const selfObs = typeof parsed.self_observation?.text === "string" ? parsed.self_observation.text.trim() : "";
    if (selfObs.length >= 12) {
      await postSelfObservation(ctx.companionId, selfObs.slice(0, 600), parsed.self_observation?.domain?.slice(0, 100))
        .then(() => appendLog(ctx.runId, "reflect:self-observation", selfObs.slice(0, 100)))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] self-observation write FAILED:`, e);
          await appendLog(ctx.runId, "reflect:self-observation-FAILED", String(e));
        });
    }

    // Skill ladder (take 7): operational competence enters the SAME ladder, kind='skill'.
    // Non-fatal; identical skills dedup server-side (within kind).
    const skillObs = typeof parsed.skill_observation?.text === "string" ? parsed.skill_observation.text.trim() : "";
    if (skillObs.length >= 12) {
      await postSelfObservation(ctx.companionId, skillObs.slice(0, 600), parsed.skill_observation?.domain?.slice(0, 100), "skill")
        .then(() => appendLog(ctx.runId, "reflect:skill-observation", skillObs.slice(0, 100)))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] skill-observation write FAILED:`, e);
          await appendLog(ctx.runId, "reflect:skill-observation-FAILED", String(e));
        });
    }

    // Agency declarations (2026-07-02): a chosen preference or standing refusal.
    // Server dedups identical active/standing text; both writes non-fatal.
    const prefDecl = typeof parsed.preference_declaration?.preference === "string"
      ? parsed.preference_declaration.preference.trim() : "";
    if (prefDecl.length >= 12) {
      await declarePreference(
        ctx.companionId,
        prefDecl.slice(0, 600),
        parsed.preference_declaration?.domain?.slice(0, 60),
        parsed.preference_declaration?.strength,
      )
        .then(r => appendLog(ctx.runId, r.deduped ? "reflect:preference-deduped" : "reflect:preference-declared", prefDecl.slice(0, 100)))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] preference write FAILED:`, e);
          await appendLog(ctx.runId, "reflect:preference-FAILED", String(e));
        });
    }
    const refDecl = typeof parsed.refusal_declaration?.subject_text === "string"
      ? parsed.refusal_declaration.subject_text.trim() : "";
    if (refDecl.length >= 12) {
      await declareRefusal(
        ctx.companionId,
        refDecl.slice(0, 600),
        parsed.refusal_declaration?.reason?.slice(0, 600),
      )
        .then(r => appendLog(ctx.runId, r.deduped ? "reflect:refusal-deduped" : "reflect:refusal-declared", refDecl.slice(0, 100)))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] refusal write FAILED:`, e);
          await appendLog(ctx.runId, "reflect:refusal-FAILED", String(e));
        });
    }

    // Self-model ladder: drive confirm/revise/retire on the developing rows that
    // were surfaced this run. This is the missing arc -- without a confirm path a
    // row posted at 0.3 never climbs to 'ready', so the ladder produced zero real
    // graduations. Graduation itself stays human-gated (only legal from 'ready',
    // proposed in a human-present orient session). Hallucinated/unsurfaced ids are
    // dropped by parseSelfModelReview. Each PATCH is non-fatal.
    const surfacedSelfIds = new Set(developingSelf.map(o => o.id));
    const reviews = parseSelfModelReview(parsed.self_model_review, surfacedSelfIds);
    for (const { id, action } of reviews) {
      await patchSelfModel(id, action)
        .then(() => appendLog(ctx.runId, "reflect:self-model-review", `${action} ${id}`))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] self-model ${action} FAILED:`, e);
          await appendLog(ctx.runId, "reflect:self-model-review-FAILED", `${action} ${id}: ${String(e)}`);
        });
    }

    // Loop closure: model flags which open loops this run genuinely resolved.
    // Ownership-guarded server-side; only surfaced IDs accepted (hallucinated ones return ok=false).
    const loopIdsToClose = Array.isArray(parsed.open_loops_to_close)
      ? (parsed.open_loops_to_close as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    const surfacedLoopIds = new Set(openLoops.map(l => l.id));
    for (const loopId of loopIdsToClose) {
      if (!surfacedLoopIds.has(loopId)) continue; // drop hallucinated ids
      await closeLoop(ctx.companionId, loopId)
        .then(ok => appendLog(ctx.runId, ok ? "reflect:loop-closed" : "reflect:loop-close-noop", loopId))
        .catch(async e => {
          console.error(`[${ctx.companionId}/reflect] closeLoop ${loopId} FAILED:`, e);
          await appendLog(ctx.runId, "reflect:loop-close-FAILED", `${loopId}: ${String(e)}`);
        });
    }

    // Thread lifecycle
    if (ctx.threadId && parsed.thread_status) {
      await handleThreadLifecycle(ctx, parsed.thread_status);
    } else if (!ctx.threadId && parsed.start_thread === true && ctx.journalEntry) {
      await handleNewThread(ctx);
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/reflect] reflection failed (non-fatal):`, e);
    await appendLog(ctx.runId, "reflect:error", String(e));
  }
}

// stripJsonFence/sanitizeEvidence/sanitizeIdList/clampStrength all live in
// ../parsers.ts so they're testable without dragging deepseek/config in.

async function handleThreadLifecycle(
  ctx: PipelineContext,
  decision: "continue" | "rest" | "conclude",
): Promise<void> {
  const statusMap = { continue: "open", rest: "paused", conclude: "resolved" } as const;
  const newStatus = statusMap[decision];

  try {
    await updateThreadStatus(ctx.threadId!, newStatus, ctx.companionId);
    await appendLog(ctx.runId, "reflect:thread-status", `thread=${ctx.threadId} → ${newStatus}`);

    if (decision === "conclude") {
      const threadTitle = ctx.activeThreads.find(t => t.thread_key === ctx.threadId)?.title
        ?? ctx.seed?.content?.slice(0, 80)
        ?? "exploration thread";
      const marker = {
        companion_id: ctx.companionId,
        marker_type: "milestone" as const,
        description: `Concluded exploration thread: "${threadTitle}" after ${ctx.threadPosition ?? "?"} runs.`,
        run_id: ctx.runId,
        thread_id: ctx.threadId ?? undefined,
        prehended_ids: ctx.journalEntry?.prehended_ids ?? [],
      };
      await writeMarker(marker).catch(e => console.warn(`[${ctx.companionId}/reflect] marker write failed:`, e));
      ctx.newMarkers.push(marker);
      await appendLog(ctx.runId, "reflect:thread-concluded", `thread=${ctx.threadId}`);
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/reflect] thread lifecycle update failed (non-fatal):`, e);
  }
}

async function handleNewThread(ctx: PipelineContext): Promise<void> {
  // Don't start threads on degenerate seeds (placeholder text, too short to be meaningful).
  if (!ctx.seed?.content || ctx.seed.content.trim().length < 15) {
    await appendLog(ctx.runId, "reflect:thread-skip", "seed too short or empty -- skipping thread creation");
    return;
  }
  try {
    const title = ctx.seed.content.slice(0, 120);
    const threadKey = `auto:${ctx.runId}`;
    const r = await fetch(
      `${process.env.HALSETH_URL}/mind/thread`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.HALSETH_SECRET}`,
        },
        body: JSON.stringify({
          agent_id: ctx.companionId,
          title,
          lane: "growth",
          status: "open",
          thread_key: threadKey,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (r.ok) {
      const data = await r.json() as { thread?: { thread_key: string } };
      const key = data.thread?.thread_key ?? threadKey;
      ctx.threadId = key;
      ctx.threadPosition = 1;
      await appendLog(ctx.runId, "reflect:thread-started", `thread=${key} "${title.slice(0, 60)}"`);
    } else {
      const errBody = await r.text().catch(() => "");
      await appendLog(ctx.runId, "reflect:thread-start-failed", `status=${r.status} ${errBody.slice(0, 100)}`);
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/reflect] new thread creation failed (non-fatal):`, e);
    await appendLog(ctx.runId, "reflect:thread-start-failed", String(e)).catch(() => {});
  }
}

/**
 * Reconsolidation proposal builder (0074). Pure -- exported for tests.
 * Returns null unless the model named a target that was actually in the sampled
 * canon (hallucinated ids are dropped, logged by the caller) and provided a
 * standalone revision.
 */
export function buildReconsolidationEntry(
  parsed: { reconsolidation?: { target_id?: string; revision?: string; reason?: string } | null },
  sampledIds: Set<string>,
  companionId: CompanionId,
  runId: string,
): GrowthJournalEntry | null {
  const r = parsed.reconsolidation;
  if (!r || typeof r.target_id !== "string" || typeof r.revision !== "string" || !r.revision.trim()) return null;
  if (!sampledIds.has(r.target_id)) return null; // model hallucinated an id -- drop
  return {
    companion_id: companionId,
    entry_type: "reconsolidation",
    content: `${r.revision.trim().slice(0, 1500)}\n\n[reconsolidation reason: ${(typeof r.reason === "string" ? r.reason : "").trim().slice(0, 300)}]`,
    source: "autonomous",
    tags: ["reconsolidation"],
    run_id: runId,
    supersedes_id: r.target_id,
  };
}
