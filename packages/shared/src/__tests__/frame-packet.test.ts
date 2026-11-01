import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  FramePacket, readFramePacketMode, looksHealthRelated, sparkIndex, frameLogLine, announceFramePacket,
  librarianFrameSources, FRAME_TOTAL_CAP, __resetFramePacketWarnings, type FrameSources,
} from "../frame-packet.js";
import { hermesDelta } from "../prompt-assembly.js";

const ok = (v: string[]) => async () => v;
const mk = (o: Partial<FrameSources> = {}): FrameSources => ({
  tasks: ok([]), projects: ok([]), spark: ok([]), calendar: null, ...o,
});
const NOW = Date.UTC(2026, 10, 1, 18, 0, 0);
const envOf = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("frame packet", () => {
  beforeEach(() => __resetFramePacketWarnings());

  it("mode defaults to shadow; junk falls to shadow", () => {
    expect(readFramePacketMode(envOf({}))).toBe("shadow");
    expect(readFramePacketMode(envOf({ FRAME_PACKET: " ON " }))).toBe("on");
    expect(readFramePacketMode(envOf({ FRAME_PACKET: "off" }))).toBe("off");
    expect(readFramePacketMode(envOf({ FRAME_PACKET: "wat" }))).toBe("shadow");
  });

  it("omits empty fields and renders nothing when all are empty", async () => {
    const r = await new FramePacket({ sources: mk(), companion: "cypher" }).build(NOW);
    expect(r.text).toBeNull();
    expect(r.fields).toEqual([]);
    const r2 = await new FramePacket({ sources: mk({ tasks: ok(["Ship the thing"]) }), companion: "cypher" }).build(NOW);
    expect(r2.text).toBe("[Right now]\nOpen tasks: Ship the thing");
    expect(r2.fields).toEqual(["tasks"]);
  });

  it("bounds tasks (3, 60 chars) and projects (2)", async () => {
    const long = "x".repeat(200);
    const r = await new FramePacket({
      sources: mk({ tasks: ok([long, "b", "c", "d"]), projects: ok(["p1", "p2", "p3"]) }), companion: "c",
    }).build(NOW);
    const tasks = r.text!.split("\n").find(l => l.startsWith("Open tasks"))!;
    expect(tasks.split("; ")).toHaveLength(3);
    expect(tasks.split("; ")[0]!.length).toBeLessThanOrEqual("Open tasks: ".length + 60);
    expect(r.text).toContain("Your projects: p1; p2");
    expect(r.text).not.toContain("p3");
  });

  it("a failed source renders a short marker, not a blank; empty stays omitted", async () => {
    const r = await new FramePacket({
      sources: mk({ tasks: async () => null, projects: async () => { throw new Error("boom"); } }), companion: "c",
    }).build(NOW);
    expect(r.text).toContain("Open tasks: (tasks unavailable)");
    expect(r.text).toContain("Your projects: (projects unavailable)");
    expect(r.text).not.toContain("Spark");
  });

  it("a slow source does not block: marker now, value once it lands", async () => {
    let release!: (v: string[]) => void;
    const slow = () => new Promise<string[]>(res => { release = res; });
    const p = new FramePacket({ sources: mk({ tasks: slow }), companion: "c", sourceTimeoutMs: 20 });
    expect((await p.build(NOW)).text).toContain("(tasks unavailable)");
    release(["Late task"]);
    await new Promise(res => setTimeout(res, 5));
    expect((await p.build(NOW + 1000)).text).toContain("Late task");
  });

  it("drops health-looking titles", async () => {
    expect(looksHealthRelated("Refill meds")).toBe(true);
    expect(looksHealthRelated("Call the doctor")).toBe(true);
    expect(looksHealthRelated("Fix the Hearth archive page")).toBe(false);
    const r = await new FramePacket({
      sources: mk({ tasks: ok(["Refill meds", "Ship frame packet", "Check glucose log", "Dr. appointment"]) }), companion: "c",
    }).build(NOW);
    expect(r.text).toBe("[Right now]\nOpen tasks: Ship frame packet");
  });

  it("an all-health task list omits the field (not a failure marker)", async () => {
    const r = await new FramePacket({ sources: mk({ tasks: ok(["Take meds"]) }), companion: "c" }).build(NOW);
    expect(r.text).toBeNull();
  });

  it("spark rotates per hour and is cached", async () => {
    let calls = 0;
    const pool = ["a one", "b two", "c three"];
    const p = new FramePacket({ sources: mk({ spark: async () => { calls++; return pool; } }), companion: "c", cacheTtlMs: 4 * 3_600_000 });
    const seen = new Set<string>();
    for (let h = 0; h < 3; h++) seen.add((await p.build(NOW + h * 3_600_000)).text!);
    expect(seen.size).toBe(3);
    expect(calls).toBe(1);
    expect(sparkIndex(NOW, 3)).toBe(Math.floor(NOW / 3_600_000) % 3);
  });

  it("calendar slot: no reader renders nothing and boot says so; a reader renders", async () => {
    const lines: string[] = [];
    expect(announceFramePacket({ calendar: null }, m => lines.push(m))).toEqual(["[frame] calendar source not configured"]);
    expect(lines).toEqual(["[frame] calendar source not configured"]);
    expect(announceFramePacket({ calendar: ok([]) }, m => lines.push(m))).toEqual([]);
    const r = await new FramePacket({ sources: mk({ calendar: ok(["Free day", "Movie night 8pm"]) }), companion: "c" }).build(NOW);
    expect(r.text).toContain("Calendar: Free day; Movie night 8pm");
  });

  it("hard cap: never over 500 chars, whole fields dropped from the tail", async () => {
    const big = (n: string) => Array.from({ length: 5 }, (_, i) => `${n}${i} ${"w".repeat(80)}`);
    const r = await new FramePacket({
      sources: mk({ tasks: ok(big("t")), projects: ok(big("p")), spark: ok(big("s")), calendar: ok(big("c")) }), companion: "c",
    }).build(NOW);
    expect(r.chars).toBeLessThanOrEqual(FRAME_TOTAL_CAP);
    expect(r.text!.length).toBe(r.chars);
    expect(r.fields[0]).toBe("tasks");
    expect(r.fields).not.toContain("calendar");
  });

  it("log line carries names and counts, never text", async () => {
    const r = await new FramePacket({ sources: mk({ tasks: ok(["SECRETTITLE"]) }), companion: "c" }).build(NOW);
    const line = frameLogLine("cypher", r);
    expect(line).toBe(`[frame] cypher fields=tasks chars=${r.chars}`);
    expect(line).not.toContain("SECRETTITLE");
  });

  it("librarian sources: tasks skip companion-assigned; projects open only; null = failure", async () => {
    const lib = {
      listTasks: async () => [
        { id: "1", title: "Raz task", priority: "normal", status: "open", due_at: null, assigned_to: "raziel" },
        { id: "2", title: "Cy task", priority: "urgent", status: "open", due_at: null, assigned_to: "cypher" },
        { id: "3", title: "Unassigned", priority: "low", status: "in_progress", due_at: null, assigned_to: null },
      ],
      botOrient: async () => ({
        projects: [
          { id: "a", title: "Open one", intention: "", status: "open", days_idle: 1, stale: false },
          { id: "b", title: "Paused", intention: "", status: "paused", days_idle: 1, stale: false },
        ],
        forage_finds: [{ id: "f", title: "A find", domain: "d", summary: "" }],
      }),
    } as never;
    const s = librarianFrameSources(lib);
    expect(await s.tasks()).toEqual(["Raz task", "Unassigned"]);
    expect(await s.projects()).toEqual(["Open one"]);
    expect(await s.spark()).toEqual(["a find: A find"]);
    const dead = librarianFrameSources({ listTasks: async () => null, botOrient: async () => null } as never);
    expect(await dead.tasks()).toBeNull();
    expect(await dead.projects()).toBeNull();
  });
});

describe("hermesDelta ordering", () => {
  const history = [{ role: "user", content: "hello there", authorName: "Raziel", timestamp: NOW }];
  it("[Right now] sits after the live words, above facts and the speaker frame (frame LAST)", () => {
    const out = hermesDelta(history, null, NOW, false, null, {
      rightNow: "[Right now]\nOpen tasks: x", facts: "[Architect facts relevant here]\nf", frame: "[You are Cypher.]",
    }).messages[0]!.content;
    const iLive = out.indexOf("hello there");
    const iRight = out.indexOf("[Right now]");
    const iFacts = out.indexOf("[Architect facts");
    const iFrame = out.indexOf("[You are Cypher.]");
    expect(iLive).toBeGreaterThan(-1);
    expect(iLive).toBeLessThan(iRight);
    expect(iRight).toBeLessThan(iFacts);
    expect(iFacts).toBeLessThan(iFrame);
    expect(out.trimEnd().endsWith("[You are Cypher.]")).toBe(true);
  });
  it("shadow does not inject: no rightNow extra means no block", () => {
    const out = hermesDelta(history, null, NOW, false, null, { frame: "[You are Cypher.]" }).messages[0]!.content;
    expect(out).not.toContain("[Right now]");
  });
});
