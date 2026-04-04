import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import Redis from "ioredis";
import * as crypto from "crypto";

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

const NODES: Record<string, string> = {
  mac: "http://192.168.50.119:11434",
  gpu5070: "http://192.168.50.79:11434",
  gpu4070: "http://192.168.50.118:11434",
};

// Cada entrada: [nodeName, modelName]
const MODEL_MAP: Record<string, NodeEntry[]> = {
  auto: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "mac", model: "qwen2.5-coder:1.5b" },
  ],
  fast: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "mac", model: "qwen2.5-coder:1.5b" },
  ],
  reasoning: [
    { nodeName: "gpu4070", model: "deepseek-r1:14b" },
    { nodeName: "mac", model: "deepseek-r1:14b" },
  ],
  "deepseek-coder": [
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "gpu5070", model: "deepseek-coder:6.7b-instruct-q4_K_M" },
  ],
};

// =========================
// 🧠 REDIS CACHE
// =========================

const CACHE_TTL = 300; // segundos

// BUG FIX: en el Python original, si Redis falla en set_cache no se captura el error.
// Aquí lo manejamos correctamente con try/catch.
const redis = new Redis({
  host: "192.168.50.82",
  port: 6379,
  password: "hom795er",
  connectTimeout: 2000,
  commandTimeout: 2000,
  lazyConnect: true, // no crashea al arrancar si Redis no está disponible
});

redis.on("error", () => {
  // Silenciamos los eventos de error para que no maten el proceso
  // Los errores se registran en los contadores de métricas
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

// BUG FIX: en el Python original, la función devuelve implícitamente None (no 999)
// si el status no es 200 — aquí siempre devolvemos un número.
async function getNodeLoad(nodeUrl: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${nodeUrl}/api/tags`, { signal: controller.signal });
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
  url: string;
  nodeName: string;
  model: string;
}

async function selectNode(modelAlias: string): Promise<SelectedNode | null> {
  const entries = MODEL_MAP[modelAlias];
  if (!entries || entries.length === 0) return null;

  let bestNode: SelectedNode | null = null;
  let bestLoad = Infinity;

  // Comprobamos todos los nodos en paralelo para mayor velocidad
  const loadResults = await Promise.all(
    entries.map(async (entry) => {
      const url = NODES[entry.nodeName];
      if (!url) return { entry, load: 999 };
      const load = await getNodeLoad(url);
      NODE_LOAD.labels({ node: entry.nodeName }).set(load);
      return { entry, url, load };
    })
  );

  for (const { entry, url, load } of loadResults) {
    if (url && load < bestLoad) {
      bestLoad = load;
      bestNode = { url, nodeName: entry.nodeName, model: entry.model };
    }
  }

  if (!bestNode) return null;

  NODE_SELECTED.labels({ node: bestNode.nodeName }).inc();
  return bestNode;
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

  if (!res.ok) {
    return { error: `HTTP ${res.status}: ${await res.text()}` };
  }

  try {
    return (await res.json()) as OllamaResponse;
  } catch {
    return { error: "Invalid JSON from Ollama" };
  }
}

// =========================
// 🔁 STREAM OLLAMA
// =========================

// BUG FIX: en el Python original, el chunk final de "done" siempre tiene
// finish_reason: null — debería ser "stop". Aquí lo corregimos.
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
        try {
          data = JSON.parse(line) as OllamaResponse;
        } catch {
          continue;
        }

        if (data.message !== undefined) {
          const content = data.message?.content ?? "";
          const chunk = {
            ...baseChunk(),
            choices: [
              {
                index: 0,
                delta: isFirst
                  ? { role: "assistant", content }
                  : { content },
                finish_reason: null,
              },
            ],
          };
          isFirst = false;
          if (content || isFirst) {
            yield `data: ${JSON.stringify(chunk)}\n\n`;
          }
        }

        if (data.done) {
          // Chunk final con finish_reason correcto
          const doneChunk = {
            ...baseChunk(),
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          yield `data: ${JSON.stringify(doneChunk)}\n\n`;
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
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: content ?? "" },
        finish_reason: "stop",
      },
    ],
    // BUG FIX: el Python siempre devuelve usage con 1/1/2 tokens hardcodeado.
    // Aquí al menos reflejamos que no lo sabemos.
    usage: {
      prompt_tokens: -1,
      completion_tokens: -1,
      total_tokens: -1,
    },
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
    return reply.status(400).send({
      error: { message: "messages required", type: "invalid_request_error" },
    });
  }

  REQUEST_COUNT.labels({ model }).inc();

  // Cache solo para non-stream
  if (!stream) {
    const cached = await getCache(messages, model);
    if (cached) {
      return reply.send(openaiResponse(model, cached));
    }
  }

  const selected = await selectNode(model);

  if (!selected) {
    ERROR_COUNT.inc();
    return reply.status(503).send({ error: "No nodes available" });
  }

  console.log(`[ROUTER] ${model} → ${selected.model} @ ${selected.nodeName}`);

  if (stream) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    for await (const chunk of streamOllama(selected.url, selected.model, messages)) {
      reply.raw.write(chunk);
    }

    reply.raw.end();
    return;
  }

  const start = Date.now();
  const result = await callOllama(selected.url, selected.model, messages);
  const latency = (Date.now() - start) / 1000;
  REQUEST_LATENCY.labels({ model: selected.model }).observe(latency);

  if (result.error) {
    ERROR_COUNT.inc();
    return reply.status(500).send({ error: result.error });
  }

  const content = result.message?.content ?? "";

  if (!content.trim()) {
    ERROR_COUNT.inc();
    // BUG FIX: en el Python esto devuelve "[ERROR] empty model response" como contenido válido
    // con status 200 — aquí devolvemos un 502 más apropiado.
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
    data: Object.keys(MODEL_MAP).map((id) => ({
      id,
      object: "model",
      owned_by: "local",
    })),
  });
});

app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", registry.contentType);
  return reply.send(await registry.metrics());
});

app.get("/health", async (_req, reply) => {
  const nodeChecks = await Promise.all(
    Object.entries(NODES).map(async ([name, url]) => ({
      name,
      load: await getNodeLoad(url),
      online: (await getNodeLoad(url)) < 999,
    }))
  );
  return reply.send({ status: "ok", nodes: nodeChecks });
});

const PORT = parseInt(process.env.PORT ?? "8000", 10);

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Router running on http://0.0.0.0:${PORT}`);
});
