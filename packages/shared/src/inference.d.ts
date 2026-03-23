import type { ChatMessage } from "./types.js";
export interface InferenceAdapter {
    generate(systemPrompt: string, messages: ChatMessage[]): Promise<string | null>;
}
export declare function createAdapter(provider: "deepseek" | "groq" | "ollama", deepseekKey?: string, groqKey?: string, ollamaUrl?: string, fetchFn?: typeof fetch): InferenceAdapter;
