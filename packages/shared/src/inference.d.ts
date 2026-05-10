import type { ChatMessage } from "./types.js";
import type { InferenceProvider } from "./models.js";
export interface InferenceAdapter {
    generate(systemPrompt: string, messages: ChatMessage[], temperature?: number): Promise<string | null>;
}
export declare function createAdapter(
  provider: InferenceProvider,
  model: string,
  keys: { deepseek?: string; groq?: string; kimi?: string; openai?: string; anthropic?: string },
  urls: { ollama?: string; lmstudio?: string },
  fetchFn?: typeof fetch,
): InferenceAdapter;
