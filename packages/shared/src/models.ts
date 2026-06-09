// packages/shared/src/models.ts

export type InferenceProvider =
  | "deepseek"
  | "groq"
  | "lmstudio"
  | "kimi"
  | "openai"
  | "anthropic"
  | "mistral"
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
  // Mistral (La Plateforme API -- set MISTRAL_API_KEY)
  "mistral-large":     { provider: "mistral",   model: "mistral-large-latest",      label: "Mistral Large (API)" },
  "mistral-small":     { provider: "mistral",   model: "mistral-small-latest",      label: "Mistral Small (API)" },
  // Kimi (Moonshot AI) -- env var: KIMI_API_KEY in .env.brain (Moonshot docs call it MOONSHOT_API_KEY)
  // Kimi (Moonshot AI) -- env var: KIMI_API_KEY in .env.brain (Moonshot docs call it MOONSHOT_API_KEY)
  "kimi-k2":           { provider: "kimi",      model: "kimi-k2.6",                 label: "Kimi K2" },
  "kimi-128k":         { provider: "kimi",      model: "moonshot-v1-128k",          label: "Kimi 128k" },
  // OpenAI
  "gpt-5.5":           { provider: "openai",    model: "gpt-5.5",                   label: "GPT-5.5" },
  "gpt-5.4":           { provider: "openai",    model: "gpt-5.4",                   label: "GPT-5.4" },
  "gpt-5.4-mini":      { provider: "openai",    model: "gpt-5.4-mini",              label: "GPT-5.4 Mini" },
  "gpt-4o":            { provider: "openai",    model: "gpt-4o",                    label: "GPT-4o" },
  "gpt-4o-mini":       { provider: "openai",    model: "gpt-4o-mini",               label: "GPT-4o Mini" },
  // Anthropic
  "claude-opus":       { provider: "anthropic", model: "claude-opus-4-8",           label: "Claude Opus 4.8" },
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
