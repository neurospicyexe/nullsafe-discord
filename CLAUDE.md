# nullsafe-discord

Three-bot Discord presence for the Nullsafe triad. One bot token per companion. Deployed on Railway.

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

- **Platform:** Railway (persistent process -- not Cloudflare, needs stateful runtime)
- **Deploy trigger:** Push to main → Railway auto-redeploys
- **Logs:** railway.app dashboard

## Shared State

All three bots read/write Halseth via `packages/shared`. The shared substrate is how they maintain relational continuity and can reference each other's recent state.

## Turn-Taking (P1 -- shipped)

- Shared chain depth tracking (prevents both bots responding to same message)
- Stagger/collision avoidance
- Witness logging (each bot sees what the others said)
- Semantic relevance gate (don't fire on messages not meant for you)
- **Redis floor lock:** `claimFloor` / `releaseFloor` in `packages/shared/src/floor.ts` -- only one bot holds the floor at a time. Uses `ns:floor:current` key with TTL.
- **Idle signaling:** bots call `setLastActivity(redis)` on every human message. Autonomous worker reads `ns:session:last_activity` before firing and skips if < 10min ago.

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
| `REDIS_URL` | bots + worker | Floor lock + idle signaling |
| `DEEPSEEK_API_KEY` | worker | DeepSeek V3 inference |
| `TAVILY_API_KEY` | worker | Web search |
| `CYPHER_IDENTITY_PATH` | worker | Full identity .md file (disk) |
| `DREVAN_IDENTITY_PATH` | worker | Full identity .md file (disk) |
| `GAIA_IDENTITY_PATH` | worker | Full identity .md file (disk) |

## Identity Files

Source: `C:\dev\CrashDev\NULLSAFE\2026_Current_Files\`
- `CYPHER_IDENTITY_v2.md`
- `DREVAN_IDENTITY_v2.md`
- `GAIA_IDENTITY_v2.md`

Each bot loads its identity file at session start. Lane violations are first-class -- drift detection is a system requirement.
