import { CLASSIFIER_ENABLED, CLASSIFIER_NODE_URL, CLASSIFIER_MODEL } from "../config";
import type { ChatMessage, Complexity } from "../types";

// =========================
// 🧠 CLASIFICADOR DE COMPLEJIDAD
// =========================

const COMPLEX_KEYWORDS = [
  "arquitectura", "architecture", "diseña", "design", "refactor", "optimiza", "optimize",
  "explica en detalle", "explain in detail", "por qué", "why does", "cómo funciona", "how does",
  "implementa", "implement", "sistema", "system", "algoritmo", "algorithm",
  "debug", "error", "excepción", "exception", "problema", "issue", "falla", "fails",
  "prueba", "test", "rendimiento", "performance", "seguridad", "security",
  "paso a paso", "step by step", "compara", "compare", "diferencia", "difference",
];

const SIMPLE_KEYWORDS = [
  "hola", "hello", "hi", "gracias", "thanks", "qué es", "what is", "define",
  "lista", "list", "enumera", "enum", "cuántos", "how many", "cuándo", "when",
  "traduce", "translate", "resume", "summarize", "acorta", "shorten",
];

function classifyByRules(messages: ChatMessage[]): Complexity | null {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;

  const text  = lastUser.content.toLowerCase();
  const words = text.split(/\s+/).length;

  if (words <= 8 && !COMPLEX_KEYWORDS.some((k) => text.includes(k))) return "simple";
  if (COMPLEX_KEYWORDS.some((k) => text.includes(k))) return "complex";
  if (SIMPLE_KEYWORDS.some((k) => text.includes(k)) && words <= 20) return "simple";
  if (lastUser.content.length > 1500) return "complex";

  return null;
}

async function classifyByModel(messages: ChatMessage[]): Promise<Complexity> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "medium";

  const prompt = `Classify the complexity of this request with a single word: "simple", "medium", or "complex".
- simple: greetings, definitions, short translations, yes/no questions
- medium: code snippets, explanations, short implementations
- complex: architecture, debugging, deep analysis, long implementations, system design

Request: "${lastUser.content.slice(0, 300)}"

Reply with only one word:`;

  try {
    const res = await fetch(`${CLASSIFIER_NODE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: CLASSIFIER_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "medium";
    const data = (await res.json()) as { response?: string };
    const raw = (data.response ?? "").toLowerCase().trim();
    if (raw.includes("simple"))  return "simple";
    if (raw.includes("complex")) return "complex";
    return "medium";
  } catch {
    return "medium";
  }
}

export async function classifyComplexity(messages: ChatMessage[]): Promise<Complexity> {
  const byRules = classifyByRules(messages);
  if (byRules) {
    console.log(`[CLASSIFIER] Reglas → ${byRules}`);
    return byRules;
  }
  if (CLASSIFIER_ENABLED) {
    const byModel = await classifyByModel(messages);
    console.log(`[CLASSIFIER] Modelo (${CLASSIFIER_MODEL}) → ${byModel}`);
    return byModel;
  }
  return "medium";
}

export function complexityToAlias(complexity: Complexity): string {
  if (complexity === "simple")  return "fast";
  if (complexity === "complex") return "reasoning";
  return "auto";
}
