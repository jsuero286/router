import { GOOGLE_API_KEY } from "../config";
import { TOKENS_PER_SEC_observe } from "../metrics";
import type { ChatMessage, OllamaResponse, GenerationOptions, McpTool } from "../types";

// =========================
// 🔵 GOOGLE GEMINI — non-stream & stream
// =========================

export interface GoogleToolCall {
  id:   string;
  name: string;
  args: Record<string, unknown>;
}

export async function callGoogle(
  model: string,
  messages: ChatMessage[],
  opts: GenerationOptions = {},
  tools: McpTool[] = [],
): Promise<OllamaResponse & { toolCalls?: GoogleToolCall[] }> {
  if (!GOOGLE_API_KEY) return { error: "GOOGLE_API_KEY not set" };
  const systemMsg    = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const contents = userMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = { contents };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg }] };
  if (opts.temperature != null || opts.top_p != null) {
    const gc: Record<string, unknown> = {};
    if (opts.temperature != null) gc.temperature = opts.temperature;
    if (opts.top_p != null)        gc.topP        = opts.top_p;
    body.generationConfig = gc;
  }
  if (tools.length > 0) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name:        t.function.name,
        description: t.function.description,
        parameters:  t.function.parameters,
      })),
    }];
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { error: `Google HTTP ${res.status}: ${await res.text()}` };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as any;

  // Extraer tool calls si los hay
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fnCalls = parts.filter((p: any) => p.functionCall);
  if (fnCalls.length > 0) {
    return {
      message:           { content: "" },
      done:              true,
      prompt_eval_count: data.usageMetadata?.promptTokenCount     ?? -1,
      eval_count:        data.usageMetadata?.candidatesTokenCount ?? -1,
      toolCalls: fnCalls.map((p: any, i: number) => ({
        id:   `google-tool-${i}`,
        name: p.functionCall.name,
        args: p.functionCall.args ?? {},
      })),
    };
  }

  return {
    message:           { content: parts.find((p: any) => p.text)?.text ?? "" },
    done:              true,
    prompt_eval_count: data.usageMetadata?.promptTokenCount     ?? -1,
    eval_count:        data.usageMetadata?.candidatesTokenCount ?? -1,
  };
}

export async function* streamGoogle(model: string, messages: ChatMessage[], opts: GenerationOptions = {}): AsyncGenerator<string> {
  if (!GOOGLE_API_KEY) { yield `data: ${JSON.stringify({ error: "GOOGLE_API_KEY not set" })}\n\n`; return; }
  const systemMsg    = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const contents = userMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = { contents };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg }] };
  if (opts.temperature != null || opts.top_p != null) {
    const gc: Record<string, unknown> = {};
    if (opts.temperature != null) gc.temperature = opts.temperature;
    if (opts.top_p != null)        gc.topP        = opts.top_p;
    body.generationConfig = gc;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.body) { yield `data: ${JSON.stringify({ error: "No response body from Google" })}\n\n`; return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let isFirst = true;
  let promptTokens = -1;
  let completionTokens = -1;
  const genStart = Date.now();

  const baseChunk = () => ({
    id: "chatcmpl-google", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, system_fingerprint: "google-router",
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
        if (!raw) continue;
        let event: any;
        try { event = JSON.parse(raw); } catch { continue; }
        if (event.usageMetadata) {
          promptTokens     = event.usageMetadata.promptTokenCount     ?? -1;
          completionTokens = event.usageMetadata.candidatesTokenCount ?? -1;
        }
        const text = event.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (text) {
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content: text } : { content: text }, finish_reason: null }],
          })}\n\n`;
          isFirst = false;
        }
        if (event.candidates?.[0]?.finishReason === "STOP") {
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
