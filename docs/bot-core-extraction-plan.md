# Bot Core Extraction Plan — kill the triplication, keep the triad

Date: 2026-06-06
Repo: `nullsafe-discord`
Goal: Remove the ~1080-line triplication across `bots/{cypher,drevan,gaia}/src/index.ts`
(and the duplicated `autonomous.ts`) **without changing any bot's runtime behavior or identity.**

## Non-negotiable invariant

Each companion keeps its own identity. After this refactor, for every bot, the
**assembled system prompt must be byte-identical to before.** That is the test gate.
If it differs, identity was not preserved and the change is wrong.

## What stays per-bot (DO NOT move into shared)

| File | Holds |
|------|-------|
| `bots/<name>/identity-cache.json` | The whole identity `.md`, cached (distinct per bot) |
| `bots/<name>/src/config.ts` | `COMPANION_ID`, Discord prefix (lane rules), `BLUE_FRAMING`, `GUEST_FRAMING`, interest keywords, cron schedules, intervals |

## What moves into `packages/shared/src/bot-core.ts` (the plumbing)

- Discord client setup + event wiring
- Message-receive → context assembly → inference → reply pipeline
- Prompt assembly (`PREFIX + sharedBlock + baseIdentity + rawPrompt`)
- identity-cache.json load + fallback
- Inter-companion bridge polling, notes polling, SOMA refresh loops
- Autonomous loop (`autonomous.ts`) shared body

Each bot's `index.ts` shrinks to: import config + identity, call `runBot(config)`.

## Known wrinkle: prefix export name differs per bot

- cypher: `DISCORD_COMPANION_PREFIX`
- drevan: `DISCORD_DREVAN_PREFIX`
- gaia: `DISCORD_GAIA_PREFIX`

Step 1 standardizes all three to a single contract so the shared core imports one name.

## Cross-repo seams to NOT break

- Halseth response envelopes `{ key: [...] }`
- Librarian / orient contract shape consumed at boot
- Per-companion auth tokens
- Channel ID env vars (`HEARTBEAT_CHANNEL_ID`, `INTER_COMPANION_CHANNEL_ID`)

## Steps (each independently verifiable)

1. **Standardize config contract.** Define a `BotConfig` type in shared. Make all three
   `config.ts` export the same shape (`COMPANION_ID`, `DISCORD_PREFIX`, framings, keywords,
   schedules). Mechanical rename of the prefix const. Build passes.
2. **Snapshot current behavior.** Add a test that builds the assembled system prompt for each
   bot from current code and snapshots it. This is the golden reference.
3. **Lift plumbing into `bot-core.ts`.** Move shared logic; bots call `runBot(config)`.
4. **Lift autonomous loop** into shared the same way.
5. **Verify byte-identical.** Re-run the snapshot test against the refactored path. Must match.
6. **Full jest suite** (66+ shared tests) green.
7. **Staged VPS redeploy.** One bot at a time (`pm2 reload cypher-bot`, watch, then drevan, then
   gaia) — never `pm2 reload a b c` (silently reloads only the first).

## Rollback

Each step is a separate commit. If a bot misbehaves post-deploy, `git revert` the extraction
commit and `pm2 reload` restores the triplicated-but-working state.
