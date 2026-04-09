import { DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from "./config.js";

interface Message {
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
