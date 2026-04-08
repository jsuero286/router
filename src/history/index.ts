import * as crypto from "crypto";
import type { FastifyRequest } from "fastify";
import { CONVERSATION_TTL, CONVERSATION_MAX_TURNS } from "../config";
import { redis, isRedisAvailable } from "../cache";
import type { ChatMessage, ConversationContext, ChatRequest } from "../types";

// =========================
// 💬 HISTORIAL DE CONVERSACIÓN
// =========================

export { CONVERSATION_MAX_TURNS };

// Fallback en memoria cuando Redis no está disponible
const memHistory = new Map<string, { ctx: ConversationContext; expires: number }>();

function memHistoryGet(sid: string): ConversationContext | null {
  const entry = memHistory.get(sid);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    memHistory.delete(sid);
    return null;
  }
  return entry.ctx;
}

function memHistorySet(sid: string, ctx: ConversationContext, ttl: number): void {
  if (memHistory.size >= 100) {
    const firstKey = memHistory.keys().next().value;
    if (firstKey) memHistory.delete(firstKey);
  }
  memHistory.set(sid, { ctx, expires: Date.now() + ttl * 1000 });
}

function memHistoryDel(sid: string): void {
  memHistory.delete(sid);
}

export function sessionId(apiKey: string, req: FastifyRequest): string {
  // Solo apiKey + hint para que cambios de IP o User-Agent (VPN, mobile, actualizaciones)
  // no rompan la sesión. IP y UA solo se usan para logging.
  const hint = (req.body as ChatRequest)?.user ?? "";
  const raw = `${apiKey}:${hint}`;
  const sid = "conv:" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
  const ua = (req.headers["user-agent"] ?? "unknown").slice(0, 30);
  console.log(`[HISTORY] sid=${sid.slice(5, 13)}… ip=${ip} ua=${ua}`);
  return sid;
}

export async function getConversation(sid: string): Promise<ConversationContext | null> {
  if (isRedisAvailable()) {
    try {
      const raw = await redis.get(sid);
      if (!raw) return null;
      return JSON.parse(raw) as ConversationContext;
    } catch {
      return null;
    }
  }
  return memHistoryGet(sid);
}

export async function saveConversation(sid: string, ctx: ConversationContext): Promise<void> {
  if (isRedisAvailable()) {
    try {
      await redis.setex(sid, CONVERSATION_TTL, JSON.stringify(ctx));
      return;
    } catch (e) {
      console.warn("[HISTORY] Error guardando conversación en Redis — fallback a memoria:", e);
    }
  }
  memHistorySet(sid, ctx, CONVERSATION_TTL);
}

export async function deleteConversation(sid: string): Promise<void> {
  if (isRedisAvailable()) {
    try { await redis.del(sid); } catch {}
  }
  memHistoryDel(sid);
}
