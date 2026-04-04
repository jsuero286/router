import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import Redis from "ioredis";
import * as crypto from "crypto";

// =========================
// 🔑 API KEYS (via entorno)
// =========================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";

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
  // Ollama — rutas internas via Traefik
  gpu5070: { url: "http://ai-5070.casa.lan", type: "ollama" },
  gpu4070: { url: "http://ai-gpu.casa.lan",  type: "ollama" },
  mac:     { url: "http://ai-mac.casa.lan",  type: "ollama" },
  // Proveedores cloud
  claude:  { url: "https://api.anthropic.com",                  type: "anthropic" },
  gemini:  { url: "https://generativelanguage.googleapis.com",  type: "google" },
};

// =========================
// 🗺️ MODEL MAP
// =========================

const MODEL_MAP: Record<string, NodeEntry[]> = {
  // ── auto: locales primero, Google segundo, Anthropic último ─
  auto: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "mac",     model: "qwen2.5-coder:1.5b" },
    { nodeName: "gemini",  model: "gemini-2.0-flash" },      // fallback 1
    { nodeName: "claude",  model: "claude-sonnet-4-5" },     // fallback 2
  ],
  // ── fast: solo locales rápidos ──────────────────────────────
  fast: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "mac",     model: "qwen2.5-coder:1.5b" },
  ],
  // ── reasoning: local + cloud como fallback ──────────────────
  reasoning: [
    { nodeName: "gpu4070", model: "deepseek-r1:14b" },
    { nodeName: "mac",     model: "deepseek-r1:14b" },
    { nodeName: "gemini",  model: "gemini-2.5-pro" },        // fallback 1
    { nodeName: "claude",  model: "claude-opus-4-5" },       // fallback 2
  ],
  // ── deepseek-coder: solo local ──────────────────────────────
  "deepseek-coder": [
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "gpu5070", model: "deepseek-coder:6.7b-instruct-q4_K_M" },
  ],
  // ── Claude directo ──────────────────────────────────────────
  "claude-sonnet": [
    { nodeName: "claude", model: "claude-sonnet-4-5" },
  ],
  "claude-opus": [
    { nodeName: "claude", model: "claude-opus-4-5" },
  ],
  // ── Google directo ───────────────────────────────────────────
  "gemini-flash": [
    { nodeName: "gemini", model: "gemini-2.0-flash" },
  ],
  "gemini-pro": [
    { nodeName: "gemini", model: "gemini-2.5-pro" },
  ],
};

// =========================
// 🧠 REDIS CACHE
// =========================

const CACHE_TTL = 300;

const redis = new Redis({
  host: "redis.casa.lan",
  port: 6379,
  password: "hom795er",
  connectTimeout: 2000,
  commandTimeout: 2000,
  lazyConnect: true,
});

redis.on("error", () => {
  // Silenciado — los errores se registran en métricas
});

function cacheKey(messages: ChatMessage[], model: string): string {
  const raw = `${model}:${JSON.stringify(messages)}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function getCache(messages: ChatMessage[], model: string): Promise<string | null> {
  try {
    const key = cacheKey(messages, model);
    const value = await redis.get(key);
    if (value) {
      CACHE_HITS.inc();
      return value;
    }
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
  // Los nodos cloud no tienen /api/tags — siempre disponibles
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
// Lógica:
//   1. Comprobar todos los nodos Ollama en paralelo
//   2. Si hay alguno online → elegir el de menor load
//   3. Si todos caídos → intentar cloud en orden (Google → Anthropic)
//   4. Saltar cloud si no tiene API key configurada
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

  // — Paso 1: Ollama en paralelo —
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

  // — Paso 2: Fallback cloud en orden —
  for (const entry of cloudEntries) {
    const config = NODES[entry.nodeName];
    if (!config) continue;

    if (config.type === "anthropic" && !ANTHROPIC_API_KEY) {
      console.warn("[ROUTER] Saltando Anthropic: ANTHROPIC_API_KEY no definida");
      continue;
    }
    if (config.type === "google" && !GOOGLE_API_KEY) {
      console.warn("[ROUTER] Saltando Google: GOOGLE_API_KEY no definida");
      continue;
    }

    NODE_SELECTED.labels({ node: entry.nodeName }).inc();
    return { nodeName: entry.nodeName, model: entry.model, config };
  }

  return null;
}

// =========================
// 🔁 CALL OLLAMA (non-stream)
// =========================

async function callOllama(
  nodeUrl: string,
  model: string,
  messages: ChatMessage[]
): Promise<OllamaResponse> {
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
  return { message: { content: data.content?.[0]?.text ?? "" }, done: true };
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
  return { message: { content: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "" }, done: true };
}

// =========================
// 🔁 STREAM OLLAMA
// =========================

async function* streamOllama(
  nodeUrl: string,
  model: string,
  messages: ChatMessage[]
): AsyncGenerator<string> {
  const res = await fetch(`${nodeUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.body) {
    yield `data: ${JSON.stringify({ error: "No response body" })}\n\n`;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let isFirst = true;

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
            choices: [{
              index: 0,
              delta: isFirst ? { role: "assistant", content } : { content },
              finish_reason: null,
            }],
          };
          isFirst = false;
          if (content || isFirst) yield `data: ${JSON.stringify(chunk)}\n\n`;
        }

        if (data.done) {
          yield `data: ${JSON.stringify({ ...baseChunk(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
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
  if (!ANTHROPIC_API_KEY) {
    yield `data: ${JSON.stringify({ error: "ANTHROPIC_API_KEY not set" })}\n\n`;
    return;
  }

  const systemMsg = messages.find((m) => m.role === "system")?.content;
  const userMessages = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, max_tokens: 8096, messages: userMessages, stream: true };
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

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const content = event.delta.text ?? "";
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content } : { content }, finish_reason: null }],
          })}\n\n`;
          isFirst = false;
        }

        if (event.type === "message_stop") {
          yield `data: ${JSON.stringify({ ...baseChunk(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
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
  if (!GOOGLE_API_KEY) {
    yield `data: ${JSON.stringify({ error: "GOOGLE_API_KEY not set" })}\n\n`;
    return;
  }

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

        const text = event.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (text) {
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content: text } : { content: text }, finish_reason: null }],
          })}\n\n`;
          isFirst = false;
        }

        if (event.candidates?.[0]?.finishReason === "STOP") {
          yield `data: ${JSON.stringify({ ...baseChunk(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
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

function openaiResponse(model: string, content: string) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "local-router",
    choices: [{ index: 0, message: { role: "assistant", content: content ?? "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
  };
}

// =========================
// 🔥 CHAT HANDLER
// =========================

async function handleChat(data: ChatRequest, reply: FastifyReply) {
  const model = data.model ?? "auto";
  const messages = data.messages ?? [];
  const stream = data.stream ?? false;

  if (messages.length === 0) {
    return reply.status(400).send({ error: { message: "messages required", type: "invalid_request_error" } });
  }

  REQUEST_COUNT.labels({ model }).inc();

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
  return reply.send(openaiResponse(model, content));
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
  return reply.send({ status: "ok", nodes: nodeChecks });
});

const PORT = parseInt(process.env.PORT ?? "8000", 10);

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  console.log(`🚀 Router running on http://0.0.0.0:${PORT}`);
  console.log(`   Anthropic: ${ANTHROPIC_API_KEY ? "✅ configurado" : "❌ ANTHROPIC_API_KEY no definida"}`);
  console.log(`   Google:    ${GOOGLE_API_KEY    ? "✅ configurado" : "❌ GOOGLE_API_KEY no definida"}`);
});