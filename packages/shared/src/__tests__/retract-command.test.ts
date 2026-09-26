// `<prefix>: retract` (2026-09-26). One gesture, three stores, all reversible on the Halseth side.
//
// The night this was built: Drevan fabricated a blood-sugar number; within a minute it was in his
// journal (twice), his continuity notes, and the vault, and his own recall returned it ranked first.
// Cleaning it took hand-written SQL. Raziel: "we really do need a way to delete things for when
// shit goes wrong like this."
import {
  handleRetractCommand, retractKeys, executeRetract, reconstructReply, CHUNK_GAP_MS,
  type RetractMsg, type ExecuteRetractDeps,
} from "../retract-command.js";
import { ReplyIndex, type ReplyIndexStore } from "../reply-index.js";
import { RetractBumps } from "../retract-bumps.js";
import { StmStore } from "../stm.js";

type Call = { url: string; body: Record<string, unknown>; auth: string | undefined };
type Resp = { status: number; json: unknown } | Error | ((body: Record<string, unknown>) => { status: number; json: unknown });
function fakeFetch(responses: Record<string, Resp>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body, auth: headers["Authorization"] });
    const key = Object.keys(responses).find(k => url.endsWith(k));
    let r: Resp = key ? responses[key]! : { status: 404, json: { error: "no route" } };
    if (typeof r === "function") r = r(body);
    if (r instanceof Error) throw r;
    const rr = r;
    return { ok: rr.status < 400, status: rr.status, json: async () => rr.json, text: async () => JSON.stringify(rr.json) } as Response;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
const base = {
  companionId: "drevan",
  channelId: "1497734427298762828",
  botMessageId: "1553286622601023586",
  userMessageIds: ["1553286543223816244"],
  judgeKeySource: "recorded" as const,
  halseth: { base: "https://h.example", secret: "drevan-secret" },
  secondBrain: { base: "https://sb.example", key: "sb-key" } as { base: string; key: string } | null,
};
const sbCalls = (calls: Call[]) => calls.filter(c => c.url === "https://sb.example/retract");

describe("retractKeys", () => {
  it("keys every writer that could have memorialised the exchange", () => {
    expect(retractKeys("BOT", ["USER"])).toEqual({
      external_ids: ["discord:BOT", "judge:USER"],
      correlation_ids: ["judge:USER"],
    });
  });
  it("without a known user message, keys the reply alone", () => {
    expect(retractKeys("BOT", [])).toEqual({ external_ids: ["discord:BOT"], correlation_ids: [] });
  });
  it("several reconstructed candidates are all keyed, deduplicated", () => {
    expect(retractKeys("BOT", ["A", "B", "A"]).correlation_ids).toEqual(["judge:A", "judge:B"]);
  });
});

describe("handleRetractCommand", () => {
  it("archives in Halseth with a reason, drops the vault doc AND the rag mirrors, and acks with the numbers", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1", "j2"], notes: ["n1"] }, release_ids: ["r1", "r2", "r3"] } },
      "/retract": (b) => ({ status: 200, json: { removed: 1, existed: b["vault_path"] !== "rag/wm_continuity_notes/n1" } }),
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    const [h] = calls;
    expect(h!.url).toBe("https://h.example/admin/retract");
    expect(h!.auth).toBe("Bearer drevan-secret");
    expect(h!.body).toMatchObject({
      agent: "drevan",
      external_ids: ["discord:1553286622601023586", "judge:1553286543223816244"],
      correlation_ids: ["judge:1553286543223816244"],
    });
    expect(String(h!.body["reason"])).toContain("Raziel retracted");
    const sb = sbCalls(calls);
    expect(sb[0]!.auth).toBe("Bearer sb-key");
    expect(sb[0]!.body).toEqual({ channel_id: "1497734427298762828", message_id: "1553286622601023586" });
    // SB bcdb917 made the rag/ mirrors of D1 rows retractable; each archived row's mirror is asked for.
    expect(sb.slice(1).map(c => c.body["vault_path"]).sort()).toEqual([
      "rag/companion_journal/j1", "rag/companion_journal/j2", "rag/wm_continuity_notes/n1",
    ]);
    expect(ack.startsWith("retracted. ")).toBe(true);
    expect(ack).toContain("2 journal");
    expect(ack).toContain("1 note");
    expect(ack).toContain("vault: dropped");
    expect(ack).toContain("vault mirrors: dropped 2 of 3");
    expect(ack).toContain("restore release");
    expect(ack).not.toMatch(/[—–]/);
  });
  it("says plainly when nothing was found, still tries the vault, and the headline is NOT 'retracted.'", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: [], notes: [] }, release_ids: [] } },
      "/retract": { status: 200, json: { removed: 0, existed: false } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    expect(calls).toHaveLength(2);
    expect(ack).toContain("nothing to archive");
    expect(ack).toContain("vault: nothing there");
    expect(ack).toMatch(/^retract incomplete \(no journal row found yet/);
  });
  it("a Halseth failure makes the headline incomplete, whatever the vault said", async () => {
    const { fn } = fakeFetch({
      "/admin/retract": new Error("ECONNRESET"),
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    expect(ack).toMatch(/^retract incomplete \(halseth failed/);
    expect(ack).toContain("halseth: FAILED");
    expect(ack).toContain("vault: dropped");
  });
  it("every store failing never reads as 'retracted.'", async () => {
    const { fn } = fakeFetch({
      "/admin/retract": { status: 500, json: { error: "boom" } },
      "/retract": { status: 502, json: {} },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    expect(ack).not.toContain("retracted.");
    expect(ack).toMatch(/^retract incomplete \(halseth failed; vault failed\)/);
  });
  it("a failed mirror call is incomplete; an absent mirror is not", async () => {
    const { fn } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1"], notes: [] }, release_ids: ["r1"] } },
      "/retract": (b) => b["vault_path"] ? { status: 503, json: {} } : { status: 200, json: { existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    expect(ack).toContain("vault mirrors: dropped 0 of 1, 1 FAILED");
    expect(ack).toMatch(/^retract incomplete \(vault mirrors failed\)/);
  });
  it("an unknown trigger says the judge note was not searched, and the headline says incomplete", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1"], notes: [] }, release_ids: ["r1"] } },
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, userMessageIds: [], judgeKeySource: "unknown", fetchFn: fn });
    expect(calls[0]!.body["correlation_ids"]).toEqual([]);
    expect(ack).toContain("judge note: could not locate the message this answered; not searched");
    expect(ack).toMatch(/^retract incomplete \(judge note not located\)/);
  });
  it("a reconstructed key is named as reconstructed", async () => {
    const { fn } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1"], notes: [] }, release_ids: ["r1"] } },
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, userMessageIds: ["H1"], judgeKeySource: "reconstructed", fetchFn: fn });
    expect(ack).toContain("judge note: keyed on H1, reconstructed from Discord");
    expect(ack.startsWith("retracted. ")).toBe(true);
  });
  // Rotate-on-retract (2026-09-26): the retracted reply kept echoing from the STM window until the
  // 19:00 CDT rotation. The bot forwards the reply text so Halseth drops its stm_entries rows in
  // the same call, and the ack reports that count as a third number.
  it("forwards `stm` to Halseth as {channel_id, content} and acks the dropped window rows", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1"], notes: ["n1"] }, release_ids: ["r1", "r2"], stm_deleted: 1 } },
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn, stm: { channelId: base.channelId, content: "the number was 187" } });
    expect(calls[0]!.body["stm"]).toEqual({ channel_id: "1497734427298762828", content: "the number was 187" });
    expect(ack).toContain("halseth: archived 1 journal row and 1 note, dropped 1 window row");
  });
  it("without `stm`, sends no stm field and the ack keeps its old shape", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1"], notes: [] }, release_ids: ["r1"], stm_deleted: 0 } },
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn });
    expect(calls[0]!.body["stm"]).toBeUndefined();
    expect(ack).toContain("halseth: archived 1 journal row and 0 notes;");
  });
  it("counts window rows even when nothing was archived, and pluralises", async () => {
    const { fn } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: [], notes: [] }, release_ids: [], stm_deleted: 2 } },
      "/retract": { status: 200, json: { removed: 0, existed: false } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn, stm: { channelId: base.channelId, content: "the number was 187" } });
    expect(ack).toContain("nothing to archive under that reply");
    expect(ack).toContain("dropped 2 window rows");
  });

  it("without Second Brain configured, does the Halseth half and says the vault was not reached", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1"], notes: [] }, release_ids: ["r1"] } },
    });
    const ack = await handleRetractCommand({ ...base, secondBrain: null, fetchFn: fn });
    expect(calls).toHaveLength(1);
    expect(ack).toContain("vault: not configured");
    expect(ack).toMatch(/^retract incomplete \(vault not configured\)/);
  });
});

// ── The handler path, through the functions the handler calls ────────────────
const ME = "BOT_SELF";
const msg = (o: Partial<RetractMsg> & { id: string }): RetractMsg => ({
  authorId: ME, isBot: true, webhookId: null, content: "", createdTimestamp: 0, referenceId: null, ...o,
});

describe("reconstructReply (the Discord fallback when the send-time record is gone)", () => {
  const human = msg({ id: "H1", authorId: "RAZIEL", isBot: false, content: "what was my number?", createdTimestamp: 1000 });
  const c1 = msg({ id: "C1", content: "chunk one", createdTimestamp: 60_000 });
  const c2 = msg({ id: "C2", content: "chunk two", createdTimestamp: 60_800 });
  const c3 = msg({ id: "C3", content: "chunk three", createdTimestamp: 61_500 });

  it("walks to the head chunk and names the human message immediately before it", () => {
    const r = reconstructReply(c2, { before: [c1, human], after: [c3] }, ME);
    expect(r.headId).toBe("C1");
    expect(r.chunkIds).toEqual(["C1", "C2", "C3"]);
    expect(r.triggerCandidates).toEqual(["H1"]);
  });
  it("a PluralKit proxy (bot user WITH a webhook) is a human", () => {
    const pk = msg({ id: "PK1", authorId: "WEBHOOK", isBot: true, webhookId: "wh", createdTimestamp: 1000 });
    expect(reconstructReply(c1, { before: [pk], after: [] }, ME).triggerCandidates).toEqual(["PK1"]);
  });
  it("stops at an earlier message of mine: the human behind it answered that reply, not this one", () => {
    const older = msg({ id: "OLD", content: "an earlier reply", createdTimestamp: 1_000 });
    const r = reconstructReply(c1, { before: [older, human], after: [] }, ME);
    expect(r.headId).toBe("C1");
    expect(r.triggerCandidates).toEqual([]);
  });
  it("a sibling bot before the head is not a human; the head's own reference still counts", () => {
    const sib = msg({ id: "SIB", authorId: "DREVAN_BOT", isBot: true, createdTimestamp: 59_000 });
    const head = msg({ id: "C1", createdTimestamp: 60_000, referenceId: "SIB" });
    expect(reconstructReply(head, { before: [sib], after: [] }, ME).triggerCandidates).toEqual(["SIB"]);
  });
  it("messages of mine further apart than a sendLong burst are separate replies", () => {
    const far = msg({ id: "FAR", createdTimestamp: c1.createdTimestamp - CHUNK_GAP_MS - 1 });
    expect(reconstructReply(c1, { before: [far], after: [] }, ME).headId).toBe("C1");
  });
});

describe("ReplyIndex", () => {
  function fakeRedis(): ReplyIndexStore & { data: Map<string, string>; ttls: number[] } {
    const data = new Map<string, string>();
    const ttls: number[] = [];
    return {
      data, ttls,
      set: async (k, v, _m, s) => { data.set(k, v); ttls.push(s); return "OK"; },
      get: async (k) => data.get(k) ?? null,
    };
  }
  const rec = { headId: "C1", chunkIds: ["C1", "C2"], triggerMessageId: "H1", channelId: "chan", content: "chunk one\n\nchunk two" };

  it("any chunk resolves to the whole record", async () => {
    const idx = new ReplyIndex("drevan");
    idx.record(rec);
    expect((await idx.resolve("C2"))?.headId).toBe("C1");
    expect((await idx.resolve("C1"))?.triggerMessageId).toBe("H1");
    expect(await idx.resolve("nope")).toBeNull();
  });
  it("survives a restart through the store: a fresh index (empty memory) still resolves chunk 2", async () => {
    const redis = fakeRedis();
    new ReplyIndex("drevan", redis).record(rec);
    await new Promise(r => setImmediate(r));
    const afterRestart = new ReplyIndex("drevan", redis);
    const r = await afterRestart.resolve("C2");
    expect(r).toMatchObject({ headId: "C1", triggerMessageId: "H1", content: "chunk one\n\nchunk two" });
    // The text is stored once (on the head), chunks point at it; everything carries a TTL.
    expect(redis.data.get("ns:reply:drevan:C2")).toBe(JSON.stringify({ headId: "C1" }));
    expect(redis.ttls.every(t => t > 0)).toBe(true);
  });
  it("a store that throws never breaks record or resolve", async () => {
    const broken: ReplyIndexStore = { set: () => { throw new Error("down"); }, get: async () => { throw new Error("down"); } };
    const idx = new ReplyIndex("drevan", broken);
    expect(() => idx.record(rec)).not.toThrow();
    expect(await new ReplyIndex("drevan", broken).resolve("C1")).toBeNull();
  });
  it("is bounded", async () => {
    const idx = new ReplyIndex("drevan", null, 3);
    for (let i = 0; i < 5; i++) idx.record({ ...rec, headId: `M${i}`, chunkIds: [`M${i}`] });
    expect(await idx.resolve("M0")).toBeNull();
    expect(await idx.resolve("M4")).not.toBeNull();
  });
});

describe("executeRetract (the handler's retract path)", () => {
  const ok = {
    "/admin/retract": { status: 200, json: { archived: { journal: ["j1", "j2"], notes: ["n1"] }, release_ids: ["r1"], stm_deleted: 1 } },
    "/retract": { status: 200, json: { removed: 1, existed: true } },
  };
  function deps(over: Partial<ExecuteRetractDeps> & { fetchFn: typeof fetch }): ExecuteRetractDeps & { stm: StmStore } {
    const stm = new StmStore("drevan", async () => {}, async () => []);
    const bumpsState = { value: null as string | null };
    const bumps = new RetractBumps({ read: async () => bumpsState.value, write: async (v) => { bumpsState.value = v; } }, { log: () => {} });
    return {
      companionId: "drevan", channelId: "chan", ownUserId: ME,
      target: msg({ id: "C2", content: "the number was 187, which I said with confidence", createdTimestamp: 60_800 }),
      replyIndex: new ReplyIndex("drevan"),
      stmRetract: (c, t) => stm.retract(c, t),
      bumps,
      halseth: { base: "https://h.example", secret: "s" },
      secondBrain: { base: "https://sb.example", key: "k" },
      stm,
      ...over,
    };
  }

  // THE FINDING: a plain reply to Raziel carries no Discord reference (computeReplyRef), so the
  // judge note keyed on his message survived every retract while the ack said "retracted.".
  it("a plain reply to Raziel (no reference) still retracts the judge note, via the send-time record", async () => {
    const { fn, calls } = fakeFetch(ok);
    const d = deps({ fetchFn: fn });
    d.replyIndex = (() => { const i = new ReplyIndex("drevan"); i.record({ headId: "C1", chunkIds: ["C1", "C2"], triggerMessageId: "RAZ1", channelId: "chan", content: "FULL" }); return i; })();
    const ack = await executeRetract(d);
    expect(calls[0]!.body).toMatchObject({
      external_ids: ["discord:C1", "judge:RAZ1"],
      correlation_ids: ["judge:RAZ1"],
      stm: { channel_id: "chan", content: "FULL" },
    });
    expect(sbCalls(calls)[0]!.body).toEqual({ channel_id: "chan", message_id: "C1" });
    expect(ack.startsWith("retracted. ")).toBe(true);
    expect(ack).toContain("transcript: rotated (next turn");
  });

  // Chunk 2 of a long reply: speech + live-ingest were keyed on chunk 1, and the STM window holds
  // the FULL reply, not one chunk.
  it("retracting chunk 2 resolves to the head for every store and drops the full reply from my window", async () => {
    const { fn, calls } = fakeFetch(ok);
    const d = deps({ fetchFn: fn });
    const full = "chunk one of the reply that goes on\n\nchunk two of the reply, the part Raziel replied to";
    d.stm.append("chan", { role: "assistant", content: full, timestamp: 1 });
    d.stm.append("chan", { role: "assistant", content: "an unrelated earlier reply that must stay put", timestamp: 0 });
    const idx = new ReplyIndex("drevan");
    idx.record({ headId: "C1", chunkIds: ["C1", "C2"], triggerMessageId: "RAZ1", channelId: "chan", content: full });
    d.replyIndex = idx;
    const ack = await executeRetract(d);
    expect((calls[0]!.body["external_ids"] as string[])[0]).toBe("discord:C1");
    expect((calls[0]!.body["stm"] as { content: string }).content).toBe(full);
    expect(d.stm.get("chan").map(m => m.content)).toEqual(["an unrelated earlier reply that must stay put"]);
    expect(ack).toContain("my window: dropped 1 line");
  });

  it("after a restart with no record, reconstructs head + trigger from Discord and says so", async () => {
    const { fn, calls } = fakeFetch(ok);
    const d = deps({
      fetchFn: fn,
      fetchNeighbours: async () => ({
        before: [
          msg({ id: "C1", createdTimestamp: 60_000 }),
          msg({ id: "RAZ1", authorId: "RAZIEL", isBot: false, createdTimestamp: 30_000 }),
        ],
        after: [],
      }),
    });
    const ack = await executeRetract(d);
    expect(calls[0]!.body["external_ids"]).toEqual(["discord:C1", "judge:RAZ1"]);
    expect(ack).toContain("reconstructed from Discord");
  });

  it("with no record and no Discord, the ack says the judge note was not located and is incomplete", async () => {
    const { fn, calls } = fakeFetch(ok);
    const ack = await executeRetract(deps({ fetchFn: fn, fetchNeighbours: async () => { throw new Error("discord 503"); } }));
    expect(calls[0]!.body["correlation_ids"]).toEqual([]);
    expect(ack).toMatch(/^retract incomplete \(judge note not located\)/);
  });

  it("refuses a message that is not mine, touching nothing", async () => {
    const { fn, calls } = fakeFetch(ok);
    const ack = await executeRetract(deps({ fetchFn: fn, target: msg({ id: "X", authorId: "SOMEONE" }) }));
    expect(ack).toContain("not mine");
    expect(calls).toHaveLength(0);
  });

  it("a rotation that could not persist is said, and the headline is incomplete", async () => {
    const { fn } = fakeFetch(ok);
    const d = deps({ fetchFn: fn });
    d.replyIndex = (() => { const i = new ReplyIndex("drevan"); i.record({ headId: "C2", chunkIds: ["C2"], triggerMessageId: "RAZ1", channelId: "chan", content: "x" }); return i; })();
    d.bumps = new RetractBumps({ read: async () => { throw new Error("halseth 503"); }, write: async () => {} }, { log: () => {} });
    const ack = await executeRetract(d);
    expect(ack).toContain("transcript: rotated (not persisted: could not read the persisted map to merge");
    expect(ack).toMatch(/^retract incomplete \(rotation not persisted\)/);
  });
});
