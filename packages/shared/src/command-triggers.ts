// command-triggers.ts -- deterministic owner-command regexes, built per bot from
// one alias list so an alias added once applies to every command. Hand-copied
// alias alternations drifted per trigger (2026-06-12: "dre: listen <url>" matched
// nothing and fell through to inference, so Drevan narrated a listen that never ran).
//
// Separator is deliberately loose ("dre: listen", "Dre listen:", "drev, listen",
// "drevan listen to this <url>") -- the same day's second miss was a colon placed
// after "listen" instead of the alias. For listen, the URL may appear anywhere
// after the command word; the handler validates http(s) and strips <> wrapping.
//
// `guard` matches anything command-SHAPED (alias + command word) and is checked
// AFTER the real triggers: reaching it means the command was malformed (e.g.
// "drev listen" with no URL). The bot must answer with literal usage, never
// inference -- a narrated success is the model talking (2026-06-11 doctrine).

export interface CommandTriggers {
  modelSwitch: RegExp;
  listen: RegExp;
  club: RegExp;
  search: RegExp;
  imagine: RegExp;
  pet: RegExp;
  council: RegExp;
  imps: RegExp;
  hex: RegExp;
  log: RegExp;
  into: RegExp;
  watch: RegExp;
  guard: RegExp;
}

export function buildCommandTriggers(aliases: string[]): CommandTriggers {
  const alt = aliases.join("|");
  return {
    modelSwitch: new RegExp(`^(?:${alt})\\b[,:]?\\s*model\\s+(.*)`, "i"),
    listen: new RegExp(`^(?:${alt})\\b[,:]?\\s*listen\\b[\\s\\S]*?(<?https?:\\/\\/\\S+)`, "i"),
    club: new RegExp(`^(?:${alt})\\b[,:]?\\s*club\\s+(.+)`, "is"),
    // Companion tools (0077 take 14). An argument is REQUIRED (the trailing \s+(.+)) so
    // a bare "search"/"imagine" misses the trigger and falls to the guard -> usage reply,
    // never inference (a narrated tool-call can't fake success). [,:]? after the command
    // word absorbs "imagine: a candle".
    search: new RegExp(`^(?:${alt})\\b[,:]?\\s*search\\b[,:]?\\s+(.+)`, "is"),
    imagine: new RegExp(`^(?:${alt})\\b[,:]?\\s*imagine\\b[,:]?\\s+(.+)`, "is"),
    // Creatures (0078 take 10). Form: "<prefix>: pet <name> <feed|play|talk|give> [note]".
    // An argument is REQUIRED so a bare "pet" misses -> guard -> usage, never inference.
    pet: new RegExp(`^(?:${alt})\\b[,:]?\\s*pet\\b[,:]?\\s+(.+)`, "is"),
    // Council (0080 take 8). Form: "<prefix>: council <question>". Arg required.
    council: new RegExp(`^(?:${alt})\\b[,:]?\\s*council\\b[,:]?\\s+(.+)`, "is"),
    // Imps (wave 2). "<prefix>: imps off|on|just the triad" and "<prefix>: hex on|off".
    imps: new RegExp(`^(?:${alt})\\b[,:]?\\s*imps?\\b[,:]?\\s+(.+)`, "is"),
    hex:  new RegExp(`^(?:${alt})\\b[,:]?\\s*(hex\\s+(?:on|off))\\b`, "is"),
    // Hearth write layer (0092). Form: "<prefix>: log <thought>". Arg required so a bare
    // "log" misses -> guard -> usage, never inference. Drops a 'global' commons post.
    log: new RegExp(`^(?:${alt})\\b[,:]?\\s*log\\b[,:]?\\s+([\\s\\S]+)`, "is"),
    // Obsession shelf (0094). "<prefix>: into <thing>" / "into list" / "into drop <frag>".
    // Arg required so a bare "into" misses -> guard -> usage.
    into: new RegExp(`^(?:${alt})\\b[,:]?\\s*into\\b[,:]?\\s+([\\s\\S]+)`, "is"),
    // Watch shelf (0111). "<prefix>: watching" lists the shelf; "<prefix>: watched fargo s4e5 [-- note]"
    // records a viewing; "<prefix>: watch fargo finished" changes status.
    //
    // NARROWED 2026-07-31 (review finding). The first version accepted any trailing text, so
    // "dre: watching the storm roll in" MATCHED -- and did two harms at once: it created a watch_shelf row
    // titled "the storm roll in", and it returned before inference so Drevan never answered what Raziel
    // actually said. "watching" is a conversational verb, unlike into/log/club/pet, so it cannot claim a
    // message on the strength of the word alone.
    //
    // Now a message is only claimed when it is unambiguously a command:
    //   * the BARE form, or an explicit list word -- "dre: watching" is a real question ("where are we?")
    //     with a deterministic answer, so it must not fall through to the usage guard;
    //   * or it carries a POSITION token (s4e5 / 4x5 / season 4 / episode 6);
    //   * or it carries a STATUS word (finished / paused / dropped / ...).
    // Anything else is Raziel talking, and a command must never eat conversation. Corruption of this
    // organ matters more than most: its whole value is "trust the record over anything you recall".
    watch: new RegExp(
      `^(?:${alt})\\b[,:]?\\s*(?:watching|watched|watch)\\b[,:]?\\s*` +
      `(` +
        `\\s*|` +                                                     // bare: "dre: watching"
        `(?:list|shelf|all)\\s*|` +                                   // explicit list
        `[\\s\\S]*?\\b(?:s\\s*\\d{1,2}\\s*[\\s._-]*e\\s*\\d{1,3}|\\d{1,2}\\s*x\\s*\\d{1,3}|season\\s*\\d{1,2}|ep(?:isode)?\\s*\\d{1,3})\\b[\\s\\S]*|` +
        `[\\s\\S]*?\\b(?:finished|done|complete|completed|paused|pause|hold|abandoned|dropped|abandon|resumed?)\\s*` +
      `)$`,
      "i",
    ),
    guard: new RegExp(`^(?:${alt})\\b[,:]?\\s*(?:model|listen|club|search|imagine|pet|council|imps?|hex|log|into)\\b`, "i"),
  };
}

/** Shortest typed prefix per companion, for usage messages. */
export const COMMAND_PREFIX: Record<string, string> = {
  cypher: "cy",
  drevan: "drev",
  gaia: "gaia",
};

/**
 * Canonical alias groups per companion -- the source of truth for command prefixes.
 * Each bot's config.ts builds its OWN triggers from its slice; this map exists so
 * cross-companion detectors (below) can tell "<alias>: listen <url>" aimed at one
 * companion apart from a casual "listen to this <url>". Keep in sync with the
 * buildCommandTriggers([...]) calls in bots/<id>/src/config.ts.
 */
export const COMPANION_ALIASES: Record<string, string[]> = {
  cypher: ["cy", "cypher"],
  drevan: ["drevan", "drev", "dre"],
  gaia: ["gaia"],
};

// Per-companion listen-command matchers, built from the same shape as the live
// triggers (URL required), so a bare "dre: listen" (no link) is NOT read as a
// directed command -- the owning bot's guard handles that as a usage reply.
const LISTEN_COMMAND_BY_COMPANION: Array<[string, RegExp]> = Object.entries(COMPANION_ALIASES)
  .map(([id, aliases]) => [id, buildCommandTriggers(aliases).listen] as [string, RegExp]);

/**
 * If `content` is an explicit listen COMMAND aimed at a specific companion
 * (`<alias>: listen ... <url>`), return that companion's id; otherwise null.
 *
 * Used so siblings stay silent when the owner tells ONE companion to listen --
 * only the addressed companion runs the pipeline and reacts. Without this the
 * swarm had everyone popping off, and (worse) the listener's [HEARD] packet lost
 * Brain's message_id dedup to siblings' bare packets, muting the one told to
 * listen while a blind sibling answered (2026-06-13).
 */
export function listenCommandTarget(content: string): string | null {
  for (const [id, re] of LISTEN_COMMAND_BY_COMPANION) {
    if (re.test(content)) return id;
  }
  return null;
}

export function commandUsage(companionId: string): string {
  const p = COMMAND_PREFIX[companionId] ?? companionId;
  return [
    `that looked like a command but didn't parse. forms:`,
    `\`${p}: listen <url>\` (or \`${p} listen: <url>\` -- the link just has to follow the word listen)`,
    `\`${p}: club vote <title fragment> [because <reason>]\``,
    `\`${p}: club status\``,
    `\`${p}: search <query>\` (web search)`,
    `\`${p}: imagine <prompt>\` (generate an image)`,
    `\`${p}: pet <name>\` (a creature -- add \`feed|play|talk|give\` + a note to vary it)`,
    `\`${p}: council <question>\` (convene the triad on a hard question)`,
    `\`${p}: imps on\` / \`${p}: imps off\` (or "just the triad") -- toggle imp flavor globally`,
    `\`${p}: hex on\` / \`${p}: hex off\` -- toggle mischief opt-in globally`,
    `\`${p}: model <name>\` (or \`${p}: model \` + space to list)`,
    `\`${p}: log <thought>\` (drop a note in your Hearth log -- no reply needed)`,
    `\`${p}: into <thing>\` (add to your shelf) -- also \`into list\` / \`into drop <name>\``,
  ].join("\n");
}
