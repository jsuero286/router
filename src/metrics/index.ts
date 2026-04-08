import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { METRICS_ENABLED } from "../config";

// =========================
// 📊 MÉTRICAS (configurables)
// =========================

export const registry = new Registry();

const noop = () => {};

export let REQUEST_COUNT_inc:       (labels: { model: string }) => void;
export let REQUEST_LATENCY_observe: (labels: { model: string }, value: number) => void;
export let CACHE_HITS_inc:          () => void;
export let CACHE_MISS_inc:          () => void;
export let ERROR_COUNT_inc:         () => void;
export let NODE_SELECTED_inc:       (labels: { node: string }) => void;
export let NODE_LOAD_set:           (labels: { node: string }, value: number) => void;
export let REDIS_ERRORS_inc:        () => void;
export let TOKENS_PER_SEC_observe:  (labels: { model: string }, value: number) => void;
export let COST_USD_inc:            (labels: { model: string }, value: number) => void;

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
