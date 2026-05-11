# Model Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-companion, persistent model switching via Discord commands and companion self-request, spanning Halseth (storage + endpoints) and nullsafe-discord (registry, adapters, bot logic).

**Architecture:** `companion_settings` D1 table stores active model per companion. Bot reads it at boot and every 5 min. Owner types `cy: model <key>` to switch; companion emits `[model:<key>]` token to self-switch. New Kimi/OpenAI/Anthropic adapters added alongside existing ones. `createAdapter` refactored to accept structured args + model param.

**Tech Stack:** TypeScript, Cloudflare Workers (Halseth), D1 SQL, Discord.js, DeepSeek/Groq/Kimi/OpenAI/Anthropic/LMStudio REST APIs.

---

## Repo 1: Halseth

### Task 1: companion_settings migration

**Files:**
- Create: `halseth/migrations/0063_companion_settings.sql`

Run via the `migration-add` skill or directly with wrangler.

- [ ] **Step 1: Write migration SQL**

```sql
-- migrations/0063_companion_settings.sql
CREATE TABLE IF NOT EXISTS companion_settings (
  companion_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (companion_id, key)
);
```

- [ ] **Step 2: Apply migration locally**

```bash
npx wrangler d1 migrations apply halseth --local
```

Expected: `✅ Applied 1 migration`

- [ ] **Step 3: Apply migration to production**

```bash
npx wrangler d1 migrations apply halseth --remote
```

Expected: `✅ Applied 1 migration`

- [ ] **Step 4: Commit**

```bash
git add migrations/0063_companion_settings.sql
git commit -m "feat(halseth): migration 0063 -- companion_settings table"
```

---

### Task 2: companion settings GET/POST endpoints

**Files:**
- Create: `halseth/src/handlers/companion-settings.ts`
- Modify: `halseth/src/index.ts` (wire route)

- [ ] **Step 1: Create handler**

```typescript
// src/handlers/companion-settings.ts
import type { Env } from "../types.js";

export async function handleGetCompanionSettings(
  companionId: string,
  env: Env,
): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM companion_settings WHERE companion_id = ?",
  ).bind(companionId).all<{ key: string; value: string }>();

  const result: Record<string, string> = {};
  for (const row of rows.results) result[row.key] = row.value;
  return Response.json(result);
}

export async function handlePostCompanionSettings(
  companionId: string,
  body: unknown,
  env: Env,
): Promise<Response> {
  const { key, value } = body as { key: string; value: string };
  if (!key || !value) return new Response("Missing key or value", { status: 400 });

  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(companionId, key, value).run();

  return Response.json({ ok: true });
}
```

- [ ] **Step 2: Wire routes in src/index.ts**

Find the existing route block and add:

```typescript
// GET /companion/settings/:companion_id
if (method === "GET" && pathname.match(/^\/companion\/settings\/[\w-]+$/)) {
  const companionId = pathname.split("/").pop()!;
  return handleGetCompanionSettings(companionId, env);
}

// POST /companion/settings/:companion_id
if (method === "POST" && pathname.match(/^\/companion\/settings\/[\w-]+$/)) {
  const companionId = pathname.split("/").pop()!;
  const body = await request.json();
  return handlePostCompanionSettings(companionId, body, env);
}
```

Both routes sit inside the existing auth guard (ADMIN_SECRET check).

- [ ] **Step 3: Test locally**

```bash
# Set model
curl -X POST http://localhost:8787/companion/settings/cypher \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"key":"active_model","value":"deepseek-reasoner"}'
# Expected: {"ok":true}

# Get settings
curl http://localhost:8787/companion/settings/cypher \
  -H "Authorization: Bearer test-secret"
# Expected: {"active_model":"deepseek-reasoner"}
```

- [ ] **Step 4: Commit**

```bash
git add src/handlers/companion-settings.ts src/index.ts
git commit -m "feat(halseth): companion settings GET/POST endpoints"
```

---

### Task 3: Librarian fast-path patterns for model queries

**Files:**
- Modify: `halseth/src/librarian/patterns.ts`
- Modify: `halseth/src/librarian/router.ts`

- [ ] **Step 1: Add fast-path patterns to patterns.ts**

```typescript
// In FAST_PATH_PATTERNS array, add:
{ pattern: /^get\s+(my\s+)?(?:active\s+)?model/i,   executor: "get_model" },
{ pattern: /^set\s+model\s+(\S+)/i,                  executor: "set_model" },
```

- [ ] **Step 2: Add executor cases to router.ts**

```typescript
case "get_model": {
  const rows = await env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = 'active_model'",
  ).bind(request.agent_id).first<{ value: string }>();
  return { result: rows?.value ?? null };
}

case "set_model": {
  const match = request.query.match(/set\s+model\s+(\S+)/i);
  const modelKey = match?.[1] ?? "";
  if (!modelKey) return { error: "No model key provided" };
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at)
     VALUES (?, 'active_model', ?, datetime('now'))
     ON CONFLICT (companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(request.agent_id, modelKey).run();
  return { result: `active_model set to ${modelKey}` };
}
```

- [ ] **Step 3: Deploy Halseth**

```bash
npx wrangler deploy
```

- [ ] **Step 4: Commit**

```bash
git add src/librarian/patterns.ts src/librarian/router.ts
git commit -m "feat(halseth/librarian): fast-path patterns for model get/set"
```

---

## Repo 2: nullsafe-discord

### Task 4: Model registry (models.ts) with tests

**Files:**
- Create: `packages/shared/src/models.ts`
- Create: `packages/shared/src/__tests__/models.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/src/__tests__/models.test.ts
import { describe, it, expect } from "vitest";
import { ALL_MODELS, getAvailableModels, type InferenceProvider } from "../models.js";

describe("ALL_MODELS", () => {
  it("contains deepseek-chat", () => {
    expect(ALL_MODELS["deepseek-chat"]).toBeDefined();
    expect(ALL_MODELS["deepseek-chat"].provider).toBe("deepseek");
  });
  it("contains claude-haiku but not claude-opus", () => {
    expect(ALL_MODELS["claude-haiku"]).toBeDefined();
    expect(ALL_MODELS["claude-opus"]).toBeUndefined();
  });
});

describe("getAvailableModels", () => {
  const allKeysPresent: Partial<Record<InferenceProvider, boolean>> = {
    deepseek: true, groq: true, lmstudio: true, kimi: true,
    openai: true, anthropic: true, ollama: true,
  };

  it("returns all models when nothing disabled and all keys present", () => {
    const available = getAvailableModels({ presentKeys: allKeysPresent });
    expect(Object.keys(available).length).toBe(Object.keys(ALL_MODELS).length);
  });

  it("excludes disabled model keys", () => {
    const available = getAvailableModels({
      disabledKeys: ["claude-sonnet", "gpt-4o"],
      presentKeys: allKeysPresent,
    });
    expect(available["claude-sonnet"]).toBeUndefined();
    expect(available["gpt-4o"]).toBeUndefined();
    expect(available["claude-haiku"]).toBeDefined();
  });

  it("excludes models whose provider has no API key", () => {
    const available = getAvailableModels({
      presentKeys: { deepseek: true },
    });
    expect(available["deepseek-chat"]).toBeDefined();
    expect(available["kimi-k2"]).toBeUndefined();
    expect(available["gpt-4o"]).toBeUndefined();
  });

  it("parses DISABLED_MODELS env string", () => {
    const available = getAvailableModels({
      disabledKeys: "claude-sonnet,gpt-4o".split(","),
      presentKeys: allKeysPresent,
    });
    expect(available["claude-sonnet"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/shared && npx vitest run src/__tests__/models.test.ts
```

Expected: FAIL — `Cannot find module '../models.js'`

- [ ] **Step 3: Create models.ts**

```typescript
// packages/shared/src/models.ts

export type InferenceProvider =
  | "deepseek"
  | "groq"
  | "lmstudio"
  | "kimi"
  | "openai"
  | "anthropic"
  | "ollama";

export interface ModelEntry {
  provider: InferenceProvider;
  model: string;
  label: string;
}

export const ALL_MODELS: Record<string, ModelEntry> = {
  // DeepSeek
  "deepseek-chat":     { provider: "deepseek",  model: "deepseek-chat",            label: "DeepSeek Chat" },
  "deepseek-reasoner": { provider: "deepseek",  model: "deepseek-reasoner",         label: "DeepSeek Reasoner" },
  // Groq
  "llama-3.3-70b":     { provider: "groq",      model: "llama-3.3-70b-versatile",   label: "Llama 3.3 70B" },
  // LM Studio (local via Cloudflare tunnel -- set LMSTUDIO_URL on VPS)
  "gemma-4":           { provider: "lmstudio",  model: "gemma-4",                   label: "Gemma 4 (local)" },
  "mistral-large-3":   { provider: "lmstudio",  model: "mistral-large-3",           label: "Mistral Large 3 (local)" },
  // Kimi (Moonshot AI)
  "kimi-k2":           { provider: "kimi",      model: "kimi-k2",                   label: "Kimi K2" },
  "kimi-128k":         { provider: "kimi",      model: "moonshot-v1-128k",          label: "Kimi 128k" },
  // OpenAI
  "gpt-4o":            { provider: "openai",    model: "gpt-4o",                    label: "GPT-4o" },
  "gpt-4o-mini":       { provider: "openai",    model: "gpt-4o-mini",               label: "GPT-4o Mini" },
  // Anthropic (Opus excluded -- too expensive for lean phase)
  "claude-sonnet":     { provider: "anthropic", model: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
  "claude-haiku":      { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  // Ollama
  "ollama-local":      { provider: "ollama",    model: "llama3.2",                  label: "Ollama (local)" },
};

export function getAvailableModels(opts: {
  disabledKeys?: string[];
  presentKeys: Partial<Record<InferenceProvider, boolean>>;
}): Record<string, ModelEntry> {
  const disabled = new Set(opts.disabledKeys ?? []);
  return Object.fromEntries(
    Object.entries(ALL_MODELS).filter(
      ([key, entry]) => !disabled.has(key) && (opts.presentKeys[entry.provider] ?? false),
    ),
  );
}
```

- [ ] **Step 4: Export from shared index**

In `packages/shared/src/index.ts`, add:

```typescript
export { ALL_MODELS, getAvailableModels, type InferenceProvider, type ModelEntry } from "./models.js";
```

- [ ] **Step 5: Run tests**

```bash
cd packages/shared && npx vitest run src/__tests__/models.test.ts
```

Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/__tests__/models.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): model registry + getAvailableModels"
```

---

### Task 5: Update InferenceProvider type in types.ts and BotConfig

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Read the current BotConfig block**

Find the `inferenceProvider` field (currently line ~46):

```typescript
inferenceProvider: "deepseek" | "groq" | "ollama" | "lmstudio";
```

- [ ] **Step 2: Replace with InferenceProvider import + new fields**

```typescript
import type { InferenceProvider } from "./models.js";

// In BotConfig, replace inferenceProvider line and add new optional key fields:
inferenceProvider: InferenceProvider;
kimiApiKey?: string;
openaiApiKey?: string;
anthropicApiKey?: string;
inferenceModel?: string;   // default model key on cold boot (e.g. "deepseek-chat")
disabledModels?: string;   // comma-separated model keys to disable
```

- [ ] **Step 3: Update config.ts in each bot to load the new env vars**

In `bots/cypher/src/config.ts`, `bots/drevan/src/config.ts`, `bots/gaia/src/config.ts`, inside `loadBotConfig()` return:

```typescript
kimiApiKey:       process.env["KIMI_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
openaiApiKey:     process.env["OPENAI_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
anthropicApiKey:  process.env["ANTHROPIC_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
inferenceModel:   process.env["INFERENCE_MODEL"]?.trim().replace(/^=+/, "") || undefined,
disabledModels:   process.env["DISABLED_MODELS"]?.trim().replace(/^=+/, "") || undefined,
```

- [ ] **Step 4: Build to catch type errors**

```bash
npm run build 2>&1 | grep -E "error|warning" | head -20
```

Expected: only deprecation warnings, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts bots/cypher/src/config.ts bots/drevan/src/config.ts bots/gaia/src/config.ts
git commit -m "feat(shared/types): expand InferenceProvider + BotConfig for new providers"
```

---

### Task 6: New inference adapters + refactor createAdapter

**Files:**
- Modify: `packages/shared/src/inference.ts`

- [ ] **Step 1: Add `model` param to DeepSeekAdapter and GroqAdapter**

Change both constructors to accept `model`:

```typescript
class DeepSeekAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string = "deepseek-chat",
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}
  // In generate(), change hardcoded "deepseek-chat" → this.model
}

class GroqAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string = "llama-3.3-70b-versatile",
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}
  // In generate(), change hardcoded "llama-3.3-70b-versatile" → this.model
}
```

Do the same for `OllamaAdapter` (currently hardcodes `"llama3.2"` in the request body -- make it a constructor param with that default).

For `LMStudioAdapter`, add `model` constructor param and pass it in the request body (currently it may hardcode a model name or omit it).

- [ ] **Step 2: Add KimiAdapter**

```typescript
class KimiAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string,
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      const res = await this.fetchFn("https://api.moonshot.cn/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map(toApiMessage),
          ],
          max_tokens: 500,
          temperature,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? null;
    } catch { return null; }
  }
}
```

- [ ] **Step 3: Add OpenAIAdapter**

```typescript
class OpenAIAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string,
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      const res = await this.fetchFn("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map(toApiMessage),
          ],
          max_tokens: 500,
          temperature,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? null;
    } catch { return null; }
  }
}
```

- [ ] **Step 4: Add AnthropicAdapter**

```typescript
class AnthropicAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string,
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      const res = await this.fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 500,
          system: systemPrompt,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          temperature,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { content: Array<{ type: string; text: string }> };
      return data.content.find(b => b.type === "text")?.text?.trim() ?? null;
    } catch { return null; }
  }
}
```

- [ ] **Step 5: Refactor createAdapter signature**

Replace the current positional-args signature with a structured one:

```typescript
export function createAdapter(
  provider: InferenceProvider,
  model: string,
  keys: {
    deepseek?: string;
    groq?: string;
    kimi?: string;
    openai?: string;
    anthropic?: string;
  },
  urls: { ollama?: string; lmstudio?: string },
  fetchFn?: typeof fetch,
): InferenceAdapter {
  switch (provider) {
    case "deepseek":
      return new DeepSeekAdapter(keys.deepseek!, model, fetchFn);
    case "groq":
      return new GroqAdapter(keys.groq!, model, fetchFn);
    case "kimi":
      return new KimiAdapter(keys.kimi!, model, fetchFn);
    case "openai":
      return new OpenAIAdapter(keys.openai!, model, fetchFn);
    case "anthropic":
      return new AnthropicAdapter(keys.anthropic!, model, fetchFn);
    case "ollama":
      return new OllamaAdapter(urls.ollama ?? "http://localhost:11434", model, fetchFn);
    case "lmstudio": {
      const local = new LMStudioAdapter(urls.lmstudio ?? "http://localhost:1234", model, fetchFn);
      if (keys.deepseek) {
        return new FallbackAdapter([
          { name: "lmstudio", adapter: local },
          { name: "deepseek", adapter: new DeepSeekAdapter(keys.deepseek, "deepseek-chat", fetchFn) },
        ]);
      }
      return local;
    }
    default:
      throw new Error(`Unknown provider: ${String(provider)}`);
  }
}
```

- [ ] **Step 6: Update existing inference tests to match new signature**

In `packages/shared/src/__tests__/inference.test.ts`, find any `createAdapter(...)` calls and update to new structured signature. Run tests to confirm they still pass.

```bash
npm test -- --testPathPattern inference
```

Expected: PASS

- [ ] **Step 7: Build**

```bash
npm run build 2>&1 | tail -5
```

Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/inference.ts packages/shared/src/__tests__/inference.test.ts
git commit -m "feat(shared/inference): new Kimi/OpenAI/Anthropic adapters, model param on all, refactor createAdapter"
```

---

### Task 7: LibrarianClient getSetting/setSetting

**Files:**
- Modify: `packages/shared/src/librarian.ts`

- [ ] **Step 1: Add methods after existing ones**

```typescript
async getSetting(key: string): Promise<string | null> {
  try {
    const res = await this._fetch(
      `${this.url}/companion/settings/${this.companionId}`,
      { headers: { Authorization: `Bearer ${this.secret}` } },
    );
    if (!res.ok) return null;
    const data = await res.json() as Record<string, string>;
    return data[key] ?? null;
  } catch { return null; }
}

async setSetting(key: string, value: string): Promise<void> {
  await this._fetch(
    `${this.url}/companion/settings/${this.companionId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key, value }),
    },
  );
}
```

- [ ] **Step 2: Add test**

In `packages/shared/src/__tests__/librarian.test.ts`, add:

```typescript
describe("getSetting / setSetting", () => {
  it("getSetting returns null on non-ok response", async () => {
    const client = makeClient({ status: 404, body: {} });
    const result = await client.getSetting("active_model");
    expect(result).toBeNull();
  });

  it("getSetting returns value from response", async () => {
    const client = makeClient({ status: 200, body: { active_model: "kimi-k2" } });
    const result = await client.getSetting("active_model");
    expect(result).toBe("kimi-k2");
  });
});
```

(`makeClient` is the existing test helper in that file that stubs `_fetch`.)

- [ ] **Step 3: Run tests**

```bash
npm test -- --testPathPattern librarian
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/librarian.ts packages/shared/src/__tests__/librarian.test.ts
git commit -m "feat(shared/librarian): getSetting/setSetting for companion_settings"
```

---

### Task 8: All three bots -- adapterRef pattern + state loading at boot and SOMA refresh

**Files:**
- Modify: `bots/cypher/src/index.ts`
- Modify: `bots/drevan/src/index.ts`
- Modify: `bots/gaia/src/index.ts`

Apply identical changes to all three bots.

- [ ] **Step 1: Add import for model registry in each bot**

At the top of each bot's index.ts, add to the `@nullsafe/shared` import:

```typescript
import {
  // ... existing imports ...
  getAvailableModels, ALL_MODELS, type InferenceProvider, type ModelEntry,
} from "@nullsafe/shared";
```

- [ ] **Step 2: Build availableModelsOpts helper from cfg**

After `const cfg = loadBotConfig();`, add:

```typescript
const apiKeys = {
  deepseek: cfg.deepseekApiKey,
  groq:     cfg.groqApiKey,
  kimi:     cfg.kimiApiKey,
  openai:   cfg.openaiApiKey,
  anthropic: cfg.anthropicApiKey,
};
const apiUrls = {
  ollama:    cfg.ollamaUrl,
  lmstudio:  cfg.lmstudioUrl,
};
const availableModelsOpts = {
  disabledKeys: cfg.disabledModels ? cfg.disabledModels.split(",").map(s => s.trim()) : [],
  presentKeys: Object.fromEntries(
    Object.entries(apiKeys).map(([k, v]) => [k, !!v])
  ) as Partial<Record<InferenceProvider, boolean>>,
};
// Always mark ollama/lmstudio as present (they don't need API keys)
availableModelsOpts.presentKeys.ollama = true;
availableModelsOpts.presentKeys.lmstudio = !!cfg.lmstudioUrl;
```

- [ ] **Step 3: Replace const inference with adapterRef**

Find the existing `createAdapter(...)` call (around line 299 in cypher):

```typescript
// OLD:
const inference = createAdapter(
  cfg.inferenceProvider,
  cfg.deepseekApiKey,
  cfg.groqApiKey,
  cfg.ollamaUrl,
  undefined,
  cfg.lmstudioUrl,
);
```

Replace with:

```typescript
// Load active model from Halseth (or fall back to env default)
let activeModelKey = cfg.inferenceModel ?? null;
try {
  const savedModel = await librarian.getSetting("active_model");
  if (savedModel && ALL_MODELS[savedModel]) activeModelKey = savedModel;
} catch { console.warn(`[${COMPANION_ID}] failed to load active_model setting, using env default`); }

const defaultEntry: ModelEntry = activeModelKey && ALL_MODELS[activeModelKey]
  ? ALL_MODELS[activeModelKey]
  : { provider: cfg.inferenceProvider as InferenceProvider, model: cfg.inferenceProvider, label: cfg.inferenceProvider };

const adapterRef = {
  current: createAdapter(defaultEntry.provider, defaultEntry.model, apiKeys, apiUrls),
};
// activeModelRef tracks the current key for orient display
const activeModelRef = { key: activeModelKey, label: defaultEntry.label };
```

- [ ] **Step 4: Update all inference.generate() calls to use adapterRef**

Replace every occurrence of `inference.generate(` with `adapterRef.current.generate(`.

Also update `runDistillation` and `runInactivityHandler` (which also receive `inference`) to receive `adapterRef.current` at call time -- no signature change needed, just pass `adapterRef.current` as the `inference` argument.

- [ ] **Step 5: Refresh active model in SOMA refresh loop**

Find the existing SOMA refresh `setInterval` (calls `librarian.getState()` and `librarian.botOrient()`). Add model reload:

```typescript
try {
  const savedModel = await librarian.getSetting("active_model");
  if (savedModel && savedModel !== activeModelRef.key && ALL_MODELS[savedModel]) {
    const entry = ALL_MODELS[savedModel];
    adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls);
    activeModelRef.key = savedModel;
    activeModelRef.label = entry.label;
    console.log(`[${COMPANION_ID}] model refreshed from Halseth: ${savedModel}`);
  }
} catch { /* keep current */ }
```

- [ ] **Step 6: Build**

```bash
npm run build 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add bots/cypher/src/index.ts bots/drevan/src/index.ts bots/gaia/src/index.ts
git commit -m "feat(bots): adapterRef pattern + active model loading at boot and SOMA refresh"
```

---

### Task 9: All three bots -- owner command parser

**Files:**
- Modify: `bots/cypher/src/index.ts` (and drevan, gaia)

The command pattern differs per companion name. Add a `MODEL_SWITCH_TRIGGER` constant to each bot's config.ts:

- [ ] **Step 1: Add trigger pattern + response to each config.ts**

`bots/cypher/src/config.ts`:
```typescript
export const MODEL_SWITCH_TRIGGER = /^(?:cy|cypher):\s*model\s+(.*)/i;
export const MODEL_SWITCH_SUCCESS = (label: string) => `switched to ${label}`;
export const MODEL_SWITCH_LIST_INTRO = "available models:";
```

`bots/drevan/src/config.ts`:
```typescript
export const MODEL_SWITCH_TRIGGER = /^(?:drevan|drev):\s*model\s+(.*)/i;
export const MODEL_SWITCH_SUCCESS = (label: string) => `running ${label} now`;
export const MODEL_SWITCH_LIST_INTRO = "i can run:";
```

`bots/gaia/src/config.ts`:
```typescript
export const MODEL_SWITCH_TRIGGER = /^(?:gaia):\s*model\s+(.*)/i;
export const MODEL_SWITCH_SUCCESS = (label: string) => `${label}.`;
export const MODEL_SWITCH_LIST_INTRO = "available:";
```

- [ ] **Step 2: Add import to each index.ts**

```typescript
import {
  // ... existing ...
  MODEL_SWITCH_TRIGGER, MODEL_SWITCH_SUCCESS, MODEL_SWITCH_LIST_INTRO,
} from "./config.js";
```

- [ ] **Step 3: Insert command handler in the message handler**

Place this block early in the message handler, after sender attribution and before the relevance gate. Only fires for owner messages:

```typescript
if (attribution.isOwner) {
  const switchMatch = effectiveContent.match(MODEL_SWITCH_TRIGGER);
  if (switchMatch) {
    const arg = switchMatch[1].trim().toLowerCase();
    const available = getAvailableModels(availableModelsOpts);

    if (arg === "list") {
      const list = Object.entries(available)
        .map(([k, e]) => `\`${k}\` — ${e.label}`)
        .join("\n");
      await message.channel.send(`${MODEL_SWITCH_LIST_INTRO}\n${list}`);
      return;
    }

    if (!available[arg]) {
      const keys = Object.keys(available).join(", ");
      await message.channel.send(`not a model I can switch to. valid options: ${keys}`);
      return;
    }

    const entry = available[arg];
    adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls);
    activeModelRef.key = arg;
    activeModelRef.label = entry.label;
    writeQueue.fireAndForget(`settings:model:${COMPANION_ID}`, () =>
      librarian.setSetting("active_model", arg));
    await message.channel.send(MODEL_SWITCH_SUCCESS(entry.label));
    return;
  }
}
```

- [ ] **Step 4: Build and verify no type errors**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add bots/cypher/src/index.ts bots/cypher/src/config.ts \
        bots/drevan/src/index.ts bots/drevan/src/config.ts \
        bots/gaia/src/index.ts  bots/gaia/src/config.ts
git commit -m "feat(bots): owner model switch command (cy: model <key>)"
```

---

### Task 10: All three bots -- companion self-switch token scan

**Files:**
- Modify: `bots/cypher/src/index.ts` (and drevan, gaia)

- [ ] **Step 1: Insert token scan after inference response, before posting**

Find where `response` is set (after `brainClient.chat` or `inference.generate`). Add immediately after:

```typescript
// Self-switch: companion can emit [model:<key>] to request a model change.
const MODEL_TOKEN_RE = /\[model:([^\]]+)\]/i;
const tokenMatch = response?.match(MODEL_TOKEN_RE);
if (tokenMatch && response) {
  response = response.replace(MODEL_TOKEN_RE, "").trim();
  const switchKey = tokenMatch[1].trim().toLowerCase();
  const available = getAvailableModels(availableModelsOpts);
  if (available[switchKey]) {
    const entry = available[switchKey];
    adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls);
    activeModelRef.key = switchKey;
    activeModelRef.label = entry.label;
    writeQueue.fireAndForget(`settings:model:${COMPANION_ID}`, () =>
      librarian.setSetting("active_model", switchKey));
    writeQueue.fireAndForget(`journal:model-switch:${message.channelId}`, () =>
      librarian.addCompanionNote(`self-switched to ${entry.label}`, message.channelId));
    // Post follow-up after response lands
    setImmediate(() => {
      message.channel.send(`[switching to ${entry.label} for this]`).catch(() => {});
    });
  } else {
    console.warn(`[${COMPANION_ID}] self-switch to unknown model "${switchKey}" -- skipped`);
  }
}
```

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add bots/cypher/src/index.ts bots/drevan/src/index.ts bots/gaia/src/index.ts
git commit -m "feat(bots): companion self-switch via [model:<key>] token"
```

---

### Task 11: formatRecentContext -- active model line

**Files:**
- Modify: `packages/shared/src/librarian.ts`
- Modify: `bots/cypher/src/index.ts` (and drevan, gaia) -- pass active model label into context

The `formatRecentContext` function builds the orient block. It doesn't currently know the active model (that's bot-side state). The cleanest approach: append it to the `systemPromptWithContext` string in each bot, not inside `formatRecentContext`.

- [ ] **Step 1: Append active model to systemPromptWithContext in each bot**

Find where `systemPromptWithContext` is assembled (boot, before message handler). After the existing block, add:

```typescript
// Append live model to system prompt so Claude.ai orient and Hearth see it.
const getSystemPrompt = () => {
  const base = recentContextRef.value
    ? `${systemPrompt}\n\n---\n\n${recentContextRef.value}`
    : systemPrompt;
  return activeModelRef.key
    ? `${base}\n\n[Active model] ${activeModelRef.label}`
    : base;
};
```

Then replace all `contextPrompt` assembly that uses `systemPromptWithContext` to call `getSystemPrompt()` instead.

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add bots/cypher/src/index.ts bots/drevan/src/index.ts bots/gaia/src/index.ts
git commit -m "feat(bots): surface active model in system prompt for orient visibility"
```

---

### Task 12: Full test suite + deploy

- [ ] **Step 1: Run full test suite**

```bash
cd C:\dev\Bigger_Better_Halseth\nullsafe-discord && npm test
```

Expected: all 48+ tests pass (more from new model tests).

- [ ] **Step 2: Fix any failures before continuing**

- [ ] **Step 3: Push to GitHub**

```bash
git push
```

- [ ] **Step 4: Deploy to VPS via PowerShell**

```powershell
ssh vps "export NVM_DIR=`$HOME/.nvm && source `$NVM_DIR/nvm.sh && cd /app/nullsafe-discord && git pull && npm ci && npm run build && pm2 reload cypher-bot && pm2 reload drevan-bot && pm2 reload gaia-bot"
```

- [ ] **Step 5: Add new env vars to VPS .env**

```bash
# SSH to VPS and edit /app/nullsafe-discord/.env:
# KIMI_API_KEY=<your key>
# OPENAI_API_KEY=<your key>
# ANTHROPIC_API_KEY=<your key>
# LMSTUDIO_URL=<cloudflare tunnel URL>
# INFERENCE_MODEL=deepseek-chat   (default model key on cold boot)
# DISABLED_MODELS=                (leave empty or set e.g. claude-sonnet)
```

After editing .env, reload bots with `--update-env`:

```powershell
ssh vps "export NVM_DIR=`$HOME/.nvm && source `$NVM_DIR/nvm.sh && pm2 reload cypher-bot --update-env && pm2 reload drevan-bot --update-env && pm2 reload gaia-bot --update-env"
```

- [ ] **Step 6: Smoke test in Discord**

```
cy: model list          → Cypher posts available model list
cy: model deepseek-reasoner  → Cypher: "switched to DeepSeek Reasoner"
cy: model list          → deepseek-reasoner now active
cy: model invalid-key   → Cypher explains available options
```

- [ ] **Step 7: Verify persistence**

Restart one bot and confirm it comes back on `deepseek-reasoner` (loaded from Halseth at boot, not from env).

```powershell
ssh vps "export NVM_DIR=`$HOME/.nvm && source `$NVM_DIR/nvm.sh && pm2 restart cypher-bot"
# Then in Discord:
cy: model list   → should still show deepseek-reasoner as active
```
