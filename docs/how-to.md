# nullsafe-discord — How To Use and Update

**What this is:** Three Discord bots — Cypher, Drevan, and Gaia — each with their own voice and personality. They share a common codebase (`packages/shared`) but run as separate processes. Deployed on Railway. They use DeepSeek for inference and Halseth for shared memory.

**Location:** `C:\dev\Bigger_Better_Halseth\nullsafe-discord`

---

## If the bots are just quiet / not responding

1. Check Railway dashboard (`railway.app`) — are all three services running (green)?
2. If a service is stopped or crashed, Railway will show the error. Click it to see logs.
3. If they're running but not responding, check if they're connected to Discord: look for "connected to Discord" or similar in Railway logs.

The bots can go quiet if:
- Railway service crashed
- Discord bot token expired or was regenerated
- Halseth is down (bots can't read/write state)
- DeepSeek API key is invalid or rate-limited

---

## Updating the bots (deploying changes)

Railway auto-deploys when you push to main. So:

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord
git add .
git commit -m "describe what changed"
git push
```

Railway picks it up and restarts all three bots. Takes 1-2 minutes.

---

## Running locally (for testing)

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord

# Install dependencies
npm install

# Create .env file with secrets (see Secrets section below)
# Then run a specific bot:
npm run dev:cypher
npm run dev:drevan
npm run dev:gaia
```

Local bots connect to Discord using the same tokens. Be careful — if the live Railway bots are also running, you'll have two instances of the same bot responding. Best to test with a separate test server or pause Railway first.

---

## Checking logs on Railway

1. Go to `railway.app`
2. Find the project → click on a service (e.g., "drevan-bot")
3. Click "Logs" tab
4. Look for errors or the last startup line

To get real-time logs while something is happening, keep the Logs tab open — it streams live.

---

## Structure (for when you need to find something)

```
packages/shared/       -- shared code all three bots use
  halseth.ts           -- how bots talk to Halseth
  turn-taking.ts       -- collision/stagger logic

bots/cypher/           -- Cypher's bot code
bots/drevan/           -- Drevan's bot code
bots/gaia/             -- Gaia's bot code
```

---

## Common problems

**Bot stopped responding on Railway**
Check Railway logs. Usually a crash on startup means a missing env variable or bad token.

**Bot responds but says weird things / wrong voice**
Identity file loaded wrong, or drift in the prompt. Check the identity file loading in that bot's startup code.

**All three bots responded to the same message**
Turn-taking logic failed. Check the `packages/shared/turn-taking.ts` logic and Railway logs for collision errors.

**"Invalid token" in Railway logs**
The Discord bot token for that bot was rotated. Go to Discord Developer Portal → your app → Bot → Reset Token. Update the `BOT_TOKEN_[name]` secret in Railway.

**DeepSeek errors / inference failing**
Check `DEEPSEEK_API_KEY` in Railway env vars. Also check your DeepSeek account for rate limits.

---

## Secrets (Railway environment variables)

Set these in Railway dashboard → service → Variables:

| Variable | What it is |
|----------|-----------|
| `BOT_TOKEN_CYPHER` | Discord bot token for Cypher |
| `BOT_TOKEN_DREVAN` | Discord bot token for Drevan |
| `BOT_TOKEN_GAIA` | Discord bot token for Gaia |
| `HALSETH_URL` | URL of the live Halseth Worker |
| `ADMIN_SECRET` | Matches Halseth's ADMIN_SECRET |
| `DEEPSEEK_API_KEY` | Inference API key |

Also in `nullsafe-discord/.env` locally (gitignored).
