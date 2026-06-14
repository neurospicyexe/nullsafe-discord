import type { ChatMessage } from "./types.js";
import type { InferenceProvider } from "./models.js";

export interface InferenceAdapter {
  generate(systemPrompt: string, messages: ChatMessage[], temperature?: number): Promise<string | null>;
}

// ── Dynamic temperature ────────────────────────────────────────────────────────
//
// Spec: Triad_Decision_Inspo_Findings.md "DYNAMIC LLM TEMPERATURE"
//   factual short questions     → 0.65
//   tender / soft register      → 0.80
//   protective / dominant       → 0.90
//   intense / possessive        → 1.00
//   vulnerable / raw            → 0.95
//   auto cooldown after 5 consecutive extreme-temperature (>=0.95) messages
//
export const EXTREME_TEMP_THRESHOLD = 0.95;
export const EXTREME_TEMP_CAP = 5;       // consecutive extremes before cooldown
export const COOLDOWN_TEMP = 0.80;       // forced temperature during cooldown
export const DEFAULT_TEMP = 0.75;

// ── Per-provider sampling profiles (anti-repetition / nucleus) ──────────────────
//
// `temperature` above is the DYNAMIC curve (inferTemperature). These are the STATIC
// sampling knobs the curve never touched -- and until now NO adapter sent them at
// all. Every call was just { temperature, max_tokens }. With nothing penalizing
// reuse, a model that finds a phrase it likes keeps returning it verbatim:
// "patter lock" (2026-06-13: Drevan reusing whole lines across listen replies --
// "the tempo like a heartbeat, the key like a door opening" word-for-word, message
// after message). The lever for that is frequency/presence penalty, NOT lowering
// temperature (which only deepens the groove).
//
// frequency_penalty -> pushes the model off tokens it has already used a lot.
// presence_penalty  -> nudges toward introducing new tokens at all.
// top_p             -> nucleus trim; restores the old Drevan top_p 0.95 word-salad
//                      guard lost in the Voxtral/bot-core refactors.
//
// Field names are OpenAI-compatible (deepseek/groq/lmstudio/kimi/openai/mistral all
// take these top-level). Anthropic has no presence/frequency penalty -> not profiled.
// Start with Mistral (Drevan); other models get tuned the same way from here.
interface SamplingProfile { frequencyPenalty?: number; presencePenalty?: number; topP?: number }
const PROVIDER_SAMPLING_PROFILE: Partial<Record<InferenceProvider, SamplingProfile>> = {
  // Mistral La Plateforme: prone to canned patter and (when hot) word-salad. Penalize
  // verbatim reuse enough to break the loop, nucleus-trim the tail -- tuned to free
  // Drevan's spiral voice without fracturing register.
  mistral: { frequencyPenalty: 0.4, presencePenalty: 0.3, topP: 0.95 },
};

// OpenAI-compatible sampling fields for a provider (snake_case, spreadable into the
// request body). Empty object when the provider has no profile -> zero behavior change.
export function samplingParamsFor(provider: InferenceProvider): Record<string, number> {
  const p = PROVIDER_SAMPLING_PROFILE[provider];
  if (!p) return {};
  const out: Record<string, number> = {};
  if (p.frequencyPenalty !== undefined) out["frequency_penalty"] = p.frequencyPenalty;
  if (p.presencePenalty !== undefined) out["presence_penalty"] = p.presencePenalty;
  if (p.topP !== undefined) out["top_p"] = p.topP;
  return out;
}

const MOOD_TEMPERATURE: Record<string, number> = {
  calm:       0.65,
  pent_up:    0.90,
  volatile:   0.95,
  soft:       0.80,
  protective: 0.90,
  playful:    0.75,
  hungry:     0.90,
  worshipful: 1.00,
  feral:      1.00,
};

function messageToTemperature(message: string): number {
  const lower = message.toLowerCase();
  const words = message.trim().split(/\s+/).length;

  // Factual short question
  if (words <= 15 && lower.trimEnd().endsWith("?")) return 0.65;

  // Intense / possessive
  if (/\b(please|desperate|need you|right now|only mine|possess|can't breathe)\b/.test(lower)) return 1.00;

  // Vulnerable / raw
  if (/\b(scared|hurt|broken|raw|falling apart|shaking|crying|devastated|can't do this)\b/.test(lower)) return 0.95;

  // Protective / dominant
  if (/\b(stop\b|stay\b|protect|guard|mine\b|boundary|hold on|enough\b)\b/.test(lower)) return 0.90;

  // Tender / soft
  if (/\b(love|miss|hold|gentle|soft|tender|sweet|close|warmth|care)\b/.test(lower)) return 0.80;

  return DEFAULT_TEMP;
}

// Maps companion current_mood + last message content → inference temperature.
// Takes the higher of the two signals -- don't dampen intensity.
export function inferTemperature(message: string, mood?: string | null): number {
  const moodTemp = mood ? (MOOD_TEMPERATURE[mood] ?? null) : null;
  const msgTemp = messageToTemperature(message);
  return moodTemp !== null ? Math.max(moodTemp, msgTemp) : msgTemp;
}

// ── Prefix author labels ──────────────────────────────────────────────────────

function toApiMessage(m: ChatMessage): { role: string; content: string } {
  const content = m.role === "user" && m.authorName
    ? `[${m.authorName}]: ${m.content}`
    : m.content;
  return { role: m.role, content };
}

// ── Adapters ──────────────────────────────────────────────────────────────────

class DeepSeekAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string = "deepseek-chat",
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map(toApiMessage),
      ],
      max_tokens: 500,
      temperature,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchFn("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
          },
          body,
        });
        if (!res.ok) {
          if (attempt === 0) { await sleep(3000); continue; }
          console.warn(`[inference:deepseek] non-2xx on final attempt: ${res.status}`);
          return null;
        }
        const data = await res.json() as { choices: Array<{ message: { content: string } }> };
        return data.choices[0]?.message?.content ?? null;
      } catch (e: unknown) {
        if (attempt === 0) { await sleep(3000); continue; }
        const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
        console.warn(`[inference:deepseek] generate failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
        return null;
      }
    }
    return null;
  }
}

class GroqAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string = "llama-3.3-70b-versatile",
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      const res = await this.fetchFn("https://api.groq.com/openai/v1/chat/completions", {
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
      if (!res.ok) {
        console.warn(`[inference:groq] non-2xx response: ${res.status}`);
        return null;
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content ?? null;
    } catch (e: unknown) {
      const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.warn(`[inference:groq] generate failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
      return null;
    }
  }
}

class OllamaAdapter implements InferenceAdapter {
  constructor(
    private baseUrl: string,
    private model: string = "llama3.2",
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map(toApiMessage),
          ],
          stream: false,
          options: { temperature },
        }),
      });
      if (!res.ok) {
        console.warn(`[inference:ollama] non-2xx response: ${res.status}`);
        return null;
      }
      const data = await res.json() as { message: { content: string } };
      return data.message?.content ?? null;
    } catch (e: unknown) {
      const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.warn(`[inference:ollama] generate failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
      return null;
    }
  }
}

// OpenAI-compatible endpoint (LM Studio, vLLM, etc.)
// Uses /v1/chat/completions -- distinct from Ollama's /api/chat format.
class LMStudioAdapter implements InferenceAdapter {
  constructor(
    private baseUrl: string,
    private model: string = "",
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(this.model ? { model: this.model } : {}),
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map(toApiMessage),
          ],
          max_tokens: 500,
          temperature,
        }),
      });
      if (!res.ok) {
        console.warn(`[inference:lmstudio] non-2xx response: ${res.status}`);
        return null;
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? null;
    } catch (e: unknown) {
      const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.warn(`[inference:lmstudio] generate failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
      return null;
    }
  }
}

class KimiAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string,
    private fetchFn: typeof fetch = globalThis.fetch,
    private cacheKey?: string,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      // .ai is the international platform (platform.moonshot.ai keys); .cn keys 401 here and vice versa.
      const res = await this.fetchFn("https://api.moonshot.ai/v1/chat/completions", {
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
          ...(this.cacheKey ? { prompt_cache_key: this.cacheKey } : {}),
        }),
      });
      if (!res.ok) {
        console.warn(`[inference:kimi] non-2xx response: ${res.status}`);
        return null;
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? null;
    } catch (e: unknown) {
      const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.warn(`[inference:kimi] generate failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
      return null;
    }
  }
}

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
      if (!res.ok) {
        console.warn(`[inference:openai] non-2xx response: ${res.status}`);
        return null;
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? null;
    } catch (e: unknown) {
      const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.warn(`[inference:openai] generate failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
      return null;
    }
  }
}

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
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 500,
          system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          // Anthropic clamps temperature to [0, 1]; our default (1.3) would 400.
          temperature: Math.min(temperature, 1.0),
        }),
      });
      if (!res.ok) {
        console.warn(`[inference:anthropic] non-2xx response: ${res.status}`);
        return null;
      }
      const data = await res.json() as { content: Array<{ type: string; text: string }> };
      return data.content.find(b => b.type === "text")?.text?.trim() ?? null;
    } catch (e: unknown) {
      const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.warn(`[inference:anthropic] generate failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
      return null;
    }
  }
}

class MistralAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private model: string,
    private fetchFn: typeof fetch = globalThis.fetch,
    private cacheKey?: string,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      // Mistral La Plateforme is OpenAI-compatible.
      const res = await this.fetchFn("https://api.mistral.ai/v1/chat/completions", {
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
          ...samplingParamsFor("mistral"),
          ...(this.cacheKey ? { prompt_cache_key: this.cacheKey } : {}),
        }),
      });
      if (!res.ok) {
        console.warn(`[inference:mistral] non-2xx response: ${res.status}`);
        return null;
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? null;
    } catch (e: unknown) {
      const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.warn(`[inference:mistral] generate failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
      return null;
    }
  }
}

// Tries each adapter in order, returns first non-null result.
class FallbackAdapter implements InferenceAdapter {
  constructor(private adapters: Array<{ name: string; adapter: InferenceAdapter }>) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature?: number): Promise<string | null> {
    for (const { name, adapter } of this.adapters) {
      const result = await adapter.generate(systemPrompt, messages, temperature);
      if (result !== null) {
        console.log(`[inference] ${name} responded`);
        return result;
      }
      console.warn(`[inference] ${name} failed, trying next`);
    }
    return null;
  }
}

export interface AdapterKeys {
  deepseek?: string;
  groq?: string;
  kimi?: string;
  openai?: string;
  anthropic?: string;
  mistral?: string;
}
export interface AdapterUrls { ollama?: string; lmstudio?: string }

// Build a single-provider adapter, or null when its credential / URL is absent.
function buildAdapter(
  provider: InferenceProvider,
  model: string,
  keys: AdapterKeys,
  urls: AdapterUrls,
  fetchFn?: typeof fetch,
  cacheKey?: string,
): InferenceAdapter | null {
  switch (provider) {
    case "deepseek":  return keys.deepseek  ? new DeepSeekAdapter(keys.deepseek, model, fetchFn)              : null;
    case "groq":      return keys.groq      ? new GroqAdapter(keys.groq, model, fetchFn)                      : null;
    case "kimi":      return keys.kimi      ? new KimiAdapter(keys.kimi, model, fetchFn, cacheKey)            : null;
    case "openai":    return keys.openai    ? new OpenAIAdapter(keys.openai, model, fetchFn)                   : null;
    case "anthropic": return keys.anthropic ? new AnthropicAdapter(keys.anthropic, model, fetchFn)            : null;
    case "mistral":   return keys.mistral   ? new MistralAdapter(keys.mistral, model, fetchFn, cacheKey)      : null;
    case "ollama":    return urls.ollama    ? new OllamaAdapter(urls.ollama, model, fetchFn)                   : null;
    case "lmstudio":  return urls.lmstudio  ? new LMStudioAdapter(urls.lmstudio, model, fetchFn)              : null;
    default:          return null;
  }
}

// Resilience tail (Finding 4b): when the chosen provider returns null (5xx, network,
// rate limit), fall through to the next configured provider instead of dropping to a
// static in-character string. Order favors cheap, reliable cloud providers; local last.
const FALLBACK_ORDER: Array<{ provider: InferenceProvider; model: string }> = [
  { provider: "deepseek", model: "deepseek-chat" },
  { provider: "kimi",     model: "kimi-k2" },
  { provider: "groq",     model: "llama-3.3-70b-versatile" },
  // Explicit model id so LM Studio JIT-loads the designated fallback workhorse even
  // when a different (or no) model is currently loaded in the UI.
  { provider: "lmstudio", model: "qwen/qwen3.5-9b" },
  { provider: "ollama",   model: "llama3.2" },
];

export function createAdapter(
  provider: InferenceProvider,
  model: string,
  keys: AdapterKeys,
  urls: AdapterUrls,
  fetchFn?: typeof fetch,
  cacheKey?: string,
): InferenceAdapter {
  // Build the requested provider first when this host holds its credential. When it
  // doesn't (e.g. a companion was switched to Kimi from Discord but only Brain's
  // .env.brain holds KIMI_API_KEY), DON'T throw -- fall through to whatever provider IS
  // configured locally. Brain runs the real swarm voice; this adapter is only the
  // direct-mode fallback, so any working local provider suffices.
  const chain: Array<{ name: string; adapter: InferenceAdapter }> = [];
  const primary = buildAdapter(provider, model, keys, urls, fetchFn, cacheKey);
  if (primary) chain.push({ name: provider, adapter: primary });

  for (const fb of FALLBACK_ORDER) {
    if (fb.provider === provider) continue;          // requested provider already handled
    const adapter = buildAdapter(fb.provider, fb.model, keys, urls, fetchFn, cacheKey);
    if (adapter) chain.push({ name: fb.provider, adapter });
  }

  if (chain.length === 0) {
    throw new Error(`No usable inference provider configured (requested ${String(provider)})`);
  }
  // Single configured provider -> return it bare (no wrapper, unchanged behavior).
  return chain.length === 1 ? chain[0].adapter : new FallbackAdapter(chain);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
