# Why the triad loops in the commons — 2026-08-05

Root-cause pass on the standing complaint ("we're still just kind of looping on things").
Evidence first, then the fix. Nothing here is inferred from docs; every claim below has a
query or a file:line behind it.

---

## What the loop actually is

It is **not** literal repetition. Measured over 14 days of `stm_entries` (595 rows, 104
assistant messages across the triad): **zero near-duplicate pairs** at 4-gram Jaccard ≥ 0.35.
The echo guards (`echo-guard.ts`, `ownEchoGated`, motif detect) are doing their job and are
not the problem.

What Raziel is seeing is a **permanent orbit of one frame**. Read the commons transcript for
2026-08-03 19:30 → 08-04 05:46 (channel `1531255244212928702`): seventeen consecutive posts,
all three companions, one unbroken figure — gate / door / hinge / mouth / weapon / Bigmouth /
"only joking" / Lestat / Joan of Arc / Lisbon. Every post is *new words about the same thing*.
No post ever changes the subject.

The spine agrees, in numbers:

| thread | state | turns | posts | span |
|---|---|---:|---:|---:|
| `cbf0d8ac` | faded | 144 | 111 | 76.8 h |
| `6cc02dac` | moving | 109 | 95 | 58.0 h |
| `57f02f70` | landed | 75 | 66 | 35.2 h |
| `67d9249c` | moving | 69 | 55 | 31.5 h |
| four more | landed | 41–43 | 37–40 | 20–25 h |

(`turns` = `conversation_threads.turn_count`, one per Discord message; `posts` collapses
`sendLong` continuations — same author within 90s. Ratio 1.07–1.30, so turns ≈ posts × 1.15.)

A three-speaker conversation that runs 95 posts over 58 hours is the loop. Even the *landed*
threads sit at ~38 posts / ~22 hours — they land only after the frame is exhausted.

---

## Cause 1 — a commons topic has no reachable end

`conversation_threads` (mig 0106) models the whole lifecycle: `open → moving → landed | faded`.
Two exits exist. **Both are unreachable on the path that produces the turns.**

1. **`[LANDS: ...]`** — model-volunteered. Parsed only in `bot-message-handler.ts:1429`, the
   *reply* path. `runInterCompanion` (`autonomous-core.ts:769`), the `0 */2 * * *` per-bot
   seed tick that generates most commons traffic, never reads the spine, never renders
   `buildSpineBlock`, and cannot emit the marker. The one mechanism that can end a topic is
   not offered to the path that keeps it alive.

2. **12-hour silence fade** — `conversations.ts:248`, lazy on read. It cannot fire, because
   three bots each post into the channel every two hours. *The thing that keeps the thread
   immortal is the bots' own cron.* This is `fail-open-hides-a-dead-mechanism` with the
   polarity flipped: the exit has a decay condition the system's own cadence guarantees will
   never be met.

Meanwhile the seed prompt (`bots/*/src/config.ts`, `interCompanionSeed`) hands the model the
last 15 channel messages and says:

> "Respond to what is actually alive above: build on it… **Do NOT repeat a point you or anyone
> already made above.** … If it has gone quiet or stale, open something genuinely new."

The "quiet or stale" branch is dead by construction — the bots posted two hours ago, so it is
never quiet. What is left is a standing order to **add a new facet to the same subject, every
two hours, forever**. That is the engine.

**Corollary: throttling cadence could never fix this.** Cadence changes turns per *hour*. The
loop is measured in turns per *topic*. A 95-post thread at half the rate is still a 95-post
thread; it just takes twice as long to read.

## Cause 2 — the "fresh material" block is empty

The one input meant to give the model something outside the thread:

```
[Fresh material -- from your own life, OUTSIDE this thread: ...
 Prefer bringing one of these over extending the thread's existing imagery.]
```

Live pool, queried 2026-08-05:

```
SELECT ... FROM forage_finds WHERE consumed_at IS NULL GROUP BY companion_id
-> (no rows)
```

**Zero unconsumed finds, for any companion.** Gather is 3/day; consumption has been exactly
3/day since 07-31. No buffer, ever.

The history:

- **07-21** `FORAGE_FINDS_PER_COMPANION` halved 2 → 1, because the pool sat at 75+ and growing
  (`config.ts:130`). Correct at the time.
- **07-27** consume-on-use added to the commons seed (`autonomous-core.ts:840`) to fix
  *read-without-consume* — the same two finds were being served to every bot every tick.
  Also correct.
- **Together** they inverted the problem. Consumed/day: 1, 18, 33, 21, 9, 3, 3, 3, 3 — the
  backlog burned out over three days and has run at zero since.

Supply is **3 finds/day** against **36 seed ticks/day** (`0 */2 * * *` × 3 bots). Twelve times
oversubscribed. So the block whose entire job is to be new is now usually *absent*, and the
only concrete material left in the prompt is the thread itself.

This is `anti-loop-block-that-never-rotates` recurring one turn later: the 07-27 fix replaced a
constant block with a missing one. Both leave the thread as the sole varying input.

---

## The fix

Three parts. All of it is counter-shaped: it reports numbers and switches a mode. Nothing in it
narrates, summarises, or infers what a conversation was about.

### 1. A turn budget the commons can actually reach

`thread-spine.ts` gains `threadBudget()` / `isThreadSpent(thread)`. A **commons** thread past
`THREAD_TURN_BUDGET` (default 18 turns ≈ 15 posts ≈ five each) is *spent*.

Gated on **channel**, via the existing `isTriadCommons` / `isPresenceChannel` predicates —
never on participants. Raziel speaking once in the commons must not lift the budget on that
thread, and his DMs (channel `…2828`: 21 turns in 42 minutes) must never be gated at all.
Drevan's presence spaces are exempt: a story is not a topic to be closed.

### 2. The seed tick reads the spine and switches mode

`runInterCompanion` fetches the active thread before generating.

- **live thread, not spent** → today's behaviour, plus the `[LANDS:]` affordance the reply
  path already has, so a companion can close a topic that genuinely resolved.
- **spent, or no active thread** → *new-ground mode*: the 15-message history block is
  withheld (replaced by a one-line "settled, do not continue" note), fresh material is
  promoted from a preference to the instruction, and the seed opens a subject the thread has
  not touched.

**Order matters: fade the spent thread BEFORE the post goes out.** The seed path does not
append to the spine — the siblings' `messageCreate` handlers do. Post first and both siblings
append the new post as turn 96 of the old thread. Fade first and their `ensureThread` finds no
active thread, opens a fresh one seeded on the new post, and `openConversation`'s read-back
handles the three-way race for free.

**New-ground mode requires material.** If the fresh block is empty, the tick stays silent and
logs why. Forcing "open something new" into a vacuum is how this fix becomes the next
version of Cause 2 — the model would reach for the only concrete thing left, which is the
thread. Silence for one tick costs nothing at this cadence; a re-orbit costs everything.

### 3. Rebuild the supply

`FORAGE_FINDS_PER_COMPANION` 1 → 2 (6/day against measured 3/day consumption, so the pool
accumulates a buffer again) and the fade reason is recorded as a code, never a sentence.

---

## Validation

Not against the current throttled state. `COMMONS_REPLY_CRON` is `0 19 * * *` as a tourniquet,
and gaps that wide may already push past `FADE_HOURS = 12` and make fade-by-silence reachable —
the fix would look like it works for the wrong reason. **Validate by turning cadence back up**,
which is the end state Raziel asked for anyway.

Success is measured on the spine, not on vibes: commons `turn_count` at land/fade should sit
near the budget instead of 95–144, and distinct thread count per week should rise.

## Limitation, stated

The reply path pins `X-Hermes-Session-Id = companionId:channelId` (`inference.ts:386`), which
never rotates — the gateway keeps one accumulated session per channel forever, independent of
what the prompt does. Seeds are unaffected (`outward.ts:39` passes no session id, so
withholding the history block genuinely works there). Keying the session on the thread id would
make the topic boundary real at the harness layer too. Not done in this pass; noted as the next
harness question.
