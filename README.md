# 🧠 LLM Router

Router de carga para nodos Ollama con API compatible OpenAI, caché Redis y métricas Prometheus. Escrito en TypeScript con Fastify.

## ¿Qué hace?

Expone un endpoint `/v1/chat/completions` compatible con cualquier cliente OpenAI (Continue, LibreChat, Open WebUI...) y balancea las peticiones entre varios nodos Ollama según disponibilidad. Cada "modelo" virtual es un alias que mapea a un modelo real en el nodo más disponible en ese momento.

```
Cliente (Continue / LibreChat / curl)
        ↓
   LLM Router :8000
        ↓
  ┌─────┬─────┬──────┐
  mac  5070  4070   (nodos Ollama)
```

## Modelos disponibles

| Alias | Nodos / Modelos (por prioridad) |
|---|---|
| `auto` | gpu5070 → qwen2.5-coder:7b, gpu4070 → deepseek-coder-v2:16b, mac → qwen2.5-coder:1.5b |
| `fast` | gpu5070 → qwen2.5-coder:7b, mac → qwen2.5-coder:1.5b |
| `reasoning` | gpu4070 → deepseek-r1:14b, mac → deepseek-r1:14b |
| `deepseek-coder` | gpu4070 → deepseek-coder-v2:16b, gpu5070 → deepseek-coder:6.7b |

## Requisitos

- Node.js 22+
- Redis
- Al menos un nodo Ollama corriendo

## Instalación

```bash
git clone https://github.com/jsuero286/router
cd router
npm install
npm run build
npm start
```

Para desarrollo con recarga automática:

```bash
npm run dev
```

## Configuración

Edita directamente `src/router.ts` y ajusta:

```typescript
// Nodos Ollama disponibles
const NODES: Record<string, string> = {
  mac:     "http://ai-mac.casa.lan",
  gpu5070: "http://ai-5070.casa.lan",
  gpu4070: "http://ai-gpu.casa.lan",
};

// Redis
const redis = new Redis({
  host: "redis.casa.lan",
  port: 6379,
  password: "tu_password",
});
```

El puerto por defecto es `8000`, configurable con la variable de entorno `PORT`.

## Servicio systemd

```ini
[Unit]
Description=LLM Router
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/llm-router
ExecStart=/usr/bin/node dist/router.js
Restart=always
RestartSec=5
Environment=PORT=8000

[Install]
WantedBy=multi-user.target
```

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/v1/chat/completions` | Chat compatible OpenAI |
| GET | `/v1/models` | Lista de modelos disponibles |
| GET | `/health` | Estado de los nodos |
| GET | `/metrics` | Métricas Prometheus |

## Métricas Prometheus

| Métrica | Descripción |
|---|---|
| `llm_requests_total` | Total de peticiones por modelo |
| `llm_latency_seconds` | Latencia por modelo |
| `llm_cache_hits_total` | Aciertos de caché Redis |
| `llm_cache_miss_total` | Fallos de caché Redis |
| `llm_node_selected_total` | Peticiones enrutadas por nodo |
| `llm_node_load` | Carga actual de cada nodo |
| `llm_errors_total` | Errores totales |
| `llm_redis_errors_total` | Errores de Redis |

## Uso con Continue

En `~/.continue/config.json`:

```json
{
  "models": [
    {
      "title": "Auto",
      "provider": "openai",
      "model": "auto",
      "apiBase": "http://router.casa.lan/v1",
      "apiKey": "dummy"
    },
    {
      "title": "Reasoning",
      "provider": "openai",
      "model": "reasoning",
      "apiBase": "http://router.casa.lan/v1",
      "apiKey": "dummy"
    }
  ]
}
```

## Uso con curl

```bash
curl http://router.casa.lan/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hola"}]
  }'
```