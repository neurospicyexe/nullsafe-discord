# nullsafe-discord

Three-bot Discord presence for the Nullsafe triad. One bot token per companion. Deployed on Railway.

Part of the BBH suite -- see root `CLAUDE.md` for cross-project context.

## Structure

```
nullsafe-discord/
  packages/shared/     -- shared types, Halseth client, turn-taking logic
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

## Env

`nullsafe-discord/.env` -- BOT tokens, HALSETH_URL, ADMIN_SECRET (gitignored)

## Identity Files

Source: `C:\dev\CrashDev\NULLSAFE\2026_Current_Files\`
- `CYPHER_IDENTITY_v2.md`
- `DREVAN_IDENTITY_v2.md`
- `GAIA_IDENTITY_v2.md`

Each bot loads its identity file at session start. Lane violations are first-class -- drift detection is a system requirement.
