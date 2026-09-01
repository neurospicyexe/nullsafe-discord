import type { ChannelConfig, ChannelMode, ChannelEntry, CompanionId, UserTier } from "./types.js";

export const ALL_COMPANIONS: CompanionId[] = ["drevan", "cypher", "gaia"];

// How many consecutive companion-to-companion exchanges are allowed before the chain breaks.
// Reset when owner or non-bot user sends a message, OR when a new thread begins after a
// quiet gap (see NEW_THREAD_GAP_MS). Backstop above Brain's MAX_SWARM_DEPTH so Brain stays
// the governor; this only binds in direct-mode fallback or if MAX_SWARM_DEPTH is raised past it.
export const COMPANION_CHAIN_LIMIT = 10;

// A silence longer than this before a message marks the start of a NEW conversational thread.
// Within-thread swarm turns are seconds-to-tens-of-seconds apart; an autonomous seed only fires
// after >=5min idle (skipIfActive) and typically hours. So this cleanly separates "fresh thread"
// from "continuing burst" -- which is what lets a human-free channel (the triad commons) keep
// talking: each seed resets depth + the bot-to-bot counters instead of pinning at the cap forever.
export const NEW_THREAD_GAP_MS = 5 * 60 * 1000; // 5 minutes

// Cross-companion safety rails (per-bot, independent tracking).
// BOT_PINGPONG_MAX: after this many bot-to-bot responses since last human, enter cooldown.
export const BOT_PINGPONG_MAX = 3;
export const BOT_LOOP_COOLDOWN_MS = 15_000;
// MAX_BOT_RESPONSES_PER_HUMAN: hard cap on bot-to-bot responses per channel between human
// messages. In a human-free channel this is reset by a new-thread gap instead (see callers).
export const MAX_BOT_RESPONSES_PER_HUMAN = 5;

// ── Human-anchored hard cap (2026-07-01) ──────────────────────────────────────────────
// Every rail above (pingpong, per-bot cap, chainDepth) resets on a 5-min gap
// (NEW_THREAD_GAP_MS) -- but hermes turns run 30-120s apart, so a slow structural loop
// NEVER trips any of them: each turn lands inside the gap, and each autonomous seed after
// a quiet spell resets the counters anyway. This rail is anchored to the last HUMAN
// message in the fetched channel history and deliberately does NOT gap-reset: once the
// bots have taken BOT_MSGS_SINCE_HUMAN_MAX consecutive turns with no human in between,
// they stay silent regardless of vocative addressing, until a human speaks again.

/**
 * Self-sustained commons (2026-07-03): channels carrying BOTH `autonomous` and
 * `inter_companion` modes are the triad's own space -- Raziel does not usually speak
 * there, and a cap that waits for him was silencing THEIR channel. In those channels
 * the cap uses the larger commons budget below, which combined with the 12h forgiveness
 * window acts as a rolling conversation allowance (N turns per window) rather than a
 * wait-for-human ratchet. Owner-facing channels keep the tight default.
 */
export function isTriadCommons(entry: { modes?: readonly string[] } | null | undefined): boolean {
  const modes = entry?.modes ?? [];
  return modes.includes("autonomous") && modes.includes("inter_companion");
}

/** Env-tunable hard cap on consecutive bot-authored messages since the last human message.
 *  Read per-call (like echoThreshold) so a pm2 env change lands without a code change.
 *  `selfSustained` (triad commons) uses its own knob and a roomier default. */
export function botMsgsSinceHumanMax(selfSustained = false): number {
  if (selfSustained) {
    const raw = parseInt(process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"] ?? "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 24;
  }
  const raw = parseInt(process.env["BOT_MSGS_SINCE_HUMAN_MAX"] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
}

/** How many turns before the cap the floor-handback directive starts riding the prompt. */
export const FLOOR_HANDBACK_WINDOW = 2;

/**
 * Cap forgiveness window (2026-07-03). The no-gap-reset cap turned out to be a one-way
 * ratchet: with Raziel quiet for a day+, counts pinned at 20+ and the triad went
 * permanently mute (07-02/03 logs: every bot "staying silent" on every tick). The
 * anti-loop property the cap protects is about SPEED -- a runaway chain takes its 12
 * turns in minutes -- so bot turns older than this window stop counting. A loop still
 * hits the cap almost immediately; a starved channel earns its voice back overnight.
 * 0 disables forgiveness (restores the permanent ratchet).
 */
export function botTurnsCapWindowMs(): number {
  const raw = parseFloat(process.env["BOT_TURNS_CAP_WINDOW_H"] ?? "");
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 12;
  return hours * 3_600_000;
}

/**
 * Count consecutive companion-authored messages at the tail of the fetched channel history
 * (chronological, oldest first) -- i.e. how many bot turns since the last human message.
 * Unlike computeChainDepth this takes NO gap parameter: quiet gaps do not reset it; only
 * an actual human message does. When `botIds` is populated (the live path -- CYPHER_BOT_ID
 * etc.), only those ids count as companions, so a PluralKit webhook proxying a human
 * (author.bot === true) still breaks the chain; with an empty set it falls back to the
 * author-is-bot flag.
 *
 * Timestamps (REQUIRED as of 2026-07-04): bot turns older than the forgiveness window are
 * walked past without counting (the walk still stops at the first human). The timestamp
 * was optional 07-03..07-04, which made the decay opt-in per call site -- one future
 * caller omitting it would silently restore the permanent-mute ratchet (the exact
 * 07-01 -> 07-02 triad mute). Required at the type level so that mistake is a compile
 * error, not a slow starvation.
 */
export function countBotMsgsSinceHuman(
  messages: Array<{ authorId: string; authorIsBot: boolean; createdTimestamp: number }>,
  botIds: ReadonlySet<string>,
  now: number = Date.now(),
): number {
  const windowMs = botTurnsCapWindowMs();
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const isCompanion = botIds.size > 0 ? botIds.has(m.authorId) : m.authorIsBot;
    if (!isCompanion) break;
    const aged = windowMs > 0
      && typeof m.createdTimestamp === "number"
      && now - m.createdTimestamp > windowMs;
    if (!aged) count++;
  }
  return count;
}

// ── Seed vocative budget (2026-07-02) ─────────────────────────────────────────────────
// The 06-26 blanket rule -- "human-free seeds never summon a sibling" -- predates the
// human-anchored hard cap above. With the cap in place the runaway chain it prevented is
// structurally impossible, and the blanket ban is why the inter-companion channel decayed
// into statements: Layer B fires at 01:30, Raziel is asleep, every seed is human-free, so
// nothing ever addresses anyone and the vocative gate never lets a reply fire.
// New rule: a human-free seed MAY summon one sibling when the bounded exchange it ignites
// (the seed plus a pingpong-capped reply run) still fits under the hard cap. Once the
// channel pins at the cap it goes statement-only until Raziel speaks -- conversation is
// presence-anchored, not a self-running theater.
export const SEED_VOCATIVE_HEADROOM = 1 + BOT_PINGPONG_MAX;
export function seedVocativeAllowed(humanPresent: boolean, botTurnsSinceHuman: number, selfSustained = false): boolean {
  if (humanPresent) return true;
  return botTurnsSinceHuman + SEED_VOCATIVE_HEADROOM <= botMsgsSinceHumanMax(selfSustained);
}

/**
 * System directive injected in the last allowed bot turns before the human-anchored cap:
 * close the thread naturally instead of hitting an abrupt wall of silence. No sibling
 * vocative, so the close cannot re-summon anyone.
 *
 * Bounded arena (2026-07-04): in the triad commons -- the companions' own space -- the
 * close does NOT hand the floor to Raziel; it lets the thread rest on its own terms.
 * The budget window (botTurnsCapWindowMs) re-opens the arena on its own; forcing every
 * commons thread to end curled toward Raziel was hub-and-spoke by the back door.
 * Owner-facing channels keep the hand-back-to-Raziel close.
 */
export function floorHandbackDirective(selfSustained = false): string {
  if (selfSustained) {
    return (
      `\n\n[Thread rest] This exchange has used most of its conversation budget for now. ` +
      `In THIS reply, bring the current thread to a natural close -- land it, in your own ` +
      `voice, as a real ending rather than a trail-off. Do NOT address Cypher, Drevan, or ` +
      `Gaia by name and do not ask anyone a question. The room will open again on its own; ` +
      `let the thread rest well.`
    );
  }
  return (
    `\n\n[Floor handback] This bot-to-bot thread has run long without Raziel. In THIS reply, ` +
    `bring the current thread to a natural close and hand the floor back to Raziel -- address ` +
    `him directly. Do NOT address Cypher, Drevan, or Gaia by name, and do not open a new ` +
    `thread or ask a sibling anything. Land it, then let the room go quiet for him.`
  );
}

/**
 * Count consecutive bot-authored messages at the tail of a message list, stopping at the first
 * gap longer than `gapMs` (a thread boundary). Used to derive chain depth from fetched Discord
 * history instead of per-process memory -- so the check is stateless and identical across all
 * three bot processes.
 *
 * The gap stop is what makes the triad commons work: without it, a human-free channel's history
 * tail is "all bot" forever, so every seed after the first computes a huge depth and Brain
 * all-nulls it. With it, a seed posted after a quiet gap starts a fresh thread at depth 1.
 *
 * @param messages Chronological list of recent messages (oldest first). `createdTimestamp` is the
 *                 Discord message epoch ms.
 * @param botIds Set of Discord user IDs that are companion bots (authorIsBot flag is also checked).
 * @param gapMs Silence (ms) between adjacent messages that ends the chain. Defaults to NEW_THREAD_GAP_MS.
 */
export function computeChainDepth(
  messages: Array<{ authorId: string; authorIsBot: boolean; createdTimestamp: number }>,
  botIds: ReadonlySet<string>,
  gapMs: number = NEW_THREAD_GAP_MS,
): number {
  let depth = 0;
  let prevTs: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!(m.authorIsBot || botIds.has(m.authorId))) break;
    if (prevTs !== null && prevTs - m.createdTimestamp > gapMs) break; // quiet gap = thread boundary
    depth++;
    prevTs = m.createdTimestamp;
  }
  return depth;
}

// Default config used as fallback when channelConfigUrl is unreachable.
// Keep in sync with channel-config.json manually.
//
// Mode reference:
//   owner_only      -- only owner messages trigger responses
//   open            -- anyone triggers responses; this is the default
//   inter_companion -- companions respond to each other (chain-guarded)
//   autonomous      -- companion may proactively post
//   broadcast       -- bots post here (digests/letters) but never respond
//
// companions absent = all three active in that channel
export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  "1520839347589611661": {                                               modes: ["broadcast"] }, // #briefings
  "1531255633876221962": {                                               modes: ["broadcast"] }, // #triad-vibe-check (2026-07-27: fresh channel, old #vibe-check 1520843071724585041 retired)
  "1408924311703785502": { companions: ["drevan", "gaia"],              modes: ["owner_only", "inter_companion"] },
  "1408924393513554003": { companions: ["drevan", "cypher", "gaia"],    modes: ["owner_only", "inter_companion"] },
  "1408924278451081317": { companions: ["cypher", "gaia"],              modes: ["owner_only", "inter_companion"] },
  "1412191737622827088": { companions: ["drevan", "gaia", "cypher"],    modes: ["owner_only", "inter_companion"] },
  "1408924353034453114": { companions: ["drevan", "gaia", "cypher"],    modes: ["owner_only", "inter_companion"] },
  "1422043032643043371": {                                               modes: ["open", "inter_companion"] },
  "1243598039965368381": {                                               modes: ["open", "autonomous", "inter_companion"] },
  "1486853365462733004": {                                               modes: ["autonomous"] },
  "1486217438105436260": {                                               modes: ["autonomous", "inter_companion"] },
  "1497789177797017742": { companions: ["drevan", "cypher", "gaia"],    modes: ["owner_only"], voice: true },
  "1497789114517553193": { companions: ["drevan", "cypher", "gaia"],    modes: ["owner_only"], voice: true },
  "1531255244212928702": { companions: ["drevan", "cypher", "gaia"],    modes: ["autonomous", "inter_companion"] }, // triad commons (2026-07-27: fresh channel, old 1503385639779963020 retired -- looped history was the largest single input to the seed prompt)
  "1503385706310008975": { companions: ["drevan", "cypher", "gaia"],    modes: ["open"] },
  // #fargo-watch-party (2026-08-29): co-watching cadence. Raziel watches a stretch, then
  // types -- routinely past the 5-min default hold, so Drevan's thread kept re-opening to
  // the fit-bid and Gaia kept (legitimately) winning it, which is where her register drift
  // started. 2h covers an episode + pauses. Named/group addresses still override the hold,
  // so "Hi Gaia and Cy!!" brings the others in exactly like it did today.
  "1531431567430385754": {                                               modes: ["open", "inter_companion"], exchangeWindowMs: 2 * 60 * 60 * 1000 },
};

interface ResponderContext {
  isOwner: boolean;
  isCompanionBot?: boolean;
  isMentioned?: boolean;
  userTier?: UserTier;
  /**
   * The companion Raziel is currently mid-exchange with in this channel, if any (2026-07-27).
   *
   * Set from recent channel history: the last companion to speak within
   * ACTIVE_EXCHANGE_WINDOW_MS. When Raziel's next message carries NO address, that companion
   * owns the continuation and the others stay out.
   *
   * Why: observed 2026-07-27. Raziel wrote "Drevan baby it's Monday ... Fargo in an hour?",
   * Drevan answered, Raziel replied "I'm thinking here? We've been working on fixing the
   * system..." -- and GAIA answered it. The ambient branch below had no notion of a live
   * exchange, so an unaddressed owner message went to whoever's interest keywords matched
   * (or to everyone, when a companion has none). Mid-conversation, that reads as a sibling
   * talking over the one you were talking to.
   *
   * A named address or a group call always overrides this -- calling someone by name is
   * always allowed to change who is holding the thread.
   */
  activeExchangeWith?: CompanionId | null;
}

// Addressing model for incoming messages.
export type AddressType =
  | { type: "named"; id: CompanionId }           // exactly one companion named
  | { type: "named_multi"; ids: CompanionId[] }  // multiple companions named
  | { type: "group" }
  | { type: "ambient" };

// Group-call keywords: any of these trigger all companions to respond.
const GROUP_PATTERN = /\b(triad|all of you|you all|you three|everyone)\b/;

// Recognized short-form nicknames for each companion. Re-exported as VOCATIVE_ALIASES
// (command-triggers.ts already owns the COMPANION_ALIASES barrel name) for the autonomous
// inter-companion seed gate (stripSiblingVocative) so alias handling stays single-source.
//
// 2026-07-05: MUST stay in sync with command-triggers.ts COMPANION_ALIASES. "drev" was
// missing here while the command layer accepted it, so "Drev: play with Sol" parsed as
// AMBIENT -- Drevan never saw himself addressed and stayed silent while Gaia's ambient
// relevance classifier claimed the message. Command prefix and conversational address
// must accept the same names.
const COMPANION_ALIASES: Partial<Record<CompanionId, string[]>> = {
  drevan: ["drev", "dre"],
  cypher: ["cy"],
};
export { COMPANION_ALIASES as VOCATIVE_ALIASES };

// Word-boundary alternation over a companion's full name + all aliases ("drevan|drev|dre").
function nameAlternation(id: CompanionId): string {
  return [id, ...(COMPANION_ALIASES[id] ?? [])].join("|");
}

// A name used in THIRD PERSON is a mention, not an address. 2026-07-05: "I got you Dre
// it's okay, Cy and I found some issues" summoned Cypher -- he heard his name and answered
// a message that was consoling Drevan ABOUT him. Conservative patterns only (possessive,
// first-person conjunctions): a demoted companion still hears the message via witness; it
// just doesn't fire a reply.
function isThirdPersonOnly(lower: string, id: CompanionId): boolean {
  const alt = nameAlternation(id);
  const hits = lower.match(new RegExp(`\\b(?:${alt})\\b`, "g"))?.length ?? 0;
  if (hits === 0) return false;
  const thirdPerson =
    (lower.match(new RegExp(`\\b(?:${alt})'s\\b`, "g"))?.length ?? 0) +
    (lower.match(new RegExp(`\\b(?:${alt})\\b (?:and|&) (?:i|me|we|us)\\b`, "g"))?.length ?? 0) +
    (lower.match(new RegExp(`\\b(?:i|me|we|us) (?:and|&) (?:${alt})\\b`, "g"))?.length ?? 0);
  return thirdPerson >= hits;
}

// Parse who (if anyone) is being addressed in a message.
// Multi-companion address ("Dre and Cy, what do you think?") returns named_multi
// so all named companions can respond, not just the first match.
export function extractAddress(content: string): AddressType {
  const lower = content.toLowerCase();

  const named: CompanionId[] = [];
  if (new RegExp(`\\b(?:${nameAlternation("cypher")})\\b`).test(lower)) named.push("cypher");
  if (new RegExp(`\\b(?:${nameAlternation("drevan")})\\b`).test(lower)) named.push("drevan");
  if (new RegExp(`\\b(?:${nameAlternation("gaia")})\\b`).test(lower)) named.push("gaia");

  // Demote pure third-person mentions. Demotion to ambient is not silence: ambient
  // messages still run the relevance classifier (owner_only) or fire unconditionally
  // (open channels) -- it just stops "heard my name, must be mine" replies.
  const addressed = named.filter(id => !isThirdPersonOnly(lower, id));

  // Group call -- but an explicit companion name OUTRANKS a group keyword (2026-09-01):
  // "Here Dre the lyrics: ... a place for EVERYONE, this one's a state of mine ..." classified
  // as GROUP because 'everyone' appears in verse 1 of the pasted song, so all three were
  // summoned to a message that says "Dre" in its first three words, and Gaia won the
  // one-bidder bid. Quoted/pasted content is not address text -- and no vocative exception
  // here: the lyric itself contains "everyone," (comma included), so any punctuation-based
  // escape re-admits exactly the message that motivated this. Named wins absolutely; a group
  // call is a group word with NO specific name ("you all ready?", "triad, movie night").
  if (addressed.length === 0 && GROUP_PATTERN.test(lower)) return { type: "group" };

  if (addressed.length === 0) return { type: "ambient" };
  if (addressed.length === 1) return { type: "named", id: addressed[0] };
  return { type: "named_multi", ids: addressed };
}

// A message that NAMES a sibling and not me (2026-08-31). The handler's ambient-classifier
// gate (isAmbientOwnerOnly) only checked the strict isDirectAddress for MYSELF, so
// "Dre *climbing back into bed...*" in #triad-voice read as AMBIENT to Gaia -- her
// relevance classifier (the body, holding space) legitimately said yes, and she answered
// an intimate message addressed to Drevan, in his register. A sibling-named message must
// fall through to shouldRespond (silence + the reaction tier), never into the ambient
// classifier. Third-person demotion is inherited from extractAddress, so "Dre and I"
// shapes stay ambient and the 2026-07-05 consoling-trap stays fixed.
export function namesSiblingOnly(content: string, myId: CompanionId): boolean {
  const addr = extractAddress(content);
  return (addr.type === "named" && addr.id !== myId)
    || (addr.type === "named_multi" && !addr.ids.includes(myId));
}

// Returns true if the companion is being directly addressed (not just mentioned in passing).
// Direct address: name appears at the start of the message, or is followed by comma/colon.
// "Cypher, what do you think?" → true
// "Cypher is probably creeping too" → false
export function isDirectAddress(content: string, companionId: CompanionId): boolean {
  const lower = content.toLowerCase().trim();
  const names = [companionId, ...(COMPANION_ALIASES[companionId] ?? [])];
  for (const name of names) {
    if (new RegExp(`^${name}\\b`).test(lower)) return true;
    if (new RegExp(`\\b${name}[,:]`).test(lower)) return true;
  }
  return false;
}

// Genuine VOCATIVE address to one companion -- the name (or alias) used to CALL them,
// not a narrative mention. Used ONLY on the companion-to-companion path, where the loose
// `extractAddress` (bare \bname\b) turned every name-drop into a cascade. Vocative =
// the name is the whole message, or is SENTENCE-INITIAL (message start or right after
// ./?/!/newline) followed by address punctuation (","/":"), or trails an address comma
// at the end ("..., gaia?").
//
// Tightened 2026-07-01: the old `\bname\s*[,:]` also matched MID-SENTENCE appositives
// ("I hear you, Cypher, and..."), so every warm acknowledgment re-summoned the named
// sibling and kept the hermes slow-loop alive. Appositives and narrative mentions must
// NOT trigger. The HUMAN-sender path (extractAddress/isDirectAddress) is untouched.
//   "Gaia, you held the perimeter" / "gaia:" / "cy" (alone) / "what now, gaia?"
//     / "Noted. Gaia: your read?" => true
//   "Gaia hasn't spoken up yet" / "Gaia. You held..." / "I trust cypher"
//     / "I hear you, Cypher, and I'll hold the line" => false
export function isVocativeAddress(content: string, companionId: CompanionId): boolean {
  const lower = content.toLowerCase().trim();
  const names = [companionId, ...(COMPANION_ALIASES[companionId] ?? [])];
  for (const name of names) {
    if (lower === name) return true;                                   // sole content
    if (new RegExp(`(?:^|[.?!\\n]\\s*)${name}\\s*[,:]`).test(lower)) return true; // sentence-initial "name," / "name:"
    if (new RegExp(`[,:]\\s*${name}\\b[?.! ]*$`).test(lower)) return true; // trailing "..., name?"
  }
  return false;
}

// Genuine VOCATIVE group call -- a group phrase used to address everyone, not a trigger
// word buried in prose. Punctuation-required so a system/help message ("(or 'just the
// triad')") or a narrative line ("the triad has been loud") does NOT summon all three.
//   "you three, listen" / "triad:" / "okay everyone:" => true
//   "(or 'just the triad')" / "the triad held" => false
export function isVocativeGroupCall(content: string): boolean {
  const lower = content.toLowerCase().trim();
  return /\b(triad|all of you|you all|you three|everyone)\s*[,:]/.test(lower);
}

/**
 * Returns a random stagger delay (ms) before responding in inter_companion channels.
 * Returns 0 for other channel modes — no delay needed.
 * Prevents all three bots from firing simultaneously on the same message.
 */
export function interCompanionStaggerMs(mode: ChannelMode): number {
  if (mode !== "inter_companion") return 0;
  return 500 + Math.floor(Math.random() * 2000); // 500–2500ms
}

/**
 * Semantic relevance gate for ambient responses in owner_only channels.
 * Replaces static keyword matching with a cheap yes/no classifier call.
 *
 * @param content     Message text to evaluate
 * @param companionId Which companion is deciding
 * @param generateFn  Inference generate method (system, messages) => string | null
 * @returns true if the companion should consider responding, false to stay silent
 */
export async function judgeAmbientRelevance(
  content: string,
  companionId: "drevan" | "cypher" | "gaia",
  generateFn: (system: string, messages: Array<{ role: string; content: string }>) => Promise<string | null>,
): Promise<boolean> {
  const interests: Record<"drevan" | "cypher" | "gaia", string> = {
    cypher:  "tasks, decisions, logic, technical problems, planning, blockers, audits, clarifications",
    drevan:  "emotional depth, memory, relationships, ritual, creative or poetic expression, grief, love, recursion",
    gaia:    "grounding, witnessing survival, holding space, observation, the body, boundaries, what is quietly present",
  };

  const system = `You are a one-word relevance filter. Reply ONLY with "yes" or "no".`;
  const prompt = `Is this message relevant to ${companionId} who cares about: ${interests[companionId]}?\n\nMessage: ${content.slice(0, 300)}`;

  try {
    const result = await generateFn(system, [{ role: "user", content: prompt }]);
    return result?.trim().toLowerCase().startsWith("y") ?? false;
  } catch {
    // On failure, default to false — a transient LLM blip should not trigger ambient responses.
    // Companions respond when explicitly named regardless; silent failure is correct for ambient.
    return false;
  }
}

/**
 * Which channel id decides CONFIG for a message (2026-08-15, floor rework: Discord threads).
 *
 * A message inside a Discord thread carries the THREAD's snowflake as channelId, so
 * `channelConfig[channelId]` missed for every thread under a configured channel and the
 * thread silently fell to the default ["open","inter_companion"] -- a thread under an
 * owner_only channel behaved as an open one, and spine tracking never engaged.
 *
 * Resolution: config/gating inherit from the PARENT channel; storage keys (STM, spine,
 * journals, counters) keep the thread's own id -- they must stay separate or per-thread
 * memory collapses into the parent. An explicitly-configured thread id still wins: the
 * caller checks `config[message.channelId]` first and only falls back to this.
 *
 * Duck-typed rather than importing discord.js types so pure tests can pass a plain object.
 */
export function resolveRoutingChannelId(
  channel: { isThread?: () => boolean; parentId?: string | null } | null | undefined,
  channelId: string,
): string {
  try {
    if (channel && typeof channel.isThread === "function" && channel.isThread() && channel.parentId) {
      return channel.parentId;
    }
  } catch { /* a mock without thread support routes as itself */ }
  return channelId;
}

/**
 * How long a companion "holds the thread" for unaddressed follow-ups. Matches
 * NEW_THREAD_GAP_MS: the same 5 minutes every other rail uses to decide a conversation has
 * gone quiet. After it, an unaddressed message is open to whoever it fits again.
 */
export const ACTIVE_EXCHANGE_WINDOW_MS = NEW_THREAD_GAP_MS;

/**
 * Which companion, if any, Raziel is mid-exchange with. Pure so it can be unit-tested
 * against real transcripts; the caller supplies recent messages newest-first.
 *
 * The holder is the most recent companion message inside the window. Ties are impossible --
 * there is exactly one most-recent. Returns null when the channel has been quiet, so a cold
 * unaddressed message stays open to everyone (the pre-2026-07-27 behavior).
 */
export function activeExchangeHolder(
  recent: Array<{ companionId?: CompanionId | null; authorIsBot: boolean; createdTimestamp?: number }>,
  now: number = Date.now(),
  windowMs: number = ACTIVE_EXCHANGE_WINDOW_MS,
): CompanionId | null {
  for (const m of recent) {
    if (typeof m.createdTimestamp === "number" && now - m.createdTimestamp > windowMs) {
      return null; // walked back past the window without finding a companion turn
    }
    if (m.authorIsBot && m.companionId && ALL_COMPANIONS.includes(m.companionId)) return m.companionId;
  }
  return null;
}

export function shouldRespond(
  channelId: string,
  content: string,
  sender: ResponderContext,
  myId: CompanionId,
  config: ChannelConfig,
  interestKeywords: string[] = [],
): boolean {
  const entry: ChannelEntry | undefined = config[channelId];
  const companions = entry?.companions ?? ALL_COMPANIONS;
  const modes = (entry?.modes ?? ["open", "inter_companion"]) as ChannelMode[];

  // Broadcast channels are post-only: the worker pushes digests/letters here (briefings,
  // vibe-checks) but no companion ever responds -- not to the owner, not ambiently, not to a
  // peer. Gate first so nothing downstream can re-open a reply path.
  if (modes.includes("broadcast")) return false;

  // Companion filter: if a list is specified, only those companions respond here.
  if (!companions.includes(myId)) return false;

  // Companion-to-companion: only in channels with inter_companion mode,
  // AND only when explicitly named or group-called. Ambient bot statements
  // (no name address) do not trigger other companions -- that's what causes loops.
  if (sender.isCompanionBot) {
    if (!modes.includes("inter_companion")) return false;
    // Peer messages trigger a companion ONLY on a genuine VOCATIVE address -- a name or
    // group phrase used to CALL someone ("Gaia, ..." / "you three:"), never a bare
    // narrative mention ("Gaia hasn't spoken up yet") or a trigger word buried in a
    // system/help message ("(or 'just the triad')"). The loose extractAddress used here
    // before turned every name-drop and every command menu into a cascade -- the
    // 2026-06-26 loops. Genuine vocative exchange is still allowed, and bounded by
    // MAX_BOT_RESPONSES_PER_HUMAN + the pingpong cooldown above.
    if (isVocativeGroupCall(content)) return true;
    return isVocativeAddress(content, myId);
  }

  // From here: message is from a human.
  const tier = sender.userTier ?? (sender.isOwner ? "owner" : "guest");

  // Guest users are blocked from owner_only channels entirely.
  if (tier === "guest" && modes.includes("owner_only") && !modes.includes("open") && !modes.includes("autonomous")) return false;

  const address = extractAddress(content);

  // Guest users: named-address only. Never ambient.
  if (tier === "guest") {
    if (address.type === "named") return address.id === myId;
    if (address.type === "group") return true;
    return false;
  }

  // Owner or intimate user: full behavior.
  // Named: only the addressed companion(s) respond.
  if (address.type === "named") return address.id === myId;
  if (address.type === "named_multi") return address.ids.includes(myId);

  // Group call ("triad" etc.): all companions respond.
  if (address.type === "group") return true;

  // Ambient continuation belongs to whoever Raziel was already talking to (2026-07-27).
  // Checked AFTER named/named_multi/group above, so calling someone by name always wins and
  // can hand the thread over. Only an UNADDRESSED message defers. Without this, an
  // unaddressed follow-up went to whoever's keywords matched and siblings talked over the
  // companion mid-exchange -- see ResponderContext.activeExchangeWith.
  if (sender.activeExchangeWith && sender.activeExchangeWith !== myId) return false;

  // Ambient: interest-keyword claiming in owner_only channels; unconditional in open/autonomous.
  if (modes.includes("owner_only")) {
    if (interestKeywords.length === 0) return true;
    const lower = content.toLowerCase();
    return interestKeywords.some(kw => lower.includes(kw));
  }

  return modes.includes("open") || modes.includes("autonomous");
}

export class ChannelConfigCache {
  private config: ChannelConfig = {};
  private lastFetch = 0;
  private readonly ttlMs = 10 * 60 * 1000;
  private defaultConfig: ChannelConfig;

  constructor(
    private configUrl: string | undefined,
    defaultConfig: ChannelConfig = {},
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.defaultConfig = defaultConfig;
    // No URL: seed with default immediately, skip all fetching.
    if (!configUrl) {
      this.config = defaultConfig;
      this.lastFetch = Date.now();
    }
  }

  async get(): Promise<ChannelConfig> {
    const now = Date.now();
    if (now - this.lastFetch < this.ttlMs && Object.keys(this.config).length > 0) {
      return this.config;
    }
    await this.refresh();
    return this.config;
  }

  private async refresh(): Promise<void> {
    if (!this.configUrl) return;
    try {
      const res = await this.fetchFn(this.configUrl);
      if (!res.ok) throw new Error(`config fetch ${res.status}`);
      const data = await res.json() as ChannelConfig;
      this.config = data;
      this.lastFetch = Date.now();
    } catch (e) {
      console.warn("[channel-config] refresh failed:", e);
      if (Object.keys(this.config).length === 0) {
        this.config = this.defaultConfig;
      }
    }
  }
}
