import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import Redis from "ioredis";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// =========================
// 🔧 CONFIG & ENTORNO
// =========================

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY ?? "";
const GOOGLE_API_KEY     = process.env.GOOGLE_API_KEY ?? "";
const SKILLS_DIR         = process.env.SKILLS_DIR ?? path.join(process.cwd(), "skills");
const METRICS_ENABLED    = (process.env.METRICS_ENABLED ?? "true") === "true";
const PORT               = parseInt(process.env.PORT ?? "8000", 10);
const REDIS_HOST         = process.env.REDIS_HOST ?? "192.168.50.82";

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

type NodeType = "ollama" | "anthropic" | "google";

interface NodeConfig {
  url: string;
  type: NodeType;
}

interface NodeEntry {
  nodeName: string;
  model: string;
}

interface NodeHealthStatus {
  online: boolean;
  load: number;
  lastChecked: number;
}

interface SelectedNode {
  nodeName: string;
  model: string;
  config: NodeConfig;
}

// =========================
// 📊 MÉTRICAS (Encapsuladas)
// =========================

const registry = new Registry();
const Metrics = {
  requestCount: new Counter({ name: "llm_requests_total", help: "Total requests", labelNames: ["model"], registers: [registry] }),
  latency: new Histogram({ name: "llm_latency_seconds", help: "Latency", labelNames: ["model"], registers: [registry] }),
  cacheHits: new Counter({ name: "llm_cache_hits_total", help: "Cache hits", registers: [registry] }),
  cacheMiss: new Counter({ name: "llm_cache_miss_total", help: "Cache miss", registers: [registry] }),
  errors: new Counter({ name: "llm_errors_total", help: "Errors", registers: [registry] }),
  nodeSelected: new Counter({ name: "llm_node_selected_total", help: "Node selection", labelNames: ["node"], registers: [registry] }),
  nodeLoad: new Gauge({ name: "llm_node_load", help: "Node load", labelNames: ["node"], registers: [registry] }),
  tokensPerSec: new Histogram({
    name: "llm_tokens_per_second", help: "Tokens/sec", labelNames: ["model"],
    buckets: [1, 5, 10, 20, 30, 50, 100], registers: [registry]
  }),
};

if (METRICS_ENABLED) collectDefaultMetrics({ register: registry });

// =========================
// 🔌 NODOS & ESTADO DE SALUD
// =========================

const NODES: Record<string, NodeConfig> = {
  gpu5070: { url: "http://ai-5070.casa.lan", type: "ollama" },
  gpu4070: { url: "http://ai-gpu.casa.lan",  type: "ollama" },
  mac:      { url: "http://ai-mac.casa.lan",  type: "ollama" },
  claude:   { url: "https://api.anthropic.com",                  type: "anthropic" },
  gemini:   { url: "https://generativelanguage.googleapis.com", type: "google" },
};

const BASE_MODEL_MAP: Record<string, NodeEntry[]> = {
  auto: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "gpu4070", model: "deepseek-coder-v2:16b" },
    { nodeName: "mac",     model: "qwen2.5-coder:1.5b" },
    { nodeName: "gemini",  model: "gemini-2.0-flash" },
    { nodeName: "claude",  model: "claude-3-5-sonnet-latest" },
  ],
  fast: [
    { nodeName: "gpu5070", model: "qwen2.5-coder:7b" },
    { nodeName: "mac",     model: "qwen2.5-coder:1.5b" },
  ],
  reasoning: [
    { nodeName: "gpu4070", model: "deepseek-r1:14b" },
    { nodeName: "gemini",  model: "gemini-2.0-pro-exp-02-05" },
  ]
};

// Mapa dinámico de salud
const NODE_HEALTH: Record<string, NodeHealthStatus> = {};
Object.keys(NODES).forEach(name => {
  NODE_HEALTH[name] = { online: false, load: 999, lastChecked: 0 };
});

// =========================
// 🧠 SKILLS
// =========================

const SKILLS: Record<string, string> = {};
let MODEL_MAP: Record<string, NodeEntry[]> = { ...BASE_MODEL_MAP };

function loadSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) return;
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
  for (const file of files) {
    const skillName = path.basename(file, ".md");
    SKILLS[skillName] = fs.readFileSync(path.join(SKILLS_DIR, file), "utf-8").trim();
    MODEL_MAP[skillName] = [{ nodeName: "gpu4070", model: "deepseek-coder-v2:16b" }];
    console.log(`[SKILLS] ✅ Loaded: ${skillName}`);
  }
}

function injectSkill(messages: ChatMessage[], modelAlias: string): ChatMessage[] {
  const skillName = Object.keys(SKILLS).find(s => modelAlias.startsWith(s));
  if (!skillName) return messages;
  
  const prompt = SKILLS[skillName];
  const hasSystem = messages.some(m => m.role === "system");
  return hasSystem 
    ? messages.map(m => m.role === "system" ? { ...m, content: `${prompt}\n\n${m.content}` } : m)
    : [{ role: "system", content: prompt }, ...messages];
}

// =========================
// 🧠 CACHE (Redis + Memoria)
// =========================

const memCache = new Map<string, { v: string; e: number }>();
let redisAvailable = false;
const redis = new Redis({ host: REDIS_HOST, port: 6379, password: "hom795er", lazyConnect: true });

redis.on("connect", () => { redisAvailable = true; console.log("[CACHE] Redis OK"); });
redis.on("error", () => { redisAvailable = false; });

async function getCache(messages: ChatMessage[], model: string): Promise<string | null> {
  const key = crypto.createHash("sha256").update(`${model}:${JSON.stringify(messages)}`).digest("hex");
  if (redisAvailable) {
    const val = await redis.get(key).catch(() => null);
    if (val) { Metrics.cacheHits.inc(); return val; }
  }
  const mem = memCache.get(key);
  if (mem && mem.e > Date.now()) { Metrics.cacheHits.inc(); return mem.v; }
  Metrics.cacheMiss.inc();
  return null;
}

async function setCache(messages: ChatMessage[], model: string, value: string): Promise<void> {
  const key = crypto.createHash("sha256").update(`${model}:${JSON.stringify(messages)}`).digest("hex");
  if (redisAvailable) await redis.setex(key, 300, value).catch(() => { redisAvailable = false; });
  memCache.set(key, { v: value, e: Date.now() + 300000 });
}

// =========================
// ⚡ BACKGROUND HEALTH CHECK
// =========================

async function performHealthChecks() {
  const checks = Object.entries(NODES).map(async ([name, config]) => {
    if (config.type !== "ollama") {
      NODE_HEALTH[name] = { online: true, load: 1, lastChecked: Date.now() };
      return;
    }
    try {
      const start = Date.now();
      const res = await fetch(`${config.url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const online = res.ok;
      const latency = Date.now() - start;
      NODE_HEALTH[name] = { online, load: online ? latency : 999, lastChecked: Date.now() };
      Metrics.nodeLoad.labels({ node: name }).set(online ? 1 : 999);
    } catch {
      NODE_HEALTH[name] = { online: false, load: 999, lastChecked: Date.now() };
      Metrics.nodeLoad.labels({ node: name }).set(999);
    }
  });
  await Promise.all(checks);
}

// =========================
// 🧠 ROUTING (Sincrónico)
// =========================

function selectNodeSync(modelAlias: string): SelectedNode | null {
  const entries = MODEL_MAP[modelAlias] || [];
  const available = entries
    .filter(e => NODE_HEALTH[e.nodeName]?.online)
    .sort((a, b) => NODE_HEALTH[a.nodeName].load - NODE_HEALTH[b.nodeName].load);

  if (available.length === 0) return null;
  
  const best = available[0];
  Metrics.nodeSelected.labels({ node: best.nodeName }).inc();
  return { nodeName: best.nodeName, model: best.model, config: NODES[best.nodeName] };
}

// =========================
// 🤖 API CALLS (Simplified)
// =========================

async function* streamOllama(nodeUrl: string, model: string, messages: ChatMessage[]): AsyncGenerator<string> {
  const res = await fetch(`${nodeUrl}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ model, messages, stream: true }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    // Aquí podrías procesar el JSON de Ollama para convertirlo a formato OpenAI
    yield `data: ${chunk}\n\n`;
  }
}

// ... (Aquí irían callAnthropic, callGoogle, etc., similares a tu versión original pero usando interfaces)

// =========================
// 🔥 HANDLERS
// =========================

async function handleChat(req: ChatRequest, reply: FastifyReply) {
  const { model = "auto", messages = [], stream = false } = req;
  if (!messages.length) return reply.status(400).send({ error: "Messages required" });

  Metrics.requestCount.labels({ model }).inc();
  const finalMessages = injectSkill(messages, model);

  if (!stream) {
    const cached = await getCache(finalMessages, model);
    if (cached) return reply.send({ id: "cached", choices: [{ message: { content: cached } }] });
  }

  const selected = selectNodeSync(model);
  if (!selected) {
    Metrics.errors.inc();
    return reply.status(503).send({ error: "No nodes online" });
  }

  console.log(`[ROUTER] ${model} -> ${selected.nodeName}`);

  if (stream) {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    // Lógica de streaming simplificada
    const gen = streamOllama(selected.config.url, selected.model, finalMessages);
    for await (const chunk of gen) reply.raw.write(chunk);
    return reply.raw.end();
  }

  // Non-stream (Ejemplo simplificado para Ollama)
  const start = Date.now();
  const res = await fetch(`${selected.config.url}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ model: selected.model, messages: finalMessages, stream: false })
  });
  const data = await res.json() as OllamaResponse;
  
  Metrics.latency.labels({ model: selected.model }).observe((Date.now() - start) / 1000);
  
  const content = data.message?.content || "";
  await setCache(finalMessages, model, content);
  return reply.send({ choices: [{ message: { content } }] });
}

// =========================
// 🚀 SERVER START
// =========================

const app = Fastify({ logger: false });

app.post("/v1/chat/completions", (req, reply) => handleChat(req.body as ChatRequest, reply));
app.get("/health", async () => ({ status: "ok", nodes: NODE_HEALTH }));
app.get("/metrics", async (_, reply) => {
  reply.header("Content-Type", registry.contentType);
  return registry.metrics();
});

async function start() {
  loadSkills();
  console.log("🔍 Checking nodes...");
  await performHealthChecks();
  
  // Iniciar ciclo de salud cada 30s
  setInterval(performHealthChecks, 30_000);

  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`🚀 Router at http://localhost:${PORT}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
