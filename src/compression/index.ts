import {
  COMPRESSION_MODE, COMPRESSION_MIN_TOKENS, COMPRESSION_RATIO,
  COMPRESSION_NODE_URL, COMPRESSION_MODEL, COMPRESSION_BACKEND,
} from "../config";
import type { ChatMessage, CompressionMode } from "../types";

// =========================
// 📐 ESTIMACIÓN DE TOKENS
// =========================

export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((acc, m) => acc + m.content.length, 0) / 4);
}

// =========================
// 🗜️ SPLIT HISTORIAL
// =========================

function splitHistory(
  messages: ChatMessage[],
  ratio: number,
): { head: ChatMessage[]; tail: ChatMessage[] } {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const chatMsgs   = messages.filter((m) => m.role !== "system");

  if (chatMsgs.length <= 2) return { head: [], tail: messages };

  const totalTokens = estimateTokens(chatMsgs);
  const keepTokens  = Math.ceil(totalTokens * (1 - ratio));

  const tail: ChatMessage[] = [];
  let acc = 0;
  for (let i = chatMsgs.length - 1; i >= 0; i--) {
    const t = Math.ceil(chatMsgs[i].content.length / 4);
    if (acc + t > keepTokens && tail.length >= 2) break;
    tail.unshift(chatMsgs[i]);
    acc += t;
  }

  const tailSet = new Set(tail);
  const head    = chatMsgs.filter((m) => !tailSet.has(m));
  return { head, tail: [...systemMsgs, ...tail] };
}

// =========================
// 🔍 PROBE DISPONIBILIDAD
// =========================

async function isCompressionNodeAvailable(): Promise<boolean> {
  try {
    if (COMPRESSION_BACKEND === "llamacpp") {
      const res = await fetch(`${COMPRESSION_NODE_URL}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      return res.ok;
    } else {
      const res = await fetch(`${COMPRESSION_NODE_URL}/api/ps`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { models?: unknown[] };
      const load = data.models?.length ?? 0;
      if (load > 0) {
        console.log(`[COMPRESSION] Nodo ocupado (${load} modelo/s) — skipping`);
        return false;
      }
      return true;
    }
  } catch {
    return false;
  }
}

// =========================
// 📝 RESUMEN DEL HEAD
// =========================

async function summarizeHead(head: ChatMessage[]): Promise<ChatMessage | null> {
  if (head.length === 0) return null;

  const transcript = head
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const prompt = `Summarize the following conversation excerpt into a concise paragraph (max 150 words) that captures the key context, decisions, and information exchanged. Write only the summary, nothing else.

Conversation:
${transcript}

Summary:`;

  try {
    let summary = "";

    if (COMPRESSION_BACKEND === "llamacpp") {
      const res = await fetch(`${COMPRESSION_NODE_URL}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, n_predict: 200, temperature: 0.3, stream: false }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) { console.warn(`[COMPRESSION] HTTP ${res.status} — skipping`); return null; }
      const data = (await res.json()) as { content?: string };
      summary = (data.content ?? "").trim();
    } else {
      const res = await fetch(`${COMPRESSION_NODE_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: COMPRESSION_MODEL, prompt, stream: false, options: { temperature: 0.3 } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) { console.warn(`[COMPRESSION] HTTP ${res.status} — skipping`); return null; }
      const data = (await res.json()) as { response?: string };
      summary = (data.response ?? "").trim();
    }

    if (!summary) return null;
    return { role: "user", content: `[Context from earlier in this conversation]: ${summary}` };
  } catch (err) {
    console.warn(`[COMPRESSION] Error: ${err} — skipping`);
    return null;
  }
}

// =========================
// 🚀 PIPELINE PRINCIPAL
// =========================

export async function compressHistory(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const mode: CompressionMode = COMPRESSION_MODE;
  if (mode === "none") return messages;

  const estimated = estimateTokens(messages);
  if (estimated < COMPRESSION_MIN_TOKENS) {
    console.log(`[COMPRESSION] Skipped — ${estimated} tokens < min ${COMPRESSION_MIN_TOKENS}`);
    return messages;
  }

  if (mode === "history" || mode === "both") {
    const before = messages.length;
    const result = await compressWithHistory(messages);
    console.log(`[COMPRESSION] history: ${before} msgs → ${result.length} msgs (~${estimateTokens(messages)} → ~${estimateTokens(result)} tokens)`);
    return result;
  }

  return messages;
}

async function compressWithHistory(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const { head, tail } = splitHistory(messages, COMPRESSION_RATIO);

  if (head.length === 0) {
    console.log("[COMPRESSION] history: nada que comprimir en el head");
    return messages;
  }

  const available = await isCompressionNodeAvailable();
  if (!available) {
    console.log("[COMPRESSION] history: nodo no disponible — skipping");
    return messages;
  }

  console.log(`[COMPRESSION] history: resumiendo ${head.length} msgs del head...`);
  const summary = await summarizeHead(head);

  if (!summary) {
    console.warn("[COMPRESSION] history: resumen falló — usando mensajes originales");
    return messages;
  }

  const systemMsgs = tail.filter((m) => m.role === "system");
  const tailChat   = tail.filter((m) => m.role !== "system");
  return [...systemMsgs, summary, ...tailChat];
}
