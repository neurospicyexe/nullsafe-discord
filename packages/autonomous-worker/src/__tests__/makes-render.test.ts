import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sanitizeSvg, scadProblem, decodeDataUrl, clampDuration, renderMake, runRenderTick, RenderFail,
  type RenderDeps, type ExecFn,
} from "../makes-render.js";
import { normalizePending, normalizeParams, type MakesClient, type PendingMake } from "../makes-client.js";

const job = (over: Partial<PendingMake>): PendingMake => ({ id: "a".repeat(32), companion_id: "cypher", kind: "drawing", params: null, source_key: null, ...over });

const base = (p: string) => p.split("\\").join("/").split("/").pop()!;

function mkDeps(over: Partial<RenderDeps> & { source?: string } = {}) {
  const files = new Map<string, string | Uint8Array>();
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const removed: string[] = [];
  const client: MakesClient = {
    getPending: vi.fn(async () => []),
    getSource: vi.fn(async () => over.source ?? "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>"),
    postRendered: vi.fn(async () => {}),
    postFailed: vi.fn(async () => {}),
  };
  const exec: ExecFn = vi.fn(async (file, args, o) => {
    calls.push({ file, args, timeoutMs: o.timeoutMs });
    const out = args[args.indexOf("-o") + 1];
    if (out) files.set(out, new Uint8Array([1, 2, 3]));
  });
  const deps: RenderDeps = {
    client, exec,
    fetchFn: vi.fn() as never,
    makeTmp: async () => "/tmp/x",
    removeTmp: async (d) => { removed.push(d); },
    readFile: async (p) => { const v = files.get(base(p)); if (!v) throw new Error("ENOENT"); return typeof v === "string" ? new TextEncoder().encode(v) : v; },
    writeFile: async (p, d) => { files.set(base(p), d); },
    deepinfraKey: () => "test-key",
    ...over,
  };
  return { deps, calls, removed, files, client };
}

describe("sanitizeSvg", () => {
  it("strips scripts, handlers, foreignObject, external hrefs and url()", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>alert(1)</script>` +
      `<foreignObject><div>hi</div></foreignObject><image href="http://evil/x.png"/><a xlink:href="#ok"/>` +
      `<rect style="fill:url(http://evil/p)" onclick='y()'/></svg>`;
    const out = sanitizeSvg(dirty)!;
    expect(out).not.toMatch(/script|onload|onclick|foreignObject|evil/i);
    expect(out).toContain('xlink:href="#ok"');
    expect(out).toContain("<rect");
  });
  it("strips DOCTYPE/ENTITY", () => {
    const out = sanitizeSvg(`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>`)!;
    expect(out).not.toMatch(/ENTITY|DOCTYPE|passwd/);
  });
  it("returns null for a non-svg", () => {
    expect(sanitizeSvg("<html></html>")).toBeNull();
  });
});

describe("scadProblem", () => {
  it("denies include/use/import/surface", () => {
    for (const kw of ["include <x.scad>;", "use <x.scad>;", 'import("a.stl");', 'surface(file="a.png");']) {
      expect(scadProblem(`cube(1); ${kw}`)).toMatch(/blocked/);
    }
  });
  it("denies $fn above 128 and allows 128", () => {
    expect(scadProblem("sphere(5, $fn=129);")).toMatch(/\$fn/);
    expect(scadProblem("sphere(5, $fn = 128);")).toBeNull();
  });
  it("denies over 64 KB", () => {
    expect(scadProblem("a".repeat(64 * 1024 + 1))).toMatch(/large/);
  });
  it("passes plain scad", () => {
    expect(scadProblem("difference(){cube(10);sphere(6);}")).toBeNull();
  });
});

describe("decodeDataUrl / clampDuration", () => {
  it("decodes a base64 data URL", () => {
    const d = decodeDataUrl("data:audio/mp3;base64," + Buffer.from("hello").toString("base64"))!;
    expect(d.mime).toBe("audio/mp3");
    expect(d.data.toString()).toBe("hello");
  });
  it("rejects junk", () => {
    expect(decodeDataUrl("https://x/y.mp3")).toBeNull();
    expect(decodeDataUrl(42)).toBeNull();
    expect(decodeDataUrl("data:audio/mp3;base64,")).toBeNull();
  });
  it("clamps duration to 30..120", () => {
    expect(clampDuration(5)).toBe(30);
    expect(clampDuration(500)).toBe(120);
    expect(clampDuration("60")).toBe(60);
    expect(clampDuration(undefined)).toBe(30);
  });
});

describe("renderMake", () => {
  it("drawing: sanitizes, runs rsvg-convert with timeout, removes the temp dir", async () => {
    const { deps, calls, removed } = mkDeps({ source: "<svg onload='x()'><rect/></svg>" });
    const out = await renderMake(job({ kind: "drawing" }), deps);
    expect(out.file.mime).toBe("image/png");
    expect(calls[0]).toMatchObject({ file: "rsvg-convert", timeoutMs: 30_000 });
    expect(calls[0]!.args).toEqual(["-w", "1024", "source.svg", "-o", "file.png"]);
    expect(removed).toEqual(["/tmp/x"]);
  });
  it("drawing: a non-svg fails without running anything", async () => {
    const { deps, calls, removed } = mkDeps({ source: "<p>nope</p>" });
    await expect(renderMake(job({ kind: "drawing" }), deps)).rejects.toMatchObject({ reason: "not an svg" });
    expect(calls).toHaveLength(0);
    expect(removed).toEqual(["/tmp/x"]);
  });
  it("drawing: the exec timeout becomes a short reason, no stderr", async () => {
    const { deps } = mkDeps();
    deps.exec = vi.fn(async () => { throw Object.assign(new Error("Command failed: timeout ... SECRET STDERR"), { code: 124 }); });
    const err = await renderMake(job({ kind: "drawing" }), deps).catch(e => e as RenderFail);
    expect(err.reason).toBe("svg did not render");
    expect(err.reason).not.toMatch(/STDERR/);
  });
  it("scad: denied source never reaches openscad", async () => {
    const { deps, calls } = mkDeps({ source: "include <evil.scad>; cube(1);" });
    await expect(renderMake(job({ kind: "scad" }), deps)).rejects.toMatchObject({ reason: "scad uses a blocked keyword" });
    expect(calls).toHaveLength(0);
  });
  it("scad: STL then preview with the input file FIRST, under timeout", async () => {
    const { deps, calls } = mkDeps({ source: "cube(10);" });
    const out = await renderMake(job({ kind: "scad" }), deps);
    expect(out.file.mime).toBe("model/stl");
    expect(out.preview?.mime).toBe("image/png");
    expect(calls[0]).toMatchObject({ file: "openscad", timeoutMs: 60_000 });
    expect(calls[0]!.args).toEqual(["source.scad", "-o", "file.stl"]);
    expect(calls[1]!.file).toBe("xvfb-run");
    expect(calls[1]!.args).toEqual(["-a", "openscad", "source.scad", "-o", "preview.png", "--imgsize=512,512", "--autocenter", "--viewall", "--render"]);
  });
  it("scad: a failed preview still ships the STL", async () => {
    const { deps } = mkDeps({ source: "cube(10);" });
    let n = 0;
    const inner = deps.exec;
    deps.exec = vi.fn(async (f, a, o) => { if (++n === 2) throw new Error("no display"); return inner(f, a, o); });
    const out = await renderMake(job({ kind: "scad" }), deps);
    expect(out.file.mime).toBe("model/stl");
    expect(out.preview).toBeUndefined();
  });
  it("scad: STL failure is a failed make", async () => {
    const { deps } = mkDeps({ source: "cube(10);" });
    deps.exec = vi.fn(async () => { throw new Error("killed"); });
    await expect(renderMake(job({ kind: "scad" }), deps)).rejects.toMatchObject({ reason: "openscad did not finish" });
  });
  it("music_audio: posts ACE-Step params, clamps duration, decodes the data URL", async () => {
    const { deps } = mkDeps();
    const f = vi.fn(async () => new Response(JSON.stringify({ audio: "data:audio/mp3;base64," + Buffer.from("MP3DATA").toString("base64") }), { status: 200 }));
    deps.fetchFn = f as never;
    const out = await renderMake(job({ kind: "music_audio", params: { prompt: "slow piano", duration: 999, instrumental: true } }), deps);
    expect(Buffer.from(out.file.data).toString()).toBe("MP3DATA");
    expect(out.file.mime).toBe("audio/mpeg");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("ACE-Step/acestep-v15-xl-sft");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ prompt: "slow piano", duration: 120, instrumental: true, response_format: "mp3" });
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("bearer test-key");
  });
  it("music_audio: a reply with no audio, a 500, a missing key and a missing prompt all fail short", async () => {
    const a = mkDeps();
    a.deps.fetchFn = (async () => new Response(JSON.stringify({}), { status: 200 })) as never;
    await expect(renderMake(job({ kind: "music_audio", params: { prompt: "x" } }), a.deps)).rejects.toMatchObject({ reason: "music reply had no audio" });
    const b = mkDeps();
    b.deps.fetchFn = (async () => new Response("boom", { status: 500 })) as never;
    await expect(renderMake(job({ kind: "music_audio", params: { prompt: "x" } }), b.deps)).rejects.toMatchObject({ reason: "music service 500" });
    const c = mkDeps({ deepinfraKey: () => "" });
    await expect(renderMake(job({ kind: "music_audio", params: { prompt: "x" } }), c.deps)).rejects.toMatchObject({ reason: "music key missing" });
    const d = mkDeps();
    await expect(renderMake(job({ kind: "music_audio", params: {} }), d.deps)).rejects.toMatchObject({ reason: "no music prompt" });
  });
  it("video: portrait by default, landscape for 16:9, downloads a relative url", async () => {
    const { deps } = mkDeps();
    const f = vi.fn(async (u: string) => u.includes("/v1/inference/")
      ? new Response(JSON.stringify({ video_url: "/model/inference/x.mp4" }), { status: 200 })
      : new Response(new Uint8Array([9, 9, 9]), { status: 200 }));
    deps.fetchFn = f as never;
    const out = await renderMake(job({ kind: "video", params: { prompt: "a crow at dusk" } }), deps);
    expect(out.file.mime).toBe("video/mp4");
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ orientation: "portrait", seconds: 5 });
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe("https://api.deepinfra.com/model/inference/x.mp4");
    await renderMake(job({ kind: "video", params: { prompt: "p", aspect: "16:9" } }), deps);
    expect(JSON.parse((f.mock.calls[2] as unknown as [string, RequestInit])[1].body as string).orientation).toBe("landscape");
  });
  it("writing/page/music_code are not the renderer's", async () => {
    const { deps } = mkDeps();
    await expect(renderMake(job({ kind: "writing" }), deps)).rejects.toBeInstanceOf(RenderFail);
  });
});

describe("runRenderTick", () => {
  beforeEach(() => { delete process.env["MAKES_RENDERER"]; });
  it("posts the render on success and a short failure on error, one at a time", async () => {
    const { deps, client } = mkDeps();
    const order: string[] = [];
    client.getPending = vi.fn(async () => [job({ id: "1".repeat(32), kind: "drawing" }), job({ id: "2".repeat(32), kind: "scad" })]);
    client.getSource = vi.fn(async (id: string) => id.startsWith("1") ? "<svg><rect/></svg>" : "include <x>;");
    client.postRendered = vi.fn(async (id) => { order.push(`ok:${id[0]}`); });
    client.postFailed = vi.fn(async (id, reason) => { order.push(`fail:${id[0]}:${reason}`); });
    const n = await runRenderTick(deps);
    expect(n).toBe(2);
    expect(order).toEqual(["ok:1", "fail:2:scad uses a blocked keyword"]);
  });
  it("is a no-op when MAKES_RENDERER=off", async () => {
    process.env["MAKES_RENDERER"] = "off";
    const { deps, client } = mkDeps();
    expect(await runRenderTick(deps)).toBe(0);
    expect(client.getPending).not.toHaveBeenCalled();
  });
  it("survives a pending-fetch failure", async () => {
    const { deps, client } = mkDeps();
    client.getPending = vi.fn(async () => { throw new Error("makes pending -> 500"); });
    expect(await runRenderTick(deps)).toBe(0);
  });
  it("does not stack: a second tick during a slow one returns 0", async () => {
    const { deps, client } = mkDeps();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    client.getPending = vi.fn(async () => { await gate; return []; });
    const first = runRenderTick(deps);
    expect(await runRenderTick(deps)).toBe(0);
    release();
    await first;
    expect(client.getPending).toHaveBeenCalledTimes(1);
  });
});

describe("makes-client normalizers", () => {
  it("accepts bare, wrapped and string params", () => {
    const row = { id: "x", kind: "video", companion_id: "drevan", params: '{"prompt":"p"}', source_key: null };
    expect(normalizePending([row])[0]!.params).toEqual({ prompt: "p" });
    expect(normalizePending({ makes: [row] })).toHaveLength(1);
    expect(normalizePending({ pending: [row] })).toHaveLength(1);
    expect(normalizePending({ nope: 1 })).toEqual([]);
    expect(normalizeParams("not json")).toBeNull();
  });
});
