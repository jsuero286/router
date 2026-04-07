import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import Redis from "ioredis";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// =========================
// 🔧 CONFIG (via entorno)
// =========================

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY ?? "";
const GOOGLE_API_KEY     = process.env.GOOGLE_API_KEY ?? "";
const SKILLS_DIR         = process.env.SKILLS_DIR ?? path.join(process.cwd(), "skills");
const METRICS_ENABLED    = (process.env.METRICS_ENABLED ?? "true") === "true";
const REDIS_HOST         = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT         = parseInt(process.env.REDIS_PORT ?? "6379", 10);
const REDIS_PASSWORD     = process.env.REDIS_PASSWORD ?? undefined;
const CACHE_TTL          = parseInt(process.env.CACHE_TTL ?? "300", 10);
const OLLAMA_KEEP_ALIVE  = process.env.OLLAMA_KEEP_ALIVE ?? "1h";
const OLLAMA_NUM_CTX     = parseInt(process.env.OLLAMA_NUM_CTX ?? "0", 10); // 0 = usar default del modelo
const WARMUP_ON_START    = (process.env.WARMUP_ON_START ?? "true") === "true";

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
// 💰 COSTE ESTIMADO
// =========================

const TOKEN_COST_USD: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-sonnet-4-5": { input: 3.00,  output: 15.00 },
  "claude-opus-4-5":   { input: 15.00, output: 75.00 },
  // Google
  "gemini-2.5-flash":  { input: 0.075, output: 0.30  },
  "gemini-2.5-pro":    { input: 1.25,  output: 10.00 },
  // Ollama — coste 0 (local)
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = TOKEN_COST_USD[model];
  if (!pricing || inputTokens < 0 || outputTokens < 0) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// =========================
// 📊 MÉTRICAS (configurables)
// =========================

const registry = new Registry();

// Wrappers que no hacen nada si las métricas están desactivadas
const noop = () => {};
const noopObs = (_v: number) => {};

let REQUEST_COUNT_inc:       (labels: { model: string }) => void;
let REQUEST_LATENCY_observe: (labels: { model: string }, value: number) => void;
let CACHE_HITS_inc:          () => void;
let CACHE_MISS_inc:          () => void;
let ERROR_COUNT_inc:         () => void;
let NODE_SELECTED_inc:       (labels: { node: string }) => void;
let NODE_LOAD_set:           (labels: { node: string }, value: number) => void;
let REDIS_ERRORS_inc:        () => void;
let TOKENS_PER_SEC_observe:  (labels: { model: string }, value: number) => void;
let COST_USD_inc:            (labels: { model: string }, value: number) => void;

if (METRICS_ENABLED) {
  collectDefaultMetrics({ register: registry });

  const REQUEST_COUNT = new Counter({
    name: "llm_requests_total", help: "Total requests",
    labelNames: ["model"] as const, registers: [registry],
  });
  const REQUEST_LATENCY = new Histogram({
    name: "llm_latency_seconds", help: "Latency",
    labelNames: ["model"] as const, registers: [registry],
  });
  const CACHE_HITS = new Counter({
    name: "llm_cache_hits_total", help: "Cache hits", registers: [registry],
  });
  const CACHE_MISS = new Counter({
    name: "llm_cache_miss_total", help: "Cache miss", registers: [registry],
  });
  const ERROR_COUNT = new Counter({
    name: "llm_errors_total", help: "Errors", registers: [registry],
  });
  const NODE_SELECTED = new Counter({
    name: "llm_node_selected_total", help: "Node selection",
    labelNames: ["node"] as const, registers: [registry],
  });
  const NODE_LOAD = new Gauge({
    name: "llm_node_load", help: "Node load",
    labelNames: ["node"] as const, registers: [registry],
  });
  const REDIS_ERRORS = new Counter({
    name: "llm_redis_errors_total", help: "Redis errors", registers: [registry],
  });
  const TOKENS_PER_SEC = new Histogram({
    name: "llm_tokens_per_second", help: "Tokens generated per second",
    labelNames: ["model"] as const,
    buckets: [1, 5, 10, 20, 30, 50, 75, 100, 150, 200],
    registers: [registry],
  });
  const COST_USD = new Counter({
    name: "llm_cost_usd_total", help: "Estimated cost in USD",
    labelNames: ["model"] as const, registers: [registry],
  });

  REQUEST_COUNT_inc       = (l) => REQUEST_COUNT.labels(l).inc();
  REQUEST_LATENCY_observe = (l, v) => REQUEST_LATENCY.labels(l).observe(v);
  CACHE_HITS_inc          = () => CACHE_HITS.inc();
  CACHE_MISS_inc          = () => CACHE_MISS.inc();
  ERROR_COUNT_inc         = () => ERROR_COUNT.inc();
  NODE_SELECTED_inc       = (l) => NODE_SELECTED.labels(l).inc();
  NODE_LOAD_set           = (l, v) => NODE_LOAD.labels(l).set(v);
  REDIS_ERRORS_inc        = () => REDIS_ERRORS.inc();
  TOKENS_PER_SEC_observe  = (l, v) => TOKENS_PER_SEC.labels(l).observe(v);
  COST_USD_inc            = (l, v) => COST_USD.labels(l).inc(v);
} else {
  REQUEST_COUNT_inc       = noop;
  REQUEST_LATENCY_observe = noop;
  CACHE_HITS_inc          = noop;
  CACHE_MISS_inc          = noop;
  ERROR_COUNT_inc         = noop;
  NODE_SELECTED_inc       = noop;
  NODE_LOAD_set           = noop;
  REDIS_ERRORS_inc        = noop;
  TOKENS_PER_SEC_observe  = noop;
  COST_USD_inc            = noop;
}

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
  "mac-fast":        [{ nodeName: "mac",     model: "qwen2.5-coder:1.5b" }],
  "mac-reason":      [{ nodeName: "mac",     model: "deepseek-r1:14b" }],
  "mac-coder":       [{ nodeName: "mac",     model: "deepseek-coder-v2:16b" }],
  "gpu5070-fast":    [{ nodeName: "gpu5070", model: "qwen2.5-coder:7b" }],
  "gpu5070-coder":   [{ nodeName: "gpu5070", model: "deepseek-coder:6.7b-instruct-q4_K_M" }],
  "gpu4070-coder":   [{ nodeName: "gpu4070", model: "deepseek-coder-v2:16b" }],
  "gpu4070-reason":  [{ nodeName: "gpu4070", model: "deepseek-r1:14b" }],
  "claude-sonnet":   [{ nodeName: "claude",  model: "claude-sonnet-4-5" }],
  "claude-opus":     [{ nodeName: "claude",  model: "claude-opus-4-5" }],
  "gemini-flash":    [{ nodeName: "gemini",  model: "gemini-2.5-flash" }],
  "gemini-pro":      [{ nodeName: "gemini",  model: "gemini-2.5-pro" }],
};

// =========================
// 🧠 SKILLS — carga dinámica con frontmatter YAML
// =========================

interface SkillFrontmatter {
  preferred_node?: string;   // e.g. "gpu5070"
  preferred_model?: string;  // e.g. "qwen2.5-coder:7b"
  fallback_node?: string;    // e.g. "gpu4070"
  fallback_model?: string;   // e.g. "deepseek-coder-v2:16b"
  cloud_fallback?: string;   // alias del MODEL_MAP: "gemini-flash" | "claude-sonnet" | ...
  cache_ttl?: number;        // segundos, sobreescribe CACHE_TTL global
}

interface SkillEntry {
  prompt: string;
  frontmatter: SkillFrontmatter;
}

const SKILLS: Record<string, SkillEntry> = {};
let MODEL_MAP: Record<string, NodeEntry[]> = { ...BASE_MODEL_MAP };

// TTL por skill (sobreescribe el global si el frontmatter lo define)
const SKILL_CACHE_TTL: Record<string, number> = {};

function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const fm: SkillFrontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const k = key.trim() as keyof SkillFrontmatter;
    const v = rest.join(":").trim();
    if (k === "cache_ttl") {
      const n = parseInt(v, 10);
      if (!isNaN(n)) (fm as any)[k] = n;
    } else {
      (fm as any)[k] = v;
    }
  }
  return { frontmatter: fm, body: match[2].trim() };
}

function buildSkillModelMap(skillName: string, fm: SkillFrontmatter): void {
  // Ruta principal: nodo preferido del frontmatter o defaults
  const primaryNode   = fm.preferred_node  ?? "mac";
  const primaryModel  = fm.preferred_model ?? "deepseek-coder-v2:16b";
  const fallbackNode  = fm.fallback_node   ?? "gpu4070";
  const fallbackModel = fm.fallback_model  ?? "deepseek-coder-v2:16b";

  // Alias directo: usa la ruta preferida + fallback local + cloud
  const cloudAlias    = fm.cloud_fallback ?? "gemini-flash";
  const cloudEntries  = BASE_MODEL_MAP[cloudAlias] ?? BASE_MODEL_MAP["gemini-flash"] ?? [];

  MODEL_MAP[skillName] = [
    { nodeName: primaryNode,  model: primaryModel  },
    { nodeName: fallbackNode, model: fallbackModel },
    ...cloudEntries,
  ];

  // Aliases explícitos (retrocompatibles)
  MODEL_MAP[`${skillName}-mac`]         = [{ nodeName: "mac",     model: primaryModel }];
  MODEL_MAP[`${skillName}-4070`]        = [{ nodeName: "gpu4070", model: fallbackModel }];
  MODEL_MAP[`${skillName}-4070-reason`] = [{ nodeName: "gpu4070", model: "deepseek-r1:14b" }];
  MODEL_MAP[`${skillName}-gemini`]      = [{ nodeName: "gemini",  model: "gemini-2.5-flash" }];
  MODEL_MAP[`${skillName}-claude`]      = [{ nodeName: "claude",  model: "claude-sonnet-4-5" }];
}

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

  // Reset para hot-reload limpio
  MODEL_MAP = { ...BASE_MODEL_MAP };
  for (const key of Object.keys(SKILLS)) delete SKILLS[key];

  for (const file of files) {
    const skillName = path.basename(file, ".md");
    const raw = fs.readFileSync(path.join(SKILLS_DIR, file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    SKILLS[skillName] = { prompt: body, frontmatter };
    buildSkillModelMap(skillName, frontmatter);

    if (frontmatter.cache_ttl) {
      SKILL_CACHE_TTL[skillName] = frontmatter.cache_ttl;
    }

    const pNode  = frontmatter.preferred_node  ?? "mac (default)";
    const pModel = frontmatter.preferred_model ?? "deepseek-coder-v2:16b (default)";
    const cloud  = frontmatter.cloud_fallback  ?? "gemini-flash (default)";
    const ttl    = frontmatter.cache_ttl       ? `${frontmatter.cache_ttl}s` : `${CACHE_TTL}s (global)`;
    console.log(`[SKILLS] ✅ ${skillName} → ${pNode}/${pModel}, cloud: ${cloud}, ttl: ${ttl}`);
  }
}

function extractSkill(modelAlias: string): string | null {
  for (const skillName of Object.keys(SKILLS)) {
    if (modelAlias.startsWith(skillName + "-") || modelAlias === skillName) {
      return skillName;
    }
  }
  return null;
}

function injectSkill(messages: ChatMessage[], skillName: string): ChatMessage[] {
  const skill = SKILLS[skillName];
  if (!skill) return messages;
  const systemPrompt = skill.prompt;
  const hasSystem = messages.some((m) => m.role === "system");
  if (hasSystem) {
    return messages.map((m) =>
        m.role === "system" ? { ...m, content: `${systemPrompt}\n\n${m.content}` } : m
    );
  }
  return [{ role: "system", content: systemPrompt }, ...messages];
}

function getSkillCacheTtl(skillName: string | null): number {
  if (skillName && SKILL_CACHE_TTL[skillName]) return SKILL_CACHE_TTL[skillName];
  return CACHE_TTL;
}

// =========================
// 🧠 CACHE — Redis + fallback memoria
// =========================

// Cache en memoria como fallback
const memCache = new Map<string, { value: string; expires: number }>();

function memCacheGet(key: string): string | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    memCache.delete(key);
    return null;
  }
  return entry.value;
}

function memCacheSet(key: string, value: string): void {
  // Limitar tamaño del cache en memoria a 200 entradas
  if (memCache.size >= 200) {
    const firstKey = memCache.keys().next().value;
    if (firstKey) memCache.delete(firstKey);
  }
  memCache.set(key, { value, expires: Date.now() + CACHE_TTL * 1000 });
}

// Estado de Redis
let redisAvailable = false;

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  connectTimeout: 2000,
  commandTimeout: 2000,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

redis.on("connect", () => {
  redisAvailable = true;
  console.log("[CACHE] Redis conectado ✅");
});

redis.on("error", () => {
  if (redisAvailable) {
    console.warn("[CACHE] Redis no disponible — usando cache en memoria");
  }
  redisAvailable = false;
});

function cacheKey(messages: ChatMessage[], model: string): string {
  const raw = `${model}:${JSON.stringify(messages)}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function getCache(messages: ChatMessage[], model: string): Promise<string | null> {
  const key = cacheKey(messages, model);

  if (redisAvailable) {
    try {
      const value = await redis.get(key);
      if (value) { CACHE_HITS_inc(); return value; }
    } catch (e) {
      REDIS_ERRORS_inc();
      redisAvailable = false;
      console.warn("[CACHE] Redis error en get — fallback a memoria:", e);
    }
  }

  // Fallback a memoria
  const memValue = memCacheGet(key);
  if (memValue) { CACHE_HITS_inc(); return memValue; }

  CACHE_MISS_inc();
  return null;
}

async function setCache(messages: ChatMessage[], model: string, value: string, ttl = CACHE_TTL): Promise<void> {
  const key = cacheKey(messages, model);

  if (redisAvailable) {
    try {
      await redis.setex(key, ttl, value);
      return;
    } catch (e) {
      REDIS_ERRORS_inc();
      redisAvailable = false;
      console.warn("[CACHE] Redis error en set — fallback a memoria:", e);
    }
  }

  // Fallback a memoria (respeta ttl)
  memCache.set(key, { value, expires: Date.now() + ttl * 1000 });
}

// =========================
// ⚡ NODE LOAD
// =========================

interface OllamaPsModel {
  name: string;
  size_vram?: number;
  expires_at?: string;
}

interface OllamaPsResponse {
  models: OllamaPsModel[];
}

async function getNodeLoad(nodeConfig: NodeConfig): Promise<number> {
  if (nodeConfig.type !== "ollama") return 0;
  try {
    const res = await fetch(`${nodeConfig.url}/api/ps`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return 999;
    const data = (await res.json()) as OllamaPsResponse;
    // 0 = libre, 1+ = modelos activos en VRAM (ocupado)
    return data.models?.length ?? 0;
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

// Devuelve la lista de candidatos ordenada: primero ollama por carga, luego cloud
async function selectCandidates(modelAlias: string): Promise<SelectedNode[]> {
  const entries = MODEL_MAP[modelAlias];
  if (!entries || entries.length === 0) return [];

  const ollamaEntries = entries.filter((e) => NODES[e.nodeName]?.type === "ollama");
  const cloudEntries  = entries.filter((e) => NODES[e.nodeName]?.type !== "ollama");

  const candidates: SelectedNode[] = [];

  if (ollamaEntries.length > 0) {
    const loadResults = await Promise.all(
        ollamaEntries.map(async (entry) => {
          const config = NODES[entry.nodeName];
          if (!config) return { entry, config: null, load: 999 };
          const load = await getNodeLoad(config);
          NODE_LOAD_set({ node: entry.nodeName }, load);
          const status = load === 999 ? "❌ offline" : load === 0 ? "✅ libre" : `⚙️  ocupado (${load} modelo/s)`;
          console.log(`[LOAD]  ${entry.nodeName.padEnd(10)} ${status}`);
          return { entry, config, load };
        })
    );

    const available = loadResults
        .filter(({ load }) => load < 999)
        .sort((a, b) => a.load - b.load);

    if (available.length === 0) {
      console.warn("[ROUTING] Todos los nodos Ollama offline, escalando a cloud");
    }

    for (const { entry, config } of available) {
      if (config) candidates.push({ nodeName: entry.nodeName, model: entry.model, config });
    }
  }

  for (const entry of cloudEntries) {
    const config = NODES[entry.nodeName];
    if (!config) continue;
    if (config.type === "anthropic" && !ANTHROPIC_API_KEY) continue;
    if (config.type === "google" && !GOOGLE_API_KEY) continue;
    candidates.push({ nodeName: entry.nodeName, model: entry.model, config });
  }

  return candidates;
}

// Compat: devuelve el primer candidato (usado internamente si no se necesita retry)
async function selectNode(modelAlias: string): Promise<SelectedNode | null> {
  const candidates = await selectCandidates(modelAlias);
  if (candidates.length === 0) return null;
  NODE_SELECTED_inc({ node: candidates[0].nodeName });
  return candidates[0];
}

// =========================
// 🔁 CALL OLLAMA (non-stream)
// =========================

async function callOllama(nodeUrl: string, model: string, messages: ChatMessage[]): Promise<OllamaResponse> {
  const res = await fetch(`${nodeUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages, stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      ...(OLLAMA_NUM_CTX > 0 ? { options: { num_ctx: OLLAMA_NUM_CTX } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text()}` };
  try { return (await res.json()) as OllamaResponse; }
  catch { return { error: "Invalid JSON from Ollama" }; }
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
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
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
    body: JSON.stringify({
      model, messages, stream: true,
      keep_alive: OLLAMA_KEEP_ALIVE,
      ...(OLLAMA_NUM_CTX > 0 ? { options: { num_ctx: OLLAMA_NUM_CTX } } : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.body) { yield `data: ${JSON.stringify({ error: "No response body" })}\n\n`; return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let isFirst = true;
  let promptTokens = -1;
  let completionTokens = -1;
  const genStart = Date.now();

  const baseChunk = () => ({
    id: "chatcmpl-local", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, system_fingerprint: "local-router",
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
          yield `data: ${JSON.stringify({
            ...baseChunk(),
            choices: [{ index: 0, delta: isFirst ? { role: "assistant", content } : { content }, finish_reason: null }],
          })}\n\n`;
          isFirst = false;
        }
        if (data.done) {
          promptTokens = data.prompt_eval_count ?? -1;
          completionTokens = data.eval_count ?? -1;
          const elapsedSec = (Date.now() - genStart) / 1000;
          if (completionTokens > 0 && elapsedSec > 0) {
            TOKENS_PER_SEC_observe({ model }, completionTokens / elapsedSec);
          }
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
  const genStart = Date.now();

  const baseChunk = () => ({
    id: "chatcmpl-anthropic", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, system_fingerprint: "anthropic-router",
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
          const elapsedSec = (Date.now() - genStart) / 1000;
          if (completionTokens > 0 && elapsedSec > 0) {
            TOKENS_PER_SEC_observe({ model }, completionTokens / elapsedSec);
          }
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
  const genStart = Date.now();

  const baseChunk = () => ({
    id: "chatcmpl-google", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model, system_fingerprint: "google-router",
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
          const elapsedSec = (Date.now() - genStart) / 1000;
          if (completionTokens > 0 && elapsedSec > 0) {
            TOKENS_PER_SEC_observe({ model }, completionTokens / elapsedSec);
          }
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

  REQUEST_COUNT_inc({ model });

  // Inyectar skill si el modelo lo requiere
  const skillName = extractSkill(model);
  if (skillName) {
    messages = injectSkill(messages, skillName);
    console.log(`[SKILL] Inyectando "${skillName}" en "${model}"`);
  }

  if (!stream) {
    const cached = await getCache(messages, model);
    if (cached) return reply.send(openaiResponse(model, cached));
  }

  const candidates = await selectCandidates(model);
  if (candidates.length === 0) {
    ERROR_COUNT_inc();
    return reply.status(503).send({ error: "No nodes available" });
  }

  // ── STREAM (sin retry: los headers ya se enviaron) ───────────
  if (stream) {
    const selected = candidates[0];
    NODE_SELECTED_inc({ node: selected.nodeName });
    console.log(`[ROUTER] ${model} → ${selected.model} @ ${selected.nodeName} (stream)`);
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

  // ── NON-STREAM con retry automático ─────────────────────────
  for (const selected of candidates) {
    console.log(`[ROUTER] ${model} → ${selected.model} @ ${selected.nodeName} (${selected.config.type})`);
    const start = Date.now();
    let result: OllamaResponse;
    try {
      result =
          selected.config.type === "anthropic" ? await callAnthropic(selected.model, messages) :
              selected.config.type === "google"    ? await callGoogle(selected.model, messages) :
                  await callOllama(selected.config.url, selected.model, messages);
    } catch (err) {
      console.warn(`[RETRY] ${selected.nodeName} lanzó excepción: ${err} — probando siguiente`);
      continue;
    }

    if (result.error) {
      console.warn(`[RETRY] ${selected.nodeName} devolvió error: ${result.error} — probando siguiente`);
      continue;
    }

    const content = result.message?.content ?? "";
    if (!content.trim()) {
      console.warn(`[RETRY] ${selected.nodeName} devolvió respuesta vacía — probando siguiente`);
      continue;
    }

    // Éxito
    NODE_SELECTED_inc({ node: selected.nodeName });
    const elapsedSec = (Date.now() - start) / 1000;
    REQUEST_LATENCY_observe({ model: selected.model }, elapsedSec);

    const inputTokens     = result.prompt_eval_count ?? -1;
    const completionTokens = result.eval_count ?? -1;
    if (completionTokens > 0 && elapsedSec > 0) {
      TOKENS_PER_SEC_observe({ model: selected.model }, completionTokens / elapsedSec);
    }
    const cost = estimateCostUsd(selected.model, inputTokens, completionTokens);
    if (cost > 0) {
      COST_USD_inc({ model: selected.model }, cost);
      console.log(`[COST]  ${selected.model} ~$${cost.toFixed(6)}`);
    }

    await setCache(messages, model, content, getSkillCacheTtl(skillName));
    return reply.send(openaiResponse(model, content, inputTokens, completionTokens));
  }

  // Todos los candidatos fallaron
  ERROR_COUNT_inc();
  return reply.status(502).send({ error: "All nodes failed" });
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
    skills: Object.entries(SKILLS).map(([name, skill]) => ({
      name,
      frontmatter: skill.frontmatter,
      cache_ttl: SKILL_CACHE_TTL[name] ?? CACHE_TTL,
      models: [name, `${name}-mac`, `${name}-4070`, `${name}-4070-reason`, `${name}-gemini`, `${name}-claude`],
    })),
  });
});

app.get("/metrics", async (_req, reply) => {
  if (!METRICS_ENABLED) {
    return reply.status(404).send({ error: "Metrics disabled. Set METRICS_ENABLED=true to enable." });
  }
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
  return reply.send({
    status: "ok",
    nodes: nodeChecks,
    skills: Object.keys(SKILLS),
    cache: redisAvailable ? "redis" : "memory",
    metrics: METRICS_ENABLED,
  });
});

const PORT = parseInt(process.env.PORT ?? "8000", 10);

loadSkills();

// Hot-reload: recarga skills automáticamente al detectar cambios en el directorio
if (fs.existsSync(SKILLS_DIR)) {
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  fs.watch(SKILLS_DIR, (_event, filename) => {
    if (!filename?.endsWith(".md")) return;
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      console.log(`[SKILLS] Cambio detectado en "${filename}" — recargando skills...`);
      loadSkills();
      console.log(`[SKILLS] Skills recargadas: ${Object.keys(SKILLS).join(", ") || "ninguna"}`);
    }, 300); // debounce 300ms por si el editor escribe en varios pasos
  });
  console.log(`[SKILLS] 👀 Watching ${SKILLS_DIR}`);
}

// =========================
// 🔥 WARMUP
// =========================

async function warmupNode(nodeName: string, nodeUrl: string, model: string): Promise<void> {
  try {
    const res = await fetch(`${nodeUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: "", keep_alive: OLLAMA_KEEP_ALIVE }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      console.log(`[WARMUP] ✅ ${nodeName} → ${model} cargado en VRAM`);
    } else {
      console.warn(`[WARMUP] ⚠️  ${nodeName} → ${model} HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[WARMUP] ❌ ${nodeName} → ${model} no disponible: ${err}`);
  }
}

async function warmupAll(): Promise<void> {
  // Recoge el modelo principal de cada nodo Ollama mirando el alias "auto"
  // y los alias de nodo explícitos del MODEL_MAP
  const toWarm = new Map<string, { url: string; model: string }>();

  for (const [alias, entries] of Object.entries(MODEL_MAP)) {
    for (const entry of entries) {
      const config = NODES[entry.nodeName];
      if (!config || config.type !== "ollama") continue;
      const key = `${entry.nodeName}:${entry.model}`;
      if (!toWarm.has(key)) {
        toWarm.set(key, { url: config.url, model: entry.model });
      }
    }
  }

  console.log(`[WARMUP] Precalentando ${toWarm.size} modelo/s en nodos Ollama...`);
  await Promise.allSettled(
      [...toWarm.entries()].map(([key, { url, model }]) => {
        const nodeName = key.split(":")[0];
        return warmupNode(nodeName, url, model);
      })
  );
  console.log("[WARMUP] Completado");
}

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  console.log(`🚀 Router running on http://0.0.0.0:${PORT}`);
  console.log(`   Anthropic: ${ANTHROPIC_API_KEY ? "✅ configurado" : "❌ no definida"}`);
  console.log(`   Google:    ${GOOGLE_API_KEY    ? "✅ configurado" : "❌ no definida"}`);
  console.log(`   Redis:     ${REDIS_HOST}:${REDIS_PORT}`);
  console.log(`   Cache TTL: ${CACHE_TTL}s (global)`);
  console.log(`   Métricas:  ${METRICS_ENABLED   ? "✅ activas"     : "❌ desactivadas"}`);
  console.log(`   Skills:    ${Object.keys(SKILLS).length > 0 ? Object.keys(SKILLS).join(", ") : "ninguno"}`);
  console.log(`   Keep-alive: ${OLLAMA_KEEP_ALIVE}${OLLAMA_NUM_CTX > 0 ? ` | ctx: ${OLLAMA_NUM_CTX}` : ""}`);
  if (WARMUP_ON_START) {
    warmupAll().catch((e) => console.error("[WARMUP] Error inesperado:", e));
  }
});