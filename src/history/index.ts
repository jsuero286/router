import * as crypto from "crypto";
import type { FastifyRequest } from "fastify";
import { CONVERSATION_TTL, CONVERSATION_MAX_TURNS } from "../config";
import { redis, isRedisAvailable } from "../cache";
import type { ChatMessage, ConversationContext, ChatRequest } from "../types";

// =========================
// 💬 HISTORIAL DE CONVERSACIÓN
// =========================

export { CONVERSATION_MAX_TURNS };

export function sessionId(apiKey: string, req: FastifyRequest): string {
  const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
  const ua = (req.headers["user-agent"] ?? "unknown").slice(0, 50);
  const hint = (req.body as ChatRequest)?.user ?? "";
  const raw = `${apiKey}:${ip}:${ua}:${hint}`;
  return "conv:" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export async function getConversation(sid: string): Promise<ConversationContext | null> {
  if (!isRedisAvailable()) return null;
  try {
    const raw = await redis.get(sid);
    if (!raw) return null;
    return JSON.parse(raw) as ConversationContext;
  } catch {
    return null;
  }
}

export async function saveConversation(sid: string, ctx: ConversationContext): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis.setex(sid, CONVERSATION_TTL, JSON.stringify(ctx));
  } catch (e) {
    console.warn("[HISTORY] Error guardando conversación:", e);
  }
}

export async function deleteConversation(sid: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try { await redis.del(sid); } catch {}
}
