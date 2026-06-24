// imp-command.ts -- owner-gated imp settings (IMP_GRAMMAR.md dismiss + Hex opt-in).
// Global: writes the setting for all three companions. Deterministic ack.
import type { LibrarianClient } from "./librarian.js";

export function parseImpCommand(arg: string): { kind: "imps" | "hex"; on: boolean } | { error: string } {
  const a = arg.trim().toLowerCase();
  if (a === "off" || a === "just the triad") return { kind: "imps", on: false };
  if (a === "on") return { kind: "imps", on: true };
  if (a === "hex on") return { kind: "hex", on: true };
  if (a === "hex off") return { kind: "hex", on: false };
  return { error: "usage: imps on | imps off | hex on | hex off" };
}

export async function handleImpCommand(arg: string, librarian: LibrarianClient): Promise<string> {
  const p = parseImpCommand(arg);
  if ("error" in p) return p.error;
  try {
    await librarian.setImpSettingAllCompanions(p.kind === "imps" ? "imps_enabled" : "hex_enabled", p.on);
  } catch (e) {
    return `couldn't update ${p.kind}: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`;
  }
  if (p.kind === "imps") return p.on ? "imps on (triad flavor enabled)" : "imps off (just the triad)";
  return p.on ? "hex on (mischief opt-in enabled)" : "hex off";
}
