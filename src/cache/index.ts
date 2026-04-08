import Redis from "ioredis";
import * as crypto from "crypto";
import { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, CACHE_TTL } from "../config";
import { CACHE_HITS_inc, CACHE_MISS_inc, REDIS_ERRORS_inc } from "../metrics";
import type { ChatMessage } from "../types";

// =========================
// 🧠 CACHE — Redis + fallback memoria
// =========================

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

function memCacheSet(key: string, value: string, ttl: number): void {
  if (memCache.size >= 200) {
    const firstKey = memCache.keys().next().value;
    if (firstKey) memCache.delete(firstKey);
  }
  memCache.set(key, { value, expires: Date.now() + ttl * 1000 });
}

let _redisAvailable = false;

export function isRedisAvailable(): boolean {
  return _redisAvailable;
}

export const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  connectTimeout: 2000,
  commandTimeout: 2000,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

redis.on("connect", () => {
  _redisAvailable = true;
  console.log("[CACHE] Redis conectado ✅");
});

redis.on("error", () => {
  if (_redisAvailable) {
    console.warn("[CACHE] Redis no disponible — usando cache en memoria");
  }
  _redisAvailable = false;
});

export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
  } catch {
    console.warn(`[CACHE] Redis no disponible en ${REDIS_HOST}:${REDIS_PORT} — operando con cache en memoria`);
  }
}

export function cacheKey(messages: ChatMessage[], model: string): string {
  const raw = `${model}:${JSON.stringify(messages)}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function getCache(messages: ChatMessage[], model: string): Promise<string | null> {
  const key = cacheKey(messages, model);

  if (_redisAvailable) {
    try {
      const value = await redis.get(key);
      if (value) { CACHE_HITS_inc(); return value; }
    } catch (e) {
      REDIS_ERRORS_inc();
      _redisAvailable = false;
      console.warn("[CACHE] Redis error en get — fallback a memoria:", e);
    }
  }

  const memValue = memCacheGet(key);
  if (memValue) { CACHE_HITS_inc(); return memValue; }

  CACHE_MISS_inc();
  return null;
}

export async function setCache(
  messages: ChatMessage[],
  model: string,
  value: string,
  ttl = CACHE_TTL,
): Promise<void> {
  const key = cacheKey(messages, model);

  if (_redisAvailable) {
    try {
      await redis.setex(key, ttl, value);
      return;
    } catch (e) {
      REDIS_ERRORS_inc();
      _redisAvailable = false;
      console.warn("[CACHE] Redis error en set — fallback a memoria:", e);
    }
  }

  memCacheSet(key, value, ttl);
}
