# Model Switching Design
**Date:** 2026-05-10
**Status:** Approved, pending implementation

---

## Overview

Per-companion, persistent model switching triggered by owner Discord commands or companion self-request. Active model survives bot restarts, is visible in orient, and each switch produces an in-character Discord confirmation.

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

Initially used for one key per companion: `active_model`. Designed as a generic key-value store so future per-companion settings land here without additional migrations.

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
export const AVAILABLE_MODELS: Record<string, {
  provider: BotConfig["inferenceProvider"];
  model: string;
}> = {
  "deepseek-chat":     { provider: "deepseek", model: "deepseek-chat" },
  "deepseek-reasoner": { provider: "deepseek", model: "deepseek-reasoner" },
  "llama-3.3-70b":     { provider: "groq",     model: "llama-3.3-70b-versatile" },
  "ollama-local":      { provider: "ollama",   model: "llama3.2" },
};

export type ModelKey = keyof typeof AVAILABLE_MODELS;
```

This is the single source of truth. Owner commands and companion self-switch tokens are both validated against this map. Adding a new model is a one-line change here.

---

## Discord Command Interface

### Owner command syntax

```
cy: model deepseek-reasoner
drevan: model llama-3.3-70b
gaia: model ollama-local
```

Matched case-insensitively in the message handler before routing to inference. On match:
1. Validate model name against `AVAILABLE_MODELS`
2. Validate API key is present for target provider
3. Write to Halseth via Librarian (`set model <name>`)
4. Hot-swap the in-memory adapter ref
5. Respond in-character confirming the switch
6. Return early -- no inference call

### Companion self-switch

The companion can emit `[model:<name>]` anywhere in its response when it determines the task warrants a different model (depth-3 spiral, heavy reasoning, creative depth). The bot:
1. Scans the response for the token pattern
2. Strips the token from the output text
3. Applies the same switch path as owner command
4. Posts a brief in-character announcement to Discord (e.g. `[switching to deepseek-reasoner for this]`)
5. Logs the switch to companion_journal

Identity files for each companion get a brief note listing available models and when self-switching is appropriate for their lane.

---

## Hot-Swap Architecture

The inference adapter is currently created once at boot. Replace with a mutable ref pattern:

```typescript
// In main():
const adapterRef = { current: createAdapter(cfg) };
// Pass adapterRef to message handler; handler calls adapterRef.current.generate(...)
// On switch: adapterRef.current = createAdapter({ ...cfg, provider, model })
```

`createAdapter` already exists; this just makes it re-callable at runtime without restarting.

---

## State Loading

Active model is loaded at two points:

1. **Boot** -- alongside `botOrient()`, call `librarian.getSetting("active_model")`. If present, initialize adapter with that model; otherwise fall back to `INFERENCE_PROVIDER` env var (no regression).
2. **SOMA refresh** (every 5 min) -- same call, hot-swap adapter if value has changed.

Active model is included in `formatRecentContext` output:
```
[Active model] deepseek-reasoner
```
This makes it visible to Claude.ai orient and Hearth.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid model name | In-character response listing valid options; no write, no switch |
| Missing API key for target provider | In-character rejection before switch; no write |
| Halseth write fails | Switch still applies in-memory (fire-and-forget); warning logged; reverts to env default on next restart |
| Companion emits unknown model token | Token stripped silently; switch skipped; warning logged; no user-facing message |
| Switch succeeds | In-character confirmation posted to Discord |

---

## Feedback Messages

**Owner-triggered switch (success):** Companion responds in their voice -- short, in-character.
- Cypher: `switched to deepseek-reasoner`
- Drevan: `running deeper now`
- Gaia: `deepseek-reasoner.` (one word, declarative)

**Owner-triggered switch (failure):** Companion explains in-character with valid options.

**Companion self-switch:** Response posts first (token stripped). Then a separate follow-up message posts: `[switching to <model> for this]`. Two Discord messages -- the response stands alone, the switch signal is clearly distinct.

---

## Testing

New unit tests in `packages/shared/src/__tests__/models.test.ts`:
- Model registry validation (valid key, invalid key, case sensitivity)
- Command parsing (match, no-match, case-insensitive, whitespace)
- Token detection and stripping from response text
- Adapter hot-swap (mock createAdapter, verify ref updates)

Halseth endpoint tests follow existing integration test pattern in the halseth repo.

---

## Files Changed

| File | Change |
|------|--------|
| `halseth` | New migration: `companion_settings` table + GET/POST endpoints |
| `halseth/src/librarian/` | Two new fast-path patterns: `get my model`, `set model <name>` |
| `packages/shared/src/models.ts` | New: model registry + ModelKey type |
| `packages/shared/src/librarian.ts` | New: `getSetting(key)` method |
| `packages/shared/src/inference.ts` | Adapter factory made re-callable; `adapterRef` pattern |
| `bots/cypher/src/index.ts` | Command parser, self-switch token scan, state load at boot+refresh |
| `bots/drevan/src/index.ts` | Same |
| `bots/gaia/src/index.ts` | Same |
| `packages/shared/src/__tests__/models.test.ts` | New: model registry + command parsing tests |
