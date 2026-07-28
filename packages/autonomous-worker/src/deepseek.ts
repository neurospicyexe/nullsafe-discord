import {
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  REASONING_HEADROOM,
  contentBudget,
  isReasoningModel,
} from "./config.js";

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

  const contentTokens = opts.maxTokens ?? 1000;

  // One attempt at the caller's content budget + reasoning headroom, then ONE retry at double
  // the headroom if the thought still ate the whole budget. The retry is the durable half of
  // the 2026-07-28 fix: `finish_reason === "length"` with empty content is unambiguous -- the
  // model was cut off before it emitted anything -- and catching it HERE covers every call
  // site, including ones added later that never think about the model tier. Without it this
  // whole class of failure surfaces only as downstream 400s ("summary is required") or as
  // sterile output ("0 finds gathered"), which is how it went unnoticed for a full day.
  let attemptBudget = contentBudget(contentTokens);
  let lastTokens = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: attemptBudget,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content?: string }; finish_reason?: string }>;
      usage?: { total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    const finish = choice?.finish_reason ?? "";
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    lastTokens += data.usage?.total_tokens ?? 0;

    if (content.trim()) return { content, tokensUsed: lastTokens };

    // Empty content. Only "length" is retryable -- an empty "stop" is the model genuinely
    // choosing to say nothing, and retrying that just burns tokens to get the same answer.
    if (finish !== "length") {
      console.warn(
        `[deepseek] empty content with finish_reason="${finish}" ` +
        `(model=${DEEPSEEK_MODEL} budget=${attemptBudget} reasoning=${reasoningTokens}) -- not retrying`,
      );
      return { content, tokensUsed: lastTokens };
    }

    if (attempt === 0) {
      const retryBudget = contentTokens + REASONING_HEADROOM * 2;
      console.warn(
        `[deepseek] REASONING STARVED CONTENT: burned ${reasoningTokens} reasoning tokens of ` +
        `${attemptBudget} and emitted nothing (model=${DEEPSEEK_MODEL}, content budget ` +
        `${contentTokens}). Retrying at ${retryBudget}. If this recurs, raise ` +
        `DEEPSEEK_REASONING_HEADROOM (currently ${REASONING_HEADROOM}).`,
      );
      attemptBudget = retryBudget;
      continue;
    }

    console.error(
      `[deepseek] EMPTY CONTENT AFTER RETRY at max_tokens=${attemptBudget} ` +
      `(model=${DEEPSEEK_MODEL}, reasoning=${reasoningTokens}). Caller will see "" -- expect a ` +
      `downstream validation failure. Raise DEEPSEEK_REASONING_HEADROOM.`,
    );
    return { content, tokensUsed: lastTokens };
  }

  return { content: "", tokensUsed: lastTokens };
}

/** Exported for the reasoning-budget tests. */
export { contentBudget, isReasoningModel };

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
