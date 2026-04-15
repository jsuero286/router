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
// 🔍 PROBE DISPONIBILIDAD (history mode)
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
// 📝 RESUMEN DEL HEAD (history mode)
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
// 🤖 LLMLINGUA-2 — implementación propia con TinyBERT
// =========================

type TokenClassifier = {
  tokenizer: { encode: (text: string) => Promise<{ input_ids: { data: bigint[] } }> };
  model:     { run: (inputs: Record<string, unknown>) => Promise<{ logits: { data: Float32Array; dims: number[] } }> };
};

let bertClassifier: TokenClassifier | null = null;
let bertLoading    = false;
let bertFailed     = false;

async function getBertClassifier(): Promise<TokenClassifier | null> {
  if (bertFailed)     return null;
  if (bertClassifier) return bertClassifier;
  if (bertLoading)    return null;

  bertLoading = true;
  try {
    console.log("[COMPRESSION] llmlingua: cargando TinyBERT...");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hf = await import("@huggingface/transformers" as any);

    const MODEL = "atjsh/llmlingua-2-js-tinybert-meetingbank";
    const tokenizer = await hf.AutoTokenizer.from_pretrained(MODEL);
    const model     = await hf.AutoModelForTokenClassification.from_pretrained(MODEL, {
      device: "cpu",
      dtype:  "fp32",
    });

    bertClassifier = { tokenizer, model };
    console.log("[COMPRESSION] llmlingua: ✅ TinyBERT cargado");
    return bertClassifier;
  } catch (err) {
    console.error(`[COMPRESSION] llmlingua: ❌ error cargando TinyBERT: ${err}`);
    bertFailed = true;
    return null;
  } finally {
    bertLoading = false;
  }
}

/**
 * Comprime un texto usando TinyBERT para clasificar la relevancia de cada token.
 * Los tokens con mayor probabilidad de ser "preserve" se mantienen.
 */
async function compressText(text: string, ratio: number): Promise<string> {
  const classifier = await getBertClassifier();
  if (!classifier) return text;

  try {
    // Tokenizar — max 512 tokens (límite de BERT)
    const encoded   = await classifier.tokenizer(text, {
      truncation:    true,
      max_length:    512,
      return_tensors: "pt",
    });

    // Inferencia
    const output  = await classifier.model(encoded);
    const logits  = output.logits; // shape [1, seq_len, 2]
    const seqLen  = logits.dims[1];
    const data    = logits.data as Float32Array;

    // Softmax por token → prob de clase 1 ("preserve")
    const scores: number[] = [];
    for (let i = 0; i < seqLen; i++) {
      const offset = i * 2;
      const l0 = data[offset];
      const l1 = data[offset + 1];
      const max = Math.max(l0, l1);
      const e0  = Math.exp(l0 - max);
      const e1  = Math.exp(l1 - max);
      scores.push(e1 / (e0 + e1)); // prob de "preserve"
    }

    // Cuántos tokens conservar (excluyendo [CLS] y [SEP])
    const keepCount = Math.max(1, Math.ceil((seqLen - 2) * ratio));

    // Indices de los tokens más relevantes (excluir pos 0=[CLS] y última=[SEP])
    const ranked = scores
      .slice(1, seqLen - 1)
      .map((score, idx) => ({ idx: idx + 1, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, keepCount)
      .map((t) => t.idx)
      .sort((a, b) => a - b); // restaurar orden original

    // Decodificar tokens seleccionados
    const inputIds    = encoded.input_ids.data as bigint[];
    const keptIds     = ranked.map((i) => inputIds[i]);
    const compressed  = await classifier.tokenizer.decode(keptIds, {
      skip_special_tokens: true,
    });

    return compressed.trim() || text;
  } catch (err) {
    console.warn(`[COMPRESSION] llmlingua: error en compressText: ${err}`);
    return text;
  }
}

async function compressWithLLMLingua(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const compressed: ChatMessage[] = [];
  for (const msg of messages) {
    // Mensajes cortos o system — pasar sin comprimir
    if (msg.role === "system" || msg.content.length < 200) {
      compressed.push(msg);
      continue;
    }
    const result = await compressText(msg.content, COMPRESSION_RATIO);
    compressed.push({ ...msg, content: result });
  }
  return compressed;
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

  let result = messages;

  if (mode === "history" || mode === "both") {
    const before = result.length;
    result = await compressWithHistory(result);
    console.log(`[COMPRESSION] history: ${before} msgs → ${result.length} msgs (~${estimateTokens(messages)} → ~${estimateTokens(result)} tokens)`);
  }

  if (mode === "llmlingua" || mode === "both") {
    const beforeTokens = estimateTokens(result);
    result = await compressWithLLMLingua(result);
    console.log(`[COMPRESSION] llmlingua: ~${beforeTokens} → ~${estimateTokens(result)} tokens`);
  }

  return result;
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

// =========================
// 🔥 PRECARGA OPCIONAL
// =========================

export function warmupLLMLingua(): void {
  if (COMPRESSION_MODE === "llmlingua" || COMPRESSION_MODE === "both") {
    getBertClassifier().catch(() => {});
  }
}
