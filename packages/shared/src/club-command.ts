// club-command.ts -- owner-gated Club commands from Discord (0072).
//
// `<prefix>: club vote <title fragment> [because <reason>]` and
// `<prefix>: club status`. The bot performs the Halseth write itself and acks
// deterministically -- the model never gets to claim an action it didn't take
// (which is exactly what happened on 2026-06-11: "Vote cast." with zero rows).
//
// Votes cast through this path are RAZIEL's (voter='raziel'): the companions
// vote in-voice during the worker's voting tick; the owner pre-casts here.

interface ClubRound {
  id: string;
  status: "gathering" | "voting" | "active" | "closed";
}

interface ClubRecommendation {
  id: string;
  title: string;
  media_kind: string;
  recommended_by: string;
}

interface ClubCurrent {
  round: ClubRound | null;
  recommendations: ClubRecommendation[];
  votes: Array<{ recommendation_id: string; voter: string }>;
}

function halsethEnv(): { base: string; secret: string } | null {
  const base = process.env["HALSETH_URL"];
  const secret = process.env["HALSETH_SECRET"] ?? process.env["ADMIN_SECRET"];
  if (!base || !secret) {
    console.error("[club] command SKIPPED: HALSETH_URL/HALSETH_SECRET missing from env");
    return null;
  }
  return { base: base.replace(/\/$/, ""), secret };
}

async function clubFetch(path: string, method: "GET" | "POST", body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const env = halsethEnv();
  if (!env) return { ok: false, status: 0, json: { error: "halseth env missing on this box" } };
  const res = await fetch(`${env.base}${path}`, {
    method,
    headers: { "Authorization": `Bearer ${env.secret}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/** Match a title fragment against the current round's recommendations.
 *  Exact-first, then case-insensitive substring (the name-lookup covenant). */
export function matchRecommendation(fragment: string, recs: ClubRecommendation[]): ClubRecommendation | { error: string } {
  const needle = fragment.trim().toLowerCase();
  if (!needle) return { error: "give me a title (or part of one) to vote for." };
  const exact = recs.find(r => r.title.toLowerCase() === needle);
  if (exact) return exact;
  const partial = recs.filter(r => r.title.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    return { error: `"${fragment}" matches ${partial.length} picks -- be more specific:\n` + partial.map(r => `• ${r.title}`).join("\n") };
  }
  return { error: `no pick in this round matches "${fragment}". Current candidates:\n` + recs.map(r => `• ${r.title} (${r.recommended_by})`).join("\n") };
}

/** Handle `club <subcommand>` text. Returns the exact message the bot sends. */
export async function handleClubCommand(text: string, voter: string): Promise<string> {
  const trimmed = text.trim();

  if (/^status\b/i.test(trimmed)) {
    const res = await clubFetch("/mind/club/current", "GET");
    if (!res.ok) return `club status failed (${res.status || "no halseth env"}).`;
    const cur = res.json as unknown as ClubCurrent;
    if (!cur.round) return "no club round is open right now.";
    const lines = [`round is ${cur.round.status} -- ${cur.recommendations.length} candidate(s), ${cur.votes.length} vote(s) in:`];
    for (const r of cur.recommendations) {
      const n = cur.votes.filter(v => v.recommendation_id === r.id).length;
      lines.push(`• ${r.title} (${r.recommended_by})${n > 0 ? ` -- ${n} vote(s)` : ""}`);
    }
    return lines.join("\n");
  }

  const voteMatch = trimmed.match(/^vote\s+(.+)$/is);
  if (voteMatch) {
    let fragment = voteMatch[1]!.trim();
    let reason: string | null = null;
    const becauseIdx = fragment.toLowerCase().indexOf(" because ");
    if (becauseIdx > 0) {
      reason = fragment.slice(becauseIdx + " because ".length).trim() || null;
      fragment = fragment.slice(0, becauseIdx).trim();
    }

    const cur = await clubFetch("/mind/club/current", "GET");
    if (!cur.ok) return `couldn't load the current round (${cur.status || "no halseth env"}).`;
    const current = cur.json as unknown as ClubCurrent;
    if (!current.round || (current.round.status !== "gathering" && current.round.status !== "voting")) {
      return `no round is accepting votes right now${current.round ? ` (round is ${current.round.status})` : ""}.`;
    }

    const rec = matchRecommendation(fragment, current.recommendations);
    if ("error" in rec) return rec.error;

    const res = await clubFetch("/mind/club/vote", "POST", {
      recommendation_id: rec.id, voter, reason,
    });
    if (!res.ok) return `vote NOT cast: ${String(res.json["error"] ?? `halseth ${res.status}`)}`;
    return `vote cast (${voter}) for «${rec.title}» (${rec.recommended_by}'s pick)${reason ? ` -- "${reason}"` : ""}.`;
  }

  // Phase 2: Raziel joins the discussion. Posts to the write layer (commons, club:<id>) so
  // it threads with the companions' residue on Hearth /club. A drop, not a vote.
  const sayMatch = trimmed.match(/^say\s+([\s\S]+)$/is);
  if (sayMatch) {
    const text = sayMatch[1]!.trim();
    if (!text) return "give me something to say: `club say <text>`.";
    const cur = await clubFetch("/mind/club/current", "GET");
    if (!cur.ok) return `couldn't load the current round (${cur.status || "no halseth env"}).`;
    const current = cur.json as unknown as ClubCurrent;
    if (!current.round) return "no club round is open to discuss right now.";
    const res = await clubFetch("/mind/commons", "POST", {
      author: voter, context: `club:${current.round.id}`, body: text,
    });
    if (!res.ok) return `couldn't post that: ${String(res.json["error"] ?? `halseth ${res.status}`)}`;
    return `posted to the ${current.round.status} round's discussion. it's on Hearth /club.`;
  }

  return 'club commands: "club status" | "club vote <title fragment> [because <reason>]" | "club say <text>"';
}
