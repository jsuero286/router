import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// =========================
// 🖥️ CLUSTER LLAMA.CPP
// =========================

const CLUSTER_HOST    = process.env.CLUSTER_HOST    ?? "jesus@192.168.50.79";
const CLUSTER_SCRIPTS = process.env.CLUSTER_SCRIPTS ?? "/home/jesus/docker";
const CLUSTER_URL     = process.env.CLUSTER_URL     ?? "http://192.168.50.79:8080";

export type ClusterStatus = "online" | "offline" | "unknown";

export async function getClusterStatus(): Promise<ClusterStatus> {
  try {
    const res = await fetch(`${CLUSTER_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok ? "online" : "offline";
  } catch {
    return "offline";
  }
}

async function runRemoteScript(script: string): Promise<{ ok: boolean; output: string }> {
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${CLUSTER_HOST} "bash ${CLUSTER_SCRIPTS}/${script}"`;
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 120_000 });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const combined = (error.stdout ?? "") + (error.stderr ?? "");
    const output   = (combined || (error.message ?? "unknown error")).trim();
    return { ok: false, output };
  }
}

export async function startCluster(): Promise<{ ok: boolean; output: string }> {
  console.log("[CLUSTER] Arrancando cluster DeepSeek-R1 32B...");
  const result = await runRemoteScript("llama-cluster-start.sh");
  if (result.ok) {
    console.log("[CLUSTER] ✅ Cluster arrancado");
  } else {
    console.error(`[CLUSTER] ❌ Error arrancando cluster: ${result.output}`);
  }
  return result;
}

export async function stopCluster(): Promise<{ ok: boolean; output: string }> {
  console.log("[CLUSTER] Parando cluster...");
  const result = await runRemoteScript("llama-cluster-stop.sh");
  if (result.ok) {
    console.log("[CLUSTER] ✅ Cluster parado");
  } else {
    console.error(`[CLUSTER] ❌ Error parando cluster: ${result.output}`);
  }
  return result;
}
