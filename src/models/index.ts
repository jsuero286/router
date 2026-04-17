import * as fs   from "fs";
import * as path from "path";
import { MODELS_DIR } from "../config";
import type { NodeEntry } from "../types";

// =========================
// 🗺️ MODELS — carga dinámica desde /models/*.json
// =========================

export interface ModelDefinition {
  name:        string;
  description?: string;
  nodes:       NodeEntry[];
}

// MODEL_MAP es el mapa vivo que usa el router para el routing
export const MODEL_MAP: Record<string, NodeEntry[]> = {};

// MODELS_META guarda la definición completa para el endpoint /v1/models
export const MODELS_META: Record<string, ModelDefinition> = {};

// =========================
// 📄 CARGA DE DEFINICIONES
// =========================

function loadDefinition(file: string): ModelDefinition | null {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const def = JSON.parse(raw) as ModelDefinition;
    if (!def.name || !Array.isArray(def.nodes) || def.nodes.length === 0) {
      console.warn(`[MODELS] ⚠️  ${path.basename(file)} — formato inválido (name y nodes requeridos)`);
      return null;
    }
    return def;
  } catch (err) {
    console.warn(`[MODELS] ⚠️  Error leyendo ${path.basename(file)}: ${err}`);
    return null;
  }
}

// =========================
// 📦 CARGA DE TODOS LOS MODELOS
// =========================

export function loadModels(): void {
  if (!fs.existsSync(MODELS_DIR)) {
    console.log(`[MODELS] Carpeta no encontrada: ${MODELS_DIR} — usando modelos vacíos`);
    return;
  }

  // Limpiar estado anterior (preservando los de skills que se añaden por separado)
  for (const key of Object.keys(MODEL_MAP))   delete MODEL_MAP[key];
  for (const key of Object.keys(MODELS_META)) delete MODELS_META[key];

  const files = fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log(`[MODELS] No se encontraron ficheros .json en ${MODELS_DIR}`);
    return;
  }

  for (const file of files) {
    const def = loadDefinition(path.join(MODELS_DIR, file));
    if (!def) continue;

    MODEL_MAP[def.name]   = def.nodes;
    MODELS_META[def.name] = def;

    const nodeList = def.nodes.map((n) => `${n.nodeName}/${n.model}`).join(" → ");
    console.log(`[MODELS] ✅ ${def.name.padEnd(12)} ${nodeList}`);
  }

  console.log(`[MODELS] Cargados: ${Object.keys(MODEL_MAP).join(", ") || "ninguno"}`);
}

// =========================
// 👀 HOT-RELOAD
// =========================

export function watchModels(): void {
  if (!fs.existsSync(MODELS_DIR)) return;

  let debounce: ReturnType<typeof setTimeout> | null = null;

  function scheduleReload(reason: string): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log(`[MODELS] ${reason} — recargando modelos...`);
      loadModels();
    }, 300);
  }

  fs.watch(MODELS_DIR, (_event, filename) => {
    if (filename?.endsWith(".json")) scheduleReload(`Cambio en "${filename}"`);
  });

  // Polling para ficheros nuevos/eliminados
  let knownFiles = new Set(fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith(".json")));
  setInterval(() => {
    if (!fs.existsSync(MODELS_DIR)) return;
    const current = new Set(fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith(".json")));
    const added   = [...current].filter((f) => !knownFiles.has(f));
    const removed = [...knownFiles].filter((f) => !current.has(f));
    if (added.length > 0 || removed.length > 0) {
      knownFiles = current;
      scheduleReload([...added.map((f) => `+${f}`), ...removed.map((f) => `-${f}`)].join(", "));
    }
  }, 5_000);

  console.log(`[MODELS] 👀 Watching ${MODELS_DIR}`);
}
