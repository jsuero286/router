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
interface ChatMessage { role: "user" | "assistant" | "system"; content: string; }
interface ChatRequest { model?: string; messages?: ChatMessage[]; stream?: boolean; }
interface OllamaResponse { message?: { content: string }; done?: boolean; error?: string; prompt_eval_count?: number; eval_count?: number; }
type NodeType = "ollama" | "anthropic" | "google";
interface NodeConfig { url: string; type: NodeType; }
interface NodeEntry { nodeName: string; model: string; }
interface NodeHealthStatus { online: boolean; load: number; lastChecked: number; }
interface SelectedNode { nodeName: string; model: string; config: NodeConfig; }

// =========================
// 📊 MÉTRICAS
// =========================
const registry = new Registry();
const Metrics = {
  requestCount: new Counter({ name: "llm_requests_total", help: "Total requests", labelNames: ["model"], registers: [registry] }),
  latency: new Histogram({ name: "llm_latency_seconds", help: "Latency", labelNames: ["model"], registers: [registry] }),
  nodeSelected: new Counter({ name: "llm_node_selected_total", help: "Node selection", labelNames: ["node"], registers: [registry] }),
  errors: new Counter({ name: "llm_errors_total", help: "Errors", registers: [registry] }),
};
if (METRICS_ENABLED) collectDefaultMetrics({ register: registry });

// =========================
// 🔌 NODOS & MAPA
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
  ],
  reasoning: [
    { nodeName: "gpu4070", model: "deepseek-r1:14b" },
    { nodeName: "gemini",  model: "gemini-2.0-pro-exp-02-05" },
  ]
};

const NODE_HEALTH: Record<string, NodeHealthStatus> = {};
Object.keys(NODES).forEach(name => { NODE_HEALTH[name] = { online: false, load: 999, lastChecked: 0 }; });

// =========================
// ⚡ HEALTH CHECK LOGIC
// =========================
async function performHealthChecks() {
  for (const [name, config] of Object.entries(NODES)) {
    if (config.type !== "ollama") {
      NODE_HEALTH[name] = { online: true, load: 1, lastChecked: Date.now() };
      continue;
    }
    try {
      const start = Date.now();
      const res = await fetch(`${config.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      NODE_HEALTH[name] = { online: res.ok, load: res.ok ? Date.now() - start : 999, lastChecked: Date.now() };
    } catch {
      NODE_HEALTH[name] = { online: false, load: 999, lastChecked: Date.now() };
    }
  }
}

function selectNodeSync(modelAlias: string): SelectedNode | null {
  const entries = BASE_MODEL_MAP[modelAlias] || BASE_MODEL_MAP["auto"];
  const ollama = entries.filter(e => NODES[e.nodeName].type === "ollama" && NODE_HEALTH[e.nodeName].online)
                        .sort((a, b) => NODE_HEALTH[a.nodeName].load - NODE_HEALTH[b.nodeName].load);
  
  const best = ollama.length > 0 ? ollama[0] : entries.find(e => NODE_HEALTH[e.nodeName].online);
  if (!best) return null;

  Metrics.nodeSelected.labels({ node: best.nodeName }).inc();
  return { nodeName: best.nodeName, model: best.model, config: NODES[best.nodeName] };
}

// =========================
// 🤖 API ADAPTERS (The missing part!)
// =========================

async function callProvider(node: SelectedNode, messages: ChatMessage[]): Promise<OllamaResponse> {
  if (node.config.type === "ollama") {
    const res = await fetch(`${node.config.url}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ model: node.model, messages, stream: false })
    });
    return await res.json() as OllamaResponse;
  }

  if (node.config.type === "google") {
    const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const res = await fetch(`${node.config.url}/v1beta/models/${node.model}:generateContent?key=${GOOGLE_API_KEY}`, {
      method: "POST",
      body: JSON.stringify({ contents })
    });
    const data = await res.json() as any;
    return { message: { content: data.candidates?.[0]?.content?.parts?.[0]?.text || "" } };
  }

  return { error: "Provider not implemented" };
}

// =========================
// 🔥 FASTIFY
// =========================
const app = Fastify({ logger: false });

app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
  const { model = "auto", messages = [] } = req.body as ChatRequest;
  
  const selected = selectNodeSync(model);
  if (!selected) return reply.status(503).send({ error: "No nodes available" });

  console.log(`[ROUTER] ${model} -> ${selected.nodeName}`);
  const start = Date.now();
  
  try {
    const result = await callProvider(selected, messages);
    Metrics.latency.labels({ model: selected.model }).observe((Date.now() - start) / 1000);
    
    return reply.send({
      id: `chat-${Date.now()}`,
      object: "chat.completion",
      model: selected.model,
      choices: [{ message: { role: "assistant", content: result.message?.content || "" }, finish_reason: "stop" }]
    });
  } catch (e) {
    return reply.status(500).send({ error: "Node communication error" });
  }
});

app.get("/health", async () => ({ status: "ok", nodes: NODE_HEALTH }));

async function start() {
  await performHealthChecks();
  setInterval(performHealthChecks, 20000);
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`🚀 Router Ready at port ${PORT}`);
}

start();
