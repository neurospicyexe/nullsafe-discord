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
