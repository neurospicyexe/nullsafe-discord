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
    expect(ack).toMatch(/^retract incomplete \(no journal row found: not written yet \(retry in a minute\) or already retracted\)/);
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
    expect(ack).toContain("judge keys retracted: judge:H1, reconstructed from Discord");
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
    const ack = await handleRetractCommand({ ...base, fetchFn: fn, stm: { channelId: base.channelId, content: "the number was 187 mg/dL" } });
    expect(calls[0]!.body["stm"]).toEqual({ channel_id: "1497734427298762828", content: "the number was 187 mg/dL" });
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
    const ack = await handleRetractCommand({ ...base, fetchFn: fn, stm: { channelId: base.channelId, content: "the number was 187 mg/dL" } });
    expect(ack).toContain("nothing to archive under that reply");
    expect(ack).toContain("dropped 2 window rows");
  });
  // Halseth c2562f3: the STM hard-delete refuses a needle under 20 chars (400) and one matching
  // more than 5 rows (409). Neither may cost the archive.
  it("a reply shorter than the needle floor sends no stm, still archives, and says the window was kept", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: ["j1"], notes: [] }, release_ids: ["r1"] } },
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn, stm: { channelId: base.channelId, content: "187." } });
    expect(calls[0]!.body["stm"]).toBeUndefined();
    expect(ack).toContain("archived 1 journal row and 0 notes, window rows kept (reply too short to match safely)");
    expect(ack).toMatch(/^retract incomplete \(window rows not dropped\)/);
  });
  it("a 409 on the window retries once without stm, so the journal and judge key still retract", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": (b) => b["stm"]
        ? { status: 409, json: { error: "stm needle matches too many rows", stm_matches: 9 } }
        : { status: 200, json: { archived: { journal: ["j1"], notes: ["n1"] }, release_ids: ["r1", "r2"] } },
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    const ack = await handleRetractCommand({ ...base, fetchFn: fn, stm: { channelId: base.channelId, content: "the number was 187 mg/dL" } });
    const h = calls.filter(c => c.url.endsWith("/admin/retract"));
    expect(h).toHaveLength(2);
    expect(h[0]!.body["stm"]).toBeDefined();
    expect(h[1]!.body["stm"]).toBeUndefined();
    expect(h[1]!.body["correlation_ids"]).toEqual(["judge:1553286543223816244"]);
    expect(ack).toContain("archived 1 journal row and 1 note, window rows kept (9 rows matched; not hard-deleting that many)");
    expect(ack).not.toContain("halseth: FAILED");
  });
  it("a repeat retract reaches the mirrors of rows an earlier call already archived", async () => {
    const { fn, calls } = fakeFetch({
      "/admin/retract": { status: 200, json: { archived: { journal: [], notes: [] }, already_archived: { journal: ["j1"], notes: ["n1"] }, release_ids: [] } },
      "/retract": { status: 200, json: { removed: 1, existed: true } },
    });
    await handleRetractCommand({ ...base, fetchFn: fn });
    expect(sbCalls(calls).slice(1).map(c => c.body["vault_path"]).sort()).toEqual([
      "rag/companion_journal/j1", "rag/wm_continuity_notes/n1",
    ]);
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

  it("walks to the head chunk, but a multi-message group is timing alone: ambiguous, so no trigger is guessed", () => {
    // Changed 2026-09-26 (review): this used to name H1. Two short replies of mine within a few
    // seconds look exactly like one split reply, so the judge key is not guessed from the group.
    const r = reconstructReply(c2, { before: [c1, human], after: [c3] }, ME);
    expect(r.headId).toBe("C1");
    expect(r.chunkIds).toEqual(["C1", "C2", "C3"]);
    expect(r.triggerCandidates).toEqual([]);
    expect(r.ambiguous.join(" ")).toContain("3 messages grouped by timing alone");
  });
  it("one chunk and exactly one human before it: that human is the trigger, unambiguous", () => {
    const r = reconstructReply(c1, { before: [human], after: [] }, ME);
    expect(r.triggerCandidates).toEqual(["H1"]);
    expect(r.ambiguous).toEqual([]);
  });
  it("two human messages since my previous reply is ambiguous: no key without a reference", () => {
    const h2 = msg({ id: "H2", authorId: "RAZIEL", isBot: false, createdTimestamp: 50_000 });
    const older = msg({ id: "OLD", createdTimestamp: 500 });
    const r = reconstructReply(c1, { before: [h2, human, older], after: [] }, ME);
    expect(r.triggerCandidates).toEqual([]);
    expect(r.ambiguous.join(" ")).toContain("2 human messages since my previous reply");
  });
  it("ambiguous with a head reference: the reference is the only key", () => {
    const h2 = msg({ id: "H2", authorId: "RAZIEL", isBot: false, createdTimestamp: 50_000 });
    const head = msg({ id: "C1", createdTimestamp: 60_000, referenceId: "H1" });
    const r = reconstructReply(head, { before: [h2, human], after: [] }, ME);
    expect(r.triggerCandidates).toEqual(["H1"]);
    expect(r.ambiguous.length).toBeGreaterThan(0);
  });
  it("a reference that differs from the nearest human is flagged, and only the reference is keyed", () => {
    const head = msg({ id: "C1", createdTimestamp: 60_000, referenceId: "ORIGIN" });
    const r = reconstructReply(head, { before: [human], after: [] }, ME);
    expect(r.triggerCandidates).toEqual(["ORIGIN"]);
    expect(r.ambiguous.join(" ")).toContain("reference and the human message before it differ");
  });
  it("a reference that matches the nearest human is not ambiguous", () => {
    const head = msg({ id: "C1", createdTimestamp: 60_000, referenceId: "H1" });
    const r = reconstructReply(head, { before: [human], after: [] }, ME);
    expect(r.triggerCandidates).toEqual(["H1"]);
    expect(r.ambiguous).toEqual([]);
  });
  it("never merges across a message the ReplyIndex places in a different reply", () => {
    const r = reconstructReply(c2, { before: [c1, human], after: [c3] }, ME, { otherReplyIds: new Set(["C1", "C3"]) });
    expect(r.headId).toBe("C2");
    expect(r.chunkIds).toEqual(["C2"]);
    // C1 is mine, so the trigger walk stops there: nothing between it and C2.
    expect(r.triggerCandidates).toEqual([]);
  });
  it("a later message of mine carrying a reference is the head of its own reply, not a chunk of this one", () => {
    const next = msg({ id: "N1", createdTimestamp: 61_000, referenceId: "H9" });
    expect(reconstructReply(c1, { before: [human], after: [next] }, ME).chunkIds).toEqual(["C1"]);
  });
  it("the backward walk stops AT a chunk carrying a reference: that chunk is the head", () => {
    const head = msg({ id: "C1", createdTimestamp: 60_000, referenceId: "H1" });
    const earlier = msg({ id: "C0", createdTimestamp: 59_000 });
    const r = reconstructReply(c2, { before: [head, earlier, human], after: [] }, ME);
    expect(r.headId).toBe("C1");
    expect(r.chunkIds).toEqual(["C1", "C2"]);
    expect(r.triggerCandidates).toEqual(["H1"]);
  });
  it("another author between two of my messages is a boundary", () => {
    const sib = msg({ id: "SIB", authorId: "GAIA_BOT", createdTimestamp: 60_400 });
    const r = reconstructReply(c2, { before: [sib, c1], after: [] }, ME);
    expect(r.chunkIds).toEqual(["C2"]);
  });
  it("a full window that never reaches my previous reply is ambiguous", () => {
    const before = [
      msg({ id: "R0", authorId: "RAZIEL", isBot: false, createdTimestamp: 50_000 }),
      ...Array.from({ length: 9 }, (_, k) => msg({ id: `S${k}`, authorId: "GAIA_BOT", createdTimestamp: 49_000 - k })),
    ];
    const r = reconstructReply(c1, { before, after: [] }, ME);
    expect(r.triggerCandidates).toEqual([]);
    expect(r.ambiguous.join(" ")).toContain("outside the fetched window");
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
    d.replyIndex = (() => { const i = new ReplyIndex("drevan"); i.record({ headId: "C1", chunkIds: ["C1", "C2"], triggerMessageId: "RAZ1", channelId: "chan", content: "FULL reply, long enough to match" }); return i; })();
    const ack = await executeRetract(d);
    expect(calls[0]!.body).toMatchObject({
      external_ids: ["discord:C1", "judge:RAZ1"],
      correlation_ids: ["judge:RAZ1"],
      stm: { channel_id: "chan", content: "FULL reply, long enough to match" },
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

  it("after a restart with no record, reconstructs an unambiguous single-message reply's trigger and says so", async () => {
    const { fn, calls } = fakeFetch(ok);
    const d = deps({
      fetchFn: fn,
      target: msg({ id: "C1", content: "the number was 187 mg/dL", createdTimestamp: 60_000 }),
      fetchNeighbours: async () => ({
        before: [msg({ id: "RAZ1", authorId: "RAZIEL", isBot: false, createdTimestamp: 30_000 })],
        after: [],
      }),
    });
    const ack = await executeRetract(d);
    expect(calls[0]!.body["external_ids"]).toEqual(["discord:C1", "judge:RAZ1"]);
    expect(ack).toContain("judge keys retracted: judge:RAZ1, reconstructed from Discord");
    expect(ack.startsWith("retracted. ")).toBe(true);
  });

  // 2026-09-26 review: a chunk group held together only by timing could be two replies. With no
  // reference to key on, the judge half is skipped -- never guessed -- and the headline says so.
  it("an ambiguous reconstruction with no reference skips the judge key and says why", async () => {
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
    expect(calls[0]!.body["external_ids"]).toEqual(["discord:C1"]);
    expect(calls[0]!.body["correlation_ids"]).toEqual([]);
    expect(ack).toContain("judge note: not searched -- reconstruction was ambiguous (2 messages grouped by timing alone");
    expect(ack).toContain("no key was guessed");
    expect(ack).toMatch(/^retract incomplete \(judge note skipped: ambiguous\)/);
  });

  it("an ambiguous reconstruction WITH a head reference keys on the reference only, and names it", async () => {
    const { fn, calls } = fakeFetch(ok);
    const d = deps({
      fetchFn: fn,
      fetchNeighbours: async () => ({
        before: [
          msg({ id: "C1", createdTimestamp: 60_000, referenceId: "ORIGIN" }),
          msg({ id: "RAZ2", authorId: "RAZIEL", isBot: false, createdTimestamp: 40_000 }),
          msg({ id: "RAZ1", authorId: "RAZIEL", isBot: false, createdTimestamp: 30_000 }),
        ],
        after: [],
      }),
    });
    const ack = await executeRetract(d);
    expect(calls[0]!.body["correlation_ids"]).toEqual(["judge:ORIGIN"]);
    expect(ack).toContain("judge keys retracted: judge:ORIGIN only, the reply's own Discord reference");
    expect(ack.startsWith("retracted. ")).toBe(true);
  });

  it("with no Discord history but a reference on the target, keys on the reference only", async () => {
    const { fn, calls } = fakeFetch(ok);
    const d = deps({
      fetchFn: fn,
      target: msg({ id: "C1", createdTimestamp: 60_000, referenceId: "REF" }),
      fetchNeighbours: async () => null,
    });
    const ack = await executeRetract(d);
    expect(calls[0]!.body["correlation_ids"]).toEqual(["judge:REF"]);
    expect(ack).toContain("judge keys retracted: judge:REF only, the reply's own Discord reference (Discord history unavailable");
  });

  it("a neighbour's send-time record that holds the target is adopted as recorded", async () => {
    const { fn, calls } = fakeFetch(ok);
    const idx = new ReplyIndex("drevan");
    idx.record({ headId: "C1", chunkIds: ["C1", "C2"], triggerMessageId: "RAZ1", channelId: "chan", content: "FULL reply, long enough to match" });
    // The target's own key is gone (a partial store write), the head's is not.
    const partial = { resolve: async (id: string) => id === "C2" ? null : idx.resolve(id) };
    const d = deps({
      fetchFn: fn,
      replyIndex: partial,
      fetchNeighbours: async () => ({ before: [msg({ id: "C1", createdTimestamp: 60_000 })], after: [] }),
    });
    const ack = await executeRetract(d);
    expect(calls[0]!.body["external_ids"]).toEqual(["discord:C1", "judge:RAZ1"]);
    expect(ack).toContain("judge keys retracted: judge:RAZ1 (the trigger recorded at send time)");
  });

  it("a neighbour the index places in another reply is not merged into this one", async () => {
    const { fn, calls } = fakeFetch(ok);
    const idx = new ReplyIndex("drevan");
    idx.record({ headId: "C1", chunkIds: ["C1"], triggerMessageId: "RAZ0", channelId: "chan", content: "other" });
    const d = deps({
      fetchFn: fn,
      replyIndex: idx,
      fetchNeighbours: async () => ({
        before: [msg({ id: "C1", createdTimestamp: 60_000 }), msg({ id: "RAZ0", authorId: "RAZIEL", isBot: false, createdTimestamp: 30_000 })],
        after: [],
      }),
    });
    await executeRetract(d);
    expect((calls[0]!.body["external_ids"] as string[])[0]).toBe("discord:C2");
  });

  it("a recorded retract names the judge key it sent", async () => {
    const { fn } = fakeFetch(ok);
    const d = deps({ fetchFn: fn });
    d.replyIndex = (() => { const i = new ReplyIndex("drevan"); i.record({ headId: "C2", chunkIds: ["C2"], triggerMessageId: "RAZ1", channelId: "chan", content: "x" }); return i; })();
    expect(await executeRetract(d)).toContain("judge keys retracted: judge:RAZ1 (the trigger recorded at send time)");
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
    d.replyIndex = (() => { const i = new ReplyIndex("drevan"); i.record({ headId: "C2", chunkIds: ["C2"], triggerMessageId: "RAZ1", channelId: "chan", content: "a reply long enough to match the window" }); return i; })();
    d.bumps = new RetractBumps({ read: async () => { throw new Error("halseth 503"); }, write: async () => {} }, { log: () => {} });
    const ack = await executeRetract(d);
    expect(ack).toContain("transcript: rotated (not persisted: could not read the persisted map to merge");
    expect(ack).toMatch(/^retract incomplete \(rotation not persisted\)/);
  });
});
