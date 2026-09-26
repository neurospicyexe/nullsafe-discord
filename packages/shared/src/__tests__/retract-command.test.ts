// `<prefix>: retract` (2026-09-26). One gesture, three stores, all reversible on the Halseth side.
//
// The night this was built: Drevan fabricated a blood-sugar number; within a minute it was in his
// journal (twice), his continuity notes, and the vault, and his own recall returned it ranked first.
// Cleaning it took hand-written SQL. Raziel: "we really do need a way to delete things for when
// shit goes wrong like this."
import { handleRetractCommand, retractKeys } from "../retract-command.js";

type Call = { url: string; body: Record<string, unknown>; auth: string | undefined };
function fakeFetch(responses: Record<string, { status: number; json: unknown } | Error>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body, auth: headers["Authorization"] });
    const key = Object.keys(responses).find(k => url.endsWith(k));
    const r = key ? responses[key]! : { status: 404, json: { error: "no route" } };
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.json, text: async () => JSON.stringify(r.json) } as Response;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
const base = {
  companionId: "drevan",
  channelId: "1497734427298762828",
  botMessageId: "1553286622601023586",
  userMessageId: "1553286543223816244" as string | null,
  halseth: { base: "https://h.example", secret: "drevan-secret" },
  secondBrain: { base: "https://sb.example", key: "sb-key" } as { base: string; key: string } | null,
};

describe("retractKeys", () => {
  it("keys every writer that could have memorialised the exchange", () => {
    expect(retractKeys("BOT", "USER")).toEqual({
      external_ids: ["discord:BOT", "judge:USER"],
      correlation_ids: ["judge:USER"],
    });
  });
  it("without a known user message, keys the reply alone", () => {
    expect(retractKeys("BOT", null)).toEqual({ external_ids: ["discord:BOT"], correlation_ids: [] });
  });
});

describe("handleRetractCommand", () => {
  it("archives in Halseth with a reason, drops the vault doc, and acks with the numbers", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1", "j2"], notes: ["n1"] }, release_ids: ["r1", "r2", "r3"] } },
      "/retract": { status: 200, json: { path: "discord-live/1497734427298762828/1553286622601023586.md", removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    expect(calls).toHaveLength(2);
    const [h, sb] = calls;
    expect(h!.url).toBe("https://h.example/admin/retract");
    expect(h!.auth).toBe("Bearer drevan-secret");
    expect(h!.body).toMatchObject({
      agent: "drevan",
      external_ids: ["discord:1553286622601023586", "judge:1553286543223816244"],
      correlation_ids: ["judge:1553286543223816244"],
    });
    expect(String(h!.body["reason"])).toContain("Raziel retracted");
    expect(sb!.url).toBe("https://sb.example/retract");
    expect(sb!.auth).toBe("Bearer sb-key");
    expect(sb!.body).toEqual({ channel_id: "1497734427298762828", message_id: "1553286622601023586" });
    expect(ack).toContain("2 journal");
    expect(ack).toContain("1 note");
    expect(ack).toContain("vault: dropped");
    expect(ack).toContain("restore release");
    expect(ack).not.toMatch(/[—–]/);
  });
  it("says plainly when nothing was found, and still tries the vault", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: [], notes: [] }, release_ids: [] } },
      "/retract": { status: 200, json: { removed: 0, existed: false } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    expect(calls).toHaveLength(2);
    expect(ack).toContain("nothing to archive");
    expect(ack).toContain("vault: nothing there");
  });
  it("reports a Halseth failure and does not pretend the vault half means the whole thing worked", async () => {
    const { fn } = fakeFetch({
      "/admin/retract": new Error("ECONNRESET"),
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    expect(ack).toContain("halseth: FAILED");
    expect(ack).toContain("vault: dropped");
  });
  it("without Second Brain configured, does the Halseth half and says the vault was not reached", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1"], notes: [] }, release_ids: ["r1"] } },
    });
    const ack = await handleRetractCommand({ ...base, secondBrain: null, fetchFn: fn });
    expect(calls).toHaveLength(1);
    expect(ack).toContain("vault: not configured");
  });
});
