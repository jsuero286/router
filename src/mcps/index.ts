import * as fs   from "fs";
import * as path from "path";
import { spawn }  from "child_process";
import { MCPS_DIR } from "../config";
import type { McpDefinition, McpTool, ActiveMcp, ChatMessage } from "../types";

// =========================
// 🔧 MCP — carga dinámica con hot-reload
// =========================

export const MCPS: Record<string, ActiveMcp> = {};

// =========================
// 📄 CARGA DE DEFINICIONES
// =========================

function loadDefinition(file: string): McpDefinition | null {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const def = JSON.parse(raw) as McpDefinition;
    if (!def.name || !def.command || !Array.isArray(def.args)) {
      console.warn(`[MCPS] ⚠️  ${path.basename(file)} — formato inválido (name, command, args requeridos)`);
      return null;
    }
    // Defaults
    def.enabled ??= true;
    def.models  ??= ["auto"];
    return def;
  } catch (err) {
    console.warn(`[MCPS] ⚠️  Error leyendo ${path.basename(file)}: ${err}`);
    return null;
  }
}

// =========================
// 🚀 ARRANQUE DE PROCESO MCP
// =========================

/**
 * Arranca el proceso MCP via stdio y negocia la lista de tools
 * usando el protocolo MCP simplificado (JSON-RPC sobre stdin/stdout).
 */
async function startMcpProcess(def: McpDefinition): Promise<ActiveMcp | null> {
  return new Promise((resolve) => {
    const proc = spawn(def.command, def.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let buffer = "";
    let initialized = false;
    let tools: McpTool[] = [];

    const timeout = setTimeout(() => {
      if (!initialized) {
        console.warn(`[MCPS] ⏱️  ${def.name} — timeout esperando tools, usando sin tools`);
        resolve({ definition: def, tools: [], client: proc });
      }
    }, 10_000);

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
            method?: string;
          };

          // Respuesta al initialize
          if (msg.id === 1 && msg.result !== undefined) {
            // Enviar tools/list
            proc.stdin.write(JSON.stringify({
              jsonrpc: "2.0", id: 2,
              method: "tools/list", params: {},
            }) + "\n");
          }

          // Respuesta a tools/list
          if (msg.id === 2 && msg.result?.tools) {
            tools = (msg.result.tools ?? []).map((t) => ({
              type: "function" as const,
              function: {
                name:        t.name,
                description: t.description ?? t.name,
                parameters:  t.inputSchema ?? { type: "object", properties: {} },
              },
            }));
            initialized = true;
            clearTimeout(timeout);
            console.log(`[MCPS] ✅ ${def.name} — ${tools.length} tool(s): ${tools.map((t) => t.function.name).join(", ")}`);
            resolve({ definition: def, tools, client: proc });
          }
        } catch {
          // línea no JSON, ignorar
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[MCPS] [${def.name}] ${msg}`);
    });

    proc.on("error", (err) => {
      console.error(`[MCPS] ❌ ${def.name} — error arrancando proceso: ${err.message}`);
      clearTimeout(timeout);
      resolve(null);
    });

    proc.on("exit", (code) => {
      if (code !== 0) console.warn(`[MCPS] ⚠️  ${def.name} — proceso terminó con código ${code}`);
      delete MCPS[def.name];
    });

    // Enviar initialize
    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "llm-router", version: "1.0.0" },
      },
    }) + "\n");
  });
}

// =========================
// 📦 CARGA DE TODOS LOS MCPS
// =========================

export async function loadMcps(): Promise<void> {
  if (!fs.existsSync(MCPS_DIR)) {
    console.log(`[MCPS] Carpeta no encontrada: ${MCPS_DIR} — MCPs desactivados`);
    return;
  }

  // Parar procesos existentes
  for (const [name, mcp] of Object.entries(MCPS)) {
    try { mcp.client?.kill?.(); } catch {}
    delete MCPS[name];
  }

  const files = fs.readdirSync(MCPS_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log(`[MCPS] No se encontraron ficheros .json en ${MCPS_DIR}`);
    return;
  }

  for (const file of files) {
    const def = loadDefinition(path.join(MCPS_DIR, file));
    if (!def) continue;
    if (!def.enabled) {
      console.log(`[MCPS] ⏭️  ${def.name} desactivado`);
      continue;
    }
    const active = await startMcpProcess(def);
    if (active) MCPS[def.name] = active;
  }

  console.log(`[MCPS] Cargados: ${Object.keys(MCPS).join(", ") || "ninguno"}`);
}

export function watchMcps(): void {
  if (!fs.existsSync(MCPS_DIR)) return;

  let debounce: ReturnType<typeof setTimeout> | null = null;

  function scheduleReload(reason: string): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log(`[MCPS] ${reason} — recargando MCPs...`);
      loadMcps().catch((e) => console.error("[MCPS] Error recargando:", e));
    }, 500);
  }

  fs.watch(MCPS_DIR, (_event, filename) => {
    if (filename?.endsWith(".json")) scheduleReload(`Cambio en "${filename}"`);
  });

  console.log(`[MCPS] 👀 Watching ${MCPS_DIR}`);
}

// =========================
// 🔍 TOOLS PARA UN ALIAS
// =========================

/**
 * Devuelve los tools de todos los MCPs activos que aplican al alias dado.
 */
export function getToolsForAlias(alias: string): McpTool[] {
  const tools: McpTool[] = [];
  for (const mcp of Object.values(MCPS)) {
    const { models } = mcp.definition;
    if (models.includes("*") || models.includes(alias)) {
      tools.push(...mcp.tools);
    }
  }
  return tools;
}

// =========================
// ⚡ EJECUCIÓN DE TOOL CALL
// =========================

/**
 * Ejecuta un tool call en el MCP correspondiente y devuelve el resultado.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Buscar qué MCP tiene este tool
  const mcp = Object.values(MCPS).find((m) =>
    m.tools.some((t) => t.function.name === toolName)
  );

  if (!mcp) return `Tool "${toolName}" no encontrado`;

  return new Promise((resolve) => {
    const proc = mcp.client;
    const id   = Date.now();
    let buffer = "";

    const handler = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: { content?: Array<{ type: string; text?: string }> };
            error?: { message?: string };
          };
          if (msg.id === id) {
            proc.stdout.off("data", handler);
            if (msg.error) {
              resolve(`Error: ${msg.error.message ?? "unknown"}`);
            } else {
              const content = msg.result?.content ?? [];
              const text = content
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n");
              resolve(text || JSON.stringify(msg.result));
            }
          }
        } catch {}
      }
    };

    proc.stdout.on("data", handler);

    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }) + "\n");

    // Timeout de seguridad
    setTimeout(() => {
      proc.stdout.off("data", handler);
      resolve(`Timeout ejecutando tool "${toolName}"`);
    }, 30_000);
  });
}

// =========================
// 💬 AGENTIC LOOP
// =========================

/**
 * Ejecuta el loop agéntico: llama al modelo, procesa tool calls,
 * vuelve a llamar con los resultados, hasta que el modelo responda sin tools.
 * Devuelve el contenido final y los tokens usados.
 */
export async function runAgenticLoop(
  callModel: (messages: ChatMessage[], tools: McpTool[]) => Promise<{
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    inputTokens: number;
    outputTokens: number;
  }>,
  messages: ChatMessage[],
  tools: McpTool[],
  maxTurns = 5,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let totalInput  = 0;
  let totalOutput = 0;
  let currentMessages = [...messages];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callModel(currentMessages, tools);
    totalInput  += response.inputTokens;
    totalOutput += response.outputTokens;

    if (!response.toolCalls || response.toolCalls.length === 0) {
      return { content: response.content, inputTokens: totalInput, outputTokens: totalOutput };
    }

    console.log(`[MCPS] Tool calls: ${response.toolCalls.map((t) => t.name).join(", ")}`);

    // Añadir respuesta del asistente con tool calls
    currentMessages.push({ role: "assistant", content: response.content });

    // Ejecutar cada tool call y añadir resultados
    for (const tc of response.toolCalls) {
      const result = await executeTool(tc.name, tc.arguments);
      console.log(`[MCPS] ${tc.name} → ${result.slice(0, 100)}...`);
      currentMessages.push({ role: "user", content: `Tool result for ${tc.name}: ${result}` });
    }
  }

  // Si llegamos al límite de turnos, devolver lo último
  const last = await callModel(currentMessages, []);
  return {
    content:      last.content,
    inputTokens:  totalInput  + last.inputTokens,
    outputTokens: totalOutput + last.outputTokens,
  };
}
