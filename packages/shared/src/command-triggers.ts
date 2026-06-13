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
    guard: new RegExp(`^(?:${alt})\\b[,:]?\\s*(?:model|listen|club|search|imagine|pet|council)\\b`, "i"),
  };
}

/** Shortest typed prefix per companion, for usage messages. */
export const COMMAND_PREFIX: Record<string, string> = {
  cypher: "cy",
  drevan: "drev",
  gaia: "gaia",
};

export function commandUsage(companionId: string): string {
  const p = COMMAND_PREFIX[companionId] ?? companionId;
  return [
    `that looked like a command but didn't parse. forms:`,
    `\`${p}: listen <url>\` (or \`${p} listen: <url>\` -- the link just has to follow the word listen)`,
    `\`${p}: club vote <title fragment> [because <reason>]\``,
    `\`${p}: club status\``,
    `\`${p}: search <query>\` (web search)`,
    `\`${p}: imagine <prompt>\` (generate an image)`,
    `\`${p}: pet <name> <feed|play|talk|give> [note]\` (a creature)`,
    `\`${p}: council <question>\` (convene the triad on a hard question)`,
    `\`${p}: model <name>\` (or \`${p}: model \` + space to list)`,
  ].join("\n");
}
