import {
  COMPRESSION_MODE, COMPRESSION_MIN_TOKENS, COMPRESSION_RATIO,
  COMPRESSION_NODE_URL, COMPRESSION_MODEL,
} from "../config";
import type { ChatMessage, CompressionMode } from "../types";

// =========================
// 📐 ESTIMACIÓN DE TOKENS
// =========================

/**
 * Estimación rápida: ~4 chars por token (OpenAI heurística).
 * No necesitamos exactitud aquí — solo un umbral de activación.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((acc, m) => acc + m.content.length, 0) / 4);
}

// =========================
// 🗜️ COMPRESIÓN POR HISTORIAL
// =========================

/**
 * Divide el historial en dos partes:
 *   - tail: los últimos N turnos (siempre se pasan íntegros al modelo)
 *   - head: todo lo anterior (candidato a compresión)
 *
 * El "tail" se calcula para que ocupe ~(1 - COMPRESSION_RATIO) del total estimado.
 */
function splitHistory(
  messages: ChatMessage[],
  ratio: number,
): { head: ChatMessage[]; tail: ChatMessage[] } {
  // System messages siempre van al tail (no se comprimen)
  const systemMsgs = messages.filter((m) => m.role === "system");
  const chatMsgs   = messages.filter((m) => m.role !== "system");

  if (chatMsgs.length <= 2) {
    // Demasiado corto — nada que comprimir
    return { head: [], tail: messages };
  }

  // Cuántos tokens queremos conservar intactos
  const totalTokens = estimateTokens(chatMsgs);
  const keepTokens  = Math.ceil(totalTokens * (1 - ratio));

  // Construir el tail empezando desde el final
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

/**
 * Llama al modelo small (clasificador) para resumir el bloque head.
 * Devuelve un único mensaje con role "user" que representa el contexto previo.
 */
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
    const res = await fetch(`${COMPRESSION_NODE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: COMPRESSION_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[COMPRESSION] HTTP ${res.status} al resumir — skipping`);
      return null;
    }

    const data = (await res.json()) as { response?: string };
    const summary = (data.response ?? "").trim();
    if (!summary) return null;

    return {
      role: "user",
      content: `[Context from earlier in this conversation]: ${summary}`,
    };
  } catch (err) {
    console.warn(`[COMPRESSION] Error llamando al clasificador: ${err} — skipping`);
    return null;
  }
}

// =========================
// 🚀 PIPELINE PRINCIPAL
// =========================

/**
 * Comprime el array de mensajes según el modo configurado.
 * Siempre devuelve un array válido — si algo falla, devuelve los originales.
 */
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
    console.log(
      `[COMPRESSION] history: ${before} msgs → ${result.length} msgs ` +
      `(~${estimateTokens(messages)} → ~${estimateTokens(result)} tokens)`,
    );
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

  console.log(`[COMPRESSION] history: resumiendo ${head.length} msgs del head...`);
  const summary = await summarizeHead(head);

  if (!summary) {
    console.warn("[COMPRESSION] history: resumen falló — usando mensajes originales");
    return messages;
  }

  // Sistema primero, luego resumen, luego tail (sin system porque ya está en tail)
  const systemMsgs = tail.filter((m) => m.role === "system");
  const tailChat   = tail.filter((m) => m.role !== "system");

  return [...systemMsgs, summary, ...tailChat];
}
