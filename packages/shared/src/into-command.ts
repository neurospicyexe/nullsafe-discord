// into-command.ts -- owner-gated obsession shelf commands (0094).
//
// `<prefix>: into <thing>` adds to Raziel's shelf (optionally `into <kind>: <thing>`);
// `into list` lists it; `into drop <fragment>` archives. Deterministic Halseth write +
// literal ack -- the model never claims a shelf change it didn't make. The triad reacts to
// the shelf in their own time via the write layer (commons, shelf:<id>).

const KINDS = new Set(["show", "movie", "actor", "person", "book", "music", "game", "article", "other"]);

interface ShelfItem { id: string; title: string; kind: string; note: string | null; status: string; }

function halsethEnv(): { base: string; secret: string } | null {
  const base = process.env["HALSETH_URL"];
  const secret = process.env["HALSETH_SECRET"] ?? process.env["ADMIN_SECRET"];
  if (!base || !secret) {
    console.error("[into] command SKIPPED: HALSETH_URL/HALSETH_SECRET missing from env");
    return null;
  }
  return { base: base.replace(/\/$/, ""), secret };
}

async function shelfFetch(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
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

/** Handle `into <subcommand>` text. Returns the exact message the bot sends. */
export async function handleIntoCommand(text: string): Promise<string> {
  const trimmed = text.trim();

  if (/^list\b/i.test(trimmed)) {
    const res = await shelfFetch("/mind/shelf?status=active", "GET");
    if (!res.ok) return `shelf list failed (${res.status || "no halseth env"}).`;
    const items = (res.json as { items?: ShelfItem[] }).items ?? [];
    if (items.length === 0) return "your shelf is empty. `into <thing>` to add something.";
    return "on your shelf:\n" + items.map(i => `• ${i.title} (${i.kind})`).join("\n");
  }

  const dropMatch = trimmed.match(/^drop\s+(.+)$/is);
  if (dropMatch) {
    const raw = dropMatch[1]!.trim();
    const frag = raw.toLowerCase();
    const res = await shelfFetch("/mind/shelf?status=active", "GET");
    if (!res.ok) return `couldn't load your shelf (${res.status || "no halseth env"}).`;
    const items = (res.json as { items?: ShelfItem[] }).items ?? [];
    const exact = items.find(i => i.title.toLowerCase() === frag);
    const matches = exact ? [exact] : items.filter(i => i.title.toLowerCase().includes(frag));
    if (matches.length === 0) return `nothing on your shelf matches "${raw}".`;
    if (matches.length > 1) return `"${raw}" matches ${matches.length} -- be specific:\n` + matches.map(i => `• ${i.title}`).join("\n");
    const patch = await shelfFetch(`/mind/shelf/${matches[0]!.id}`, "PATCH", { status: "archived" });
    if (!patch.ok) return `couldn't drop it: ${String(patch.json["error"] ?? `halseth ${patch.status}`)}`;
    return `dropped «${matches[0]!.title}» from your shelf.`;
  }

  // add: "into <thing>" or "into <kind>: <thing>"
  let kind = "other";
  let title = trimmed;
  const kindMatch = trimmed.match(/^(\w+)\s*:\s*([\s\S]+)$/);
  if (kindMatch && KINDS.has(kindMatch[1]!.toLowerCase())) {
    kind = kindMatch[1]!.toLowerCase();
    title = kindMatch[2]!.trim();
  }
  if (!title) return "what are you into? `into <thing>` (or `into show: <name>`).";
  const res = await shelfFetch("/mind/shelf", "POST", { title, kind });
  if (!res.ok) return `couldn't add that: ${String(res.json["error"] ?? `halseth ${res.status}`)}`;
  return `added «${title}» (${kind}) to your shelf. the triad will react in their own time.`;
}
