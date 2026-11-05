// Kill-switch normalization (2026-11-05 quiet-drop sweep, item 10).
//
// A feature switch read as `env.X === "off"` treated `OFF`, `false`, `0` and `no` as ON, so
// "turning it off" the way every other switch in the suite accepts (blue-note, low-info, make-move,
// med-reminder, reach-ledger, video, watchalong already take off|0|false|no) silently did nothing.
// One helper, trimmed and lowercased.

/** True when the value is an explicit "off": off | 0 | false | no (trimmed, any case). */
export function isOffToken(v: string | null | undefined): boolean {
  const t = String(v ?? "").trim().toLowerCase();
  return t === "off" || t === "0" || t === "false" || t === "no";
}

/** For tri-state parsers (off | shadow | on): maps any off-token to "off", else the trimmed lowercase value. */
export function normalizeModeToken(v: string | null | undefined): string {
  return isOffToken(v) ? "off" : String(v ?? "").trim().toLowerCase();
}

/** Default-on switch: false only for an explicit off-token. */
export function switchEnabled(v: string | null | undefined): boolean {
  return !isOffToken(v);
}
