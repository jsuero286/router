# 🧠 LLM Router

Router de carga para nodos Ollama, Anthropic y Google con API compatible OpenAI, caché Redis con fallback en memoria, skills dinámicos y métricas Prometheus. Escrito en TypeScript con Fastify.

## ¿Qué hace?

Expone un endpoint `/v1/chat/completions` compatible con cualquier cliente OpenAI (Aider, Open WebUI, Continue...) y balancea las peticiones entre nodos Ollama locales y proveedores cloud según disponibilidad. Cada "modelo" virtual es un alias que mapea a un modelo real en el nodo más disponible en ese momento.

```
Cliente (Aider / Open WebUI / curl)
              ↓
        LLM Router :8000
              ↓
  ┌──────┬──────┬──────┬────────┬────────┐
  mac   5070  4070  Anthropic  Google
```

## Modelos disponibles

### Automáticos (el router elige el nodo)

| Alias | Nodos / Modelos (por prioridad) |
|---|---|
| `auto` | gpu5070 → qwen2.5-coder:7b, gpu4070 → deepseek-coder-v2:16b, mac → qwen2.5-coder:1.5b, gemini-2.5-flash, claude-sonnet-4-5 |
| `fast` | gpu5070 → qwen2.5-coder:7b, mac → qwen2.5-coder:1.5b |
| `reasoning` | gpu4070 → deepseek-r1:14b, mac → deepseek-r1:14b, gemini-2.5-pro, claude-opus-4-5 |
| `deepseek-coder` | gpu4070 → deepseek-coder-v2:16b, gpu5070 → deepseek-coder:6.7b |

### Nodos específicos (tú eliges)

| Alias | Nodo | Modelo |
|---|---|---|
| `mac-fast` | mac | qwen2.5-coder:1.5b |
| `mac-reason` | mac | deepseek-r1:14b |
| `mac-coder` | mac | deepseek-coder-v2:16b |
| `gpu5070-fast` | gpu5070 | qwen2.5-coder:7b |
| `gpu5070-coder` | gpu5070 | deepseek-coder:6.7b |
| `gpu4070-coder` | gpu4070 | deepseek-coder-v2:16b |
| `gpu4070-reason` | gpu4070 | deepseek-r1:14b |

### Cloud directo

| Alias | Proveedor | Modelo |
|---|---|---|
| `claude-sonnet` | Anthropic | claude-sonnet-4-5 |
| `claude-opus` | Anthropic | claude-opus-4-5 |
| `gemini-flash` | Google | gemini-2.5-flash |
| `gemini-pro` | Google | gemini-2.5-pro |

### Skills (se generan automáticamente desde `/skills/*.md`)

Cada fichero `.md` en la carpeta `skills/` genera 5 modelos automáticamente:

| Alias | Nodo |
|---|---|
| `{skill}-mac` | mac → deepseek-coder-v2:16b |
| `{skill}-4070` | gpu4070 → deepseek-coder-v2:16b |
| `{skill}-4070-reason` | gpu4070 → deepseek-r1:14b |
| `{skill}-gemini` | gemini → gemini-2.5-flash |
| `{skill}-claude` | claude → claude-sonnet-4-5 |

Skills incluidos por defecto: `angular-expert`, `spring-expert`, `debug`, `refactor`, `web-design`.

Para añadir un skill nuevo basta con crear un `.md` en `skills/` y reiniciar el servicio.

## Requisitos

- Node.js 22+
- Redis (opcional — si no está disponible usa caché en memoria automáticamente)
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

Crea un fichero `.env` en la raíz del proyecto:

```bash
# Puerto del servidor
PORT=8000

# Autenticación — OBLIGATORIA, el router no arranca sin ella
# Genera un token con: openssl rand -hex 32
ROUTER_API_KEY=tu-token-aqui

# API Keys de proveedores cloud
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...

# Métricas Prometheus (true/false)
METRICS_ENABLED=true

# Carpeta de skills (por defecto: ./skills)
SKILLS_DIR=/opt/llm-router/skills

# Optimización de velocidad Ollama
OLLAMA_KEEP_ALIVE=1h     # tiempo que el modelo permanece en VRAM tras la última petición (-1 = siempre)
OLLAMA_NUM_CTX=0         # tamaño de contexto (0 = usa el default del modelo)
WARMUP_ON_START=true     # precalentar modelos en VRAM al arrancar el router

# Clasificador de complejidad (solo afecta al alias "auto")
CLASSIFIER_ENABLED=true
CLASSIFIER_NODE_URL=http://ai-mac.casa.lan  # nodo donde corre el clasificador
CLASSIFIER_MODEL=qwen2.5:0.5b              # modelo pequeño y rápido

# Historial de conversación (requiere Redis)
CONVERSATION_TTL=3600        # segundos hasta que expira una sesión inactiva
CONVERSATION_MAX_TURNS=50    # máximo de turnos guardados por sesión
```

Los nodos y modelos se configuran directamente en `src/router.ts`:

```typescript
const NODES: Record<string, NodeConfig> = {
  gpu5070: { url: "http://ai-5070.casa.lan", type: "ollama" },
  gpu4070: { url: "http://ai-gpu.casa.lan",  type: "ollama" },
  mac:     { url: "http://ai-mac.casa.lan",  type: "ollama" },
  claude:  { url: "https://api.anthropic.com",                 type: "anthropic" },
  gemini:  { url: "https://generativelanguage.googleapis.com", type: "google" },
};
```

## Autenticación

El router requiere autenticación mediante `Authorization: Bearer <token>` en todas las peticiones excepto `/health`, `/metrics`, `/skills` y `/v1` (rutas públicas para Prometheus y healthchecks).

Si `ROUTER_API_KEY` no está definida en el entorno, **el proceso no arranca**.

Genera un token seguro:

```bash
openssl rand -hex 32
```

### Aider

Añade `--openai-api-key` a tus aliases en `aliases/aliases.zsh`:

```bash
alias aider-auto="aider --openai-api-key tu-token --openai-api-base http://router.casa.lan/v1 --model openai/auto"
```

### Open WebUI

En **Settings → Admin → Connections → OpenAI API**, sustituye `none` por tu token en el campo API Key.

### curl

```bash
curl http://router.casa.lan/v1/chat/completions \
  -H "Authorization: Bearer tu-token" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hola"}]}'
```

## Routing por complejidad

Cuando se usa el alias `auto`, el router clasifica la complejidad de la petición antes de enrutarla:

| Complejidad | Alias resultante | Modelos |
|---|---|---|
| `simple` | `fast` | gpu5070 → qwen2.5-coder:7b, mac → qwen2.5-coder:1.5b |
| `medium` | `auto` | gpu5070 → gpu4070 → mac → gemini → claude |
| `complex` | `reasoning` | gpu4070 → deepseek-r1:14b, gemini-pro, claude-opus |

La clasificación funciona en dos pasos:

**1. Reglas rápidas (sin latencia):**
- Mensajes cortos sin keywords técnicos → `simple`
- Keywords de razonamiento (`refactor`, `arquitectura`, `debug`, `implementa`...) → `complex`
- Mensajes muy largos (>1500 chars) → `complex`
- Resto → dudoso, pasa al clasificador

**2. Modelo local (solo si el paso 1 no decide):**
- `qwen2.5:0.5b` en el nodo mac clasifica la query en <5s
- Si el clasificador falla, usa `medium` como fallback — nunca bloquea la petición

Para desactivar el modelo y usar solo reglas:
```bash
CLASSIFIER_ENABLED=false
```

## Optimización de velocidad (Ollama)

### Keep-alive — evitar cold starts

Por defecto Ollama descarga el modelo de VRAM si no recibe peticiones durante 5 minutos. El router envía `keep_alive` en cada llamada para mantenerlo cargado:

```bash
OLLAMA_KEEP_ALIVE=1h   # mantener 1 hora tras la última petición
OLLAMA_KEEP_ALIVE=-1   # nunca descargar (recomendado si tienes VRAM suficiente)
```

### Warmup al arrancar

Con `WARMUP_ON_START=true` (por defecto) el router envía una petición vacía a todos los nodos Ollama al arrancar, cargando los modelos en VRAM antes de que llegue la primera petición real. En los logs verás:

```
[WARMUP] Precalentando 6 modelo/s en nodos Ollama...
[WARMUP] ✅ gpu5070 → qwen2.5-coder:7b cargado en VRAM
[WARMUP] ✅ gpu4070 → deepseek-coder-v2:16b cargado en VRAM
[WARMUP] Completado
```

### Contexto (`OLLAMA_NUM_CTX`)

El tamaño de contexto afecta directamente a la velocidad y el uso de VRAM. Por defecto usa el valor del modelo, pero puedes reducirlo para respuestas más rápidas:

```bash
OLLAMA_NUM_CTX=4096   # suficiente para la mayoría de tareas de código
OLLAMA_NUM_CTX=8192   # para ficheros grandes con Aider
OLLAMA_NUM_CTX=0      # default del modelo (sin restricción)
```

### Variables de entorno en Ollama

Estas variables se configuran en el servicio de Ollama (no en el router):

```bash
OLLAMA_FLASH_ATTENTION=1   # reduce VRAM y mejora velocidad en contextos largos
OLLAMA_NUM_PARALLEL=2      # peticiones simultáneas por modelo (requiere más VRAM)
```

## Servicio systemd

```ini
[Unit]
Description=LLM Router
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/llm-router
EnvironmentFile=/opt/llm-router/.env
ExecStart=/usr/bin/node dist/router.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/v1/chat/completions` | ✅ | Chat compatible OpenAI |
| GET | `/v1/models` | ✅ | Lista de todos los modelos disponibles |
| GET | `/v1/conversation` | ✅ | Ver historial y contexto de la sesión |
| DELETE | `/v1/conversation` | ✅ | Borrar sesión y empezar de cero |
| GET | `/v1` | ❌ | Health check básico |
| GET | `/health` | ❌ | Estado de nodos, skills y caché |
| GET | `/skills` | ❌ | Lista de skills cargados y sus modelos |
| GET | `/metrics` | ❌ | Métricas Prometheus (si `METRICS_ENABLED=true`) |

## Caché

El router usa Redis como caché principal. Si Redis no está disponible, cambia automáticamente a caché en memoria (máx. 200 entradas, TTL 300s) sin interrumpir el servicio.

El endpoint `/health` muestra qué caché está activa:

```json
{ "cache": "redis" }   // Redis disponible
{ "cache": "memory" }  // Usando fallback en memoria
```

## Métricas Prometheus

| Métrica | Descripción |
|---|---|
| `llm_requests_total` | Total de peticiones por modelo |
| `llm_latency_seconds` | Latencia por modelo |
| `llm_tokens_per_second` | Tokens generados por segundo por modelo |
| `llm_cache_hits_total` | Aciertos de caché |
| `llm_cache_miss_total` | Fallos de caché |
| `llm_node_selected_total` | Peticiones enrutadas por nodo |
| `llm_node_load` | Carga actual de cada nodo |
| `llm_errors_total` | Errores totales |
| `llm_redis_errors_total` | Errores de Redis |
| `llm_cost_usd_total` | Coste estimado acumulado por modelo (cloud) |
| `llm_compression_runs_total` | Runs de compresión por modo y resultado |
| `llm_compression_ratio` | Ratio de reducción de tokens alcanzado |

---

## Dashboard Grafana

El fichero `grafana.json` en la raíz del proyecto contiene un dashboard preconfigurado con las siguientes secciones:

- **Resumen** — total peticiones, latencia media, cache hit rate, coste estimado, errores y errores Redis
- **Tráfico y latencia** — req/s por modelo + latencia p50/p95/p99
- **Nodos** — peticiones por nodo en el tiempo + gauge de carga en VRAM (verde=libre, rojo=OFFLINE)
- **Rendimiento de modelos** — tokens/segundo por modelo + distribución de peticiones
- **Coste y caché** — coste acumulado por modelo (USD) + hits vs misses
- **Detalle por modelo** — tabla resumen con peticiones, latencia, tok/s y coste

### Importar

1. En Grafana: **Dashboards → Import → Upload JSON file** → selecciona `grafana.json`
2. En el selector de datasource elige tu instancia de Prometheus
3. Importar

El dashboard se refresca cada 30 segundos y muestra por defecto las últimas 6 horas.

### Requisitos

- Prometheus raspando `/metrics` del router (`METRICS_ENABLED=true`)
- Datasource Prometheus configurado en Grafana apuntando a tu instancia

---

## Uso con Aider

### Instalación

**macOS / Linux:**

```bash
# Con pipx (recomendado)
brew install pipx      # macOS
pipx ensurepath
pipx install aider-chat

# Si tienes Python > 3.12 instala primero una versión compatible
brew install pyenv
pyenv install 3.11.9
pyenv global 3.11.9
pipx install aider-chat --python $(pyenv which python3)
```

### Configurar aliases

Los ficheros de aliases están en la carpeta `aliases/` del repo:

**ZSH:**
```bash
echo "source $(pwd)/aliases/aliases.zsh" >> ~/.zshrc
source ~/.zshrc
```

**Bash:**
```bash
echo "source $(pwd)/aliases/aliases.bash" >> ~/.bashrc
source ~/.bashrc
```

### Aliases disponibles

| Alias | Modelo | Cuándo usarlo |
|---|---|---|
| `aider-auto` | auto | Uso general, el router elige |
| `aider-fast` | fast | Preguntas rápidas, snippets simples |
| `aider-reason` | reasoning | Lógica compleja, arquitectura |
| `aider-mac` | mac-fast | Forzar mac, modelo pequeño |
| `aider-mac-coder` | mac-coder | Forzar mac, deepseek-coder 16b |
| `aider-mac-reason` | mac-reason | Forzar mac, deepseek-r1 |
| `aider-4070` | gpu4070-coder | GPU principal, deepseek-coder |
| `aider-4070-reason` | gpu4070-reason | GPU principal, deepseek-r1 |
| `aider-gemini` | gemini-flash | Google, rápido y gratuito |
| `aider-gemini-pro` | gemini-pro | Google, máxima calidad |
| `aider-claude` | claude-sonnet | Anthropic, mejor para código |
| `aider-claude-opus` | claude-opus | Anthropic, máxima calidad |
| `aider-angular` | angular-expert-gemini | Experto Angular 18 + SSR |
| `aider-angular-local` | angular-expert-4070 | Ídem, sin cloud |
| `aider-spring` | spring-expert-gemini | Experto Spring Boot |
| `aider-spring-local` | spring-expert-4070 | Ídem, sin cloud |
| `aider-debug` | debug-gemini | Análisis de errores y bugs |
| `aider-debug-local` | debug-4070 | Ídem, sin cloud |
| `aider-refactor` | refactor-gemini | Limpieza y mejora de código |
| `aider-refactor-local` | refactor-4070 | Ídem, sin cloud |
| `aider-web` | web-design-gemini | HTML/CSS/UX |
| `aider-web-local` | web-design-4070 | Ídem, sin cloud |

### Comandos útiles dentro de Aider

```bash
/add src/app/services/mi-servicio.ts    # añadir fichero al contexto
/add src/app/**/*.service.ts            # añadir varios ficheros
/ls                                      # ver ficheros en contexto
/drop mi-servicio.ts                    # quitar fichero del contexto
/diff                                   # ver cambios realizados
/undo                                   # deshacer último cambio
/model openai/gemini-flash              # cambiar modelo en mitad de sesión
```

### Flujo de trabajo recomendado

```bash
# 1. Entrar al proyecto
cd ~/proyectos/mi-app

# 2. Elegir el alias según la tarea
aider-angular       # para componentes Angular
aider-spring        # para servicios Spring Boot
aider-debug         # para analizar un error

# 3. Añadir los ficheros relevantes
/add src/app/services/autofirma.service.ts

# 4. Describir la tarea
"el método firmarDocumento no gestiona bien el error AI600101, revísalo"
```

### Nota sobre modelos pequeños

Los modelos pequeños (`fast`, `mac-fast`) no siguen bien el formato de edición de Aider. Si ves el error `The LLM did not conform to the edit format`, usa un modelo más capaz:

```bash
# En lugar de aider-auto, usa:
aider-4070          # local potente
aider-gemini        # cloud gratuito
aider-claude        # cloud máxima calidad

# O fuerza el modo de edición simple (más tokens, menos preciso):
aider-auto --edit-format whole
```

---

## Uso con Open WebUI

En **Settings → Admin → Connections → OpenAI API**:
- URL: `http://router.casa.lan/v1`
- API Key: `none`

---

## Historial de conversación

El router mantiene el contexto de conversación por sesión en Redis. La sesión se identifica automáticamente a partir de la API key, IP y User-Agent — no es necesario configurar nada en el cliente.

Cada sesión guarda:
- Historial de mensajes (hasta `CONVERSATION_MAX_TURNS` turnos)
- Modelo y skill utilizados en el último turno
- Coste acumulado estimado en USD
- Timestamps de creación y última actividad

Las sesiones expiran tras `CONVERSATION_TTL` segundos de inactividad (por defecto 1 hora).

Si Redis no está disponible, el historial se desactiva automáticamente — el router sigue funcionando sin él.

### Endpoints

```bash
# Ver historial y contexto de la sesión actual
curl http://router.casa.lan/v1/conversation \
  -H "Authorization: Bearer tu-token"

# Borrar la sesión y empezar de cero
curl -X DELETE http://router.casa.lan/v1/conversation \
  -H "Authorization: Bearer tu-token"
```

La respuesta de cada `/v1/chat/completions` incluye un campo `session_id` que identifica la sesión activa.

## Compresión de historial

El router incluye un pipeline de compresión configurable que reduce el tamaño del historial antes de enviarlo al modelo. Útil para conversaciones largas que superan el contexto o generan latencia innecesaria.

### Modos disponibles

| Modo | Descripción |
|---|---|
| `none` | Sin compresión (por defecto) |
| `history` | Resume los mensajes más antiguos usando un LLM pequeño |
| `llmlingua` | Comprime cada mensaje eliminando tokens poco relevantes con TinyBERT |
| `both` | Aplica `history` primero, luego `llmlingua` al resultado |

### Variables de entorno

```bash
# Modo de compresión
COMPRESSION_MODE=history        # none | history | llmlingua | both

# Umbral mínimo — no comprime si el historial es menor a N tokens estimados
COMPRESSION_MIN_TOKENS=500

# Ratio de compresión (0.5 = conservar el 50% de los tokens)
COMPRESSION_RATIO=0.5

# Nodo y backend para el modo history
COMPRESSION_NODE_URL=http://peque.casa.lan   # nodo con llama.cpp o Ollama
COMPRESSION_BACKEND=llamacpp                 # llamacpp | ollama
COMPRESSION_MODEL=qwen2.5:3b                # solo para backend ollama
```

### Modo `history`

Divide el historial en dos bloques: el **tail** (turnos recientes, se pasa íntegro) y el **head** (mensajes más antiguos, candidatos a compresión). El head se resume en un único mensaje de contexto usando el LLM configurado en `COMPRESSION_NODE_URL`.

El resumen se inyecta como mensaje de usuario con el prefijo `[Context from earlier in this conversation]:`.

Requiere un nodo con `llama.cpp server` o `Ollama` disponible. Si el nodo no responde, el pipeline hace fallback a los mensajes originales sin bloquear la petición.

```bash
# Con llama.cpp (recomendado para CPU puro)
COMPRESSION_BACKEND=llamacpp
COMPRESSION_NODE_URL=http://peque.casa.lan

# Con Ollama
COMPRESSION_BACKEND=ollama
COMPRESSION_NODE_URL=http://ai-mac.casa.lan
COMPRESSION_MODEL=qwen2.5:3b
```

### Modo `llmlingua`

Usa el modelo TinyBERT (`atjsh/llmlingua-2-js-tinybert-meetingbank`, 57 MB) para clasificar la relevancia de cada token en cada mensaje y eliminar los menos informativos. El modelo se descarga automáticamente de HuggingFace la primera vez y se cachea localmente.

Corre en el mismo proceso Node.js del router — no requiere ningún servicio externo.

El modelo se precarga en background al arrancar si `COMPRESSION_MODE=llmlingua` o `both`. Los logs de carga:

```
[COMPRESSION] llmlingua: cargando TinyBERT...
[COMPRESSION] llmlingua: ✅ TinyBERT cargado
```

**Nota de permisos:** el directorio de caché de HuggingFace debe tener permisos de escritura para el usuario del servicio:

```bash
chown -R nobody:nogroup /opt/llm-router/node_modules/@huggingface/transformers/
```

### Logs de compresión

```
[COMPRESSION] Skipped — 320 tokens < min 500
[COMPRESSION] history: resumiendo 6 msgs del head...
[COMPRESSION] history: 12 msgs → 5 msgs (~1800 → ~420 tokens)
[COMPRESSION] llmlingua: ~2016 → ~980 tokens
[COMPRESSION] history: nodo no disponible — skipping
```

### Métricas

| Métrica | Descripción |
|---|---|
| `llm_compression_runs_total{mode, result}` | Runs por modo y resultado (`ok`/`fallback`/`skipped`) |
| `llm_compression_ratio` | Histograma del ratio tokens_out/tokens_in por modo |



```bash
# Chat básico
curl http://router.casa.lan/v1/chat/completions \
  -H "Authorization: Bearer tu-token" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hola"}]}'

# Con skill
curl http://router.casa.lan/v1/chat/completions \
  -H "Authorization: Bearer tu-token" \
  -H "Content-Type: application/json" \
  -d '{"model": "angular-expert-gemini", "messages": [{"role": "user", "content": "Explícame los signals de Angular 18"}]}'

# Ver skills disponibles (ruta pública, sin auth)
curl http://router.casa.lan/skills

# Estado del sistema (ruta pública, sin auth)
curl http://router.casa.lan/health
```

---

## Licencia

MIT License (Non-Commercial) — © 2025 [Jesús Suero](https://github.com/jsuero286)

Puedes usar, modificar y distribuir este proyecto libremente para uso **no comercial**, siempre que mantengas la atribución al autor original. Para uso comercial contacta al autor a través de GitHub.

Ver [`LICENSE`](./LICENSE) para el texto completo.