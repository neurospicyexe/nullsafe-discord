// command-triggers.ts -- deterministic owner-command regexes, built per bot from
// one alias list so an alias added once applies to every command. Hand-copied
// alias alternations drifted per trigger (2026-06-12: "dre: listen <url>" matched
// nothing and fell through to inference, so Drevan narrated a listen that never ran).
//
// `guard` matches anything command-SHAPED (alias + colon + command word) and is
// checked AFTER the real triggers: reaching it means the command was malformed
// (e.g. "drev: listen" with no URL). The bot must answer with literal usage,
// never inference -- a narrated success is the model talking (2026-06-11 doctrine).

export interface CommandTriggers {
  modelSwitch: RegExp;
  listen: RegExp;
  club: RegExp;
  guard: RegExp;
}

export function buildCommandTriggers(aliases: string[]): CommandTriggers {
  const alt = aliases.join("|");
  return {
    modelSwitch: new RegExp(`^(?:${alt}):\\s*model\\s+(.*)`, "i"),
    listen: new RegExp(`^(?:${alt}):\\s*listen\\s+(\\S+)`, "i"),
    club: new RegExp(`^(?:${alt}):\\s*club\\s+(.+)`, "is"),
    guard: new RegExp(`^(?:${alt}):\\s*(?:model|listen|club)\\b`, "i"),
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
    `\`${p}: listen <url>\``,
    `\`${p}: club vote <title fragment> [because <reason>]\``,
    `\`${p}: club status\``,
    `\`${p}: model <name>\` (or \`${p}: model\` + space to list)`,
  ].join("\n");
}
