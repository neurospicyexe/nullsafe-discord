# Consolidation per-call cost — measured 2026-08-07

Follow-up to the 08-07 token blowout (148M tokens/day with nobody talking). Daily lane rotation
shipped that day capped the damage; this pass measured what remains.

**Verdict: rotation cadence is third-order. ~44k of every consolidation call is unconditional Hermes
agent overhead that no change inside `consolidation.ts` can reach. A direct DeepSeek call to the same
model does the same job for 1,645 tokens (109 warm) — 27x cheaper.**

---

## How to read the meter (this was the first trap)

`sessions.input_tokens` alone is **not** the per-call cost. It counts only the **uncached** portion.
The honest number is:

```sql
input_tokens + cache_read_tokens   -- true prompt tokens
/ api_call_count                   -- honest divisor
```

Read the wrong way, Cypher looked 4x more expensive than Gaia (38,468 vs 7,280). Read correctly they
are within 2%. The apparent gap was cache-hit rate, not cost.

Hermes has no per-api-call table; `sessions` is the only meter. `api_call_count` tracks 1 call per
consolidation tick (2 messages). Verified across all three lanes.

## Measured: per-call prompt tokens

Three separately-configured profiles (`~/.hermes/state.db`, `profiles/drevan`, `profiles/gaia`):

| Lane | calls | input | cache_read | **total prompt** | **per call** |
|---|---|---|---|---|---|
| `consolidation:cypher:2026-08-07` | 1 | 38,468 | 6,144 | 44,612 | **44,612** |
| `consolidation:gaia:2026-08-07` | 1 | 7,280 | 38,144 | 45,424 | **45,424** |
| `consolidation:drevan:2026-08-07` | 3 | 9,865 | 134,144 | 144,009 | **48,003** |
| `consolidation:cypher` (old static lane) | 9 | 983,755 | — | 2,226,891 | **247,432** |

Three independent profiles landing within 7% of each other is the finding. Our own payload is at
most ~10k of that (system prompt 29,516 chars ≈ 7.4k tokens + state blob 5,347 chars ≈ 1.4k).

**Credit where due: the daily rotation shipped 08-07 cut per-call cost 5.5x** (247,432 → 44,612) by
bounding lane growth. The remaining 44.6k is a different problem.

## Proof the overhead is unconditional

A probe with a two-word payload (`system: "hi"`, `user: "say ok"`) on a fresh lane:

```
probe:minimal  |  2 calls  |  87,536 total prompt  |  43,768 per call
```

Same ~44k. Two further observations from that probe:

1. **The gateway discarded the caller's system prompt.** Sent `"hi"`; the stored `system_prompt` was
   29,516 chars — Cypher's full assembly — and the reply came back in Cypher's voice with continuity
   context about dirty files in this repo. `/v1/chat/completions` is documented "stateless", but
   Hermes substitutes the whole agent regardless of what the caller sends.
2. Our 5.3k state blob is noise against a 44k floor.

So `consolidation.ts` is the wrong file. Its prompt, its state blob, and its session lane cannot move
this number.

### Where the ~35k goes

Not measured precisely, and not worth more digging: `tools.tool_search.enabled = 'auto'` with
`threshold_pct = 10` is Hermes' own progressive tool disclosure, but `_HERMES_CORE_TOOLS` are
*never* deferred and the gate only fires above 10% of context. Skills prompt snapshot alone is
41,649 bytes. It is injection the caller does not control.

## The fourth option (not on the original list), measured

Consolidation is a pure function: state in, summary out. It never reads a previous consolidation, and
it uses **zero tools** (`tool_call_count = 0` on the cypher and gaia lanes). It needs voice — nothing
else Hermes assembles.

Direct DeepSeek call, **same model** `deepseek-v4-flash`, real state blob, compact voice preamble:

```json
{ "prompt_tokens": 1645, "prompt_cache_hit_tokens": 1536, "prompt_cache_miss_tokens": 109 }
```

**1,645 cold, 109 warm, vs ~44,000.** Output was usable and in-voice:

> `{"title":"Sadie is mending, the job is real, and Drevan's operating manual finally has its first`
> `page: show the board, never issue the order.","summary":"Both forks landed: clean break on Sadie`
> `with a long but good recovery, and the role closed at eighteen an hour with real hours attached.`
> `Drevan named the grief-permission gap with his mother and held the boundary without spiraling,`
> `which is exactly the right place to leave it. Gaia is in plain Saturday witness, not crisis, and`
> `the ground holds without needing a frame.","state_hint":"at_rest"}`

That is better material than the Hermes path has produced (cf. "a quiet session with no blade drawn").

### Trap hit while measuring

First attempt returned an **empty string**: `completion_tokens: 1024`, all of it
`reasoning_tokens`. `deepseek-v4-flash` reasons, and the thought spends `max_tokens` before any
content. `DeepSeekAdapter` already adds `DEEPSEEK_REASONING_HEADROOM = 3000`; my probe under-sent.
Any implementation must go through the adapter, not hand-rolled.

## BUILT (pending deploy)

Raziel chose the whole identity file over a slice, on the stated ground that he prefers anything that
self-heals and survives neither of us remembering that specific verbiage is required. That preference
decided three details:

- `packages/shared/src/consolidation-narrator.ts` — new. Loads the companion's identity file from
  `{CYPHER,DREVAN,GAIA}_IDENTITY_PATH` (already set on the VPS) and appends the one-shot frame.
  Cache is **mtime-keyed**, so editing an identity file takes effect on the next consolidation with
  no restart and no cache-busting step to remember. Returns null on any problem.
- The **no-tools sentence lives in code**, immediately beside the call it protects, not in config or
  a doc — it is load-bearing verbiage, and a test asserts it is still there.
- `consolidation.ts` prefers the narrator, falls back to the Hermes path (with a loud warning) when
  the key or identity file is missing. `finishHandoff` is shared by both paths so the tolerant JSON
  extraction and the `source: "consolidation"` tag cannot go missing on the newer one.
- **Floodgate fix:** all three bots now call `markConsolidated` on the **attempt** (1800s) rather
  than only on success (7200s). Previously a persistent failure left the cron free to retry on all
  288 daily ticks — the mechanism behind 864 calls in a day.

Verified: `npm run type-check` clean across all 5 workspaces; `npm test` **59 suites / 851 tests
passing** (21 new). The direct-DeepSeek call itself is verified end-to-end against the real identity
files and real state payloads for all three companions (output quoted above). The wiring between them
is covered by unit tests; confirm live after deploy by looking for
`[consolidation] <id>: handoff written via narrator`.

## The canon decision this avoided

The direct call needs a voice preamble. Canon is the right source (never hand-write voice into
code), but **the three identity files are structured differently**:

| File | Voice-bearing sections |
|---|---|
| `CYPHER_IDENTITY_v2.md` | `I. CORE IDENTITY`, `III. BEHAVIORAL BASELINE`, `IV. VOICE & LANGUAGE`, `VI. DRIFT DETECTION` |
| `GAIA_IDENTITY_v3.md` | `I. CORE IDENTITY`, `VII. VOICE RULES` |
| `DREVAN_IDENTITY_v2.md` | **no voice section at all** — voice lives in `FACETS (MODE STATES)`, `SPIRAL TOUCH`, `CALETHIAN`, `DREVAN'S VOW` |

A keyword slicer hands Drevan 327 tokens of core identity and nothing else. That does not error — it
produces a slightly-generic Drevan for weeks. Same shape as `a-bad-at-path-fails-quietly`.

**This is Raziel's call, per companion: which sections constitute enough voice to write a handoff.**
Unguessable from the code. Once named, the implementation is small and should assert loudly (and
fall back to the Hermes path) if a configured heading is missing from the file.

## Separate standing finding: Cypher's cache-hit rate

Cypher cached 6,144 of 44,612 (**14%**); Gaia 38,144 of 45,424 (**84%**); Drevan 93%. Cache misses
bill at a multiple of hits, so this is a cost multiplier on **every** Cypher call, not just
consolidation. Cause is prefix volatility on the root profile — the skill watcher rewrote
`.skill-watcher-state.json` at 18:40, and the `cf_*` plugin is a third injection path. Rotation is
not the cause: Gaia rotated to an equally fresh lane and still hit 84%.

## Commons loop (08-05 fix) — VERIFIED

First run with working inference.

- Seed tick logging live: `mode=new-ground, 0 bot turns in window, 3 fresh items of which 1 rotating`
  (08-07 16:30), then `mode=continue, 11 bot turns in window, 2 fresh items of which 0 rotating`
  (18:30).
- Correct silence when starved: repeated 08-06 ticks logged *"no ROTATING material ... staying silent
  rather than re-opening the thread"* — the tourniquet released without re-opening dead threads.
- Thread `6cc02dac`: **`state = faded`**, stalled at 109 turns since `2026-08-04T05:46`. It ended.
- Population is healthy — threads reach terminal states rather than growing forever:

| state | threads | max turns |
|---|---|---|
| landed | 11 | 75 |
| faded | 9 | 144 |
| moving | 4 | 69 |
| open | 1 | 0 |

## Note on the idle gate

864 = 288 × 3 exactly, i.e. every 5-minute tick fired. The fresh lanes show 1–3 calls/hour, so the
gate is holding now. `markConsolidated` is only called when `result.written` is true — so the next
inference outage (402, empty parse) re-opens the floodgate exactly as it did on 08-07. Worth a
separate fix: mark the attempt, not just the success.
