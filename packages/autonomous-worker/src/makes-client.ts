// makes-client.ts -- the HTTP seam between the VPS renderer / forage and Halseth's B62 routes.
// One small module so a route-shape adjustment lands in one place. Contract:
// Hand-off/SPEC-B62-making-2026-11-02.md. Auth is the same ADMIN_SECRET bearer as halseth-client.

import { HALSETH_URL, HALSETH_SECRET } from "./config.js";

export type FetchFn = typeof fetch;

export interface PendingMake {
  id: string;
  companion_id: string;
  kind: string;
  params: Record<string, unknown> | null;
  source_key: string | null;
}

export interface InterestRow {
  id: string;
  name: string;
  why?: string | null;
  status: string;
  heat: number;
  band?: string | null;
}

export interface RenderedFile { data: Uint8Array; mime: string; filename: string }

export interface MakesClient {
  getPending(limit?: number): Promise<PendingMake[]>;
  getSource(id: string): Promise<string>;
  postRendered(id: string, out: { file: RenderedFile; preview?: RenderedFile }): Promise<void>;
  postFailed(id: string, reason: string): Promise<void>;
}

function headers(json = false): Record<string, string> {
  return { Authorization: `Bearer ${HALSETH_SECRET}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

/** params can arrive as a JSON string (D1 TEXT) or an object. */
export function normalizeParams(p: unknown): Record<string, unknown> | null {
  if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  if (typeof p === "string" && p.trim()) {
    try {
      const v = JSON.parse(p) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* fall through */ }
  }
  return null;
}

/** The pending list may be a bare array or wrapped; accept the shapes a builder would pick. */
export function normalizePending(body: unknown): PendingMake[] {
  const b = body as Record<string, unknown> | unknown[] | null;
  const arr = Array.isArray(b) ? b : b ? (b["makes"] ?? b["pending"] ?? b["rows"] ?? b["results"]) : null;
  if (!Array.isArray(arr)) return [];
  const out: PendingMake[] = [];
  for (const r of arr as Array<Record<string, unknown>>) {
    if (!r || typeof r["id"] !== "string" || typeof r["kind"] !== "string") continue;
    out.push({
      id: r["id"] as string,
      companion_id: String(r["companion_id"] ?? ""),
      kind: r["kind"] as string,
      params: normalizeParams(r["params"]),
      source_key: typeof r["source_key"] === "string" ? (r["source_key"] as string) : null,
    });
  }
  return out;
}

export function createMakesClient(fetchFn: FetchFn = fetch, base: string = HALSETH_URL): MakesClient {
  const url = (p: string) => `${base}${p}`;
  return {
    async getPending(limit = 5) {
      const res = await fetchFn(url(`/mind/makes/pending?limit=${limit}`), { headers: headers(), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`makes pending -> ${res.status}`);
      return normalizePending(await res.json());
    },
    async getSource(id) {
      const res = await fetchFn(url(`/mind/makes/source/${encodeURIComponent(id)}`), { headers: headers(), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`makes source -> ${res.status}`);
      return res.text();
    },
    async postRendered(id, out) {
      const fd = new FormData();
      fd.append("file", new Blob([out.file.data as BlobPart], { type: out.file.mime }), out.file.filename);
      if (out.preview) fd.append("preview", new Blob([out.preview.data as BlobPart], { type: out.preview.mime }), out.preview.filename);
      const res = await fetchFn(url(`/mind/makes/${encodeURIComponent(id)}/rendered`), {
        method: "POST", headers: headers(), body: fd, signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`makes rendered -> ${res.status}`);
    },
    async postFailed(id, reason) {
      const res = await fetchFn(url(`/mind/makes/${encodeURIComponent(id)}/rendered`), {
        method: "POST", headers: headers(true), body: JSON.stringify({ failed: true, reason: reason.slice(0, 200) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`makes failed-post -> ${res.status}`);
    },
  };
}

/** GET /mind/interests/:companion (exists). Throws on failure so the caller can fail soft. */
export async function getInterests(companionId: string, fetchFn: FetchFn = fetch, base: string = HALSETH_URL): Promise<InterestRow[]> {
  const res = await fetchFn(`${base}/mind/interests/${encodeURIComponent(companionId)}`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`interests -> ${res.status}`);
  const b = await res.json() as { interests?: InterestRow[] };
  return Array.isArray(b.interests) ? b.interests : [];
}
