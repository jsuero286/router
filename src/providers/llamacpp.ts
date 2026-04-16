import type { ChatMessage, OllamaResponse, GenerationOptions } from "../types";

// =========================
// 🦙 LLAMA.CPP — non-stream & stream
// =========================

/**
 * Convierte el array de mensajes al formato de prompt para llama.cpp.
 * Usa el formato ChatML que entienden los modelos Qwen y DeepSeek.
 */
function messagesToPrompt(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "system")    return `<|im_start|>system\n${m.content}<|im_end|>`;
      if (m.role === "user")      return `<|im_start|>user\n${m.content}<|im_end|>`;
      if (m.role === "assistant") return `<|im_start|>assistant\n${m.content}<|im_end|>`;
      return m.content;
    })
    .join("\n") + "\n<|im_start|>assistant\n";
}

export async function callLlamaCpp(
  nodeUrl: string,
  messages: ChatMessage[],
  opts: GenerationOptions = {},
): Promise<OllamaResponse> {
  const prompt = messagesToPrompt(messages);
  const body: Record<string, unknown> = {
    prompt,
    stream:    false,
    n_predict: opts.max_tokens ?? 2048,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.top_p       != null) body.top_p       = opts.top_p;

  const res = await fetch(`${nodeUrl}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text()}` };

  try {
    const data = (await res.json()) as {
      content?: string;
      tokens_evaluated?: number;
      tokens_predicted?: number;
    };
    return {
      message:           { content: data.content ?? "" },
      done:              true,
      prompt_eval_count: data.tokens_evaluated,
      eval_count:        data.tokens_predicted,
    };
  } catch {
    return { error: "Invalid JSON from llama.cpp" };
  }
}

export async function* streamLlamaCpp(
  nodeUrl: string,
  messages: ChatMessage[],
  opts: GenerationOptions = {},
): AsyncGenerator<string> {
  const prompt = messagesToPrompt(messages);
  const body: Record<string, unknown> = {
    prompt,
    stream:    true,
    n_predict: opts.max_tokens ?? 2048,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.top_p       != null) body.top_p       = opts.top_p;

  const res = await fetch(`${nodeUrl}/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.body) {
    yield `data: ${JSON.stringify({ error: "No response body" })}\n\n`;
    return;
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = "";
  let isFirst   = true;
  let promptTokens     = -1;
  let completionTokens = -1;

  const baseChunk = () => ({
    id: "chatcmpl-local", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model: "llamacpp", system_fingerprint: "local-router",
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
        // llama.cpp stream usa "data: {...}"
        const jsonStr = line.startsWith("data: ") ? line.slice(6) : line;
        let data: { content?: string; stop?: boolean; tokens_evaluated?: number; tokens_predicted?: number };
        try { data = JSON.parse(jsonStr); } catch { continue; }

        if (data.content) {
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content: data.content } : { content: data.content }, finish_reason: null }],
          })}\n\n`;
          isFirst = false;
        }

        if (data.stop) {
          promptTokens     = data.tokens_evaluated ?? -1;
          completionTokens = data.tokens_predicted ?? -1;
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens:     promptTokens,
              completion_tokens: completionTokens,
              total_tokens:      promptTokens >= 0 && completionTokens >= 0 ? promptTokens + completionTokens : -1,
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
