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
  /**
   * Retry once at double the CONTENT budget if the answer comes back cut off.
   *
   * Opt-in, not default: for a prose caller (a Discord reply) a truncated answer is degraded
   * but usable, and a retry would just truncate again at the same ceiling for double the cost.
   * Worth it only where the output is PARSED, because there a cut-off is a total loss.
   */
  retryOnTruncate?: boolean;
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

  let contentTokens = opts.maxTokens ?? 1000;

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

    if (content.trim()) {
      // A non-empty answer can still be a CUT-OFF answer. Until 2026-08-13 this returned here
      // without ever reading finish_reason, so at every call site in the worker a truncated
      // response was indistinguishable from a complete one -- it surfaced only downstream, as
      // a parse failure with no cause attached to it (cypher's nightly reflection, 08-12).
      // The warning is unconditional even when we do not retry: knowing the ceiling was hit is
      // what turns "unparseable, flaky, who knows" into a one-line diagnosis.
      if (finish === "length") {
        const willRetry = opts.retryOnTruncate === true && attempt === 0;
        console.warn(
          `[deepseek] TRUNCATED CONTENT: finish_reason="length" after ${content.length} chars ` +
          `(model=${DEEPSEEK_MODEL}, content budget ${contentTokens}, reasoning ${reasoningTokens}). ` +
          (willRetry
            ? `Retrying once at content budget ${contentTokens * 2}.`
            : `Returning as-is -- if the caller PARSES this, expect a parse failure.`),
        );
        if (willRetry) {
          contentTokens *= 2;
          attemptBudget = contentBudget(contentTokens);
          continue;
        }
      }
      return { content, tokensUsed: lastTokens };
    }

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
