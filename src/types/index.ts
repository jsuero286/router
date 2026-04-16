// =========================
// 🔧 TYPES
// =========================

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  user?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export interface GenerationOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export interface ConversationContext {
  messages: ChatMessage[];
  model: string;
  skill: string | null;
  totalCostUsd: number;
  createdAt: number;
  updatedAt: number;
  turns: number;
}

export interface OllamaResponse {
  message?: { content: string };
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface NodeEntry {
  nodeName: string;
  model: string;
}

export type NodeType = "ollama" | "anthropic" | "google";

export interface NodeConfig {
  url: string;
  type: NodeType;
}

export interface SelectedNode {
  nodeName: string;
  model: string;
  config: NodeConfig;
}

export interface OllamaPsModel {
  name: string;
  size_vram?: number;
  expires_at?: string;
}

export interface OllamaPsResponse {
  models: OllamaPsModel[];
}

export interface SkillFrontmatter {
  preferred_node?: string;
  preferred_model?: string;
  fallback_node?: string;
  fallback_model?: string;
  cloud_fallback?: string;
  cache_ttl?: number;
}

export interface SkillEntry {
  prompt: string;
  frontmatter: SkillFrontmatter;
}

export type Complexity = "simple" | "medium" | "complex";

export type CompressionMode = "none" | "history" | "llmlingua" | "both";

// =========================
// 🔧 MCP
// =========================

export interface McpDefinition {
  name:    string;
  command: string;
  args:    string[];
  enabled: boolean;
  models:  string[];   // aliases donde se inyecta ("auto", "fast", "*" = todos)
}

export interface McpTool {
  type:     "function";
  function: {
    name:        string;
    description: string;
    parameters:  Record<string, unknown>;
  };
}

export interface ActiveMcp {
  definition: McpDefinition;
  tools:      McpTool[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client:     any; // instancia del cliente MCP
}
