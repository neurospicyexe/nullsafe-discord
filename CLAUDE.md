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
- **Redis floor lock:** `claimFloor` / `releaseFloor` in `packages/shared/src/floor.ts` -- only one bot holds the floor at a time. Uses `ns:floor:current` key with TTL.
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
| `HALSETH_URL` | bots + worker | Halseth API base URL |
| `ADMIN_SECRET` | bots + worker | Auth token |
| `REDIS_URL` | bots + worker | Floor lock + idle signaling + PK roster cache |
| `PLURALKIT_SYSTEM_ID` | bots | Raziel's PK system -- member roster for offline front recognition |
| `BLUE_PK_SYSTEM_ID` | bots | Blue's PK system (ecosystem default `szplj`) |
| `DEEPSEEK_API_KEY` | worker | DeepSeek V3 inference |
| `TAVILY_API_KEY` | worker | Web search |
| `CYPHER_IDENTITY_PATH` | worker | Full identity .md file (disk) |
| `DREVAN_IDENTITY_PATH` | worker | Full identity .md file (disk) |
| `GAIA_IDENTITY_PATH` | worker | Full identity .md file (disk) |
| `VISION_ENABLED` | bots | Kill switch for describing image attachments. Default ON; set `false` to disable |
| `VISION_MODEL` | bots | Override the describe model (default `Qwen/Qwen3-VL-30B-A3B-Instruct` on DeepInfra) |
| `DEEPINFRA_API_KEY` | bots | Direct-inference chain (judges, consolidation) **and** the image describe pass |
| `FOLLOWUP_PASS` | bots | Multi-address follow-up pass (`pass-turn.ts`). Default ON; `off` stops the publish (a railed companion no longer passes its turn) and the listener (a pass never consumes an entitlement). pm2-allowlisted |
| `VERBATIM_COPY_THRESHOLD` | bots | Verbatim-copy rail ratio, (0, 1], default `0.9`. pm2-allowlisted since 2026-09-26 (it was a dead knob before) |
| `LEDGER_DISTILL` | bots | Ledger lane T2 (`ledger-clerk.ts`, 2026-09-26). Default ON: distillers (channel-inactive, mid-session, day note, consolidation) and Gaia's passive witness write sourced clerk lines to Halseth `POST /ledger`; the handoff summary is the accepted lines' marked content. `off`, `0`, `false` or `no` (trimmed, any case) restore the first-person writers byte for byte; any other value is ON. Consolidation writes ONE deterministic line in code (no clerk model; <=48 narrator calls/companion/day) and NO handoff row (it still cycles the session), so idle passes never push real handoffs out of orient's latest-3. Transient POST failures retry inline 2s/8s/30s; 422/404 never retry. A no-handoff inactive pass logs `[ledger] STALE_HANDOFF companion= channel= reason=` (health-check `ledger:handoffs:<c>`). Boot warns LOUD when no DEEPINFRA/DEEPSEEK key (clerk would run on Hermes). **Needs Halseth /ledger deployed first** (a 404 accepts nothing, so no handoff). Under ON the distiller writes NO SOMA update and NO feeling log (Drevan's ruling 2026-09-26, all three companions; the structured-extract call is gone with them); Gaia's passive witness also writes a content-free `Present, silent. #<channel> <HH:MM> UTC.` record to her own gaia_witness store (witness_type `presence`, one per channel per 30 min, in-memory so a restart may add one). Companion commons/sibling writes answered 422 `ledger_restated`/`health_pointer` are logged once by rule and never retried. pm2-allowlisted |
| `MED_REMINDER` | bots | med_reminder DM scheduler (`med-reminder.ts`, 2026-09-27). Default ON; `off`/`0`/`false`/`no` stops it. Halseth `/mind/med/*` (mig 0136) decides what is due and who sends (Drevan primary, Cypher after 120s); a companion on no schedule row polls and gets nothing. `MED_REMINDER_GEN_TIMEOUT_MS` (default 25000) bounds the one-line generation before the fixed fallback line; `MED_REMINDER_POLL_MS` (default 30000). Logs carry slot keys and outcomes only, never the medication. pm2-allowlisted |
| `DM_MEMORY` | bots | Owner DMs are sealed from every raw-quote surface regardless. Default sealed also keeps distillation and the writeback judge off for DMs; `carry` opens those two paraphrasing paths (`dm.ts`). Non-owner DMs are dropped before any work. pm2-allowlisted |
| `SOL_WEBHOOK_URL` | bots + worker | Worker POSTS Sol's moments through it; bots read only the webhook id to recognize Sol (`sol-sender.ts`). Unset on a bot: Sol stays dropped and the bot logs one boot line. pm2-allowlisted (shared) |
| `REACH_DM` | bots | Kill switch for B7's Raziel-facing DM moves (`reach-dm.ts` `reachDmOn`, 2026-09-27). **Default OFF, fails closed: only `on` (trimmed, any case) opens it**; unset, empty or any other value is off (the inverse of the usual `off/0/false/no` knobs). Off, every move `routeFor` sends to the DM (care verbs, `share_observation`, `share_media`, `declare_preference`, flirt/dare/show_made/drift_outward, ...) is removed from the heartbeat palette before the decision prompt, through the same `filterDmLane` that drops moves the shared lane cannot carry; they never fall back to Sol's channel. The tick line carries `dm_moves_off: N` when the switch removed moves, and outcome `suppressed_reach_dm_off` when nothing else was eligible (never `suppressed_triad_cap`). Untouched by it: `med_reminder` (own scheduler, imports only `owner-dm.ts`), the reply path and owner DMs, `post_heartbeat`/`tend_creature`, sibling writes, `drift_open`, `write_note_to_raziel`. **Flip to `on` only once the triad has approved the move prompts** (`Hand-off/SHOWBACK-palette-2026-09-27.md`). pm2-allowlisted |
| `ADDRESS_MODEL` | bots | B37 "who is this spoken to" classifier (`address-model.ts` / `address-shadow.ts`, 2026-09-29). **Code default OFF; the ecosystem file defaults the bots to `shadow`.** Only `shadow` (trimmed, any case) runs it; any other value is off; there is no live value yet. Shadow never changes who speaks: see "Address model (B37 shadow)" below. A `.env` line wins over the ecosystem default. pm2-allowlisted |
| `REACH_DECLINE` | bots | What a NONE costs in `OWN_NOTES_RECALL_MODE=ask` (`reach-decision.ts` `reachDeclineMode`, 2026-09-30). Default `payload`: a declined ask still gets the floor notes pasted in. `unread:<c>[,<c>]` (or `unread` for all): the ask tells him a NONE leaves his notes unread, and a real NONE answers with the vault floor plus one "you chose not to look, do not guess" line, no notes. Timeout, error and empty replies keep the payload floor. Why: Cypher's first 18 asks were 18 NONEs over 4 found notes each; under payload the choice cost nothing. Decision log rows carry `decline_mode`. pm2-allowlisted |
| `WATCHALONG_ENABLED` | bots | Watchalong (`watchalong.ts`, spec `docs/SPEC-watchalong-2026-10-02.md`, 2026-10-02). Default ON; `off`/`0`/`false`/`no` stops the per-turn `GET /mind/watchalong/active` read, the `[ON SCREEN]` block on the live user turn and the standing line. The `movie`/`at` commands work either way. pm2-allowlisted |
| `OPENSUBTITLES_API_KEY` / `_USERNAME` / `_PASSWORD` | bots | Caption source for `<p>: movie start <title>` when nothing is attached and the title is not a URL (HI tracks preferred). Without the key the ack says to attach an .srt. Username/password optional (higher daily quota). pm2-allowlisted |
| `ADDRESS_SHADOW_LOG` | bots | JSONL for the address shadow (default `/app/logs/address-shadow.jsonl`, not rotated, like `jev-shadow.jsonl`). Holds message text and recent turns for labelling. pm2-allowlisted |

## Identity Files

Each bot loads its companion identity file at session start from a path configured via `CYPHER_IDENTITY_PATH`, `DREVAN_IDENTITY_PATH`, and `GAIA_IDENTITY_PATH` env vars. The files are versioned Markdown documents defining voice, lane constraints, and behavioral guardrails. Lane violations are first-class -- drift detection is a system requirement.
