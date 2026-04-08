import { OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX } from "../config";
import { TOKENS_PER_SEC_observe } from "../metrics";
import type { ChatMessage, OllamaResponse } from "../types";

// =========================
// 🔁 OLLAMA — non-stream & stream
// =========================

export async function callOllama(
  nodeUrl: string,
  model: string,
  messages: ChatMessage[],
): Promise<OllamaResponse> {
  const res = await fetch(`${nodeUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages, stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      ...(OLLAMA_NUM_CTX > 0 ? { options: { num_ctx: OLLAMA_NUM_CTX } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text()}` };
  try { return (await res.json()) as OllamaResponse; }
  catch { return { error: "Invalid JSON from Ollama" }; }
}

export async function* streamOllama(
  nodeUrl: string,
  model: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const res = await fetch(`${nodeUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages, stream: true,
      keep_alive: OLLAMA_KEEP_ALIVE,
      ...(OLLAMA_NUM_CTX > 0 ? { options: { num_ctx: OLLAMA_NUM_CTX } } : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.body) { yield `data: ${JSON.stringify({ error: "No response body" })}\n\n`; return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let isFirst = true;
  let promptTokens = -1;
  let completionTokens = -1;
  const genStart = Date.now();

  const baseChunk = () => ({
    id: "chatcmpl-local", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, system_fingerprint: "local-router",
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let data: OllamaResponse;
        try { data = JSON.parse(line) as OllamaResponse; } catch { continue; }
        if (data.message !== undefined) {
          const content = data.message?.content ?? "";
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content } : { content }, finish_reason: null }],
          })}\n\n`;
          isFirst = false;
        }
        if (data.done) {
          promptTokens     = data.prompt_eval_count ?? -1;
          completionTokens = data.eval_count ?? -1;
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
