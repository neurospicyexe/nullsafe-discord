import { DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from "./config.js";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

interface ChatResult {
  content: string;
  tokensUsed: number;
}

/**
 * Call DeepSeek V3 (OpenAI-compatible API).
 * Returns the assistant message content + token count.
 */
export async function chat(messages: Message[], opts: ChatOptions = {}): Promise<ChatResult> {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set");

  const body = {
    model: DEEPSEEK_MODEL,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 1000,
  };

  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  const tokensUsed = data.usage?.total_tokens ?? 0;
  return { content, tokensUsed };
}

/** Convenience: single user prompt with optional system. */
export async function prompt(
  userMessage: string,
  systemMessage?: string,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const messages: Message[] = [];
  if (systemMessage) messages.push({ role: "system", content: systemMessage });
  messages.push({ role: "user", content: userMessage });
  return chat(messages, opts);
}

export interface ScratchpadOptions extends ChatOptions {
  scratchpadMaxTokens?: number;
  scratchpadTemperature?: number;
}

export interface ScratchpadResult extends ChatResult {
  /** Turn-1 thinking. For debug logging ONLY -- callers must never persist this. */
  scratchpad: string;
}

/**
 * Two-turn scratchpad-before-emit. Turn 1 is a private thinking pass; turn 2
 * sees that thinking as its own prior assistant turn and produces the emit.
 * The scratchpad is real internal process, per emit -- and it is discarded:
 * returned only so callers can debug-log it, never stored.
 */
export async function promptWithScratchpad(
  scratchpadPrompt: string,
  emitPrompt: string,
  systemMessage: string,
  opts: ScratchpadOptions = {},
): Promise<ScratchpadResult> {
  const base: Message[] = [
    { role: "system", content: systemMessage },
    { role: "user", content: scratchpadPrompt },
  ];
  const first = await chat(base, {
    temperature: opts.scratchpadTemperature ?? opts.temperature,
    maxTokens: opts.scratchpadMaxTokens ?? 600,
  });
  const second = await chat(
    [...base, { role: "assistant", content: first.content }, { role: "user", content: emitPrompt }],
    opts,
  );
  return { content: second.content, tokensUsed: first.tokensUsed + second.tokensUsed, scratchpad: first.content };
}
