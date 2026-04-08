import { ANTHROPIC_API_KEY, ANTHROPIC_MAX_TOKENS } from "../config";
import { TOKENS_PER_SEC_observe } from "../metrics";
import type { ChatMessage, OllamaResponse, GenerationOptions } from "../types";

// =========================
// 🤖 ANTHROPIC — non-stream & stream
// =========================

export async function callAnthropic(model: string, messages: ChatMessage[], opts: GenerationOptions = {}): Promise<OllamaResponse> {
  if (!ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not set" };
  const systemMsg    = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, max_tokens: opts.max_tokens ?? ANTHROPIC_MAX_TOKENS, messages: userMessages };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.top_p != null)        body.top_p       = opts.top_p;
  if (systemMsg) body.system = systemMsg;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { error: `Anthropic HTTP ${res.status}: ${await res.text()}` };
  const data = (await res.json()) as any;
  return {
    message: { content: data.content?.[0]?.text ?? "" },
    done: true,
    prompt_eval_count: data.usage?.input_tokens  ?? -1,
    eval_count:        data.usage?.output_tokens ?? -1,
  };
}

export async function* streamAnthropic(model: string, messages: ChatMessage[], opts: GenerationOptions = {}): AsyncGenerator<string> {
  if (!ANTHROPIC_API_KEY) {
    yield `data: ${JSON.stringify({ error: "ANTHROPIC_API_KEY not set" })}\n\n`;
    return;
  }
  const systemMsg    = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, max_tokens: opts.max_tokens ?? ANTHROPIC_MAX_TOKENS, messages: userMessages, stream: true };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.top_p != null)        body.top_p       = opts.top_p;
  if (systemMsg) body.system = systemMsg;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.body) { yield `data: ${JSON.stringify({ error: "No response body from Anthropic" })}\n\n`; return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let isFirst = true;
  let promptTokens = -1;
  let completionTokens = -1;
  const genStart = Date.now();

  const baseChunk = () => ({
    id: "chatcmpl-anthropic", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, system_fingerprint: "anthropic-router",
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let event: any;
        try { event = JSON.parse(raw); } catch { continue; }
        if (event.type === "message_start" && event.message?.usage) {
          promptTokens = event.message.usage.input_tokens ?? -1;
        }
        if (event.type === "message_delta" && event.usage) {
          completionTokens = event.usage.output_tokens ?? -1;
        }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const content = event.delta.text ?? "";
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content } : { content }, finish_reason: null }],
          })}\n\n`;
          isFirst = false;
        }
        if (event.type === "message_stop") {
          const elapsedSec = (Date.now() - genStart) / 1000;
          if (completionTokens > 0 && elapsedSec > 0) {
            TOKENS_PER_SEC_observe({ model }, completionTokens / elapsedSec);
          }
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens >= 0 && completionTokens >= 0 ? promptTokens + completionTokens : -1,
            },
          })}\n\n`;
          yield "data: [DONE]\n\n";
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
