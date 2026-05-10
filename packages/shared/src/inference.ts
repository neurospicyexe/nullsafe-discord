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
          return null;
        }
        const data = await res.json() as { choices: Array<{ message: { content: string } }> };
        return data.choices[0]?.message?.content ?? null;
      } catch {
        if (attempt === 0) { await sleep(3000); continue; }
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
      if (!res.ok) return null;
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content ?? null;
    } catch {
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
      if (!res.ok) return null;
      const data = await res.json() as { message: { content: string } };
      return data.message?.content ?? null;
    } catch {
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
      if (!res.ok) return null;
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? null;
    } catch {
      return null;
    }
  }
}

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

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
