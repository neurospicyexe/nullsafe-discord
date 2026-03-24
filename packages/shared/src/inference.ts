import type { ChatMessage } from "./types.js";

export interface InferenceAdapter {
  generate(systemPrompt: string, messages: ChatMessage[]): Promise<string | null>;
}

// Prefix user-role messages with [AuthorName]: when authorName is present.
// This is how multi-party channel context reaches the model -- without it,
// a companion reading a conversation between Drevan and Raziel has no signal
// about who said what.
function toApiMessage(m: ChatMessage): { role: string; content: string } {
  const content = m.role === "user" && m.authorName
    ? `[${m.authorName}]: ${m.content}`
    : m.content;
  return { role: m.role, content };
}

class DeepSeekAdapter implements InferenceAdapter {
  constructor(
    private apiKey: string,
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async generate(systemPrompt: string, messages: ChatMessage[]): Promise<string | null> {
    const body = JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map(toApiMessage),
      ],
      max_tokens: 500,
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

  async generate(systemPrompt: string, messages: ChatMessage[]): Promise<string | null> {
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

  async generate(systemPrompt: string, messages: ChatMessage[]): Promise<string | null> {
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

export function createAdapter(
  provider: "deepseek" | "groq" | "ollama",
  deepseekKey?: string,
  groqKey?: string,
  ollamaUrl?: string,
  fetchFn?: typeof fetch,
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
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
