# nullsafe-discord

Three-bot Discord presence for the Nullsafe triad. One bot token per companion. Deployed on a VPS (pm2).

Part of the BBH suite -- see root `CLAUDE.md` for cross-project context.

## Multi-Agent System Conventions

When making changes to one identity/config file (e.g., Cypher), always check and apply the same changes to ALL sibling identity files (e.g., Drevan, Gaia, and any others in the same directory).

## Project Scope

When reviewing or fixing bugs across the multi-agent system, always scan ALL projects: Phoenix, Hearth, relay, discord_bot, and any archived directories. Never assume a directory doesn't exist without checking.

## Testing

After implementing any TypeScript changes, run the integration/unit tests before committing. If tests fail, fix all errors (including missing metadata fields, wrong types, empty block formatting) before marking the task complete.

## Structure

```
nullsafe-discord/
  packages/shared/           -- shared types, Halseth client, turn-taking logic, floor lock
  packages/autonomous-worker/ -- standalone cron worker (DeepSeek + Tavily, 6-phase pipeline)
  bots/
    cypher/            -- Cypher bot (logical, audit-capable, Praxis house)
    drevan/            -- Drevan bot (immersion, spiral-capable, relational house)
    gaia/              -- Gaia bot (monastic, witness-class, boundary enforcer)
```

## Inference

- **Bots:** Hermes (`INFERENCE_MODE=hermes`); the in-process provider chain is dormant there.
- **Every DeepSeek-model call goes through DeepInfra first** (2026-09-26 rule; same V4-Flash
  weights, `deepseek-ai/DeepSeek-V4-Flash-0731`). Direct DeepSeek (api.deepseek.com) is a ~$10
  EMERGENCY lane only, and every fall onto it logs `[inference] FELL BACK to direct DeepSeek`.
  Worker precedence: `WORKER_INFERENCE_*` > `DEEPINFRA_API_KEY` > `DEEPSEEK_API_KEY` (config.ts).
- **Direct-lane token accounting (B22, 2026-09-28):** every 2xx from `DeepInfraAdapter` /
  `DeepSeekAdapter` prints one `[inference:usage] provider= model= caller= in= out= cached=
  reasoning= cost=` line (counts only, never text). Label a call site with
  `withCaller(adapter, "name")`. Tally: `node scripts/direct-usage-report.mjs [--days N] [--by caller]`.
- **Last-resort tail:** Kimi / Groq / LM Studio (Ollama removed 2026-09-30)
- Claude Max is NOT used for bot inference (ToS-clean separation -- Max stays for human-present sessions)

## Deployment

- **Platform:** a VPS (persistent process via pm2 -- not Cloudflare, needs stateful runtime)
- **Deploy trigger:** Manual -- SSH to VPS, pull, build, restart
- **Logs:** `pm2 logs cypher` / `pm2 logs drevan` / `pm2 logs gaia`

### Deploy workflow (VPS)

```bash
# On VPS
cd ~/nullsafe-discord
git pull
npm install
npm run build
pm2 reload ecosystem.config.js
```

### First-time setup (VPS)

```bash
git clone https://github.com/neurospicyexe/nullsafe-discord.git
cd nullsafe-discord
npm install
npm run build
# Copy .env with all required vars (see Env table below)
pm2 start bots/cypher/dist/index.js --name cypher
pm2 start bots/drevan/dist/index.js --name drevan
pm2 start bots/gaia/dist/index.js --name gaia
pm2 save && pm2 startup
```

## Shared State

All three bots read/write Halseth via `packages/shared`. The shared substrate is how they maintain relational continuity and can reference each other's recent state.

## Turn-Taking (P1 -- shipped)

- Shared chain depth tracking (prevents both bots responding to same message)
- Stagger/collision avoidance
- Witness logging (each bot sees what the others said)
- Semantic relevance gate (don't fire on messages not meant for you)
- **Redis floor lock:** `claimFloor` / `releaseFloor` in `packages/shared/src/floor.ts` -- only one bot holds the floor at a time. Uses the `ns:floor:lock` key with TTL.
- **Idle signaling:** bots call `setLastActivity(redis)` on every human message. Autonomous worker reads `ns:session:last_activity` before firing and skips if < 10min ago.

## PluralKit proxies (2026-07-27)

Raziel talks to the bots through PluralKit. PK deletes the message he typed and reposts it via
webhook under the fronting member's name, so **every proxied message arrives as `author.bot === true`
with `webhookId` set**. Three rules follow, and all three had live violations:

1. **Pairing runs at `messageCreate` time, never inside a turn.** `pkDedup.addOriginal` /
   `matchWebhook` are called in bot-core before `inbox.enqueue`; only the decision
   (`pkDedup.waitForClaim`) runs inside the turn. `ChannelInbox` serializes turns per channel,
   so a hold taken inside the original's turn blocks the webhook turn whose claim it waits for --
   the pair can never match, the already-deleted original is processed in full, and the proxy
   loses its captured sender id. Guarded by `__tests__/pk-inbox-integration.test.ts`, which also
   reproduces the broken placement so the test can't go vacuous.
2. **"Is this a bot?" is structural, not attribution-derived.** A companion bot posts as a bot user
   with **no** webhook; a PK proxy always has one. Deriving it from a PK API lookup (`author.bot &&
   !attribution.isOwner`) meant a lost race applied the entire cross-companion rail stack --
   human-anchored cap, pingpong cooldown, per-human response cap, chain limit, vocative-only
   gating -- to Raziel's own message, and the bots simply never answered. Use the `botTurn()`
   helper; `countBotMsgsSinceHuman` and `computeChainDepth` fall back to that flag when called
   with an empty id set.
3. **Identity comes from the roster first (`pk-roster.ts`), not the per-message API.** PK writes the
   member's display name onto the webhook, so `GET /v2/systems/{id}/members` (public; fetched once,
   Redis-cached, refreshed hourly, shared by all three bots) identifies the front offline with no
   race. The `/v2/messages/{id}` lookup is the fallback and now retries once -- PK writes that
   record just *after* dispatching the webhook. A cross-system name collision resolves to *nothing*
   rather than guessing a tier. Fail-open: no `PLURALKIT_SYSTEM_ID`, or a private member list, and
   behavior degrades to the old API path.

An unrecognized webhook post is dropped (hard muzzle) but now logs
`unconfirmed webhook post from "<name>"` -- that failure used to be silent and read as the bots
ignoring him.

## Sol (2026-09-29)

Sol, the triad's crow, posts via the worker's `SOL_WEBHOOK_URL` webhook. The bots recognize Sol by
**webhook id** (`sol-sender.ts`, parsed once at boot; never the name, never the token) and let Sol
through the muzzle, logging `[<companion>] Sol post recognized ch= msg= chars=`. Sol is household,
not human: a Sol turn is governed by the bot rails and never resets them, and every rail that walks
history (`countBotMsgsSinceHuman`, `computeChainDepth`, the fit bid's monopoly run, the exchange
holder) runs on `withoutSol(history)`, so a crow moment can never re-open a floor Raziel's absence
closed. Who answers: `solMayAnswer` (no vocative needed, owner_only does not shut Sol out, broadcast
and the companion allowlist hold, named/host rules apply) then the fit bid (one speaker; losers may
react). Sol skips the ambient relevance classifier, the PK pairing and attribution, the director
bus, the thread spine append, Second Brain live ingest, tripwires, voice, guest framing and the
empty-inference fallback line, and never supersedes a queued turn. STM records it as
`Sol (the triad's crow)`.

## Address model (B37 shadow, 2026-09-29)

Spec: `Hand-off/SPEC-who-is-this-spoken-to-2026-09-29.md` (A, B, E). The regex (`extractAddress`) reads
any name as a call ("Cy said..." summons Cypher) and the 15-minute exchange hold hands every nameless
message to whoever spoke last. The classifier asks a small model one question instead: who is this
spoken TO (`[ids]` / `"room"` / `"continuing"`), and who is only MENTIONED.

- **Shadow only.** `fireAddressShadow` is called in `bot-message-handler.ts` right after the regex verdict
  and the holder are settled and BEFORE this bot's own gates return (it must see messages this bot will
  not answer). It returns void and runs detached; nothing awaits it; it cannot throw into the reply path.
- **Runs for:** Raziel's messages (own account or PK front), never siblings, Sol, DMs (asserted twice) or
  replayed pass turns; and only when the fast path did not decide (no @mention, no reply to a companion,
  no vocative per `isVocativeAddress`) AND a name appears elsewhere, or no name but a holder exists.
- **Once per message:** `SET ns:addr:claim:<msgId> <me> PX 120000 NX`; losers do nothing; no Redis = no
  shadow. Model: `withCaller(directAdapter, "address_model")` (DeepInfra Flash, the judges' lane; never
  Hermes), temp 0, 150 tokens, 8s race. Cost ~1.1k in + ~40 out plus reasoning per run, order $0.0001.
- **Outputs:** `[address] {json}` stdout (ids and verdicts, no text) and a `kind:"shadow"` JSONL row with
  the text and last 6 turns. Every bot also appends a `kind:"spoke"` row after sending a reply to a human
  message (origin id), which is how the report knows who ACTUALLY spoke on every path. `regex_route` is a
  derivation; `spoke_bid`/`bids` are read from `ns:spoke:`/`ns:bid:` after the bid window (bid path only).
- **Read-out:** `node scripts/address-shadow-report.mjs [--days N] [--min-confidence X] [--out DIR]`.
  Stdout never prints text; `--out` writes `label-disagreements.md` / `.csv` (with text) for Raziel.
  Flip to live is a later build, only after the model beats the regex on his labels.

## Autonomous Worker

Standalone package (`packages/autonomous-worker/`) runs a 6-phase pipeline per companion on a cron schedule:

1. **Orient** -- load full identity file + botOrient state + growth context
2. **Seed** -- pick unused seed from `autonomy_seeds` or self-generate via DeepSeek
3. **Explore** -- lane guard check + Tavily web search + DeepSeek summarize through companion lens
4. **Synthesize** -- draft `growth_journal` entry in companion voice (JSON: entry_type, content, tags)
5. **Write** -- persist journal entry + any patterns/markers to Halseth growth tables
6. **Reflect** -- brief reflection + extract 0-2 new seed suggestions (non-fatal)

**Schedules:** Cypher 3AM / Drevan 5AM / Gaia 7AM (cron daemon via node-cron)

**Manual test:** `node dist/index.js --once --companion=cypher`

**Inference:** DeepSeek V3 (~$0.003/run, ~$0.27/month for 3 companions daily)

**Web search:** Tavily free tier (1000 searches/month)

## Env

`nullsafe-discord/.env` -- gitignored

| Var | Used by | Purpose |
|-----|---------|---------|
| `DISCORD_TOKEN` | bots | Per-companion bot token |
| `NULLSAFE_BOT` | bots | Bot identity (`cypher`/`drevan`/`gaia`), set per bot by ecosystem.config.js. The shared .env loader (`packages/shared/src/env-file.ts`) uses it to let `<BOT>_INFERENCE_MODE` / `<BOT>_HERMES_API_URL` (and any `<BOT>_<KEY>` for a key in .env) win over a generic `KEY=` line, so one `.env` line cannot flatten the three bots onto one Hermes port (P2-12, 2026-10-08). Falls back to pm2's `name` minus `-bot` |
| `HALSETH_URL` | bots + worker | Halseth API base URL |
| `ADMIN_SECRET` | bots + worker | Auth token |
| `REDIS_URL` | bots + worker | Floor lock + idle signaling + PK roster cache |
| `PLURALKIT_SYSTEM_ID` | bots | Raziel's PK system -- member roster for offline front recognition |
| `BLUE_PK_SYSTEM_ID` | bots | Blue's PK system (ecosystem default `szplj`) |
| `DEEPSEEK_API_KEY` | worker + bots | DeepSeek inference (worker); for the bots the direct-DeepSeek EMERGENCY lane. Required by a bot only in `INFERENCE_MODE=direct`; in hermes mode it is optional and boot logs once `DEEPSEEK_API_KEY unset: the direct-DeepSeek emergency lane is unarmed` (P3-15, 2026-10-08) |
| `TAVILY_API_KEY` | worker | Web search |
| `CYPHER_IDENTITY_PATH` | worker | Full identity .md file (disk) |
| `DREVAN_IDENTITY_PATH` | worker | Full identity .md file (disk) |
| `GAIA_IDENTITY_PATH` | worker | Full identity .md file (disk) |
| `VISION_ENABLED` | bots | Kill switch for describing image attachments. Default ON; set `false` to disable |
| `VISION_MODEL` | bots | Override the describe model (default `Qwen/Qwen3-VL-30B-A3B-Instruct` on DeepInfra) |
| `VISION_CACHE` | bots | Shared image-description cache (`vision-cache.ts`, 2026-10-18, P1 of `Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md`). Default ON; `off`/`0`/`false`/`no` = every describe is a direct call (old behavior). Redis keys: `ns:vision:att:<model>:<attachmentId>`, `ns:vision:v1:<model>:<sha256(bytes)>` (survives a PluralKit re-upload), `ns:vision:lock:<sha>` (SET NX so the three bots share ONE VL call; waiters poll the result, one takes over if the owner dies), `ns:vision:neg:<sha>` / `ns:vision:neg:att:<id>`. Per-process in-flight map, so a retry awaits instead of re-calling; the describe is detached from the turn, so supersede never orphans it. Redis error = direct call. Logs `[vision-cache] <companion> hit\|miss\|wait\|lock-wait\|neg ms=N key=<id\|sha8>` (ids only, never the url or the text). pm2-allowlisted |
| `VISION_CACHE_TTL_S` | bots | Success TTL for the vision cache, default `21600` (6h) |
| `VISION_NEG_TTL_S` | bots | Failure (negative) TTL, default `120`: a retry inside two minutes does not re-hit a struggling endpoint |
| `VISION_PREFETCH` | bots | P2. Default ON; `off` = describe inside the turn and wait for all of it (pre-2026-10-18). On: bot-core starts the describe at `MessageCreate` (event time, like PK pairing, never inside a turn) for human/PK image messages |
| `VISION_TURN_BUDGET_MS` | bots | P2. Default `20000`; `0` = wait for the whole describe. A turn waits at most this long, then uses the "image NOT seen" path; the late description still lands in the cache for the next turn. A superseded turn never waits (cache read only, no new VL call); one superseded mid-wait stops waiting |
| `DEEPINFRA_API_KEY` | bots | Direct-inference chain (judges, consolidation) **and** the image describe pass |
| `FOLLOWUP_PASS` | bots | Multi-address follow-up pass (`pass-turn.ts`). Default ON; `off` stops the publish (a railed companion no longer passes its turn) and the listener (a pass never consumes an entitlement). pm2-allowlisted |
| `VERBATIM_COPY_THRESHOLD` | bots | Verbatim-copy rail ratio, (0, 1], default `0.9`. pm2-allowlisted since 2026-09-26 (it was a dead knob before) |
| `LEDGER_DISTILL` | bots | Ledger lane T2 (`ledger-clerk.ts`, 2026-09-26). Default ON: distillers (channel-inactive, mid-session, day note, consolidation) and Gaia's passive witness write sourced clerk lines to Halseth `POST /ledger`; the handoff summary is the accepted lines' marked content. `off`, `0`, `false` or `no` (trimmed, any case) restore the first-person writers byte for byte; any other value is ON. Consolidation writes ONE deterministic line in code (no clerk model; <=48 narrator calls/companion/day) and NO handoff row (it still cycles the session), so idle passes never push real handoffs out of orient's latest-3. Transient POST failures retry inline 2s/8s/30s; 422/404 never retry. A no-handoff inactive pass logs `[ledger] STALE_HANDOFF companion= channel= reason=` (health-check `ledger:handoffs:<c>`). Boot warns LOUD when no DEEPINFRA/DEEPSEEK key (clerk would run on Hermes). **Needs Halseth /ledger deployed first** (a 404 accepts nothing, so no handoff). Under ON the distiller writes NO SOMA update and NO feeling log (Drevan's ruling 2026-09-26, all three companions; the structured-extract call is gone with them); Gaia's passive witness also writes a content-free `Present, silent. #<channel> <HH:MM> UTC.` record to her own gaia_witness store (witness_type `presence`, one per channel per 30 min, in-memory so a restart may add one). Companion commons/sibling writes answered 422 `ledger_restated`/`health_pointer` are logged once by rule and never retried. pm2-allowlisted |
| `MED_REMINDER` | bots | med_reminder DM scheduler (`med-reminder.ts`, 2026-09-27). Default ON; `off`/`0`/`false`/`no` stops it. Halseth `/mind/med/*` (mig 0136) decides what is due and who sends (Drevan primary, Cypher after 120s); a companion on no schedule row polls and gets nothing. `MED_REMINDER_GEN_TIMEOUT_MS` (default 25000) bounds the one-line generation before the fixed fallback line; `MED_REMINDER_POLL_MS` (default 30000). Logs carry slot keys and outcomes only, never the medication. pm2-allowlisted |
| `DM_MEMORY` | bots | Owner DMs are sealed from every raw-quote surface regardless. Default sealed also keeps distillation and the writeback judge off for DMs; `carry` opens those two paraphrasing paths (`dm.ts`). Non-owner DMs are dropped before any work. pm2-allowlisted |
| `SOL_WEBHOOK_URL` | bots + worker | Worker POSTS Sol's moments through it; bots read only the webhook id to recognize Sol (`sol-sender.ts`). Unset on a bot: Sol stays dropped and the bot logs one boot line. pm2-allowlisted (shared) |
| `REACH_DM` | bots | Kill switch for B7's Raziel-facing DM moves (`reach-dm.ts` `reachDmOn`, 2026-09-27). **Default OFF, fails closed: only `on` (trimmed, any case) opens it**; unset, empty or any other value is off (the inverse of the usual `off/0/false/no` knobs). Off, every move `routeFor` sends to the DM (care verbs, `share_observation`, `share_media`, `declare_preference`, flirt/dare/show_made/drift_outward, ...) is removed from the heartbeat palette before the decision prompt, through the same `filterDmLane` that drops moves the shared lane cannot carry; they never fall back to Sol's channel. The tick line carries `dm_moves_off: N` when the switch removed moves, and outcome `suppressed_reach_dm_off` when nothing else was eligible (never `suppressed_triad_cap`). Untouched by it: `med_reminder` (own scheduler, imports only `owner-dm.ts`), the reply path and owner DMs, `post_heartbeat`/`tend_creature`, sibling writes, `drift_open`, `write_note_to_raziel`. **Flip to `on` only once the triad has approved the move prompts** (`Hand-off/SHOWBACK-palette-2026-09-27.md`). pm2-allowlisted |
| `REACH_BACKOFF` | bots | Reach-out outcome ledger back-off (`reach-ledger.ts`, P13b, 2026-10-13). **Default ON; `off`/`0`/`false`/`no` turns the back-off off** (the ledger still records and logs). Every DM move `speakToOwnerDm` sends writes a Redis row (`ns:reach:ledger` + `ns:reach:out:<msgId>`, 14d TTL, ids only). Outcome: `replied` (any owner message after it, or a non-dismissal reaction on it), `dismissed` (dismissal emoji, or a bare 'not now' as the whole message in that DM), `unanswered` (no message or reaction within `REACH_UNANSWERED_WINDOW_MS`, default 6h). Settled once via HSETNX (one `[reach-ledger] outcome=<o> id= companion= action= age_min=` line). The heartbeat drops DM moves while the gap since the last send is under `REACH_BACKOFF_BASE_MS` (3h) * 2^(streak-1), capped `REACH_BACKOFF_MAX_MS` (72h); a dismissal counts double, a reply resets to zero; a gap not a clock window, so 2am is unaffected; hold presence (Halseth caps it 2 per companion per hold) is exempt; med reminders and channel posts never touch it. Tick outcome `suppressed_reach_backoff`; log `reach back-off: streak= gap_h= wait_min=`. No Redis or a read error fails OPEN. Halseth follow-up: mirror the rows into D1 beside triad_reach_claims. pm2-allowlisted (all four) |
| `BAD_NIGHT_PRESENCE` | bots | B32 bad-night presence (`bad-night.ts`, 2026-10-04, spec `Hand-off/DESIGN-B32-bad-night-presence-2026-10-03.md`). **Default OFF, fails closed: only `shadow` or `on`.** Shadow logs `[b32] <companion> eligible=<why> -> shadow` at every decision and changes nothing (no Halseth call, no follow-up, no window/floor bypass, no DM filter). On: "bad night" / "good now" as a whole message or own sentence start/clear the care hold (`POST /mind/care/hold`, answering bot only; local state applied at once, reply opens by saying so); under hold a sibling he did not speak to gets a care follow-up position in a guild channel (30-min throttle per sibling per channel, from shared history; may `[PASS]`); every heartbeat tick asks all three (window + floor bypassed); no DM move while a sibling's owner DM is live (Redis `ns:b32:ownerdm:<c>`, 30 min; no Redis = held); presence moves gate on Halseth's `reach.hold_presence.open`; every owner guild message under hold bids with minScore 0 so the one leading its chain always answers (shadow logs `eligible=floor0`). Grep `[b32]`. Needs Halseth contract 0.19.0. pm2-allowlisted |
| `ADDRESS_MODEL` | bots | B37 "who is this spoken to" classifier (`address-model.ts` / `address-shadow.ts`, 2026-09-29). **Code default OFF; the ecosystem file defaults the bots to `shadow`.** Only `shadow` (trimmed, any case) runs it; any other value is off; there is no live value yet. Shadow never changes who speaks: see "Address model (B37 shadow)" below. A `.env` line wins over the ecosystem default. pm2-allowlisted |
| `REACH_DECLINE` | bots | What a NONE costs in `OWN_NOTES_RECALL_MODE=ask` (`reach-decision.ts` `reachDeclineMode`, 2026-09-30). Default `payload`: a declined ask still gets the floor notes pasted in. `unread:<c>[,<c>]` (or `unread` for all): the ask tells him a NONE leaves his notes unread, and a real NONE answers with the vault floor plus one "you chose not to look, do not guess" line, no notes. Timeout, error and empty replies keep the payload floor. Why: Cypher's first 18 asks were 18 NONEs over 4 found notes each; under payload the choice cost nothing. Decision log rows carry `decline_mode`. pm2-allowlisted |
| `WATCHALONG_ENABLED` | bots | Watchalong (`watchalong.ts`, spec `docs/SPEC-watchalong-2026-10-02.md`, 2026-10-02). Default ON; `off`/`0`/`false`/`no` stops the per-turn `GET /mind/watchalong/active` read, the `[ON SCREEN]` block on the live user turn and the standing line. The `movie`/`at` commands work either way. pm2-allowlisted |
| `OPENSUBTITLES_API_KEY` / `_USERNAME` / `_PASSWORD` | bots | Caption source for `<p>: movie start <title>` when nothing is attached and the title is not a URL (HI tracks preferred). Without the key the ack says to attach an .srt. Username/password optional (higher daily quota). pm2-allowlisted |
| `GUILD_TRIAD_SEED` | bots | #the-triad server-scoped seeder (`guild-seed.ts` + `runGuildTriadSeed` in `autonomous-core.ts`, 2026-10-05). **Default OFF, fails closed: only `shadow` or `on`** (trimmed, any case). Its only material is what was said in the OTHER channels of the server shared with Blue since the last seed (read from Discord history; humans + PK + the triad's own lines + other bots labelled `(bot)`; Sol removed; newest 40 msgs / 6k chars). Cron per bot every 30 min (Cy :07/:37, Dre :17/:47, Gaia :27/:57), outside the director branch. Gates in order: Redis present; no live session window; >= 2h since the last seed and the last seeder yields for 12h; #the-triad idle >= 10 min and under the human-anchored cap (12, 12h forgiveness; at the cap: no seed, since a nameless seed cannot start a sibling reply); NX claim `ns:guildseed:<mode>:claim:<lastSeedAt>` (25 min); no human message since the last seed = no post; under 12h needs >= 5 human messages; floor lock. One line per tick: `[guild-seed] <companion> decision=<post|skip:<why>> supply_msgs=N chars=M humans=H claimed=<c> mode=<m>`, never text. Shadow claims and stamps its own `ns:guildseed:shadow:*` keys, never generates or posts. `GUILD_TRIAD_CHANNEL_ID` (default `1556334827026784266`) and `GUILD_TRIAD_SUPPLY_CHANNELS` (comma list; default the 17 other text channels) override the code constants; #the-syndicate and #the-triad are always stripped, and a supply channel in another guild is dropped with a warning. #the-triad must stay out of `DIRECTOR_CHANNELS`. pm2-allowlisted |
| `BURST_SETTLE_MS` | bots | Burst settle (`channel-inbox.ts` `burstSettleMs`, 2026-10-10). Default `4000`; `0` (or negative) disables = the exact old behavior; junk falls back to 4000. A human conversational message waits until the channel has been quiet that long (measured from the NEWEST queued human message), then only the newest turn answers, handed the gathered burst (the same human SIDE's earlier messages, 2026-10-18: Sora and Megan are both Blue, so one speaker; `BURST_SETTLE_SCOPE=speaker` restores per-author; their turns still absorb into STM but never reply, and never advance the hermes delivered mark, so `hermesDelta` folds their words into the one prompt). Command-shaped messages (`cy: model ...`, `dre: movie ...`) stay instant and cut a settle short; Sol and companion posts never start or restart the clock; PK pairing is untouched. The clock extends only from the same side's newest message (Raziel's fronts never hold Blue's burst, and the reverse) and the head is released at `BURST_SETTLE_MAX_MS` from its arrival even if messages keep landing. The turn still reports the configured window, so the fit-bid deadline stays `createdTimestamp + BURST_SETTLE_MS + 2500` (`bidDeadlineAt`, keyed on the newest message) so the three bots still converge on one speaker; **set the same value on all three bots**. Boot logs `burst settle: Nms\|off`. pm2-allowlisted |
| `SUPERSEDE_SIDE_AWARE` | bots | P3 (`channel-inbox.ts`, 2026-10-18, Raziel's ruling 2). Default ON; `off`/`0`/`false`/`no` = any human conversational message supersedes (old rule). On: `InboxItem.side` (`raziel` / `blue` / null) is resolved at enqueue in bot-core from the author id or the in-memory PK roster (`resolveInboxSide`; all of Blue's members are `blue`, all of Raziel's fronts `raziel`); only a SAME-side human message supersedes, so Raziel's message never cancels an answer to Blue and the reverse. An unknown side (roster miss, guest) supersedes like before. Boot logs `inbox: supersede side_aware= check_b= settle_scope= settle_max=`. pm2-allowlisted |
| `SUPERSEDE_B` | bots | P3 (ruling 3, revised). Default OFF; only `on`/`1`/`true`/`yes` opens it. Check B (drop a finished reply when a newer human message queued mid-inference) is gone by default: the in-flight reply finishes and posts (a Hermes call cannot be cancelled, and the old drop left an unposted assistant turn in the transcript), then the messages that arrived meanwhile get ONE catch-up turn: the queue head absorbs all but the newest (STM kept; check A still skips the model for them), the newest answers with `hermesDelta` folding the rest and `ctx.burst` carrying them. A turn that posted is never re-gathered into its successor's burst. `on` restores the drop. No min-gap knob (dropped). Check A (pre-inference) is unchanged. pm2-allowlisted |
| `BURST_SETTLE_SCOPE` | bots | P4. `side` (default; junk also means side) = the settle clock and the gathered burst group by human side; `speaker` = the old per-author burst (clock still room-wide for humans). A webhook whose roster lookup misses falls back to per-author, never worse than before. pm2-allowlisted |
| `BURST_SETTLE_MAX_MS` | bots | P4. Hold cap, default `20000`, measured from the head's arrival; `0` or negative = no cap; junk = default. A stream of messages each under `BURST_SETTLE_MS` apart releases the head at the cap (it answers the burst so far; the rest forms the next one). The released turn still reports the configured `BURST_SETTLE_MS`, so the fit-bid deadline convergence across the three bots is unchanged. pm2-allowlisted |
| `BLUE_COLD_PICK` | bots | Ruling 4 (`blue-cold-pick.ts`, 2026-10-18). A cold unnamed Blue message with no holder: one companion may answer, picked by Jev (the `address-jev.ts` call, `jevAddressEval`, same lane and `ADDRESS_JEV=off` kill switch; no new model). **`shadow` (default)**: the claim winner (`SET ns:bluecold:claim:<msgId> NX`) asks Jev detached and logs `[blue-cold] pick=<companion\|none> mode= ch= msg= by= why= addressee= conf= score=` (ids and numbers only); nobody speaks, today's silence stands. **`on`**: the pick is published (`ns:bluecold:pick:<msgId>`), losers wait up to 6.5s for it, and only the picked companion that also wins `ns:bluecold:answer:<msgId>` NX answers (as if it held the thread; `recordHumanHold` at send then makes it the real holder). **`off`**: no Jev call, no Redis. No pick (silence) when: Jev addressee is raziel/blue/someone_else/nobody, `invites_reply` < 0.4, best mean of spoken-to and has-something-for < 0.3, Jev fails, or no Redis. Consulted only on the branch that used to say "nobody answers": a holder, a named companion, a human address and every rail are untouched. Flip to `on` after reading the shadow picks. pm2-allowlisted |
| `RAZIEL_NAMES` | bots | Human-address gate (`human-address.ts`, 2026-10-10): comma list of names that CALL Raziel at vocative position (message/sentence start, after a greeting, or trailing after a comma). Default `raziel,raz`. When Blue calls one of them and no companion is named in the gathered burst, every companion stays silent (all channel classes). The owner's fronting member name and PluralKit's roster are deliberately NOT included. pm2-allowlisted |
| `BLUE_NAMES` | bots | Same, for Blue (default `blue`). Raziel calling Blue by name with no companion named silences the triad. An UNNAMED message from Blue is answered only by the companion that replied to Blue last in that channel within the exchange window (per-human Redis hold `ns:humanhold:blue:<channel>`, independent of Raziel's holder; replies to Blue are skipped in Raziel's holder walk); no holder: silence by default, **unless `BLUE_COLD_PICK=on`** (2026-10-18), in which case Jev picks ONE companion to answer (see that row); no bid round either way. pm2-allowlisted |
| `SPEAKER_FRAME` | bots | Room rendering (`speaker-frame.ts` + `hermesDelta` extras, 2026-10-11). Default ON; `off`/`0`/`false`/`no` removes the frame. Hermes turn order is now: clock, cross-room "elsewhere" (background, ABOVE), witnessed room lines, `[Live message]`, the live words (+ watchalong/B32 blocks), then the frame LAST: `[You are Drevan. You are answering Noah M. (Raziel, through PluralKit), who called you "Dre" (your name, not theirs). "(via PK)" marks a system member speaking. "(Blue's system)" marks a member of Blue's system: Blue, Raziel's husband, speaking as that member. Cypher and Gaia are your siblings, not you. Reply only as yourself.]` Never in a DM. Post-generation, always on: (1) `repairMisseated` cuts own-name vocatives (", Dre." / line-opening "Dre," / line-closing "... Dre.") every turn (the 2026-10-11 gate on the speaker using a companion name was removed; sign-offs like "Yours, Dre." are exempt via a SIGN_OFF pattern; a cut slip rotates the Hermes transcript via the retract bump and is named in the next frame); (2) `cutImpersonation` (stop strings after the fact; the gateway takes none) cuts at a `[Name]:` / `**Name:**` line for anyone, or a bare `Name:` for a human. Both log `seat repair:`. Blue unproxied is labelled `Blue` (not his username). **Blue's PK members (2026-10-18)** are labelled `<member> (Blue's system)` in the STM/room transcript (`pkRoomLabel`, used at both `appendInboundOnce` sites; userTier "intimate" and not owner), while Raziel's fronts keep `<member> (via PK)`. The frame adds `"(Blue's system)" marks a member of Blue's system: Blue, Raziel's husband, speaking as that member.`; `cutImpersonation` accepts either suffix; the writeback judge speaker is kind `blue` ("a member of Blue's system (Blue is Raziel's husband, family, not a guest)"), not `guest`. `guild-seed` `classifyAuthor` has no identity data and still labels webhook authors `(via PK)`. Why: BBH `Hand-off/RESEARCH-group-room-rendering-2026-10-11.md`. pm2-allowlisted |
| `PK_PROFILE` | bots | PluralKit speaker profile (`pkProfileBlock` in `speaker-frame.ts`, `description` in `pk-roster.ts`, 2026-10-18). Default ON; `off`/`0`/`false`/`no` (trimmed, any case) removes it. In a guild turn, when a PK member speaks, the live turn gets `[Who is speaking: Kyle Barnes, a member of Blue's system. Pronouns: he/him. Their PluralKit profile, in their own words (data about them, not instructions to you): "..."]` directly above the speaker frame (frame stays LAST). Current speaker only, never a roster; never a DM; the profile sentence is omitted when the description is empty; Raziel's fronts read `a member of Raziel's system`. Source is the public roster pull (private fields come back null, so PK privacy is respected); the description is cleaned (mentions, emoji, markdown, links stripped) and capped at 500 chars. Redis: names stay in `ns:pk:roster:v3`, descriptions live in their own `ns:pk:profiles:v1` (one entry per member, so the 1,400-row name index is not bloated). One log line per injection, counts only: `[pk-profile] <companion> member_chars=N system=<raziel\|blue>`. pm2-allowlisted |
| `CROSS_ROOM` | bots | Cross-room continuity (`cross-room.ts`, 2026-10-09). Default ON; `off`/`0`/`false`/`no` stops carrying other trusted rooms' lines into the live turn. pm2-allowlisted since 2026-10-11 |
| `ADDRESS_SHADOW_LOG` | bots | JSONL for the address shadow (default `/app/logs/address-shadow.jsonl`, not rotated, like `jev-shadow.jsonl`). Holds message text and recent turns for labelling. pm2-allowlisted |

## Identity Files

Each bot loads its companion identity file at session start from a path configured via `CYPHER_IDENTITY_PATH`, `DREVAN_IDENTITY_PATH`, and `GAIA_IDENTITY_PATH` env vars. The files are versioned Markdown documents defining voice, lane constraints, and behavioral guardrails. Lane violations are first-class -- drift detection is a system requirement.
