import type { ChatMessage } from "./types.js";
import type { InferenceProvider } from "./models.js";
export interface InferenceAdapter {
    generate(systemPrompt: string, messages: ChatMessage[], temperature?: number): Promise<string | null>;
}
export declare function createAdapter(provider: InferenceProvider, deepseekKey?: string, groqKey?: string, ollamaUrl?: string, fetchFn?: typeof fetch, lmstudioUrl?: string, kimiKey?: string, openaiKey?: string, anthropicKey?: string): InferenceAdapter;
