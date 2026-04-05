import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import Redis from "ioredis";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// =========================
// 🔑 API KEYS (via entorno)
// =========================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";
const SKILLS_DIR = process.env.SKILLS_DIR ?? path.join(process.cwd(), "skills");

// =========================
// 🔧 TYPES
// =========================

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
}

interface OllamaResponse {
  message?: { content: string };
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface NodeEntry {
  nodeName: string;
  model: string;
}

type NodeType = "ollama" | "anthropic" | "google";

interface NodeConfig {
  url: string;
  type: NodeType;
}

// =========================
// 📊 MÉTRICAS
// =========================

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const REQUEST_COUNT = new Counter({
  name: "llm_requests_total",
  help: "Total requests",
  labelNames: ["model"] as const,
  registers: [registry],
});

const REQUEST_LATENCY = new Histogram({
  name: "llm_latency_seconds",
  help: "Latency",
  labelNames: ["model"] as const,
  registers: [registry],
});

const CACHE_HITS = new Counter({
  name: "llm_cache_hits_total",
  help: "Cache hits",
  registers: [registry],
});

const CACHE_MISS = new Counter({
  name: "llm_cache_miss_total",
  help: "Cache miss",
  registers: [registry],
});

const ERROR_COUNT = new Counter({
  name: "llm_errors_total",
  help: "Errors",
  registers: [registry],
});

const NODE_SELECTED = new Counter({
  name: "llm_node_selected_total",
  help: "Node selection",
  labelNames: ["node"] as const,
  registers: [registry],
});

const NODE_LOAD = new Gauge({
  name: "llm_node_load",
  help: "Node load",
  labelNames: ["node"] as const,
  registers: [registry],
});

const REDIS_ERRORS = new Counter({
  name: "llm_redis_errors_total",
  help: "Redis errors",
  registers: [registry],
});

// =========================
// 🔌 NODOS
// =========================

const NODES: Record<string, NodeConfig> = {
  gpu5070: { url: "http://ai-5070.casa.lan", type: "ollama" },
  gpu4070: { url: "http://ai-gpu.casa.lan",  type: "ollama" },
  mac:     { url: "http://ai-mac.casa.lan",  type: "ollama" },
  claude:  { url: "https://api.anthropic.com",                 type: "anthropic" },
  gemini:  { url: "https://generativelanguage.googleapis.com", type: "google" },
};

// =========================
// 🗺️ MODEL MAP BASE
// =========================

const BASE_MODEL_MAP: Record<string, NodeEntry[]> = {
  // ── AUTOMÁTICOS ─────────────────────────────────────────────
  auto: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "mac",     model: "qwen2.5-coder:1.5b" },
    { nodeName: "gemini",  model: "gemini-2.5-flash" },
    { nodeName: "claude",  model: "claude-sonnet-4-5" },
  ],
  fast: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "mac",     model: "qwen2.5-coder:1.5b" },
  ],
  reasoning: [
    { nodeName: "gpu4070", model: "deepseek-r1:14b" },
    { nodeName: "mac",     model: "deepseek-r1:14b" },
    { nodeName: "gemini",  model: "gemini-2.5-pro" },
    { nodeName: "claude",  model: "claude-opus-4-5" },
  ],
  "deepseek-coder": [
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "gpu5070", model: "deepseek-coder:6.7b-instruct-q4_K_M" },
  ],
  // ── NODOS ESPECÍFICOS ────────────────────────────────────────
  "mac-fast": [
    { nodeName: "mac", model: "qwen2.5-coder:1.5b" },
  ],
  "mac-reason": [
    { nodeName: "mac", model: "deepseek-r1:14b" },
  ],
  "mac-coder": [
    { nodeName: "mac", model: "deepseek-coder-v2:16b" },
  ],
  "gpu5070-fast": [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
  ],
  "gpu5070-coder": [
    { nodeName: "gpu5070", model: "deepseek-coder:6.7b-instruct-q4_K_M" },
  ],
  "gpu4070-coder": [
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
  ],
  "gpu4070-reason": [
    { nodeName: "gpu4070", model: "deepseek-r1:14b" },
  ],
  // ── CLOUD DIRECTO ────────────────────────────────────────────
  "claude-sonnet": [
    { nodeName: "claude", model: "claude-sonnet-4-5" },
  ],
  "claude-opus": [
    { nodeName: "claude", model: "claude-opus-4-5" },
  ],
  "gemini-flash": [
    { nodeName: "gemini", model: "gemini-2.5-flash" },
  ],
  "gemini-pro": [
    { nodeName: "gemini", model: "gemini-2.5-pro" },
  ],
};

// =========================
// 🧠 SKILLS — carga dinámica
// Nodos con suficiente capacidad para seguir system prompts:
//   mac      → deepseek-r1:14b / deepseek-coder-v2:16b
//   gpu4070  → deepseek-r1:14b / deepseek-coder-v2:16b
//   gemini   → gemini-2.5-flash
//   claude   → claude-sonnet-4-5
// =========================

// Map de skills cargados: skillName → system prompt
const SKILLS: Record<string, string> = {};

// MODEL_MAP dinámico que se construye al arrancar
let MODEL_MAP: Record<string, NodeEntry[]> = { ...BASE_MODEL_MAP };

function loadSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log(`[SKILLS] Carpeta no encontrada: ${SKILLS_DIR} — skills desactivados`);
    return;
  }

  const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));

  if (files.length === 0) {
    console.log(`[SKILLS] No se encontraron ficheros .md en ${SKILLS_DIR}`);
    return;
  }

  for (const file of files) {
    const skillName = path.basename(file, ".md");
    const content = fs.readFileSync(path.join(SKILLS_DIR, file), "utf-8").trim();
    SKILLS[skillName] = content;

    // Crear entradas en MODEL_MAP para cada skill + nodo capaz
    MODEL_MAP[`${skillName}-mac`] = [
      { nodeName: "mac", model: "deepseek-coder-v2:16b" },
    ];
    MODEL_MAP[`${skillName}-4070`] = [
      { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    ];
    MODEL_MAP[`${skillName}-4070-reason`] = [
      { nodeName: "gpu4070", model: "deepseek-r1:14b" },
    ];
    MODEL_MAP[`${skillName}-gemini`] = [
      { nodeName: "gemini", model: "gemini-2.5-flash" },
    ];
    MODEL_MAP[`${skillName}-claude`] = [
      { nodeName: "claude", model: "claude-sonnet-4-5" },
    ];

    console.log(`[SKILLS] ✅ ${skillName} → mac, 4070, gemini, claude`);
  }
}

// Extrae el nombre del skill de un alias de modelo
// Ej: "angular-expert-gemini" → "angular-expert"
function extractSkill(modelAlias: string): string | null {
  for (const skillName of Object.keys(SKILLS)) {
    if (modelAlias.startsWith(skillName + "-") || modelAlias === skillName) {
      return skillName;
    }
  }
  return null;
}

// Inyecta el system prompt del skill en los mensajes
function injectSkill(messages: ChatMessage[], skillName: string): ChatMessage[] {
  const systemPrompt = SKILLS[skillName];
  if (!systemPrompt) return messages;

  // Si ya hay un system message, lo prepende al existente
  const hasSystem = messages.some((m) => m.role === "system");
  if (hasSystem) {
    return messages.map((m) =>
      m.role === "system"
        ? { ...m, content: `${systemPrompt}\n\n${m.content}` }
        : m
    );
  }

  // Si no hay system message, lo añade al principio
  return [{ role: "system", content: systemPrompt }, ...messages];
}

// =========================
// 🧠 REDIS CACHE
// =========================

const CACHE_TTL = 300;

const redis = new Redis({
  host: "192.168.50.82",
  port: 6379,
  password: "hom795er",
  connectTimeout: 2000,
  commandTimeout: 2000,
  lazyConnect: true,
});

redis.on("error", () => {});

function cacheKey(messages: ChatMessage[], model: string): string {
  const raw = `${model}:${JSON.stringify(messages)}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function getCache(messages: ChatMessage[], model: string): Promise<string | null> {
  try {
    const key = cacheKey(messages, model);
    const value = await redis.get(key);
    if (value) { CACHE_HITS.inc(); return value; }
    CACHE_MISS.inc();
    return null;
  } catch (e) {
    REDIS_ERRORS.inc();
    console.error("Redis error (get):", e);
    return null;
  }
}

async function setCache(messages: ChatMessage[], model: string, value: string): Promise<void> {
  try {
    const key = cacheKey(messages, model);
    await redis.setex(key, CACHE_TTL, value);
  } catch (e) {
    REDIS_ERRORS.inc();
    console.error("Redis error (set):", e);
  }
}

// =========================
// ⚡ NODE LOAD
// =========================

async function getNodeLoad(nodeConfig: NodeConfig): Promise<number> {
  if (nodeConfig.type !== "ollama") return 1;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${nodeConfig.url}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok ? 1 : 999;
  } catch {
    return 999;
  }
}

// =========================
// 🧠 ROUTING
// =========================

interface SelectedNode {
  nodeName: string;
  model: string;
  config: NodeConfig;
}

async function selectNode(modelAlias: string): Promise<SelectedNode | null> {
  const entries = MODEL_MAP[modelAlias];
  if (!entries || entries.length === 0) return null;

  const ollamaEntries = entries.filter((e) => NODES[e.nodeName]?.type === "ollama");
  const cloudEntries  = entries.filter((e) => NODES[e.nodeName]?.type !== "ollama");

  if (ollamaEntries.length > 0) {
    const loadResults = await Promise.all(
      ollamaEntries.map(async (entry) => {
        const config = NODES[entry.nodeName];
        if (!config) return { entry, config: null, load: 999 };
        const load = await getNodeLoad(config);
        NODE_LOAD.labels({ node: entry.nodeName }).set(load);
        return { entry, config, load };
      })
    );

    let bestNode: SelectedNode | null = null;
    let bestLoad = Infinity;
    for (const { entry, config, load } of loadResults) {
      if (config && load < bestLoad) {
        bestLoad = load;
        bestNode = { nodeName: entry.nodeName, model: entry.model, config };
      }
    }
    if (bestNode) {
      NODE_SELECTED.labels({ node: bestNode.nodeName }).inc();
      return bestNode;
    }
  }

  for (const entry of cloudEntries) {
    const config = NODES[entry.nodeName];
    if (!config) continue;
    if (config.type === "anthropic" && !ANTHROPIC_API_KEY) continue;
    if (config.type === "google" && !GOOGLE_API_KEY) continue;
    NODE_SELECTED.labels({ node: entry.nodeName }).inc();
    return { nodeName: entry.nodeName, model: entry.model, config };
  }

  return null;
}

// =========================
// 🔁 CALL OLLAMA (non-stream)
// =========================

async function callOllama(nodeUrl: string, model: string, messages: ChatMessage[]): Promise<OllamaResponse> {
  const res = await fetch(`${nodeUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text()}` };
  try {
    return (await res.json()) as OllamaResponse;
  } catch {
    return { error: "Invalid JSON from Ollama" };
  }
}

// =========================
// 🤖 CALL ANTHROPIC (non-stream)
// =========================

async function callAnthropic(model: string, messages: ChatMessage[]): Promise<OllamaResponse> {
  if (!ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not set" };
  const systemMsg = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, max_tokens: 8096, messages: userMessages };
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
    prompt_eval_count: data.usage?.input_tokens ?? -1,
    eval_count: data.usage?.output_tokens ?? -1,
  };
}

// =========================
// 🔵 CALL GOOGLE GEMINI (non-stream)
// =========================

async function callGoogle(model: string, messages: ChatMessage[]): Promise<OllamaResponse> {
  if (!GOOGLE_API_KEY) return { error: "GOOGLE_API_KEY not set" };
  const systemMsg = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const contents = userMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = { contents };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { error: `Google HTTP ${res.status}: ${await res.text()}` };
  const data = (await res.json()) as any;
  return {
    message: { content: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "" },
    done: true,
    prompt_eval_count: data.usageMetadata?.promptTokenCount ?? -1,
    eval_count: data.usageMetadata?.candidatesTokenCount ?? -1,
  };
}

// =========================
// 🔁 STREAM OLLAMA
// =========================

async function* streamOllama(nodeUrl: string, model: string, messages: ChatMessage[]): AsyncGenerator<string> {
  const res = await fetch(`${nodeUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.body) { yield `data: ${JSON.stringify({ error: "No response body" })}\n\n`; return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let isFirst = true;
  let promptTokens = -1;
  let completionTokens = -1;

  const baseChunk = () => ({
    id: "chatcmpl-local",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "local-router",
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
          const chunk = {
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content } : { content }, finish_reason: null }],
          };
          isFirst = false;
          if (content || isFirst) yield `data: ${JSON.stringify(chunk)}\n\n`;
        }
        if (data.done) {
          promptTokens = data.prompt_eval_count ?? -1;
          completionTokens = data.eval_count ?? -1;
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

// =========================
// 🔁 STREAM ANTHROPIC
// =========================

async function* streamAnthropic(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
  if (!ANTHROPIC_API_KEY) { yield `data: ${JSON.stringify({ error: "ANTHROPIC_API_KEY not set" })}\n\n`; return; }
  const systemMsg = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, max_tokens: 8096, messages: userMessages, stream: true };
  if (systemMsg) body.system = systemMsg;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
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

  const baseChunk = () => ({
    id: "chatcmpl-anthropic",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "anthropic-router",
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
        if (event.type === "message_start" && event.message?.usage) promptTokens = event.message.usage.input_tokens ?? -1;
        if (event.type === "message_delta" && event.usage) completionTokens = event.usage.output_tokens ?? -1;
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const content = event.delta.text ?? "";
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content } : { content }, finish_reason: null }],
          })}\n\n`;
          isFirst = false;
        }
        if (event.type === "message_stop") {
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

// =========================
// 🔁 STREAM GOOGLE GEMINI
// =========================

async function* streamGoogle(model: string, messages: ChatMessage[]): AsyncGenerator<string> {
  if (!GOOGLE_API_KEY) { yield `data: ${JSON.stringify({ error: "GOOGLE_API_KEY not set" })}\n\n`; return; }
  const systemMsg = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const contents = userMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = { contents };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg }] };
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

  const baseChunk = () => ({
    id: "chatcmpl-google",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "google-router",
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
          promptTokens = event.usageMetadata.promptTokenCount ?? -1;
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

// =========================
// 🧠 OPENAI RESPONSE FORMAT
// =========================

function openaiResponse(model: string, content: string, promptTokens = -1, completionTokens = -1) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "local-router",
    choices: [{ index: 0, message: { role: "assistant", content: content ?? "" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens >= 0 && completionTokens >= 0 ? promptTokens + completionTokens : -1,
    },
  };
}

// =========================
// 🔥 CHAT HANDLER
// =========================

async function handleChat(data: ChatRequest, reply: FastifyReply) {
  const model = data.model ?? "auto";
  let messages = data.messages ?? [];
  const stream = data.stream ?? false;

  if (messages.length === 0) {
    return reply.status(400).send({ error: { message: "messages required", type: "invalid_request_error" } });
  }

  REQUEST_COUNT.labels({ model }).inc();

  // Inyectar skill si el modelo lo requiere
  const skillName = extractSkill(model);
  if (skillName) {
    messages = injectSkill(messages, skillName);
    console.log(`[SKILL] Inyectando skill "${skillName}" en modelo "${model}"`);
  }

  if (!stream) {
    const cached = await getCache(messages, model);
    if (cached) return reply.send(openaiResponse(model, cached));
  }

  const selected = await selectNode(model);

  if (!selected) {
    ERROR_COUNT.inc();
    return reply.status(503).send({ error: "No nodes available" });
  }

  console.log(`[ROUTER] ${model} → ${selected.model} @ ${selected.nodeName} (${selected.config.type})`);

  // ── STREAM ──────────────────────────────────────────────────
  if (stream) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const generator =
      selected.config.type === "anthropic" ? streamAnthropic(selected.model, messages) :
      selected.config.type === "google"    ? streamGoogle(selected.model, messages) :
                                             streamOllama(selected.config.url, selected.model, messages);

    for await (const chunk of generator) reply.raw.write(chunk);
    reply.raw.end();
    return;
  }

  // ── NON-STREAM ───────────────────────────────────────────────
  const start = Date.now();

  const result =
    selected.config.type === "anthropic" ? await callAnthropic(selected.model, messages) :
    selected.config.type === "google"    ? await callGoogle(selected.model, messages) :
                                           await callOllama(selected.config.url, selected.model, messages);

  REQUEST_LATENCY.labels({ model: selected.model }).observe((Date.now() - start) / 1000);

  if (result.error) {
    ERROR_COUNT.inc();
    return reply.status(500).send({ error: result.error });
  }

  const content = result.message?.content ?? "";
  if (!content.trim()) {
    ERROR_COUNT.inc();
    return reply.status(502).send({ error: "Empty response from model" });
  }

  await setCache(messages, model, content);
  return reply.send(openaiResponse(model, content, result.prompt_eval_count ?? -1, result.eval_count ?? -1));
}

// =========================
// 🚀 FASTIFY SERVER
// =========================

const app = Fastify({ logger: true });

app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
  return handleChat(req.body as ChatRequest, reply);
});

app.get("/v1/models", async (_req, reply) => {
  return reply.send({
    object: "list",
    data: Object.keys(MODEL_MAP).map((id) => ({ id, object: "model", owned_by: "local" })),
  });
});

app.get("/v1", async (_req, reply) => {
  return reply.send({ status: "ok" });
});

app.get("/skills", async (_req, reply) => {
  return reply.send({
    skills: Object.keys(SKILLS).map((name) => ({
      name,
      models: [`${name}-mac`, `${name}-4070`, `${name}-4070-reason`, `${name}-gemini`, `${name}-claude`],
    })),
  });
});

app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", registry.contentType);
  return reply.send(await registry.metrics());
});

app.get("/health", async (_req, reply) => {
  const nodeChecks = await Promise.all(
    Object.entries(NODES).map(async ([name, config]) => ({
      name,
      type: config.type,
      online: config.type !== "ollama" ? true : (await getNodeLoad(config)) < 999,
    }))
  );
  return reply.send({ status: "ok", nodes: nodeChecks, skills: Object.keys(SKILLS) });
});

const PORT = parseInt(process.env.PORT ?? "8000", 10);

// Cargar skills antes de arrancar
loadSkills();

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  console.log(`🚀 Router running on http://0.0.0.0:${PORT}`);
  console.log(`   Anthropic: ${ANTHROPIC_API_KEY ? "✅ configurado" : "❌ ANTHROPIC_API_KEY no definida"}`);
  console.log(`   Google:    ${GOOGLE_API_KEY    ? "✅ configurado" : "❌ GOOGLE_API_KEY no definida"}`);
  console.log(`   Skills:    ${Object.keys(SKILLS).length > 0 ? Object.keys(SKILLS).join(", ") : "ninguno"}`);
});