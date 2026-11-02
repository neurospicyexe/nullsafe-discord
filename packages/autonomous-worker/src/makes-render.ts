// makes-render.ts -- the VPS renderer for B62 makes (spec 2026-11-02).
// Pulls pending makes from Halseth and renders them: drawing (rsvg-convert), scad (openscad STL + PNG
// preview), music_audio (DeepInfra ACE-Step), video (DeepInfra FastWan2.2). Runs in the autonomous-worker
// on a 2 minute cron, one make at a time. Every external binary and the network are injectable so the
// tests run on Windows without them. Failure posts {failed, reason} with a SHORT reason, never stderr.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMakesClient, normalizeParams, type MakesClient, type PendingMake, type RenderedFile } from "./makes-client.js";

export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number; cwd: string }) => Promise<void>;

export interface RenderDeps {
  client: MakesClient;
  exec: ExecFn;
  fetchFn: typeof fetch;
  /** Make a fresh temp dir; the renderer removes it afterwards. */
  makeTmp: () => Promise<string>;
  removeTmp: (dir: string) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  deepinfraKey: () => string;
}

export const MAX_SOURCE_BYTES = 64 * 1024;
const ACE_URL = "https://api.deepinfra.com/v1/inference/ACE-Step/acestep-v15-xl-sft";
const VIDEO_URL = "https://api.deepinfra.com/v1/inference/FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers";
const DEEPINFRA_ORIGIN = "https://api.deepinfra.com";

export class RenderFail extends Error {
  constructor(public reason: string) { super(reason); }
}

/** The real thing: execFile with an argument array (no shell), wrapped in `timeout -k` so a stuck child dies. */
export const realExec: ExecFn = (file, args, { timeoutMs, cwd }) =>
  new Promise((resolve, reject) => {
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    execFile("timeout", ["-k", "5", String(secs), file, ...args], { cwd, timeout: timeoutMs + 10_000, maxBuffer: 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()));
  });

export function realDeps(): RenderDeps {
  return {
    client: createMakesClient(),
    exec: realExec,
    fetchFn: fetch,
    makeTmp: () => mkdtemp(join(tmpdir(), "make-")),
    removeTmp: (d) => rm(d, { recursive: true, force: true }),
    readFile: (p) => readFile(p),
    writeFile: (p, d) => writeFile(p, d),
    deepinfraKey: () => (process.env["DEEPINFRA_API_KEY"] ?? "").trim().replace(/^=+/, ""),
  };
}

// ---------------------------------------------------------------------------
// Pure guards
// ---------------------------------------------------------------------------

/**
 * Strip what makes an SVG active or external before it meets rsvg-convert: scripts, event handlers,
 * foreignObject, DOCTYPE/ENTITY (XXE), and any href / url() that is not an in-document #fragment or an
 * inline data: image. Returns null when it is not an SVG document at all.
 */
export function sanitizeSvg(src: string): string | null {
  if (!/<svg[\s>]/i.test(src)) return null;
  let s = src;
  s = s.replace(/<!DOCTYPE[\s\S]*?(\]>|>)/gi, "").replace(/<!ENTITY[\s\S]*?>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, "").replace(/<script[\s\S]*$/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "").replace(/<foreignObject[\s\S]*$/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // href / xlink:href: keep only #fragment and inline data:image targets.
  s = s.replace(/\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, a?: string, b?: string) => {
    const v = (a ?? b ?? "").trim();
    return v.startsWith("#") || /^data:image\/(png|jpe?g|gif|webp);/i.test(v) ? m : "";
  });
  s = s.replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, (m) => (/^url\(\s*['"]?data:image\//i.test(m) ? m : "none"));
  s = s.replace(/@import[^;]*;?/gi, "");
  return /<svg[\s>]/i.test(s) ? s : null;
}

const SCAD_DENY = /\b(include|use|import|surface)\b/;

/** null = fine; otherwise a short reason. */
export function scadProblem(src: string): string | null {
  if (Buffer.byteLength(src, "utf8") > MAX_SOURCE_BYTES) return "scad source too large";
  if (SCAD_DENY.test(src)) return "scad uses a blocked keyword";
  for (const m of src.matchAll(/\$fn\s*=\s*(\d+(?:\.\d+)?)/g)) {
    if (Number(m[1]) > 128) return "scad $fn above 128";
  }
  return null;
}

/** Decode a `data:<mime>;base64,<payload>` string. null when it is not one. */
export function decodeDataUrl(s: unknown): { mime: string; data: Buffer } | null {
  if (typeof s !== "string") return null;
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(s.trim());
  if (!m) return null;
  const data = Buffer.from(m[2]!, "base64");
  return data.length > 0 ? { mime: m[1]!, data } : null;
}

export function clampDuration(d: unknown): number {
  const n = typeof d === "number" ? d : Number(d);
  if (!Number.isFinite(n)) return 30;
  return Math.min(120, Math.max(30, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export interface Rendered { file: RenderedFile; preview?: RenderedFile }

async function renderDrawing(src: string, dir: string, d: RenderDeps): Promise<Rendered> {
  const clean = sanitizeSvg(src);
  if (!clean) throw new RenderFail("not an svg");
  await d.writeFile(join(dir, "source.svg"), clean);
  try {
    await d.exec("rsvg-convert", ["-w", "1024", "source.svg", "-o", "file.png"], { timeoutMs: 30_000, cwd: dir });
  } catch { throw new RenderFail("svg did not render"); }
  return { file: { data: await d.readFile(join(dir, "file.png")), mime: "image/png", filename: "file.png" } };
}

async function renderScad(src: string, dir: string, d: RenderDeps): Promise<Rendered> {
  const bad = scadProblem(src);
  if (bad) throw new RenderFail(bad);
  await d.writeFile(join(dir, "source.scad"), src);
  try {
    await d.exec("openscad", ["source.scad", "-o", "file.stl"], { timeoutMs: 60_000, cwd: dir });
  } catch { throw new RenderFail("openscad did not finish"); }
  const out: Rendered = { file: { data: await d.readFile(join(dir, "file.stl")), mime: "model/stl", filename: "file.stl" } };
  // A failed preview still ships the STL.
  try {
    await d.exec("xvfb-run", ["-a", "openscad", "source.scad", "-o", "preview.png", "--imgsize=512,512", "--autocenter", "--viewall", "--render"],
      { timeoutMs: 60_000, cwd: dir });
    out.preview = { data: await d.readFile(join(dir, "preview.png")), mime: "image/png", filename: "preview.png" };
  } catch {
    console.warn("[makes] scad preview failed; shipping the STL alone");
  }
  return out;
}

async function renderMusic(params: Record<string, unknown> | null, d: RenderDeps): Promise<Rendered> {
  const prompt = typeof params?.["prompt"] === "string" ? (params["prompt"] as string).trim() : "";
  if (!prompt) throw new RenderFail("no music prompt");
  const key = d.deepinfraKey();
  if (!key) throw new RenderFail("music key missing");
  const lyrics = typeof params?.["lyrics"] === "string" ? (params["lyrics"] as string).trim() : "";
  const body: Record<string, unknown> = {
    prompt: prompt.slice(0, 1000),
    duration: clampDuration(params?.["duration"]),
    instrumental: params?.["instrumental"] === undefined ? !lyrics : Boolean(params["instrumental"]),
    response_format: "mp3",
  };
  if (lyrics) body["lyrics"] = lyrics.slice(0, 4000);
  let res: Response;
  try {
    res = await d.fetchFn(ACE_URL, {
      method: "POST", headers: { Authorization: `bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
  } catch { throw new RenderFail("music service unreachable"); }
  if (!res.ok) throw new RenderFail(`music service ${res.status}`);
  const j = await res.json().catch(() => null) as { audio?: unknown } | null;
  const dec = decodeDataUrl(j?.audio);
  if (!dec) throw new RenderFail("music reply had no audio");
  return { file: { data: dec.data, mime: "audio/mpeg", filename: "file.mp3" } };
}

async function renderVideo(params: Record<string, unknown> | null, d: RenderDeps): Promise<Rendered> {
  const prompt = typeof params?.["prompt"] === "string" ? (params["prompt"] as string).trim() : "";
  if (!prompt) throw new RenderFail("no video prompt");
  const key = d.deepinfraKey();
  if (!key) throw new RenderFail("video key missing");
  // 9:16 is the default (TikTok-ready); FastWan takes orientation portrait|landscape.
  const orientation = params?.["aspect"] === "16:9" ? "landscape" : "portrait";
  let res: Response;
  try {
    res = await d.fetchFn(VIDEO_URL, {
      method: "POST", headers: { Authorization: `bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 1500), seconds: 5, resolution: "720p", orientation }),
      signal: AbortSignal.timeout(240_000),
    });
  } catch { throw new RenderFail("video service unreachable"); }
  if (!res.ok) throw new RenderFail(`video service ${res.status}`);
  const j = await res.json().catch(() => null) as { video_url?: unknown } | null;
  const u = j?.video_url;
  if (typeof u !== "string" || !u) throw new RenderFail("video reply had no url");
  let bytes: Uint8Array;
  const inline = decodeDataUrl(u);
  if (inline) bytes = inline.data;
  else {
    const abs = /^https:\/\//i.test(u) ? u : u.startsWith("/") ? `${DEEPINFRA_ORIGIN}${u}` : null;
    if (!abs) throw new RenderFail("video url not usable");
    try {
      const v = await d.fetchFn(abs, { signal: AbortSignal.timeout(120_000) });
      if (!v.ok) throw new Error("status");
      bytes = new Uint8Array(await v.arrayBuffer());
    } catch { throw new RenderFail("video download failed"); }
  }
  if (bytes.length === 0) throw new RenderFail("video was empty");
  return { file: { data: bytes, mime: "video/mp4", filename: "file.mp4" } };
}

/** Render one make. Throws RenderFail with a short reason; the temp dir is always removed. */
export async function renderMake(job: PendingMake, d: RenderDeps): Promise<Rendered> {
  const dir = await d.makeTmp();
  try {
    switch (job.kind) {
      case "drawing": return await renderDrawing(await d.client.getSource(job.id), dir, d);
      case "scad": return await renderScad(await d.client.getSource(job.id), dir, d);
      case "music_audio": return await renderMusic(normalizeParams(job.params), d);
      case "video": return await renderVideo(normalizeParams(job.params), d);
      default: throw new RenderFail(`kind ${job.kind} is not rendered here`);
    }
  } finally {
    await d.removeTmp(dir).catch(() => {});
  }
}

let ticking = false;

/**
 * One renderer tick: fetch the oldest pending makes and render them one at a time. Reentrancy-guarded
 * (a slow video must not stack a second tick). Returns how many makes it settled.
 */
export async function runRenderTick(d: RenderDeps = realDeps(), limit = 3): Promise<number> {
  if ((process.env["MAKES_RENDERER"] ?? "").trim().toLowerCase() === "off") return 0;
  if (ticking) return 0;
  ticking = true;
  let settled = 0;
  try {
    let jobs: PendingMake[];
    try { jobs = await d.client.getPending(limit); }
    catch (e) { console.warn(`[makes] pending fetch failed: ${e instanceof Error ? e.message : String(e)}`); return 0; }
    for (const job of jobs.slice(0, limit)) {
      const t0 = Date.now();
      try {
        const out = await renderMake(job, d);
        await d.client.postRendered(job.id, out);
        console.log(`[makes] ${job.id.slice(0, 8)} ${job.companion_id}/${job.kind} ready in ${Date.now() - t0}ms`);
      } catch (e) {
        const reason = e instanceof RenderFail ? e.reason : "render failed";
        console.warn(`[makes] ${job.id.slice(0, 8)} ${job.companion_id}/${job.kind} failed: ${reason}`);
        await d.client.postFailed(job.id, reason).catch((pe) =>
          console.warn(`[makes] ${job.id.slice(0, 8)} could not post failure: ${pe instanceof Error ? pe.message : String(pe)}`));
      }
      settled++;
    }
  } finally {
    ticking = false;
  }
  return settled;
}
