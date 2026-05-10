# Model Switching Design
**Date:** 2026-05-10
**Status:** Approved, pending implementation

---

## Overview

Per-companion, persistent model switching triggered by owner Discord commands or companion self-request. Active model survives bot restarts, is visible in orient, and each switch produces an in-character Discord confirmation. Models can be disabled without code changes via `DISABLED_MODELS` env var.

---

## Data Model

### New Halseth table: `companion_settings`

```sql
CREATE TABLE companion_settings (
  companion_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (companion_id, key)
);
```

Initially used for one key per companion: `active_model`. Generic key-value store -- future per-companion settings land here without additional migrations.

### New Halseth endpoints

- `GET /companion/settings/:companion_id` -- returns `{ key: value, ... }` for all settings
- `POST /companion/settings/:companion_id` -- upserts `{ key, value }`

Both are auth-gated (ADMIN_SECRET). Librarian gets two fast-path patterns:
- `"get my model"` → GET companion settings, return `active_model`
- `"set model <name>"` → POST `{ key: "active_model", value: "<name>" }`

---

## Model Registry

New file: `packages/shared/src/models.ts`

```typescript
export const ALL_MODELS: Record<string, {
  provider: InferenceProvider;
  model: string;
  label: string;          // human-readable name shown in Discord
}> = {
  // DeepSeek
  "deepseek-chat":       { provider: "deepseek",  model: "deepseek-chat",              label: "DeepSeek Chat" },
  "deepseek-reasoner":   { provider: "deepseek",  model: "deepseek-reasoner",           label: "DeepSeek Reasoner" },

  // Groq
  "llama-3.3-70b":       { provider: "groq",      model: "llama-3.3-70b-versatile",     label: "Llama 3.3 70B" },

  // LM Studio (local, exposed via Cloudflare tunnel -- set LMSTUDIO_URL on VPS)
  "gemma-4":             { provider: "lmstudio",  model: "gemma-4",                     label: "Gemma 4 (local)" },
  "mistral-large-3":     { provider: "lmstudio",  model: "mistral-large-3",             label: "Mistral Large 3 (local)" },

  // Kimi (Moonshot AI)
  "kimi-k2":             { provider: "kimi",      model: "kimi-k2",                     label: "Kimi K2" },
  "kimi-128k":           { provider: "kimi",      model: "moonshot-v1-128k",            label: "Kimi 128k" },

  // OpenAI
  "gpt-4o":              { provider: "openai",    model: "gpt-4o",                      label: "GPT-4o" },
  "gpt-4o-mini":         { provider: "openai",    model: "gpt-4o-mini",                 label: "GPT-4o Mini" },

  // Anthropic (Opus excluded -- too expensive for lean phase)
  "claude-sonnet":       { provider: "anthropic", model: "claude-sonnet-4-6",           label: "Claude Sonnet 4.6" },
  "claude-haiku":        { provider: "anthropic", model: "claude-haiku-4-5-20251001",   label: "Claude Haiku 4.5" },

  // Ollama (local fallback)
  "ollama-local":        { provider: "ollama",    model: "llama3.2",                    label: "Ollama (local)" },
};

export type InferenceProvider =
  "deepseek" | "groq" | "lmstudio" | "kimi" | "openai" | "anthropic" | "ollama";
```

### Model availability (no code changes needed)

`DISABLED_MODELS` env var (comma-separated model keys) marks models as unavailable at runtime:

```
DISABLED_MODELS=claude-sonnet,gpt-4o
```

At boot, `getAvailableModels()` filters `ALL_MODELS` against the disabled list and against which API keys are present. A model whose provider has no API key configured is automatically excluded. This means adding Opus later is a one-line registry entry + env var removal, not a deploy.

```typescript
export function getAvailableModels(env: {
  disabledModels?: string;   // DISABLED_MODELS env var
  apiKeys: Record<InferenceProvider, boolean>; // which keys are present
}): Record<string, ModelEntry> { ... }
```

---

## New Inference Adapters

`packages/shared/src/inference.ts` gets three new adapters. All use the OpenAI-compatible chat completions format:

### Kimi (Moonshot AI)
- Base URL: `https://api.moonshot.cn/v1`
- Auth: `Authorization: Bearer {KIMI_API_KEY}`
- Same request shape as DeepSeek adapter

### OpenAI
- Base URL: `https://api.openai.com/v1`
- Auth: `Authorization: Bearer {OPENAI_API_KEY}`
- Same request shape

### Anthropic
- Base URL: `https://api.anthropic.com/v1/messages`
- Auth: `x-api-key: {ANTHROPIC_API_KEY}` + `anthropic-version: 2023-06-01`
- Different request shape: `{ model, max_tokens, system, messages }` -- needs its own adapter class

`createAdapter` gains a `model` parameter (passed through to the adapter) and handles all seven providers:

```typescript
export function createAdapter(
  provider: InferenceProvider,
  model: string,
  keys: { deepseek?: string; groq?: string; kimi?: string; openai?: string; anthropic?: string },
  urls: { ollama?: string; lmstudio?: string },
  fetchFn?: typeof fetch,
): InferenceAdapter
```

### LM Studio
No new adapter needed -- `LMStudioAdapter` already exists. The `model` parameter is now passed through so the adapter sends the correct model name in the API call (currently it may be hardcoded). `LMSTUDIO_URL` on VPS must point to the Cloudflare tunnel exposing the local LM Studio instance.

---

## Discord Command Interface

### Owner command syntax

```
cy: model deepseek-reasoner
drevan: model kimi-k2
gaia: model claude-haiku
cy: model list
```

`cy: model list` posts the available models in-character (filtered by what's enabled + which keys are present).

Matched case-insensitively before routing to inference. On match:
1. Validate model key against `getAvailableModels()`
2. Validate API key is present for target provider
3. Write to Halseth via Librarian (`set model <name>`)
4. Hot-swap the in-memory adapter ref
5. Respond in-character confirming the switch
6. Return early -- no inference call

### Companion self-switch

Companion emits `[model:<key>]` in response when context warrants. Bot:
1. Scans response for token
2. Strips token from output
3. Applies same switch path as owner command
4. Posts follow-up: `[switching to <label> for this]`
5. Logs switch to companion_journal

Identity files get a brief note listing available models and when self-switching is lane-appropriate.

---

## Hot-Swap Architecture

```typescript
// In main():
const adapterRef = { current: createAdapter(activeProvider, activeModel, keys, urls) };
// Message handler calls adapterRef.current.generate(...)
// On switch: adapterRef.current = createAdapter(newProvider, newModel, keys, urls)
```

`createAdapter` is already a factory -- this just makes it re-callable at runtime.

---

## State Loading

1. **Boot** -- load `active_model` from Halseth alongside `botOrient()`. Fall back to `INFERENCE_PROVIDER` + `INFERENCE_MODEL` env vars if not set.
2. **SOMA refresh** (every 5 min) -- reload, hot-swap if changed.

Active model included in `formatRecentContext`:
```
[Active model] Kimi K2
```

---

## New Env Vars

| Var | Used by | Purpose |
|-----|---------|---------|
| `KIMI_API_KEY` | bots | Moonshot AI API key |
| `OPENAI_API_KEY` | bots | OpenAI API key |
| `ANTHROPIC_API_KEY` | bots | Anthropic API key |
| `LMSTUDIO_URL` | bots | Cloudflare tunnel URL for local LM Studio |
| `INFERENCE_MODEL` | bots | Default model key on cold boot (supplements `INFERENCE_PROVIDER`) |
| `DISABLED_MODELS` | bots | Comma-separated model keys to exclude (e.g. `claude-sonnet,gpt-4o`) |

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid / disabled model name | In-character response listing available options; no write, no switch |
| Missing API key for target provider | In-character rejection; no write |
| Halseth write fails | Switch applies in-memory; warning logged; reverts to default on next restart |
| Companion emits unknown model token | Token stripped silently; switch skipped; warning logged |
| Switch succeeds | In-character confirmation posted to Discord |

---

## Feedback Messages

**Owner-triggered switch (success):**
- Cypher: `switched to Kimi K2`
- Drevan: `running deeper now -- Kimi K2`
- Gaia: `Kimi K2.`

**Owner-triggered switch (failure):** In-character with valid options list.

**Companion self-switch:** Response posts first (token stripped), then separate follow-up `[switching to <label> for this]`.

---

## Testing

`packages/shared/src/__tests__/models.test.ts`:
- Registry: valid key, invalid key, disabled key, missing API key exclusion
- `getAvailableModels()`: correct filtering given env combos
- Command parsing: match, no-match, case-insensitive, whitespace, `list` subcommand
- Token detection and stripping
- Adapter hot-swap (mock createAdapter, verify ref updates)

---

## Files Changed

| File | Change |
|------|--------|
| `halseth` | Migration: `companion_settings` table + GET/POST endpoints |
| `halseth/src/librarian/` | Fast-path patterns: `get my model`, `set model <name>` |
| `packages/shared/src/types.ts` | `InferenceProvider` union expanded; `BotConfig` keys updated |
| `packages/shared/src/models.ts` | New: full model registry + `getAvailableModels()` |
| `packages/shared/src/librarian.ts` | New: `getSetting(key)` method |
| `packages/shared/src/inference.ts` | New: Kimi, OpenAI, Anthropic adapters; `createAdapter` gains `model` param + new providers; LMStudio passes model through |
| `bots/cypher/src/index.ts` | Command parser, self-switch token scan, state load at boot+refresh, adapter ref pattern |
| `bots/drevan/src/index.ts` | Same |
| `bots/gaia/src/index.ts` | Same |
| `packages/shared/src/__tests__/models.test.ts` | New: registry + command parsing tests |
