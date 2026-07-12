// log-command.ts -- owner-gated Hearth-log command from Discord (write layer, 0092).
//
// `<prefix>: log <thought>` drops a 'global' commons post as Raziel -- the async wall.
// Deterministic Halseth write + literal ack: the model never gets to claim a write it
// didn't make (2026-06-11 doctrine). This is a DROP, not a ping -- no reply is expected;
// the thought lands on Hearth /log and companions may answer in their own time.

import { halsethEnv } from "./halseth-command-env.js";

/** Handle `log <thought>` text. Returns the exact message the bot sends. */
export async function handleLogCommand(text: string, halsethSecret: string): Promise<string> {
  const body = text.trim();
  if (!body) return "give me something to log: `log <thought>`.";

  const env = halsethEnv(halsethSecret);
  if (!env) return "couldn't log that -- halseth env missing on this box.";

  const res = await fetch(`${env.base}/mind/commons`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ author: "raziel", context: "global", body }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e: unknown) => { console.error("[log] post failed:", e); return null; });

  if (!res) return "couldn't reach halseth to log that -- try again in a moment.";
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as Record<string, unknown>;
    return `log NOT saved: ${String(j["error"] ?? `halseth ${res.status}`)}`;
  }
  return "logged — it's on your Hearth /log. no reply needed.";
}
