import * as fs from "fs";
import * as path from "path";
import { SKILLS_DIR, CACHE_TTL, BASE_MODEL_MAP } from "../config";
import type { SkillEntry, SkillFrontmatter, NodeEntry } from "../types";

// =========================
// 🧠 SKILLS — carga dinámica con frontmatter YAML
// =========================

export const SKILLS: Record<string, SkillEntry> = {};
export const MODEL_MAP: Record<string, NodeEntry[]> = { ...BASE_MODEL_MAP };
export const SKILL_CACHE_TTL: Record<string, number> = {};

function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const fm: SkillFrontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const k = key.trim() as keyof SkillFrontmatter;
    const v = rest.join(":").trim();
    if (k === "cache_ttl") {
      const n = parseInt(v, 10);
      if (!isNaN(n)) (fm as any)[k] = n;
    } else {
      (fm as any)[k] = v;
    }
  }
  return { frontmatter: fm, body: match[2].trim() };
}

function buildSkillModelMap(skillName: string, fm: SkillFrontmatter): void {
  const primaryNode   = fm.preferred_node  ?? "mac";
  const primaryModel  = fm.preferred_model ?? "deepseek-coder-v2:16b";
  const fallbackNode  = fm.fallback_node   ?? "gpu4070";
  const fallbackModel = fm.fallback_model  ?? "deepseek-coder-v2:16b";
  const cloudAlias    = fm.cloud_fallback  ?? "gemini-flash";
  const cloudEntries  = BASE_MODEL_MAP[cloudAlias] ?? BASE_MODEL_MAP["gemini-flash"] ?? [];

  MODEL_MAP[skillName] = [
    { nodeName: primaryNode,  model: primaryModel  },
    { nodeName: fallbackNode, model: fallbackModel },
    ...cloudEntries,
  ];

  MODEL_MAP[`${skillName}-mac`]         = [{ nodeName: "mac",     model: primaryModel }];
  MODEL_MAP[`${skillName}-4070`]        = [{ nodeName: "gpu4070", model: fallbackModel }];
  MODEL_MAP[`${skillName}-4070-reason`] = [{ nodeName: "gpu4070", model: "deepseek-r1:14b" }];
  MODEL_MAP[`${skillName}-gemini`]      = [{ nodeName: "gemini",  model: "gemini-2.5-flash" }];
  MODEL_MAP[`${skillName}-claude`]      = [{ nodeName: "claude",  model: "claude-sonnet-4-6" }];
}

export function loadSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log(`[SKILLS] Carpeta no encontrada: ${SKILLS_DIR} — skills desactivados`);
    return;
  }
  const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.log(`[SKILLS] No se encontraron ficheros .md en ${SKILLS_DIR}`);
    return;
  }

  for (const key of Object.keys(MODEL_MAP)) delete MODEL_MAP[key];
  Object.assign(MODEL_MAP, BASE_MODEL_MAP);
  for (const key of Object.keys(SKILLS)) delete SKILLS[key];

  for (const file of files) {
    const skillName = path.basename(file, ".md");
    const raw = fs.readFileSync(path.join(SKILLS_DIR, file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    SKILLS[skillName] = { prompt: body, frontmatter };
    buildSkillModelMap(skillName, frontmatter);

    if (frontmatter.cache_ttl) {
      SKILL_CACHE_TTL[skillName] = frontmatter.cache_ttl;
    }

    const pNode  = frontmatter.preferred_node  ?? "mac (default)";
    const pModel = frontmatter.preferred_model ?? "deepseek-coder-v2:16b (default)";
    const cloud  = frontmatter.cloud_fallback  ?? "gemini-flash (default)";
    const ttl    = frontmatter.cache_ttl       ? `${frontmatter.cache_ttl}s` : `${CACHE_TTL}s (global)`;
    console.log(`[SKILLS] ✅ ${skillName} → ${pNode}/${pModel}, cloud: ${cloud}, ttl: ${ttl}`);
  }
}

export function extractSkill(modelAlias: string): string | null {
  // Match exacto primero
  if (SKILLS[modelAlias]) return modelAlias;

  // Para sufijos (ej: "debug-mac"), elegir el skill con nombre más largo que coincida
  // para evitar que "debug" matchee antes que "debug-expert" si ambos existen
  let best: string | null = null;
  for (const skillName of Object.keys(SKILLS)) {
    if (modelAlias.startsWith(skillName + "-")) {
      if (!best || skillName.length > best.length) {
        best = skillName;
      }
    }
  }
  return best;
}

export function injectSkill(messages: import("../types").ChatMessage[], skillName: string): import("../types").ChatMessage[] {
  const skill = SKILLS[skillName];
  if (!skill) return messages;
  const systemPrompt = skill.prompt;
  const hasSystem = messages.some((m) => m.role === "system");
  if (hasSystem) {
    return messages.map((m) =>
      m.role === "system" ? { ...m, content: `${systemPrompt}\n\n${m.content}` } : m
    );
  }
  return [{ role: "system", content: systemPrompt }, ...messages];
}

export function getSkillCacheTtl(skillName: string | null): number {
  if (skillName && SKILL_CACHE_TTL[skillName]) return SKILL_CACHE_TTL[skillName];
  return CACHE_TTL;
}

export function watchSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) return;
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  fs.watch(SKILLS_DIR, (_event, filename) => {
    if (!filename?.endsWith(".md")) return;
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      console.log(`[SKILLS] Cambio detectado en "${filename}" — recargando skills...`);
      loadSkills();
      console.log(`[SKILLS] Skills recargadas: ${Object.keys(SKILLS).join(", ") || "ninguna"}`);
    }, 300);
  });
  console.log(`[SKILLS] 👀 Watching ${SKILLS_DIR}`);
}
