import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import * as crypto from "crypto";
import {
  ROUTER_API_KEY, METRICS_ENABLED, CACHE_TTL, PORT,
  ANTHROPIC_API_KEY, ANTHROPIC_MAX_TOKENS, GOOGLE_API_KEY, REDIS_HOST, REDIS_PORT,
  OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX, CLASSIFIER_ENABLED, CLASSIFIER_MODEL, CLASSIFIER_NODE_URL,
  WARMUP_ON_START, CONVERSATION_TTL, CONVERSATION_MAX_TURNS, NODES,
  estimateCostUsd, COMPRESSION_MODE, COMPRESSION_MIN_TOKENS, COMPRESSION_RATIO,
  COMPRESSION_NODE_URL, COMPRESSION_MODEL,
} from "../config";
import { registry } from "../metrics";
import {
  REQUEST_COUNT_inc, REQUEST_LATENCY_observe, ERROR_COUNT_inc,
  NODE_SELECTED_inc, TOKENS_PER_SEC_observe, COST_USD_inc,
} from "../metrics";
import { getCache, setCache, isRedisAvailable, connectRedis } from "../cache";
import { SKILLS, MODEL_MAP, SKILL_CACHE_TTL, loadSkills, watchSkills, extractSkill, injectSkill, getSkillCacheTtl } from "../skills";
import { classifyComplexity, complexityToAlias } from "../classifier";
import { sessionId, getConversation, saveConversation, deleteConversation } from "../history";
import { selectCandidates, getNodeLoad } from "../nodes";
import { compressHistory } from "../compression";
import { callOllama, streamOllama, callAnthropic, streamAnthropic, callGoogle, streamGoogle } from "../providers";
import type { ChatRequest, ChatMessage, ConversationContext, GenerationOptions } from "../types";

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
// 📊 ACUMULADOR DE USO GLOBAL
// =========================

const globalUsage = {
  requests:        0,
  totalCostUsd:    0,
  tokensByModel:   {} as Record<string, { input: number; output: number }>,
  startedAt:       Date.now(),
};

export function trackUsage(model: string, inputTokens: number, completionTokens: number, costUsd: number): void {
  globalUsage.requests++;
  globalUsage.totalCostUsd += costUsd;
  if (!globalUsage.tokensByModel[model]) {
    globalUsage.tokensByModel[model] = { input: 0, output: 0 };
  }
  if (inputTokens > 0)      globalUsage.tokensByModel[model].input  += inputTokens;
  if (completionTokens > 0) globalUsage.tokensByModel[model].output += completionTokens;
}

// =========================
// 🔥 CHAT HANDLER
// =========================

async function handleChat(data: ChatRequest, reply: FastifyReply, req: FastifyRequest) {
  const model    = data.model ?? "auto";
  let messages   = data.messages ?? [];
  const stream   = data.stream ?? false;
  const opts: GenerationOptions = {
    ...(data.temperature != null ? { temperature: data.temperature } : {}),
    ...(data.top_p       != null ? { top_p:       data.top_p       } : {}),
    ...(data.max_tokens  != null ? { max_tokens:  data.max_tokens  } : {}),
  };

  if (messages.length === 0) {
    return reply.status(400).send({ error: { message: "messages required", type: "invalid_request_error" } });
  }

  REQUEST_COUNT_inc({ model });

  const apiKey = (req.headers["authorization"] ?? "").replace("Bearer ", "").trim();
  const sid    = sessionId(apiKey, req);
  const ctx: ConversationContext = (await getConversation(sid)) ?? {
    messages: [], model, skill: null, totalCostUsd: 0,
    createdAt: Date.now(), updatedAt: Date.now(), turns: 0,
  };

  const incomingUserMsgs = messages.filter((m) => m.role !== "system");
  const systemMsg        = messages.find((m) => m.role === "system");
  if (incomingUserMsgs.length > 0) {
    const lastIncoming = incomingUserMsgs[incomingUserMsgs.length - 1];
    const alreadyInHistory = ctx.messages.some(
      (m) => m.role === lastIncoming.role && m.content === lastIncoming.content
    );
    if (!alreadyInHistory) ctx.messages.push(...incomingUserMsgs);
  }

  messages = [
    ...(systemMsg ? [systemMsg] : []),
    ...ctx.messages.slice(-(CONVERSATION_MAX_TURNS * 2)),
  ];

  console.log(`[HISTORY] sid=${sid.slice(5, 13)}… turns=${ctx.turns} msgs=${ctx.messages.length}`);

  let resolvedModel = model;
  if (model === "auto") {
    const complexity  = await classifyComplexity(messages);
    resolvedModel     = complexityToAlias(complexity);
    if (resolvedModel !== "auto") {
      console.log(`[CLASSIFIER] "${model}" → "${resolvedModel}" (${complexity})`);
    }
  }

  const skillName = extractSkill(resolvedModel);
  if (skillName) {
    messages = injectSkill(messages, skillName);
    console.log(`[SKILL] Inyectando "${skillName}" en "${resolvedModel}"`);
  }

  // Comprimir historial si está activado (antes del cache lookup y del routing)
  messages = await compressHistory(messages);

  if (!stream) {
    const cached = await getCache(messages, resolvedModel);
    if (cached) return reply.send(openaiResponse(resolvedModel, cached));
  }

  const candidates = await selectCandidates(resolvedModel);
  if (candidates.length === 0) {
    ERROR_COUNT_inc();
    return reply.status(503).send({ error: "No nodes available" });
  }

  // ── STREAM con retry pre-headers ────────────────────────────
  if (stream) {
    // Probe rápido antes de abrir el stream para poder hacer retry
    async function probeNode(selected: (typeof candidates)[0]): Promise<boolean> {
      if (selected.config.type === "anthropic") return !!ANTHROPIC_API_KEY;
      if (selected.config.type === "google")    return !!GOOGLE_API_KEY;
      try {
        const res = await fetch(`${selected.config.url}/api/ps`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    let streamSelected: (typeof candidates)[0] | null = null;
    for (const candidate of candidates) {
      const alive = await probeNode(candidate);
      if (alive) {
        streamSelected = candidate;
        break;
      }
      console.warn(`[STREAM-RETRY] ${candidate.nodeName} no responde — probando siguiente`);
    }

    if (!streamSelected) {
      ERROR_COUNT_inc();
      return reply.status(503).send({ error: "No nodes available for streaming" });
    }

    NODE_SELECTED_inc({ node: streamSelected.nodeName });
    console.log(`[ROUTER] ${model} → ${streamSelected.model} @ ${streamSelected.nodeName} (stream)`);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const generator =
      streamSelected.config.type === "anthropic" ? streamAnthropic(streamSelected.model, messages, opts) :
      streamSelected.config.type === "google"    ? streamGoogle(streamSelected.model, messages, opts) :
                                                   streamOllama(streamSelected.config.url, streamSelected.model, messages, opts);
    for await (const chunk of generator) reply.raw.write(chunk);
    reply.raw.end();
    return;
  }

  // ── NON-STREAM con retry automático ─────────────────────────
  for (const selected of candidates) {
    console.log(`[ROUTER] ${model} → ${selected.model} @ ${selected.nodeName} (${selected.config.type})`);
    const start = Date.now();
    let result: import("../types").OllamaResponse;
    try {
      result =
        selected.config.type === "anthropic" ? await callAnthropic(selected.model, messages, opts) :
        selected.config.type === "google"    ? await callGoogle(selected.model, messages, opts) :
                                               await callOllama(selected.config.url, selected.model, messages, opts);
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

    NODE_SELECTED_inc({ node: selected.nodeName });
    const elapsedSec       = (Date.now() - start) / 1000;
    REQUEST_LATENCY_observe({ model: selected.model }, elapsedSec);

    const inputTokens      = result.prompt_eval_count ?? -1;
    const completionTokens = result.eval_count ?? -1;
    if (completionTokens > 0 && elapsedSec > 0) {
      TOKENS_PER_SEC_observe({ model: selected.model }, completionTokens / elapsedSec);
    }
    const cost = estimateCostUsd(selected.model, inputTokens, completionTokens);
    if (cost > 0) {
      COST_USD_inc({ model: selected.model }, cost);
      console.log(`[COST]  ${selected.model} ~$${cost.toFixed(6)}`);
    }
    trackUsage(selected.model, inputTokens, completionTokens, cost);

    await setCache(messages, resolvedModel, content, getSkillCacheTtl(skillName));

    ctx.messages.push({ role: "assistant", content });
    ctx.model        = selected.model;
    ctx.skill        = skillName;
    ctx.totalCostUsd += cost;
    ctx.updatedAt    = Date.now();
    ctx.turns       += 1;
    await saveConversation(sid, ctx);

    return reply.send({
      ...openaiResponse(resolvedModel, content, inputTokens, completionTokens),
      session_id: sid,
    });
  }

  ERROR_COUNT_inc();
  return reply.status(502).send({ error: "All nodes failed" });
}

// =========================
// 🚀 FASTIFY SERVER
// =========================

export const app = Fastify({ logger: true });

app.addHook("onRequest", async (req, reply) => {
  const publicRoutes = ["/health", "/metrics", "/v1", "/skills"];
  if (publicRoutes.includes(req.url)) return;
  const auth  = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const valid =
    token.length === ROUTER_API_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ROUTER_API_KEY));
  if (!valid) {
    return reply.status(401).send({
      error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" },
    });
  }
});

app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
  return handleChat(req.body as ChatRequest, reply, req);
});

app.get("/v1/models", async (_req, reply) => {
  return reply.send({
    object: "list",
    data: Object.keys(MODEL_MAP).map((id) => ({ id, object: "model", owned_by: "local" })),
  });
});

app.get("/v1", async (_req, reply) => reply.send({ status: "ok" }));

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

app.get("/v1/conversation", async (req: FastifyRequest, reply: FastifyReply) => {
  const apiKey = (req.headers["authorization"] ?? "").replace("Bearer ", "").trim();
  const sid    = sessionId(apiKey, req);
  const ctx    = await getConversation(sid);
  if (!ctx) return reply.send({ session_id: sid, turns: 0, messages: [] });
  return reply.send({ session_id: sid, ...ctx });
});

app.delete("/v1/conversation", async (req: FastifyRequest, reply: FastifyReply) => {
  const apiKey = (req.headers["authorization"] ?? "").replace("Bearer ", "").trim();
  const sid    = sessionId(apiKey, req);
  await deleteConversation(sid);
  console.log(`[HISTORY] Conversación eliminada: ${sid.slice(5, 13)}…`);
  return reply.send({ deleted: true, session_id: sid });
});

app.get("/v1/usage", async (_req, reply) => {
  const uptimeSec = Math.floor((Date.now() - globalUsage.startedAt) / 1000);
  return reply.send({
    uptime_seconds:   uptimeSec,
    requests:         globalUsage.requests,
    total_cost_usd:   parseFloat(globalUsage.totalCostUsd.toFixed(6)),
    tokens_by_model:  globalUsage.tokensByModel,
    started_at:       new Date(globalUsage.startedAt).toISOString(),
  });
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
    cache: isRedisAvailable() ? "redis" : "memory",
    metrics: METRICS_ENABLED,
  });
});

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
  const toWarm = new Map<string, { url: string; model: string }>();
  for (const [, entries] of Object.entries(MODEL_MAP)) {
    for (const entry of entries) {
      const config = NODES[entry.nodeName];
      if (!config || config.type !== "ollama") continue;
      const key = `${entry.nodeName}:${entry.model}`;
      if (!toWarm.has(key)) toWarm.set(key, { url: config.url, model: entry.model });
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

export async function startServer(): Promise<void> {
  await connectRedis();

  loadSkills();
  watchSkills();

  const shutdown = async (signal: string) => {
    console.log(`[SERVER] ${signal} recibido — cerrando conexiones...`);
    await app.close();
    console.log("[SERVER] Servidor cerrado correctamente");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
    if (err) { app.log.error(err); process.exit(1); }
    console.log(`🚀 Router running on http://0.0.0.0:${PORT}`);
    console.log(`   Anthropic: ${ANTHROPIC_API_KEY ? "✅ configurado" : "❌ no definida"} (max_tokens: ${ANTHROPIC_MAX_TOKENS})`);
    console.log(`   Google:    ${GOOGLE_API_KEY    ? "✅ configurado" : "❌ no definida"}`);
    console.log(`   Redis:     ${REDIS_HOST}:${REDIS_PORT}`);
    console.log(`   Cache TTL: ${CACHE_TTL}s (global)`);
    console.log(`   Métricas:  ${METRICS_ENABLED   ? "✅ activas"     : "❌ desactivadas"}`);
    console.log(`   Skills:    ${Object.keys(SKILLS).length > 0 ? Object.keys(SKILLS).join(", ") : "ninguno"}`);
    console.log(`   Keep-alive: ${OLLAMA_KEEP_ALIVE}${OLLAMA_NUM_CTX > 0 ? ` | ctx: ${OLLAMA_NUM_CTX}` : ""}`);
    console.log(`   Auth:       ✅ API key activa`);
    console.log(`   Classifier: ${CLASSIFIER_ENABLED ? `✅ ${CLASSIFIER_MODEL} @ ${CLASSIFIER_NODE_URL}` : "❌ desactivado (solo reglas)"}`);
    console.log(`   History:    TTL ${CONVERSATION_TTL}s, max ${CONVERSATION_MAX_TURNS} turnos (requiere Redis)`);
    console.log(`   Compression: ${COMPRESSION_MODE === "none" ? "❌ desactivada" : `✅ mode=${COMPRESSION_MODE}, model=${COMPRESSION_MODEL} @ ${COMPRESSION_NODE_URL}, min=${COMPRESSION_MIN_TOKENS} tokens, ratio=${COMPRESSION_RATIO}`}`);
    if (WARMUP_ON_START) {
      warmupAll().catch((e) => console.error("[WARMUP] Error inesperado:", e));
    }
  });
}
