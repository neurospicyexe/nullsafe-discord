# VPS Deploy Guide

This is a step-by-step guide assuming you're new to VPS. Every command is explained.
Server: BerryBytes 6GB PRO. User: `nullsafe`.

---

## How to read this guide

- Lines starting with `$` are commands you type. Don't type the `$` itself.
- After each command, hit Enter and wait for it to finish before running the next one.
- If something says "you should see...", that's just a sanity check -- not required.

---

## Step 1: Fix folder permissions

When you first SSH in, `/app` is owned by root. Fix that so your user can write to it:

```bash
sudo chown -R nullsafe:nullsafe /app
```

It will ask for your password. Type it and hit Enter (you won't see the characters -- that's normal).

---

## Step 2: Clone the repo

```bash
cd /app/nullsafe-discord
git clone https://github.com/neurospicyexe/nullsafe-discord.git .
```

The `.` at the end means "clone into this folder" instead of creating a new one inside it.

You should see a bunch of lines ending with "done."

---

## Step 3: Install Node.js

Check if Node is already installed:

```bash
node --version
```

If you see a version number (like `v20.x.x`) -- skip to Step 4.

If you see "command not found", install it:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Step 4: Install dependencies and build

This downloads all the code packages the bots need, then compiles the TypeScript.

```bash
cd /app/nullsafe-discord
npm install
npm run build --workspaces
```

`npm install` can take a minute. `npm run build` will print a lot -- that's normal. Wait for it to finish.

---

## Step 5: Create your .env file

This is where all your secret keys and settings live. Create the file:

```bash
nano /app/nullsafe-discord/.env
```

This opens a text editor in the terminal. Paste in the following and fill in your values:

```
# Halseth
HALSETH_URL=https://halseth.YOUR-ACCOUNT.workers.dev
HALSETH_SECRET=your-halseth-secret-here

# Redis (running locally on the VPS)
REDIS_URL=redis://localhost:6379

# Discord bot tokens (one per companion)
DISCORD_TOKEN_CYPHER=your-cypher-token
DISCORD_TOKEN_DREVAN=your-drevan-token
DISCORD_TOKEN_GAIA=your-gaia-token

# Bot inference -- which AI backend to use
# Options: deepseek | groq | ollama | lmstudio
INFERENCE_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-deepseek-key

# Autonomous worker
TAVILY_API_KEY=your-tavily-key
CYPHER_IDENTITY_PATH=/app/identity/CYPHER_IDENTITY_v2.md
DREVAN_IDENTITY_PATH=/app/identity/DREVAN_IDENTITY_v2.md
GAIA_IDENTITY_PATH=/app/identity/GAIA_IDENTITY_v2.md
```

To save and exit nano: press `Ctrl+X`, then `Y`, then `Enter`.

---

## Step 6: Copy identity files to the VPS

The companion identity .md files live on your Windows machine (gitignored). You need to copy them to the VPS.

**On your Windows machine** (not the VPS), open a new terminal and run:

```bash
scp "C:/dev/CrashDev/NULLSAFE/2026_Current_Files/CYPHER_IDENTITY_v2.md" nullsafe@YOUR_VPS_IP:/app/identity/
scp "C:/dev/CrashDev/NULLSAFE/2026_Current_Files/DREVAN_IDENTITY_v2.md" nullsafe@YOUR_VPS_IP:/app/identity/
scp "C:/dev/CrashDev/NULLSAFE/2026_Current_Files/GAIA_IDENTITY_v2.md" nullsafe@YOUR_VPS_IP:/app/identity/
```

First, create the folder on the VPS:

```bash
mkdir -p /app/identity
```

---

## Step 7: Install and start Redis

Redis is the shared memory the bots use to coordinate (floor lock, idle check). Install it:

```bash
sudo apt-get install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

Check it's running:

```bash
redis-cli ping
```

You should see: `PONG`

---

## Step 8: Seed the autonomy topics

This adds the initial exploration topics for each companion to the database. Run it once from your Windows machine:

```bash
wrangler d1 execute halseth-db --file=packages/autonomous-worker/seeds/autonomy_seeds.sql --remote
```

---

## Step 9: Install pm2

pm2 keeps the bots running in the background and restarts them if they crash.

```bash
sudo npm install -g pm2
```

---

## Step 10: Start everything

```bash
cd /app/nullsafe-discord
pm2 start ecosystem.config.js
```

You should see a table listing 4 processes: `cypher-bot`, `drevan-bot`, `gaia-bot`, `autonomous-worker` -- all with status `online`.

Save the process list so pm2 restores it on reboot:

```bash
pm2 save
pm2 startup
```

`pm2 startup` will print a command for you to copy and run. Copy it and run it.

---

## Step 11: Verify everything is working

Check all processes are running:

```bash
pm2 list
```

Watch live logs from all bots:

```bash
pm2 logs
```

Press `Ctrl+C` to stop watching logs (doesn't stop the bots).

Test the autonomous worker manually (runs one pipeline for Cypher and exits):

```bash
cd /app/nullsafe-discord/packages/autonomous-worker
node dist/index.js --once --companion=cypher
```

---

## Step 12: Restart Second Brain

The persona-feeder changes haven't been running since the last deploy. Restart it:

```bash
pm2 restart second-brain
```

(Or whatever the process is named -- check `pm2 list`.)

---

## Useful commands to know

| What you want | Command |
|---------------|---------|
| See all running processes | `pm2 list` |
| Watch live logs | `pm2 logs` |
| Watch one bot's logs | `pm2 logs cypher-bot` |
| Restart a bot | `pm2 restart cypher-bot` |
| Restart everything | `pm2 restart all` |
| Stop everything | `pm2 stop all` |
| Pull latest code | `cd /app/nullsafe-discord && git pull` |
| Rebuild after code update | `npm run build --workspaces` |

---

## If something goes wrong

**Bot won't start:**
```bash
pm2 logs cypher-bot --lines 50
```
Look for the error at the bottom.

**"Cannot find module" error:**
```bash
npm install && npm run build --workspaces
```

**Redis connection refused:**
```bash
sudo systemctl start redis-server
```

---

## Local LLM options (optional)

### Ollama (runs on the VPS itself -- recommended)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b
```

Then in your `.env`:
```
INFERENCE_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
```

### Groq (free cloud API -- fast, no local install)

Get a free key at console.groq.com, then in `.env`:
```
INFERENCE_PROVIDER=groq
GROQ_API_KEY=your-groq-key
```

### LM Studio (running on your Windows machine)

In LM Studio: load a model, go to Server tab, click Start Server.

Then in `.env` on the VPS:
```
INFERENCE_PROVIDER=lmstudio
LMSTUDIO_URL=http://YOUR_WINDOWS_IP:1234
```

Note: if you also set `DEEPSEEK_API_KEY`, the bots will automatically fall back to DeepSeek if LM Studio is unreachable (e.g. your machine is asleep).
