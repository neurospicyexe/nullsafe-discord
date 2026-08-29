// packages/shared/src/models.ts

export type InferenceProvider =
  | "deepseek"
  | "groq"
  | "lmstudio"
  | "kimi"
  | "openai"
  | "anthropic"
  | "mistral"
  | "deepinfra"
  | "ollama";

export interface ModelEntry {
  provider: InferenceProvider;
  model: string;
  label: string;
}

export const ALL_MODELS: Record<string, ModelEntry> = {
  // DeepSeek. Only deepseek-v4-flash and deepseek-v4-pro are listed by GET /v1/models as of
  // 2026-07-28; `deepseek-chat` and `deepseek-reasoner` are delisted (they still answer, which
  // is exactly how the 07-27 intermittent-400 outage went unnoticed for a day). The two legacy
  // KEYS are kept as aliases pointing at the live models so a stored `active_model` -- cypher's
  // was still `deepseek-chat` -- keeps resolving instead of falling back to the env default.
  // This mirrors ops/hermes-model-map.json, which already aliased them the same way.
  "flash":             { provider: "deepseek",  model: "deepseek-v4-flash",         label: "DeepSeek Flash (everyday)" },
  "pro":               { provider: "deepseek",  model: "deepseek-v4-pro",           label: "DeepSeek Pro (deep thinking)" },
  "deepseek-chat":     { provider: "deepseek",  model: "deepseek-v4-flash",         label: "DeepSeek Flash (everyday)" },
  "deepseek-reasoner": { provider: "deepseek",  model: "deepseek-v4-pro",           label: "DeepSeek Pro (deep thinking)" },
  // Groq
  "llama-3.3-70b":     { provider: "groq",      model: "llama-3.3-70b-versatile",   label: "Llama 3.3 70B" },
  // LM Studio (workstation, reached via reverse SSH tunnel -- LMSTUDIO_URL=http://127.0.0.1:11435
  // on VPS; tunnel script halseth/scripts/lmstudio-tunnel.ps1 runs at workstation logon).
  // Model ids MUST match LM Studio's /v1/models ids exactly (JIT-loaded on request).
  "gemma-local":       { provider: "lmstudio",  model: "google/gemma-4-e4b",                   label: "Gemma 4 E4B (local)" },
  "nemo-local":        { provider: "lmstudio",  model: "mistralai/mistral-nemo-instruct-2407", label: "Mistral Nemo (local)" },
  // 2026-08-21: Qwen3.5-9B is a THINKING model -- on the 4GB-VRAM laptop it spent 2m19s in
  // reasoning_content and returned empty content (finish_reason=length). Qwen2.5-7B-Instruct is
  // non-thinking, mostly fits VRAM, and answered a Gaia-register prompt in <10s cold.
  "qwen-local":        { provider: "lmstudio",  model: "qwen2.5-7b-instruct",                  label: "Qwen2.5 7B (local)" },
  "lfm-local":         { provider: "lmstudio",  model: "liquid/lfm2-1.2b",                     label: "LFM2 1.2B (local)" },
  // Mistral (La Plateforme API -- set MISTRAL_API_KEY)
  "mistral-large":     { provider: "mistral",   model: "mistral-large-latest",      label: "Mistral Large (API)" },
  "mistral-small":     { provider: "mistral",   model: "mistral-small-latest",      label: "Mistral Small (API)" },
  // DeepInfra (OpenAI-compatible; set DEEPINFRA_API_KEY). Flat pricing, no peak window --
  // the answer to the 2026-08 DeepSeek repricing. Model ids are DeepInfra's full HF-style ids;
  // verify against GET /v1/openai/models before trusting a new one (aliases have burned us).
  "flash-di":          { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Flash-0731", label: "DeepSeek Flash (DeepInfra)" },
  "gemma-di":          { provider: "deepinfra", model: "google/gemma-4-31B-it-turbo",        label: "Gemma 4 31B Turbo (DeepInfra)" },
  // 2026-08-29: expressive/conversational trial for Drevan (Raziel's call -- flash is Cypher/Gaia's
  // register, not his). Id verified against GET /v1/openai/models same day.
  "minimax-m3":        { provider: "deepinfra", model: "MiniMaxAI/MiniMax-M3",               label: "MiniMax M3 (DeepInfra)" },
  // Kimi (Moonshot AI) -- env var: KIMI_API_KEY in .env.brain (Moonshot docs call it MOONSHOT_API_KEY)
  "kimi-k2":           { provider: "kimi",      model: "kimi-k2.6",                 label: "Kimi K2" },
  "kimi-k2.5":         { provider: "kimi",      model: "kimi-k2.5",                 label: "Kimi K2.5" },
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
