// self-window.ts -- the bot's own recent turns, merged from two sources (2026-09-21).
//
// THREE GATES READ THIS WINDOW: `detectSelfLoop` (since 2026-06-13), `formBreakAppend` (2026-09-20)
// and `ownEchoGated`. It was assembled inline in bot-message-handler as:
//
//   [...new Set([...selfFromStm, ...selfFromChannel])].slice(-5)
//
// which is wrong in a way that hid for three months, because `Set` keeps the FIRST occurrence of a
// duplicate. A turn the bot just spoke lives in BOTH sources: STM (appended in-process at the end
// of the handler) and Discord channel history (it posted it). Dedup therefore pinned that turn to
// its STM position at the FRONT of the array, and `slice(-5)` -- taking the TAIL -- discarded it.
// The fresher a turn was, the more certainly it was in both sources, so the window systematically
// preferred the STALEST turns available.
//
// Caught by the window log added the night before, on Drevan, four consecutive turns:
//
//   09:42  window=11x58|19x80|31x59|23x84|22x31  stm=0  ch=11
//   09:50  window=11x58|19x80|31x59|23x84|22x31  stm=1  ch=11
//   09:53  window=11x58|19x80|31x59|23x84|22x31  stm=2  ch=11
//   09:55  window=11x58|19x80|31x59|23x84|22x31  stm=3  ch=11
//
// Byte-identical while STM filled 0 -> 3 with that morning's turns. `19x80` and `31x59` are the
// PREVIOUS day's turns 5 and 6 measured exactly. So the gate fired a form break on his healthiest
// turn of the morning (7 lines, 132 chars) and then sat frozen on day-old evidence through the
// descent to 57 -- which is why "the directive was proven delivered and ignored" could not be
// concluded from any of it: the directive was being aimed at yesterday.
//
// THE RULE: dedup NEWEST-first so the newest copy of a repeated turn is the one that survives, then
// keep the newest N, then restore chronological order for the reader. This makes the result
// independent of which source happens to be fresher, which is the property the old expression
// silently depended on and did not have.

/** Turns kept. Enough to see a groove, few enough to stay current (the original intent, now true). */
export const SELF_WINDOW_SIZE = 5;

/**
 * The bot's own most recent turns, oldest-first, deduped.
 *
 * @param fromStm     assistant turns from STM, chronological. Authoritative for the newest turns.
 * @param fromChannel this bot's own authored channel history, chronological. Survives a restart
 *                    that clears STM, which is the only reason both sources exist.
 */
export function mergeSelfTurns(
  fromStm: string[],
  fromChannel: string[],
  limit = SELF_WINDOW_SIZE,
): string[] {
  // Channel first, STM last: roughly chronological, with the freshest turns at the end. Then walk
  // it BACKWARDS, so the de-duplicating Set encounters the newest copy of a turn first and that is
  // the copy that is kept.
  const newestFirst: string[] = [];
  const seen = new Set<string>();
  const combined = [...fromChannel, ...fromStm];
  for (let i = combined.length - 1; i >= 0 && newestFirst.length < limit; i--) {
    const turn = combined[i]!;
    if (seen.has(turn)) continue;
    seen.add(turn);
    newestFirst.push(turn);
  }
  return newestFirst.reverse();
}
