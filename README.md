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

# API Keys de proveedores cloud
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...

# Métricas Prometheus (true/false)
METRICS_ENABLED=true

# Carpeta de skills (por defecto: ./skills)
SKILLS_DIR=/opt/llm-router/skills
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

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/v1/chat/completions` | Chat compatible OpenAI |
| GET | `/v1/models` | Lista de todos los modelos disponibles |
| GET | `/v1` | Health check básico |
| GET | `/health` | Estado de nodos, skills y caché |
| GET | `/skills` | Lista de skills cargados y sus modelos |
| GET | `/metrics` | Métricas Prometheus (si `METRICS_ENABLED=true`) |

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

## Uso con curl

```bash
# Chat básico
curl http://router.casa.lan/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hola"}]}'

# Con skill
curl http://router.casa.lan/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "angular-expert-gemini", "messages": [{"role": "user", "content": "Explícame los signals de Angular 18"}]}'

# Ver skills disponibles
curl http://router.casa.lan/skills

# Estado del sistema
curl http://router.casa.lan/health
```
