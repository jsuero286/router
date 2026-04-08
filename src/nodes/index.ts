import { NODES, ANTHROPIC_API_KEY, GOOGLE_API_KEY } from "../config";
import { NODE_LOAD_set, NODE_SELECTED_inc } from "../metrics";
import { MODEL_MAP } from "../skills";
import type { NodeConfig, OllamaPsResponse, SelectedNode } from "../types";

// =========================
// ⚡ NODE LOAD & ROUTING
// =========================

export async function getNodeLoad(nodeConfig: NodeConfig): Promise<number> {
  if (nodeConfig.type !== "ollama") return 0;
  try {
    const res = await fetch(`${nodeConfig.url}/api/ps`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return 999;
    const data = (await res.json()) as OllamaPsResponse;
    return data.models?.length ?? 0;
  } catch {
    return 999;
  }
}

export async function selectCandidates(modelAlias: string): Promise<SelectedNode[]> {
  const entries = MODEL_MAP[modelAlias];
  if (!entries || entries.length === 0) return [];

  const ollamaEntries = entries.filter((e) => NODES[e.nodeName]?.type === "ollama");
  const cloudEntries  = entries.filter((e) => NODES[e.nodeName]?.type !== "ollama");

  const candidates: SelectedNode[] = [];

  if (ollamaEntries.length > 0) {
    const loadResults = await Promise.all(
      ollamaEntries.map(async (entry) => {
        const config = NODES[entry.nodeName];
        if (!config) return { entry, config: null, load: 999 };
        const load = await getNodeLoad(config);
        NODE_LOAD_set({ node: entry.nodeName }, load);
        const status = load === 999 ? "❌ offline" : load === 0 ? "✅ libre" : `⚙️  ocupado (${load} modelo/s)`;
        console.log(`[LOAD]  ${entry.nodeName.padEnd(10)} ${status}`);
        return { entry, config, load };
      })
    );

    const available = loadResults
      .filter(({ load }) => load < 999)
      .sort((a, b) => a.load - b.load);

    if (available.length === 0) {
      console.warn("[ROUTING] Todos los nodos Ollama offline, escalando a cloud");
    }

    for (const { entry, config } of available) {
      if (config) candidates.push({ nodeName: entry.nodeName, model: entry.model, config });
    }
  }

  for (const entry of cloudEntries) {
    const config = NODES[entry.nodeName];
    if (!config) continue;
    if (config.type === "anthropic" && !ANTHROPIC_API_KEY) continue;
    if (config.type === "google"    && !GOOGLE_API_KEY)    continue;
    candidates.push({ nodeName: entry.nodeName, model: entry.model, config });
  }

  return candidates;
}

export async function selectNode(modelAlias: string): Promise<SelectedNode | null> {
  const candidates = await selectCandidates(modelAlias);
  if (candidates.length === 0) return null;
  NODE_SELECTED_inc({ node: candidates[0].nodeName });
  return candidates[0];
}
