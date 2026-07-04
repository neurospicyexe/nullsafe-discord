# nullsafe-discord

Three Discord bots with distinct personalities, persistent memory, and shared state. Built on a monorepo with a shared library, a nightly autonomous worker, and bidirectional voice via the Mistral API (Voxtral).

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

**Not sure where to start?** See [INSTALL.md](./INSTALL.md) for a beginner-friendly guide covering both local and VPS deployment.

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
git clone https://github.com/neurospicyexe/nullsafe-discord.git
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
| `MISTRAL_API_KEY` | Mistral API key for voice (Voxtral TTS + STT) |
| `CYPHER_VOICE_ID` / `DREVAN_VOICE_ID` / `GAIA_VOICE_ID` | Per-bot Voxtral voice ID for TTS |
| `GROQ_API_KEY` | Groq API key (if using Groq as inference provider) |
| `BRAIN_URL` | URL to a Phoenix Brain instance (if using brain relay mode) |
| `INFERENCE_MODE` | `direct` (default), `brain`, or `hermes` (see Inference modes below) |
| `HERMES_API_URL` | URL of your Hermes gateway (only if `INFERENCE_MODE=hermes`) |
| `HERMES_API_KEY` | Auth key for your Hermes gateway (only if `INFERENCE_MODE=hermes`) |

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

### 6. Set up voice (optional)

Voice (TTS + STT) runs through the Mistral API (Voxtral) -- no local services or models needed. Set `MISTRAL_API_KEY` and the per-bot voice IDs in `.env`, and install ffmpeg for audio handling:

```bash
sudo apt install ffmpeg
```

---

## Inference modes (how the bots think)

Set `INFERENCE_MODE` in each bot's `.env`. There are three options:

| Mode | What it does | When to use it |
|------|--------------|----------------|
| `direct` (default) | Each bot calls an LLM provider directly (DeepSeek, OpenAI, Anthropic, Mistral, Groq, Kimi, Ollama, LM Studio). Pick the provider with `INFERENCE_PROVIDER` and an API key. | Simplest. Good for most people. |
| `brain` | Bots relay to a shared "Brain" service that runs a multi-companion swarm, then fall back to direct if it's down. | If you run the optional Phoenix Brain. |
| `hermes` | Bots relay each reply to a self-hosted **Hermes** gateway (an OpenAI-compatible LLM gateway you run yourself). Set `HERMES_API_URL` and `HERMES_API_KEY`. | If you want one gateway in front of many providers. |

### Optional: switch models from Discord (no SSH)

Companions can be told which model to use with an **owner-only** chat command:

```
cy: model <key>        # also drevan: / drev: / gaia:
cy: model deepseek-reasoner
```

This writes your chosen model key into Halseth (`companion_settings.active_model`). How it takes effect depends on your mode:

- **`direct` / `brain` mode:** the model registry lives in `packages/shared/src/models.ts` (a map of friendly keys -> provider + model id). The bot validates `<key>` against that map and uses it. Edit that file to change which models are offered.
- **`hermes` mode:** Hermes pins a model per gateway, so a tiny **model-watcher** on your gateway host polls Halseth for the chosen key, looks it up in a JSON map (key -> Hermes model id + provider), runs `hermes config set model.default <id>`, and restarts the gateway (~10s). A ready-to-use watcher + example model map live in [nullsafe-hermes-lever](https://github.com/neurospicyexe/nullsafe-hermes-lever); copy them to your gateway host and adjust the paths/keys to your setup. Keep your provider API keys only in the gateway's own env file.

Keep the model keys in `models.ts` and your Hermes map in sync so the same `cy: model <key>` works everywhere. All model ids are just strings you control -- update them to whatever each provider currently ships.

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

**Voice not working.** Verify `MISTRAL_API_KEY` and the bot's voice ID are set in `.env` (and present in the pm2 ecosystem env block -- pm2 needs delete+start to pick up new env vars, not reload). Verify ffmpeg is installed.

**PluralKit messages getting double responses.** Normal on first message; the bot fetches the PK member and deduplicates subsequent messages from the same proxied user.

---

## Part of a suite

| Project | Purpose |
|---------|---------|
| Halseth | Data backbone -- all state lives here |
| Hearth | Visual dashboard |
| nullsafe-second-brain | Memory synthesis + Obsidian vault |
| nullsafe-plural-v2 | Plurality tracking via SimplyPlural |

---

## Acknowledgments

Borrowed sparks, and one real dependency:

- **[amarisaster/Discord-Resonance](https://github.com/amarisaster/Discord-Resonance)** — the key
  trick for companion voices: distinct per-companion Discord presences, sharing state, able to talk
  to each other instead of only through their human.
- **[karpathy/llm-council](https://github.com/karpathy/llm-council)** — the `council` command's
  deliberate-then-answer shape.
- **[codependentai/hear-music](https://github.com/codependentai/hear-music)** — more than
  inspiration: the `listen` pipeline **runs hear-music itself** for audio analysis (key, BPM, mood),
  installed on the host under its source-available personal-use license. Our code wraps it; the
  analysis engine is theirs. [amarisaster/Synesthesia](https://github.com/amarisaster/Synesthesia)
  informed the shared-listening design.

Fuller credits: [nullsafe-suite acknowledgments](https://github.com/neurospicyexe/nullsafe-suite#acknowledgments). Thank you.
