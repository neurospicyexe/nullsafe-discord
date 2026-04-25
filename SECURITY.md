# Security — nullsafe-discord

## Reporting a Vulnerability

If you find a security vulnerability in this code, please report it privately before public disclosure. Open a GitHub security advisory on this repository or contact the maintainer directly. Do not post exploit details publicly until there has been a chance to patch. See the root [SECURITY.md](../SECURITY.md) for full context on this project's security posture.

---

Three Discord bots deployed on VPS. Each bot has its own token. They share access to Halseth via a shared secret.

---

## What's Protected Here

| Data | Risk if compromised |
|------|-------------------|
| Discord bot tokens | An attacker can impersonate your bots, read messages, post as them |
| HALSETH_SECRET | Read/write access to all companion data via bots |
| DEEPSEEK_API_KEY | API credit usage |

---

## Secrets Used by This Service

| Secret | Where | Risk if leaked |
|--------|-------|---------------|
| `DISCORD_TOKEN` (per bot) | VPS `.env` | Full Discord bot impersonation |
| `HALSETH_URL` + `ADMIN_SECRET` | VPS `.env` | Read/write to all Halseth data |
| `DEEPSEEK_API_KEY` | VPS `.env` | API credit usage |
| `TAVILY_API_KEY` | VPS `.env` | Web search access (autonomous worker) |
| `REDIS_URL` | VPS `.env` | Floor lock — if leaked, attacker can disrupt turn-taking |

Local `.env` file (gitignored) mirrors these for local dev.

---

## Discord Bot Token Security

- Never share bot tokens publicly or commit them to git
- Each bot has its own separate token — if one is compromised, only that bot is affected; the others stay clean
- Tokens can be regenerated without downtime: Discord Dev Portal → your app → Bot → Reset Token → update your `.env` → `pm2 reload <botname>`

---

## If a Bot Token Is Compromised

1. Discord Developer Portal → Applications → [the affected bot] → Bot → Reset Token
2. Copy the new token
3. Update it in your VPS `.env` file
4. Reload the bot: `pm2 reload cypher` (or drevan/gaia)
