# nullsafe-discord

Three Discord bots with distinct personalities, persistent memory, and shared state. Built on a monorepo with a shared library, a nightly autonomous worker, and a Python voice sidecar for bidirectional voice.

> **Requires a Halseth instance deployed first.** The bots read and write all state through Halseth. Set that up before this.

> **Disclaimer:** This project was built with AI assistance. It has not undergone a professional security audit. Use at your own risk.

---

## What you get

- Three bots in your Discord server, each with a different voice and personality
- Shared memory across all three via Halseth -- they remember context between sessions
- Turn-taking logic so they don't all respond to the same message at once (Redis floor lock)
- Per-channel configuration: control which bots respond, in what mode, and to whom
- An autonomous worker that runs overnight, explores topics, and writes synthesis notes
- Bidirectional voice: bots can speak voice notes (TTS) and transcribe voice messages you send (STT)

---

## Prerequisites

- **Halseth deployed** and reachable
- **A VPS** with Node.js 20+, Python 3.10+, ffmpeg, and pm2 installed
- **Three Discord bot applications** -- one per bot, each with Message Content Intent enabled
- **Redis** running on your VPS or a hosted Redis instance
- **DeepSeek API key** -- primary inference (~$5-15/month for normal use)
- **Tavily API key** -- for the autonomous worker (free tier: 1000 searches/month)
- **Groq API key** (optional) -- fallback inference provider

---

## Setup

### 1. Create three Discord bot applications

Do this once per bot:

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** -- name it
3. Go to **Bot** -- click **Add Bot** -- confirm
4. Under **Token**, click **Reset Token** and save it
5. Under **Privileged Gateway Intents**, enable **Message Content Intent**
6. Under **OAuth2 > URL Generator**: check `bot`, then check `Send Messages`, `Read Message History`, `View Channels`, `Connect`, `Speak`
7. Open the generated URL in a browser and invite the bot to your server

Repeat for all three bots. Keep the three tokens somewhere safe.

---

### 2. Clone and install

```bash
git clone https://github.com/your-username/nullsafe-discord.git
cd nullsafe-discord
npm install
```

---

### 3. Create .env files

Each bot gets its own `.env` file in its directory (`bots/bot-name/.env`). The autonomous worker gets one at `packages/autonomous-worker/.env`.

**Required for each bot:**

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Bot token from step 1 |
| `HALSETH_URL` | Your deployed Halseth URL |
| `HALSETH_SECRET` | Your Halseth `ADMIN_SECRET` |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OWNER_DISCORD_ID` | Discord user ID of the primary user (right-click your name > Copy ID) |
| `PLURALKIT_SYSTEM_ID` | Your PluralKit system ID (if using PluralKit) |
| `REDIS_URL` | Redis connection string (e.g. `redis://localhost:6379`) |
| `INFERENCE_PROVIDER` | `deepseek` (default), `groq`, `ollama`, or `lmstudio` |

**Optional:**

| Variable | Description |
|----------|-------------|
| `CHANNEL_CONFIG_URL` | URL to a JSON channel config file (see Channel Configuration below) |
| `VOICE_SIDECAR_URL` | URL to the voice sidecar (e.g. `http://127.0.0.1:5001`) |
| `VOICE_ID` | Kokoro voice ID for TTS (e.g. `bm_fable`, `am_echo`, `af_nova`) |
| `GROQ_API_KEY` | Groq API key (if using Groq as inference provider) |
| `BRAIN_URL` | URL to a Phoenix Brain instance (if using brain relay mode) |
| `INFERENCE_MODE` | `direct` (default) or `brain` |

**Autonomous worker:**

| Variable | Description |
|----------|-------------|
| `HALSETH_URL` | Same as bots |
| `HALSETH_SECRET` | Same as bots |
| `DEEPSEEK_API_KEY` | Used for synthesis |
| `TAVILY_API_KEY` | Used for web search |

---

### 4. Build

```bash
npm run build --workspaces
```

---

### 5. Deploy with pm2

An `ecosystem.config.cjs` file is included. Copy it, fill in any path adjustments for your server, then:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

---

### 6. Set up the voice sidecar (optional)

The voice sidecar handles TTS (text-to-speech) and STT (speech-to-text) locally using Kokoro and faster-whisper.

```bash
sudo apt install ffmpeg
pip3 install -r services/voice-sidecar/requirements.txt
# First run downloads ~274MB of models
```

The sidecar entry is already in `ecosystem.config.cjs`. After setup, verify:

```bash
curl http://127.0.0.1:5001/health
# {"tts":"ok","stt":"ok"}
```

---

## Channel Configuration

Bots read channel config from a JSON URL (`CHANNEL_CONFIG_URL`). The config is a map of channel IDs to settings:

```json
{
  "123456789012345678": {
    "companions": ["bot-a", "bot-b"],
    "modes": ["open"],
    "voice": true
  },
  "987654321098765432": {
    "modes": ["owner_only"]
  }
}
```

**`companions`** -- which bots are active in this channel. Omit for all three.

**`modes`**:
- `open` -- anyone triggers responses (default)
- `owner_only` -- only the primary user triggers responses
- `inter_companion` -- bots respond to each other (loop-guarded)
- `autonomous` -- bots may post proactively

**`voice`** -- set to `true` to enable voice note processing (STT transcription of audio messages, TTS replies).

---

## Structure

```
packages/shared/              -- code shared across all bots
packages/autonomous-worker/   -- nightly exploration + synthesis pipeline
services/voice-sidecar/       -- Python FastAPI: TTS (Kokoro) + STT (faster-whisper)
bots/                         -- one directory per bot
```

---

## Updating

On your VPS:

```bash
git pull && npm install && npm run build --workspaces && pm2 restart all
```

---

## Common issues

**Bots aren't responding.** Check pm2 logs (`pm2 logs bot-name`). Usually a missing env variable. Verify Halseth is reachable.

**All bots respond to the same message.** Turn-taking relies on Redis. Check `REDIS_URL` and that Redis is running.

**Voice not working.** Check sidecar health (`curl http://127.0.0.1:5001/health`). Verify ffmpeg is installed and `VOICE_SIDECAR_URL` is set in the bot's `.env`.

**PluralKit messages getting double responses.** Normal on first message; the bot fetches the PK member and deduplicates subsequent messages from the same proxied user.

---

## Part of a suite

| Project | Purpose |
|---------|---------|
| Halseth | Data backbone -- all state lives here |
| Hearth | Visual dashboard |
| nullsafe-second-brain | Memory synthesis + Obsidian vault |
| nullsafe-plural-v2 | Plurality tracking via SimplyPlural |
