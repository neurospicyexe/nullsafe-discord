import type { ChatMessage } from "./types.js";

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
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    const body = JSON.stringify({
      model: "deepseek-chat",
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
          model: "llama-3.3-70b-versatile",
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
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama3.2",
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
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[], temperature = DEFAULT_TEMP): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
  provider: "deepseek" | "groq" | "ollama" | "lmstudio",
  deepseekKey?: string,
  groqKey?: string,
  ollamaUrl?: string,
  fetchFn?: typeof fetch,
  lmstudioUrl?: string,
): InferenceAdapter {
  switch (provider) {
    case "deepseek":
      if (!deepseekKey) throw new Error("DEEPSEEK_API_KEY required");
      return new DeepSeekAdapter(deepseekKey, fetchFn);
    case "groq":
      if (!groqKey) throw new Error("GROQ_API_KEY required");
      return new GroqAdapter(groqKey, fetchFn);
    case "ollama":
      return new OllamaAdapter(ollamaUrl ?? "http://localhost:11434", fetchFn);
    case "lmstudio": {
      const local = new LMStudioAdapter(lmstudioUrl ?? "http://localhost:1234", fetchFn);
      // Auto-chain: if DeepSeek key is present, it's the fallback when local is unreachable.
      if (deepseekKey) {
        return new FallbackAdapter([
          { name: "lmstudio", adapter: local },
          { name: "deepseek", adapter: new DeepSeekAdapter(deepseekKey, fetchFn) },
        ]);
      }
      return local;
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
