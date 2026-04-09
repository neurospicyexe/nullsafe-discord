# VPS Deploy Checklist

BerryBytes 6GB PRO. Run in order.

## 1. Build

```bash
cd /app/nullsafe-discord
npm install
npm run build --workspaces
```

## 2. Environment variables

Set these in `/app/nullsafe-discord/.env` (loaded by each process via dotenv or pm2 env):

### Shared (all bots + worker)
| Var | Value |
|-----|-------|
| `HALSETH_URL` | https://halseth.your-domain.com |
| `ADMIN_SECRET` | (from Halseth secret) |
| `REDIS_URL` | redis://localhost:6379 |

### Per-bot Discord tokens
| Var | Value |
|-----|-------|
| `CYPHER_DISCORD_TOKEN` | (Cypher bot token) |
| `DREVAN_DISCORD_TOKEN` | (Drevan bot token) |
| `GAIA_DISCORD_TOKEN` | (Gaia bot token) |

### Bot inference (pick one provider -- see Section 2b below)
| Var | Value |
|-----|-------|
| `INFERENCE_PROVIDER` | `deepseek` \| `groq` \| `ollama` \| `lmstudio` (default: `deepseek`) |
| `DEEPSEEK_API_KEY` | Required if provider is `deepseek` |
| `GROQ_API_KEY` | Required if provider is `groq` |
| `OLLAMA_URL` | Required if provider is `ollama` (e.g. `http://localhost:11434`) |
| `LMSTUDIO_URL` | Required if provider is `lmstudio` (e.g. `http://localhost:1234`) |

### Autonomous worker only
| Var | Value |
|-----|-------|
| `DEEPSEEK_API_KEY` | (DeepSeek V3 API key) |
| `TAVILY_API_KEY` | (Tavily free tier key) |
| `CYPHER_IDENTITY_PATH` | /app/identity/CYPHER_IDENTITY_v2.md |
| `DREVAN_IDENTITY_PATH` | /app/identity/DREVAN_IDENTITY_v2.md |
| `GAIA_IDENTITY_PATH` | /app/identity/GAIA_IDENTITY_v2.md |

## 2b. Local LLM inference options

The bots support four inference backends. Set `INFERENCE_PROVIDER` to switch.

---

### Option A: Ollama (recommended for VPS)

Ollama runs directly on the VPS as a background service. Lowest latency, no egress cost.

**Install:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Pull a model** (pick one -- smaller = faster, larger = better quality):
```bash
ollama pull llama3.2          # 3B -- fast, lightweight
ollama pull llama3.1:8b       # 8B -- good balance for the triad's voice work
ollama pull mistral            # 7B -- alternative, strong instruction following
```

**Confirm it's running:**
```bash
ollama list
curl http://localhost:11434/api/tags
```

**Set env vars:**
```
INFERENCE_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
```

Ollama starts automatically after install. If it doesn't:
```bash
systemctl enable ollama
systemctl start ollama
```

---

### Option B: LM Studio (local machine, exposed to VPS)

If you're running LM Studio on your local Windows machine and want the bots on VPS to hit it, expose the LM Studio server and point the bots at your machine's IP.

**In LM Studio:** Load a model → Server tab → Start server (default port 1234)

**Expose to VPS** (if your machine has a static IP or you use a tunnel like ngrok/Cloudflare Tunnel):
```
INFERENCE_PROVIDER=lmstudio
LMSTUDIO_URL=http://YOUR_LOCAL_IP:1234
```

Note: `lmstudio` adapter **auto-chains DeepSeek as fallback** if `DEEPSEEK_API_KEY` is also set. So if LM Studio goes down (machine sleeps, etc.) the bots silently fall back to DeepSeek. Useful for hybrid setups.

---

### Option C: Groq (free cloud, fast)

Groq free tier is fast and free -- good middle ground between local and DeepSeek. Uses `llama-3.3-70b-versatile`.

```
INFERENCE_PROVIDER=groq
GROQ_API_KEY=your-groq-key
```

Get a key at console.groq.com (free tier available).

---

### Fallback behavior

| Provider | What happens if it fails |
|----------|-------------------------|
| `deepseek` | Returns null, bot stays silent for that message |
| `groq` | Returns null, bot stays silent |
| `ollama` | Returns null, bot stays silent |
| `lmstudio` | Auto-retries DeepSeek if `DEEPSEEK_API_KEY` is set; otherwise silent |

To add explicit fallback to any provider, switch to `lmstudio` + set `DEEPSEEK_API_KEY` -- the adapter chains them automatically.

---

## 3. Identity files on VPS

Copy identity .md files to `/app/identity/` (gitignored -- copy manually):
```bash
scp CYPHER_IDENTITY_v2.md user@vps:/app/identity/
scp DREVAN_IDENTITY_v2.md user@vps:/app/identity/
scp GAIA_IDENTITY_v2.md user@vps:/app/identity/
```

## 4. Seed autonomy_seeds

Apply to Halseth D1 (run once):
```bash
wrangler d1 execute halseth-db \
  --file=packages/autonomous-worker/seeds/autonomy_seeds.sql \
  --remote
```

## 5. Start with pm2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # generate systemd service for auto-restart on reboot
```

## 6. Verify

```bash
# Confirm all 4 processes running
pm2 list

# Test autonomous worker one-shot (Cypher only)
cd packages/autonomous-worker
node dist/index.js --once --companion=cypher

# Check Halseth for result
# GET /mind/autonomy/cypher/runs -- should show one completed run
# GET /mind/growth/cypher/journal -- should show one entry

# Tail worker logs
pm2 logs autonomous-worker
```

## 7. Second Brain restart

The persona-feeder changes haven't been running since last deploy. After VPS cutover:
```bash
pm2 restart second-brain  # or whatever the process name is
```
Confirm drift evaluator + persona-feeder crons are firing.
