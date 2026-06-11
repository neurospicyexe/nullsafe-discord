// Unified Guardian tick (0073) -- thin trigger; all detection lives server-side
// in Halseth (handlers/guardian.ts), where every feed table is local D1.
// Halseth-only writes; no floor lock, no idle check needed.
//
// Daily tick raises/resolves red-flag cards. On GUARDIAN_LETTER_DOW the tick
// also writes the weekly meta-commentary letter to Raziel (companion_journal,
// agent=guardian, tag letter_to_raziel).

import { GUARDIAN_LETTER_DOW } from "./config.js";
import { runGuardian } from "./halseth-client.js";

export async function runGuardianTick(now: Date = new Date()): Promise<void> {
  const letter = now.getDay() === GUARDIAN_LETTER_DOW;
  const res = await runGuardian(letter);
  console.log(
    `[guardian] tick: ${res.flags_created} new, ${res.flags_resolved} resolved` +
    (res.letter_id ? `, letter ${res.letter_id}` : ""),
  );
}
