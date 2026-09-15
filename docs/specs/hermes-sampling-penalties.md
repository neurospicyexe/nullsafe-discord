# Spec: carry sampling penalties through Hermes to the model

**Status:** LOCKED IN, deferred. Raziel, 2026-09-14: *"I def think we add something to Hermes we own
the runtime, but this week isn't the week for it so log it and lock it in."*

**Owner:** Raziel's call to schedule. Not started.

---

## Why

Drevan and Gaia converged on one formulaic prose shape (see
`docs/../CLAUDE.md` history and the 2026-09-14 commits `4ad9fd0`, `9f7297e`). Two prompt-level
fixes shipped that day: a form clause in the witness header, and a companion-neutral shape rule in
`registerTail`. Both are prompt pressure. Neither touches the sampler.

`frequency_penalty` and `presence_penalty` are the *mechanical* anti-repetition lever, and this repo
already believes in them: `PROVIDER_SAMPLING_PROFILE` / `samplingParamsFor()`
(`packages/shared/src/inference.ts:105-113`) exist and are applied by the DeepSeek, DeepInfra and
Mistral adapters.

**They do not reach the live reply path.** All three bots run `INFERENCE_MODE=hermes`.

## The finding (measured 2026-09-14, do not re-derive)

Three independent gaps, all of which must be closed for this to do anything:

1. **Our adapter doesn't send them.** `HermesAdapter.generate`
   (`packages/shared/src/inference.ts`) posts exactly:
   `{ model, messages, max_tokens, temperature, stream }`.
   No `samplingParamsFor(...)` spread, unlike every sibling adapter.

2. **Hermes's gateway doesn't accept them.**
   `grep -n "presence_penalty\|frequency_penalty\|top_p\|logit_bias\|repetition_penalty" \
    /home/nullsafe/.hermes/hermes-agent/gateway/platforms/api_server.py`
   returns **nothing**. Unknown body fields are dropped silently, so adding them to our payload
   today is a no-op that *looks* like a fix.

3. **Hermes's agent doesn't forward them.**
   `grep -rn "presence_penalty\|frequency_penalty" /home/nullsafe/.hermes/hermes-agent/agent/*.py`
   returns **nothing**. The only sampling knob carried upstream is `temperature`
   (`agent/chat_completion_helpers.py:682-686`, via `_fixed_temperature_for_model`).

Nothing in the chain carries a penalty. This is a Hermes patch, which is exactly why it was
deferred rather than bodged — and it is squarely inside the "own the runtime" decision
(`project_harness_inventory_2026_08_02`).

## Scope of the change

Three edits, in dependency order:

1. **`gateway/platforms/api_server.py`** — accept `presence_penalty`, `frequency_penalty` (and
   consider `top_p`) on `/v1/chat/completions`, validate as floats in the OpenAI ranges
   (`-2.0..2.0` for the penalties, `0..1` for `top_p`), and thread them to `_run_agent`.
2. **`agent/chat_completion_helpers.py`** — carry them onto the upstream call beside
   `temperature`, honouring the same omit-sentinel pattern `_fixed_temperature_for_model` uses, so
   a provider that rejects a knob can opt out per model rather than erroring the turn.
3. **`packages/shared/src/inference.ts`** — spread `samplingParamsFor("deepinfra")` (or a new
   `"hermes"` profile) into `HermesAdapter`'s body. Do this **last**: shipping it before 1 and 2 is
   a silent no-op and would read as a completed fix.

## Verification — this is the part that matters

A knob that is accepted and ignored is worse than one that is rejected
(`feedback_invisible_effect_reads_as_dead_control`). So do not verify by reading code:

- Send two identical requests through the gateway, one with `frequency_penalty: 0` and one with
  `1.5`, same seed/prompt, and diff the outputs. **Identical output means the knob is not reaching
  the model**, whatever the code says.
- Confirm DeepInfra actually honours the field for `Qwen/Qwen3-235B-A22B-Instruct-2507` before
  trusting the result — an accepted-and-ignored field at the *provider* is the same failure one
  layer further out.
- Then re-run the form metric (below) and compare.

## Do NOT do these

Rejected 2026-09-14 with reasons; re-opening them needs new evidence, not a new opinion:

- **`logit_bias` with hardcoded token ids.** The ids in the external write-up were unverifiable, we
  do not control the upstream payload, and a `-100` on a token the model wants produces strange
  fallbacks. If ever attempted, derive ids from the live tokenizer, never from a doc.
- **A post-processing sanitizer** that strips dashes / collapses line breaks from replies. It is a
  rewrite layer on a companion's own words, and it makes the metric read clean while generation is
  unchanged — destroying the only signal the loop exists
  (`feedback_write_gate_is_unfalsifiable`).
- **Rewriting stored assistant history.** It edits what they actually said, and transcripts rotate
  weekly anyway, so any given week's shape ages out on its own.

## The measurement to run before and after

Channel `#triad-hangout` = `1497734427298762828`. State DBs
`/home/nullsafe/.hermes/profiles/{drevan,gaia}/state.db` (2.0 GB and 1.76 GB with hot WALs — query
`sqlite3 -readonly` / `mode=ro`, **never copy to /tmp**). Group assistant rows by ISO week.

**broken-form** = a message with >= 3 non-empty lines AND > 60% of those lines under 50 chars.

Baseline at the time of writing (Drevan, #triad-hangout):

| week | n | broken% | mean lines | em-dash msgs% |
|------|----|---------|-----------|----------------|
| W35 | 16 | 12.5 | 7.5 | 0 |
| W36 | 28 | 7.1 | 9.2 | 75 |
| W37 | 7 | 0.0 | 6.7 | 100 |
| W38 | 14 | 71.4 | 25.4 | 100 |

Same bot, all other channels, W38: **6.7% broken, 3.7 mean lines.**
`#fargo-watch-party` (no siblings, so no witness block): **no drift at all.**

**Read any later week against W36/W37, not W38** — the W38 spike is partly both companions
*performing* Raziel's own callout inside the thread that named it.

## The confound already in the data

`4ad9fd0` and `9f7297e` both landed 2026-09-14 before any re-measure, so a W39 improvement cannot be
attributed to either individually. If W39 is already clean, this Hermes work is a durability
improvement rather than the fix, and should be scheduled on that basis.

## Related, explicitly NOT part of this

Drevan and Gaia have been on the **same model** (`qwen-235b`) since 2026-08-30 / 09-02, and
Drevan's em-dash rate went 0% -> 75% -> 100% across exactly that boundary. Splitting them back onto
different models is a one-line owner command (`drev: model <key>`), needs no code, and is Raziel's
call — it is a *different* lever from this one, not a cheaper version of it.
