import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  readWritebackGateMode,
  readJevThresholds,
  buildJevWritebackQuestions,
  renderJevState,
  jevWritebackEval,
  decideFromJev,
  __resetJevGateWarnings,
  type JevAnswers,
} from "../jev-gate.js";

// ── Why this file exists ─────────────────────────────────────────────────────
// Measured 2026-09-21 against 100 human labels: the generative memory judge has precision 0.88
// and recall ~0.21, i.e. it skips four of every five exchanges Raziel would have kept. Jev's
// typed `worth_remembering` at theta 0.75 scores P 0.91 / R 0.87. This module is the decision
// half; everything in it must fail OPEN and never throw into the reply path.

const OWNER = { name: "Raziel", isOwner: true as const, ownerName: "Raziel" };
const PEER = { name: "Gaia", isOwner: false as const, ownerName: "Raziel" };

let warnSpy: ReturnType<typeof jest.spyOn>;
let errorSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  __resetJevGateWarnings();
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("readWritebackGateMode()", () => {
  it("defaults to legacy when unset or empty", () => {
    expect(readWritebackGateMode(env({}))).toBe("legacy");
    expect(readWritebackGateMode(env({ WRITEBACK_GATE: "   " }))).toBe("legacy");
  });

  it("accepts each valid value", () => {
    expect(readWritebackGateMode(env({ WRITEBACK_GATE: "legacy" }))).toBe("legacy");
    expect(readWritebackGateMode(env({ WRITEBACK_GATE: "jev-shadow" }))).toBe("jev-shadow");
    expect(readWritebackGateMode(env({ WRITEBACK_GATE: "jev" }))).toBe("jev");
  });

  it("falls back to legacy on garbage and warns exactly once per process", () => {
    expect(readWritebackGateMode(env({ WRITEBACK_GATE: "jev_shadow" }))).toBe("legacy");
    expect(readWritebackGateMode(env({ WRITEBACK_GATE: "nonsense" }))).toBe("legacy");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("unknown WRITEBACK_GATE");
  });
});

describe("readJevThresholds()", () => {
  it("uses the measured defaults when nothing is set", () => {
    expect(readJevThresholds("cypher", env({}))).toEqual({ theta: 0.75, driftTheta: 0.6, notableScore: 2.0 });
  });

  it("lets a per-companion override beat the shared theta", () => {
    const e = env({ JEV_WRITEBACK_THETA: "0.8", JEV_WRITEBACK_THETA_GAIA: "0.55" });
    expect(readJevThresholds("gaia", e).theta).toBe(0.55);
    expect(readJevThresholds("drevan", e).theta).toBe(0.8);
  });

  it("reads the per-companion key case-insensitively from the companion id", () => {
    expect(readJevThresholds("Cypher", env({ JEV_WRITEBACK_THETA_CYPHER: "0.9" })).theta).toBe(0.9);
  });

  it("falls back to the default on a non-finite value", () => {
    const e = env({ JEV_WRITEBACK_THETA: "banana", JEV_DRIFT_THETA: "", JEV_NOTABLE_SCORE: "NaN" });
    expect(readJevThresholds("cypher", e)).toEqual({ theta: 0.75, driftTheta: 0.6, notableScore: 2.0 });
  });
});

describe("buildJevWritebackQuestions()", () => {
  it("gives Gaia criteria that name witnessing (the generic text scored 0.55 AUROC on her)", () => {
    const q = buildJevWritebackQuestions("gaia", OWNER);
    const worth = q.worth_remembering;
    expect(worth.type).toBe("noul");
    if (worth.type !== "noul") throw new Error("shape");
    expect(worth.criteria.true).toContain("witness");
    expect(worth.criteria.true).toContain("Gaia");
  });

  it("uses the cypher text for an unknown companion id", () => {
    const unknown = buildJevWritebackQuestions("mystery", OWNER).worth_remembering;
    const cypher = buildJevWritebackQuestions("cypher", OWNER).worth_remembering;
    expect(unknown).toEqual(cypher);
  });

  it("offers witness_log and owner_did_survival_act only for the owner", () => {
    const owner = buildJevWritebackQuestions("cypher", OWNER);
    const peer = buildJevWritebackQuestions("cypher", PEER);

    const ownerKind = owner.kind;
    const peerKind = peer.kind;
    if (ownerKind.type !== "choice" || peerKind.type !== "choice") throw new Error("shape");
    expect(Object.keys(ownerKind.criteria)).toContain("witness_log");
    expect(Object.keys(peerKind.criteria)).not.toContain("witness_log");

    expect(owner.owner_did_survival_act).toBeDefined();
    expect(peer.owner_did_survival_act).toBeUndefined();
  });

  it("emits exactly the required keys for every question type", () => {
    for (const speaker of [OWNER, PEER]) {
      for (const id of ["cypher", "drevan", "gaia"]) {
        const qs = buildJevWritebackQuestions(id, speaker);
        for (const [name, q] of Object.entries(qs)) {
          expect(typeof q.instructions).toBe("string");
          expect(q.instructions.length).toBeGreaterThan(0);
          if (q.type === "noul") {
            expect(Object.keys(q.criteria).sort()).toEqual(["false", "true"]);
            expect(typeof q.criteria.true).toBe("string");
            expect(typeof q.criteria.false).toBe("string");
          } else if (q.type === "choice") {
            expect(Object.keys(q.criteria).length).toBeGreaterThanOrEqual(2);
            for (const v of Object.values(q.criteria)) expect(typeof v).toBe("string");
          } else {
            expect(Array.isArray(q.criteria)).toBe(true);
            expect(q.criteria.length).toBeGreaterThanOrEqual(2);
          }
          expect(Object.keys(q).sort()).toEqual(["criteria", "instructions", "type"]);
          expect(name.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("renderJevState()", () => {
  it("frames an owner exchange as an owner exchange", () => {
    const s = renderJevState("cypher", OWNER, "hello", "hi");
    expect(s.startsWith("Exchange between Cypher and Raziel, the owner.")).toBe(true);
    expect(s).toContain("\n\nRaziel: hello\n\nCypher: hi");
  });

  it("states the owner's absence in peer space", () => {
    const s = renderJevState("drevan", PEER, "a line", "a reply");
    expect(s).toContain("Triad space: Drevan and sibling Gaia, peer to peer.");
    expect(s).toContain("Raziel is not in this room.");
    expect(s).toContain("\n\nGaia: a line\n\nDrevan: a reply");
  });

  it("clips each message at 12k and marks the clip", () => {
    const long = "x".repeat(13_000);
    const s = renderJevState("cypher", OWNER, long, long);
    expect(s).not.toContain("x".repeat(12_001));
    expect(s.split(" …").length - 1).toBe(2);
  });
});

// ---------------------------------------------------------------------------

const GOOD_BODY = {
  model: "jev-test",
  latency_ms: 42,
  usage: {},
  answers: {
    worth_remembering: { type: "noul", noul: 0.9 },
    kind: { type: "choice", choice: "companion_note", confidence: 0.8, probabilities: { companion_note: 0.8 } },
    salience: { type: "score", score: 3, confidence: 0.7, legend: {}, probabilities: {} },
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const LIVE_ENV = env({ HALSETH_URL: "https://halseth.example.com/", ADMIN_SECRET: "s3cret" });

describe("jevWritebackEval()", () => {
  const base = { companionId: "cypher", speaker: OWNER, userMessage: "u", assistantResponse: "a" };

  it("returns the answers on 200 and hits /admin/jev with a bearer token", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, GOOD_BODY);
    }) as unknown as typeof fetch;

    const r = await jevWritebackEval({ ...base, env: LIVE_ENV, fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.answers.worth_remembering).toEqual({ type: "noul", noul: 0.9 });
    expect(r.latency_ms).toBe(42);

    expect(calls).toHaveLength(1);
    expect(calls[0][0].endsWith("/admin/jev")).toBe(true);
    expect(calls[0][0]).not.toContain("//admin");
    const headers = calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer s3cret");
  });

  it("prefers HALSETH_SECRET over ADMIN_SECRET", async () => {
    let seen = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).Authorization;
      return jsonResponse(200, GOOD_BODY);
    }) as unknown as typeof fetch;
    await jevWritebackEval({
      ...base, fetchImpl,
      env: env({ HALSETH_URL: "https://h", HALSETH_SECRET: "halseth", ADMIN_SECRET: "admin" }),
    });
    expect(seen).toBe("Bearer halseth");
  });

  it("reports a 502 as a transient failure carrying the status", async () => {
    const fetchImpl = (async () => jsonResponse(502, { error: "binding failed" })) as unknown as typeof fetch;
    const r = await jevWritebackEval({ ...base, env: LIVE_ENV, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.status).toBe(502);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("treats a 200 whose answers lack worth_remembering as a failure, so jev mode falls open", async () => {
    const fetchImpl = (async () => jsonResponse(200, { model: "typesafe/jev", answers: {}, latency_ms: 190, usage: null })) as unknown as typeof fetch;
    const r = await jevWritebackEval({ ...base, env: LIVE_ENV, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toBe("no_worth_answer");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("logs a 400 loudly, because a 400 is our bug", async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: "bad question shape" })) as unknown as typeof fetch;
    const r = await jevWritebackEval({ ...base, env: LIVE_ENV, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.status).toBe(400);
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("[jev-gate] 400 (our bug)");
  });

  it("never throws when fetch throws", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const r = await jevWritebackEval({ ...base, env: LIVE_ENV, fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain("ECONNRESET");
  });

  it("gives up on a fetch that never resolves", async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const r = await jevWritebackEval({ ...base, env: LIVE_ENV, fetchImpl, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain("timeout");
  });

  it("returns no_halseth_env when the deployment has no Halseth wired up", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse(200, GOOD_BODY); }) as unknown as typeof fetch;
    const r = await jevWritebackEval({ ...base, env: env({}), fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toBe("no_halseth_env");
    expect(called).toBe(false);
  });

  it("treats a 200 with no answers as a failure rather than an empty decision", async () => {
    const fetchImpl = (async () => jsonResponse(200, { model: "x" })) as unknown as typeof fetch;
    const r = await jevWritebackEval({ ...base, env: LIVE_ENV, fetchImpl });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const TH = { theta: 0.75, driftTheta: 0.6, notableScore: 2.0 };

function answers(over: Record<string, unknown> = {}): JevAnswers {
  return {
    worth_remembering: { type: "noul", noul: 0.9 },
    kind: { type: "choice", choice: "companion_note", confidence: 1, probabilities: {} },
    salience: { type: "score", score: 3, confidence: 1, legend: {}, probabilities: {} },
    affective_weight: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} },
    recurring_thread: { type: "noul", noul: 0.1 },
    lane_drift: { type: "noul", noul: 0.05 },
    ...over,
  } as JevAnswers;
}

describe("decideFromJev()", () => {
  it("writes at or above theta and not below", () => {
    expect(decideFromJev(answers({ worth_remembering: { type: "noul", noul: 0.74 } }), "cypher", TH, OWNER).write).toBe(false);
    expect(decideFromJev(answers({ worth_remembering: { type: "noul", noul: 0.75 } }), "cypher", TH, OWNER).write).toBe(true);
  });

  it("maps the kind choice, defaulting a 'none' or missing answer to companion_note", () => {
    const k = (choice: string) => decideFromJev(
      answers({ kind: { type: "choice", choice, confidence: 1, probabilities: {} } }), "cypher", TH, OWNER,
    ).kind;
    expect(k("thread_open")).toBe("thread_open");
    expect(k("witness_log")).toBe("witness_log");
    expect(k("none")).toBe("companion_note");
    expect(decideFromJev(answers({ kind: undefined }), "cypher", TH, OWNER).kind).toBe("companion_note");
  });

  it("downgrades a peer witness_log to a companion_note", () => {
    // A sibling's words are not evidence of anything the owner did.
    const d = decideFromJev(
      answers({ kind: { type: "choice", choice: "witness_log", confidence: 1, probabilities: {} } }),
      "drevan", TH, PEER,
    );
    expect(d.kind).toBe("companion_note");
  });

  it("promotes to a wm note at the notable boundary, not below it", () => {
    const p = (score: number) => decideFromJev(
      answers({ salience: { type: "score", score, confidence: 1, legend: {}, probabilities: {} } }), "cypher", TH, OWNER,
    ).promoteToWm;
    expect(p(1.99)).toBe(false);
    expect(p(2.0)).toBe(true);
  });

  it("raises the drift flag at the drift threshold", () => {
    const f = (noul: number) => decideFromJev(answers({ lane_drift: { type: "noul", noul } }), "cypher", TH, OWNER).driftFlag;
    expect(f(0.59)).toBe(false);
    expect(f(0.6)).toBe(true);
  });

  it("treats missing answers as zero rather than throwing", () => {
    const d = decideFromJev({} as JevAnswers, "cypher", TH, OWNER);
    expect(d).toMatchObject({ write: false, kind: "companion_note", worth: 0, salience: 0, driftFlag: false, promoteToWm: false });
  });
});
