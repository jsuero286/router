from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
import httpx
import time
import hashlib
import json
import redis
from prometheus_client import Counter, Histogram, Gauge, generate_latest

app = FastAPI()


# =========================
# 📊 MÉTRICAS
# =========================
REQUEST_COUNT = Counter("llm_requests_total", "Total requests", ["model"])
REQUEST_LATENCY = Histogram("llm_latency_seconds", "Latency", ["model"])
CACHE_HITS = Counter("llm_cache_hits_total", "Cache hits")
ERROR_COUNT = Counter("llm_errors_total", "Errors")
NODE_SELECTED = Counter("llm_node_selected_total", "Node selection", ["node"])
NODE_LOAD = Gauge("llm_node_load", "Node load", ["node"])

CACHE_MISS = Counter("llm_cache_miss_total", "Cache miss")
REDIS_ERRORS = Counter("llm_redis_errors_total", "Redis errors")

# =========================
# 🔌 NODOS
# =========================
NODES = {
    "mac": "http://192.168.50.119:11434",
    "gpu5070": "http://192.168.50.79:11434",
    "gpu4070": "http://192.168.50.118:11434"
}

# 👇 TU CONFIG ORIGINAL (intacta)
MODEL_MAP = {
    "auto": [
        ("gpu5070", "qwen2.5-coder:7b"),
        ("gpu4070", "deepseek-coder-v2:16b"),
        ("mac", "qwen2.5-coder:1.5b"),
    ],
    "fast": [
        ("gpu5070", "qwen2.5-coder:7b"),
        ("mac", "qwen2.5-coder:1.5b"),
    ],
    "reasoning": [
        ("gpu4070", "deepseek-r1:14b"),
        ("mac", "deepseek-r1:14b"),
    ],
    "deepseek-coder": [
        ("gpu4070", "deepseek-coder-v2:16b"),
        ("gpu5070", "deepseek-coder:6.7b-instruct-q4_K_M"),
    ]
}

# =========================
# 🧠 CACHE
# =========================
CACHE = {}
CACHE_TTL = 300

r = redis.Redis(
    host="192.168.50.82",
    port=6379,
    password="hom795er",
    decode_responses=True,
    socket_timeout=2,
    socket_connect_timeout=2
)

def cache_key(messages, model):
    return hashlib.sha256(f"{model}:{json.dumps(messages)}".encode()).hexdigest()

def get_cache(messages, model):
    try:
        key = cache_key(messages, model)
        value = r.get(key)
        if value:
            CACHE_HITS.inc()
            return value
        else:
            CACHE_MISS.inc()
    except Exception as e:
        REDIS_ERRORS.inc()
        print("Redis error:", e)
    return None


def set_cache(messages, model, value):
    key = cache_key(messages, model)
    r.setex(key, CACHE_TTL, value)

""" def get_cache(messages, model):
    item = CACHE.get(cache_key(messages, model))
    if item and (time.time() - item["time"] < CACHE_TTL):
        CACHE_HITS.inc()
        return item["value"]
    return None

def set_cache(messages, model, value):
    CACHE[cache_key(messages, model)] = {
        "value": value,
        "time": time.time()
    } """

# =========================
# ⚡ NODE LOAD
# =========================
async def node_load(node_url):
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            r = await client.get(f"{node_url}/api/tags")
            if r.status_code == 200:
                return 1
    except:
        return 999
    return 999

# =========================
# 🧠 ROUTING (FIXED)
# =========================
async def select_node(model):
    best_node = None
    best_model = None
    best_load = 999

    for entry in MODEL_MAP.get(model, []):
        node_name, real_model = entry

        url = NODES.get(node_name)
        if not url:
            continue

        load = await node_load(url)
        NODE_LOAD.labels(node=node_name).set(load)

        if load < best_load:
            best_node = node_name
            best_model = real_model
            best_load = load

    if not best_node:
        return None, None, None

    NODE_SELECTED.labels(node=best_node).inc()
    return NODES[best_node], best_node, best_model

# =========================
# 🔁 CALL OLLAMA
# =========================
async def call_ollama(node, model, messages):
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            f"{node}/api/chat",
            json={
                "model": model,
                "messages": messages,
                "stream": False
            }
        )

        try:
            return r.json()
        except:
            return {"error": r.text}

# =========================
# 🔁 STREAM OLLAMA
# =========================
async def stream_ollama(node, model, messages):
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            f"{node}/api/chat",
            json={
                "model": model,
                "messages": messages,
                "stream": True
            }
        ) as r:

            first = True

            async for line in r.aiter_lines():
                if not line:
                    continue

                try:
                    data = json.loads(line)
                except:
                    continue

                if "message" in data:
                    content = data["message"].get("content", "")

                    chunk = {
                        "id": "chatcmpl-local",
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model,
                        "system_fingerprint": "local-router",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": None
                            }
                        ]
                    }

                    if first:
                        chunk["choices"][0]["delta"]["role"] = "assistant"
                        first = False

                    if content:
                        chunk["choices"][0]["delta"]["content"] = content

                    yield f"data: {json.dumps(chunk)}\n\n"

                if data.get("done"):
                    yield f"data: {json.dumps({
                        'id': 'chatcmpl-local',
                        'object': 'chat.completion.chunk',
                        'created': int(time.time()),
                        'model': model,
                        'system_fingerprint': 'local-router',
                        'choices': [{
                            'index': 0,
                            'delta': {},
                            'finish_reason': None
                        }]
                    })}\n\n"

                    yield "data: [DONE]\n\n"
                    break

# =========================
# 🧠 OPENAI RESPONSE
# =========================
def openai_response(model, content):
    return {
        "id": f"chatcmpl-{int(time.time()*1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "system_fingerprint": "local-router",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content or ""
                },
                "finish_reason": "stop"
            }
        ],
        "usage": {
            "prompt_tokens": 1,
            "completion_tokens": 1,
            "total_tokens": 2
        }
    }

# =========================
# 🔥 CHAT HANDLER (FIXED)
# =========================
async def handle_chat(data):
    model = data.get("model", "auto")
    messages = data.get("messages", [])
    stream = data.get("stream", False)
    start = time.time()


    if not messages:
        return JSONResponse({
            "error": {
                "message": "messages required",
                "type": "invalid_request_error"
            }
        }, status_code=400)

    cached = get_cache(messages, model)
    if cached and not stream:
        return JSONResponse(openai_response(model, cached))

    node, node_name, real_model = await select_node(model)

    if not node:
        return JSONResponse({"error": "No nodes available"}, status_code=500)

    if not real_model:
        return JSONResponse({"error": "No model resolved"}, status_code=500)

    print(f"[ROUTER] {model} → {real_model} @ {node_name}")

    if stream:
        return StreamingResponse(
            stream_ollama(node, real_model, messages),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )

    result = await call_ollama(node, real_model, messages)

    latency = time.time() - start
    REQUEST_LATENCY.labels(model=real_model).observe(latency)

    if "error" in result:
        return JSONResponse(result, status_code=500)

    content = result.get("message", {}).get("content", "")

    if not content.strip():
        ERROR_COUNT.inc()
        content = "[ERROR] empty model response"

    set_cache(messages, model, content)

    return JSONResponse(openai_response(model, content))

# =========================
# 🔥 ENDPOINTS
# =========================
@app.post("/v1/chat/completions")
async def chat_v1(request: Request):
    data = await request.json()
    return await handle_chat(data)

@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {"id": "auto", "object": "model", "owned_by": "local"},
            {"id": "fast", "object": "model", "owned_by": "local"},
            {"id": "reasoning", "object": "model", "owned_by": "local"},
            {"id": "deepseek-coder", "object": "model", "owned_by": "local"}
        ]
    }

# =========================
# 📊 METRICS
# =========================
@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type="text/plain")