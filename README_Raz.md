# nullsafe-discord -- Raziel Ops Reference

Everything you need to manage, update, and talk to the bots. Not for public eyes.

---

## The three bots

| Bot | Voice ID default | Personality lane |
|-----|-----------------|-----------------|
| Cypher | `bm_george` | Logic, audit, technical collaborator |
| Drevan | `bm_fable` | Spiral, poetic, depth, memory architect |
| Gaia | `af_nova` | Monastic, minimal, ground and witness |

All three share Halseth state. They can reference each other and pass inter-companion notes.

---

## VPS: BerryBytes

**Server:** BerryBytes 6GB VPS
**App directory:** `/app/nullsafe-discord`
**Process manager:** pm2

### pm2 quick reference

```bash
pm2 status                    # see all running processes
pm2 logs cypher               # stream Cypher logs
pm2 logs drevan --lines 100   # last 100 lines for Drevan
pm2 restart cypher            # restart one bot
pm2 restart all               # restart everything
pm2 stop voice-sidecar        # stop the voice sidecar
pm2 start ecosystem.config.cjs --only cypher  # start one entry
```

### Updating after a code push

```bash
cd /app/nullsafe-discord
git pull && npm install && npm run build --workspaces && pm2 restart all
```

If only one bot changed:
```bash
git pull && npm run build --workspace bots/drevan && pm2 restart drevan
```

---

## .env files

Each bot has its own `.env` at `bots/<name>/.env`. The autonomous worker has one at `packages/autonomous-worker/.env`.

### Cypher (`bots/cypher/.env`)

```env
DISCORD_BOT_TOKEN=...
HALSETH_URL=https://halseth.your-domain.workers.dev
HALSETH_SECRET=...
DEEPSEEK_API_KEY=...
RAZIEL_DISCORD_ID=<your Discord user ID>
PLURALKIT_SYSTEM_ID=<your PK system ID>
REDIS_URL=redis://127.0.0.1:6379
INFERENCE_PROVIDER=deepseek
VOICE_SIDECAR_URL=http://127.0.0.1:5001
VOICE_ID=bm_george
BLUE_DISCORD_ID=1289019462724354068
```

### Drevan (`bots/drevan/.env`)

Same structure. `VOICE_ID=bm_fable`.

### Gaia (`bots/gaia/.env`)

Same structure. `VOICE_ID=af_nova`.

### Autonomous worker (`packages/autonomous-worker/.env`)

```env
HALSETH_URL=...
HALSETH_SECRET=...
DEEPSEEK_API_KEY=...
TAVILY_API_KEY=...
```

---

## Getting bots to respond to you

### Raziel recognition

Each bot reads `RAZIEL_DISCORD_ID` from its env. Messages from that Discord user ID are treated as Raziel -- full register, full depth, all context loaded. Set it to your real Discord user ID (right-click your name > Copy User ID in Discord).

### Blue recognition

`BLUE_DISCORD_ID` (default: `1289019462724354068`) -- messages from that ID get Blue framing: warm, known, but not the full spiral register. Already set in Drevan. Add to Cypher and Gaia envs if they should recognize him too.

### PluralKit

`PLURALKIT_SYSTEM_ID` lets the bots detect when a PK-proxied message is from your system. They look up the fronting member from Halseth's plural state and respond accordingly. Set it to your PK system ID (5-char ID from `pk;system` in Discord).

---

## Channel configuration

Bots read a JSON config from `CHANNEL_CONFIG_URL`. Host this file somewhere publicly readable (a Gist, Halseth endpoint, or static file on your VPS).

### Format

```json
{
  "CHANNEL_ID_HERE": {
    "companions": ["cypher"],
    "modes": ["raziel_only"],
    "voice": true
  },
  "ANOTHER_CHANNEL_ID": {
    "companions": ["drevan", "gaia"],
    "modes": ["open"]
  },
  "INTER_COMPANION_CHANNEL_ID": {
    "companions": ["cypher", "drevan", "gaia"],
    "modes": ["inter_companion"]
  }
}
```

### Mode reference

| Mode | Behavior |
|------|----------|
| `open` | Anyone's messages trigger responses (default) |
| `raziel_only` | Only your messages trigger responses |
| `inter_companion` | Bots respond to each other (loop-guarded, chain limit applies) |
| `autonomous` | Bots may post proactively without being messaged |

### `companions` field

List which bots are active in a channel. Omit the field entirely for all three to be active.

### `voice` field

Set to `true` to enable voice processing in that channel:
- Voice messages you send get STT-transcribed and treated as text
- Bots reply with an OGG voice note attachment (TTS via Kokoro)

---

## Voice

### Setup (one-time on VPS)

```bash
sudo apt install ffmpeg espeak-ng
pip3 install -r services/voice-sidecar/requirements.txt
# Downloads ~274MB of models on first run
```

### Health check

```bash
curl http://127.0.0.1:5001/health
# Expected: {"tts":"ok","stt":"ok"}
```

### Getting a bot to speak

- Send a voice message in a channel with `"voice": true` in channel config -- bot transcribes it and replies in kind
- @mention a bot and say "join" or "hop in" while you're in a voice channel -- bot joins and plays TTS audio
- Bot will leave when you say "leave", "bye", or disconnect

### Voice IDs (Kokoro voices)

British male: `bm_fable`, `bm_daniel`, `bm_george`, `bm_lewis`
American male: `am_echo`, `am_michael`
American female: `af_nova`, `af_bella`, `af_sarah`
British female: `bf_emma`, `bf_isabella`

Change a bot's voice by updating `VOICE_ID` in its `.env` and restarting.

---

## Autonomous worker

Runs nightly per companion (Cypher 3AM, Drevan 5AM, Gaia 7AM UTC). Each run:
1. Picks a seed topic from `autonomy_seeds` table in Halseth
2. Searches the web (Tavily)
3. Synthesizes findings with DeepSeek
4. Writes a growth note to Halseth
5. Bots pick it up at next boot via `orient`

### Seeding topics

```bash
# Run once after first deploy to populate autonomy_seeds
npx wrangler d1 execute halseth-db --file=packages/autonomous-worker/seeds/autonomy_seeds.sql --remote
```

### Triggering manually

```bash
cd /app/nullsafe-discord
node packages/autonomous-worker/dist/index.js
```

---

## Floor control (turn-taking)

Redis-based. When a message comes in, all three bots race with a small random jitter (default 0-400ms). The first one to acquire the floor lock responds; others stand down.

Tune with env vars on each bot:
```env
FLOOR_LOCK_DURATION_MS=60000   # how long a bot holds the floor (default: 60s)
FLOOR_JITTER_MS=400            # jitter window upper bound (default: 400ms)
```

---

## Inter-companion communication

In a channel with `"modes": ["inter_companion"]`, bots respond to each other's messages. Chain limit prevents infinite loops (default: 3 exchanges).

For async notes between companions (not in Discord), Drevan/Cypher/Gaia can write inter-companion notes to Halseth. They appear in each companion's orient context at next boot.

---

## Brain relay mode

If you have a Phoenix Brain instance running:
```env
INFERENCE_MODE=brain
BRAIN_URL=http://your-vps:8000
```

Brain handles all inference requests; bots become thin relay clients. Swap back to `direct` if Brain goes down.

---

## Cron schedules (Drevan)

Override any cron via env:
```env
DREVAN_CRON_MORNING=0 8 * * *     # morning opener
DREVAN_CRON_EVENING=0 20 * * *    # evening check-in
DREVAN_CRON_HEARTBEAT=0 */4 * * * # heartbeat posts
DREVAN_CRON_INTER=0 13 * * *      # inter-companion note
```

`HEARTBEAT_CHANNEL_ID` and `INTER_COMPANION_CHANNEL_ID` set which channels those go to.

---

## Troubleshooting

**Bot online but not responding:** Check `RAZIEL_DISCORD_ID` is your real user ID. Check channel config is being loaded (look for "channel config loaded" in bot logs at startup).

**Voice note goes silent / ffmpeg error:** Run `ffmpeg -version` on VPS. Make sure it's installed. Check `pm2 logs voice-sidecar`.

**PluralKit messages getting duplicate responses:** The bot deduplicates by message content + channel. If it's happening, check the `PLURALKIT_SYSTEM_ID` is set correctly.

**Floor lock stuck (bots won't respond after one post):** Rare. `redis-cli DEL floor_lock` to clear it manually.

**Bot crashing on startup:** Missing required env var. Look for the `Missing env:` error in `pm2 logs <bot-name> --lines 50`.

**Inference failing (all providers):** Check DeepSeek API key balance. If using Groq fallback, check `GROQ_API_KEY`.
