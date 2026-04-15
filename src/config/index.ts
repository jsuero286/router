import * as path from "path";
import type { NodeConfig, NodeEntry } from "../types";

// =========================
// 🔧 CONFIG (via entorno)
// =========================

export const ANTHROPIC_API_KEY       = process.env.ANTHROPIC_API_KEY ?? "";
export const ANTHROPIC_MAX_TOKENS    = parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? "8096", 10);
export const GOOGLE_API_KEY          = process.env.GOOGLE_API_KEY ?? "";
export const SKILLS_DIR              = process.env.SKILLS_DIR ?? path.join(process.cwd(), "skills");
export const METRICS_ENABLED         = (process.env.METRICS_ENABLED ?? "true") === "true";
export const REDIS_HOST              = process.env.REDIS_HOST ?? "127.0.0.1";
export const REDIS_PORT              = parseInt(process.env.REDIS_PORT ?? "6379", 10);
export const REDIS_PASSWORD          = process.env.REDIS_PASSWORD ?? undefined;
export const CACHE_TTL               = parseInt(process.env.CACHE_TTL ?? "300", 10);
export const OLLAMA_KEEP_ALIVE       = process.env.OLLAMA_KEEP_ALIVE ?? "1h";
export const OLLAMA_NUM_CTX          = parseInt(process.env.OLLAMA_NUM_CTX ?? "0", 10);
export const WARMUP_ON_START         = (process.env.WARMUP_ON_START ?? "true") === "true";
export const ROUTER_API_KEY          = process.env.ROUTER_API_KEY ?? "";
export const CLASSIFIER_ENABLED      = (process.env.CLASSIFIER_ENABLED ?? "true") === "true";
export const CLASSIFIER_NODE_URL     = process.env.CLASSIFIER_NODE_URL ?? "http://ai-mac.casa.lan";
export const CLASSIFIER_MODEL        = process.env.CLASSIFIER_MODEL ?? "qwen2.5:0.5b";
export const CONVERSATION_TTL        = parseInt(process.env.CONVERSATION_TTL ?? "3600", 10);
export const CONVERSATION_MAX_TURNS  = parseInt(process.env.CONVERSATION_MAX_TURNS ?? "50", 10);
export const PORT                    = parseInt(process.env.PORT ?? "8000", 10);

// =========================
// 🗜️ COMPRESIÓN DE HISTORIAL
// =========================

export type CompressionMode = "none" | "history" | "llmlingua" | "both";

const _compressionMode = process.env.COMPRESSION_MODE ?? "none";
export const COMPRESSION_MODE: CompressionMode =
  ["none", "history", "llmlingua", "both"].includes(_compressionMode)
    ? (_compressionMode as CompressionMode)
    : "none";

export const COMPRESSION_MIN_TOKENS  = parseInt(process.env.COMPRESSION_MIN_TOKENS ?? "500", 10);
export const COMPRESSION_RATIO       = parseFloat(process.env.COMPRESSION_RATIO ?? "0.5");
export const COMPRESSION_NODE_URL    = process.env.COMPRESSION_NODE_URL ?? CLASSIFIER_NODE_URL;
export const COMPRESSION_MODEL       = process.env.COMPRESSION_MODEL ?? "qwen2.5:3b";

if (!ROUTER_API_KEY) {
  console.error("❌ ROUTER_API_KEY no definida — el router no arrancará sin autenticación configurada");
  process.exit(1);
}

// =========================
// 💰 COSTE ESTIMADO
// =========================

export const TOKEN_COST_USD: Record<string, { input: number; output: number }> = {
  // Anthropic (precios por millón de tokens)
  "claude-sonnet-4-6": { input: 3.00,  output: 15.00 },
  "claude-opus-4-6":   { input: 15.00, output: 75.00 },
  // Google
  "gemini-2.5-flash":  { input: 0.075, output: 0.30  },
  "gemini-2.5-pro":    { input: 1.25,  output: 10.00 },
  // Ollama — coste 0 (local)
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = TOKEN_COST_USD[model];
  if (!pricing || inputTokens < 0 || outputTokens < 0) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// =========================
// 🔌 NODOS
// =========================

export const NODES: Record<string, NodeConfig> = {
  gpu5070: { url: "http://ai-5070.casa.lan", type: "ollama" },
  gpu4070: { url: "http://ai-gpu.casa.lan",  type: "ollama" },
  mac:     { url: "http://ai-mac.casa.lan",  type: "ollama" },
  claude:  { url: "https://api.anthropic.com",                 type: "anthropic" },
  gemini:  { url: "https://generativelanguage.googleapis.com", type: "google" },
  "llama-cluster": { url: "http://ai-5070.casa.lan:8080", type: "ollama" },
};

// =========================
// 🗺️ MODEL MAP BASE
// =========================

export const BASE_MODEL_MAP: Record<string, NodeEntry[]> = {
  auto: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "mac",     model: "qwen2.5-coder:1.5b" },
    { nodeName: "gemini",  model: "gemini-2.5-flash" },
    { nodeName: "claude",  model: "claude-sonnet-4-6" },
  ],
  fast: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "mac",     model: "qwen2.5-coder:1.5b" },
  ],
  reasoning: [
    { nodeName: "gpu4070", model: "deepseek-r1:14b" },
    { nodeName: "mac",     model: "deepseek-r1:14b" },
    { nodeName: "gemini",  model: "gemini-2.5-pro" },
    { nodeName: "claude",  model: "claude-opus-4-6" },
  ],
  "reasoning-large": [
    { nodeName: "llama-cluster", model: "DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf" },
    { nodeName: "gpu4070",       model: "deepseek-r1:14b" },
  ],
  "deepseek-coder": [
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "gpu5070", model: "deepseek-coder:6.7b-instruct-q4_K_M" },
  ],
  "mac-fast":        [{ nodeName: "mac",     model: "qwen2.5-coder:1.5b" }],
  "mac-reason":      [{ nodeName: "mac",     model: "deepseek-r1:14b" }],
  "mac-coder":       [{ nodeName: "mac",     model: "deepseek-coder-v2:16b" }],
  "gpu5070-fast":    [{ nodeName: "gpu5070", model: "qwen2.5-coder:7b" }],
  "gpu5070-reason":  [{ nodeName: "gpu5070", model: "deepseek-r1:14b" }],
  "gpu5070-coder":   [{ nodeName: "gpu5070", model: "deepseek-coder:6.7b-instruct-q4_K_M" }],
  "gpu4070-coder":   [{ nodeName: "gpu4070", model: "deepseek-coder-v2:16b" }],
  "gpu4070-reason":  [{ nodeName: "gpu4070", model: "deepseek-r1:14b" }],
  "claude-sonnet":   [{ nodeName: "claude",  model: "claude-sonnet-4-6" }],
  "claude-opus":     [{ nodeName: "claude",  model: "claude-opus-4-6" }],
  "gemini-flash":    [{ nodeName: "gemini",  model: "gemini-2.5-flash" }],
  "gemini-pro":      [{ nodeName: "gemini",  model: "gemini-2.5-pro" }],
};
