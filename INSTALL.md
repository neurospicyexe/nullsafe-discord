# Installing nullsafe-discord

> **Tech-savvy?** The quick version is in [README.md](./README.md). This guide is for everyone else.

## What is this, in plain English?

This is a set of three Discord bots — one for each companion (Cypher, Drevan, Gaia). They show up in your Discord server as separate accounts, each speaking in their own voice. They share memory through Halseth and can talk to each other.

**You need Halseth running before the bots will work.**

---

## Local computer vs. VPS — which should I use?

**Local computer (simpler to start):**
The bots run on your machine. They're online when your computer is on, offline when it's off. Good for getting started and testing.

**VPS — a virtual private server (recommended for real use):**
A VPS is a computer in a data center that runs 24/7. You rent one for ~$5-10/month (DigitalOcean, Hetzner, Vultr, etc.). The bots stay online all the time and can respond even when your computer is off.

---

## What you need (both options)

- **Halseth deployed** and running
- **Node.js 20+** — [nodejs.org](https://nodejs.org) (LTS)
- **Git** — [git-scm.com](https://git-scm.com)
- **Three Discord bot applications** — one per companion (see Step 1)
- **A Redis instance** — either [Upstash](https://upstash.com) (free hosted Redis) or Redis on your VPS
- **A DeepSeek API key** — for bot responses. [platform.deepseek.com](https://platform.deepseek.com) — very affordable (~$5-15/month for normal use)
- **A Tavily API key** — for the autonomous research worker (free tier: 1000 searches/month). [tavily.com](https://tavily.com)

---

## Step 1 — Create your Discord bot applications

You need to do this three times — once for each companion.

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g. "Cypher Bot")
3. Go to **Bot** → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - **Server Members Intent**
   - **Message Content Intent**
5. Click **Reset Token** → copy the token and save it somewhere safe
6. Repeat for Drevan and Gaia

To add each bot to your server:
- Go to **OAuth2 → URL Generator**
- Select **bot** scope, then **Send Messages**, **Read Message History**, **Add Reactions**
- Open the generated URL and add the bot to your server

---

## Step 2 — Get the code

```bash
git clone https://github.com/neurospicyexe/nullsafe-discord.git
cd nullsafe-discord
npm install
```

---

## Step 3 — Create your environment file

```bash
cp .env.example .env
```

Open `.env` in a text editor and fill in:

```
# One entry per companion
CYPHER_DISCORD_TOKEN=your-cypher-bot-token
DREVAN_DISCORD_TOKEN=your-drevan-bot-token
GAIA_DISCORD_TOKEN=your-gaia-bot-token

# Halseth connection
HALSETH_URL=https://halseth.neurospicyexe.workers.dev
ADMIN_SECRET=your-halseth-admin-secret

# Redis (use your Upstash URL or local Redis)
REDIS_URL=redis://localhost:6379

# AI inference
DEEPSEEK_API_KEY=your-deepseek-key
TAVILY_API_KEY=your-tavily-key

# Identity files (full paths to companion identity .md files)
CYPHER_IDENTITY_PATH=/path/to/CYPHER_IDENTITY_v2.md
DREVAN_IDENTITY_PATH=/path/to/DREVAN_IDENTITY_v2.md
GAIA_IDENTITY_PATH=/path/to/GAIA_IDENTITY_v2.md
```

---

## Step 4 — Build

```bash
npm run build
```

---

## Option A: Run locally

```bash
# Start all three bots
pm2 start ecosystem.config.cjs
```

If you don't have pm2 yet: `npm install -g pm2`

To check if they're running: `pm2 list`
To see logs: `pm2 logs cypher`

---

## Option B: Run on a VPS (always-on)

### Set up your VPS

SSH into your VPS, then:

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Install pm2
npm install -g pm2

# Install Redis (if not using hosted Redis)
sudo apt-get install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

### Deploy

```bash
git clone https://github.com/neurospicyexe/nullsafe-discord.git
cd nullsafe-discord
npm install
# Create and fill in .env as above
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # follow the printed instruction to survive reboots
```

### Check it's working

```bash
pm2 list          # should show cypher, drevan, gaia as "online"
pm2 logs cypher   # should show the bot connecting to Discord
```

---

## Updating

```bash
git pull
npm install   # if dependencies changed
npm run build
pm2 reload ecosystem.config.cjs
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `ECONNREFUSED` on Redis | Redis isn't running. Start it: `sudo systemctl start redis-server`, or use Upstash |
| Bot shows offline in Discord | Check the token in `.env` — it might have reset (tokens invalidate if you click "Reset Token" again) |
| `Cannot find identity file` | Check `CYPHER_IDENTITY_PATH` etc. — must be absolute paths to the right files |
| Bots responding to wrong messages | Check channel configuration in `ecosystem.config.cjs` |
| `pm2: command not found` | Run `npm install -g pm2` |
