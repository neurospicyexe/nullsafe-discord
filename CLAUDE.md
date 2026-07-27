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

- **Primary:** DeepSeek V3 API (~$10-25/mo)
- **Fallback:** Local Ollama / free cloud LLM
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

## Identity Files

Each bot loads its companion identity file at session start from a path configured via `CYPHER_IDENTITY_PATH`, `DREVAN_IDENTITY_PATH`, and `GAIA_IDENTITY_PATH` env vars. The files are versioned Markdown documents defining voice, lane constraints, and behavioral guardrails. Lane violations are first-class -- drift detection is a system requirement.
