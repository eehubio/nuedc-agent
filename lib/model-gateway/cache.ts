import { createHash } from "node:crypto";
import { db, ensureSchema } from "../db";
import type { TaskPolicy } from "./task-policy";

/** 结果缓存。Key 包含 promptVersion 与 model，避免升级后返回陈旧结果。 */
export const PROMPT_VERSION = "v1";

export function buildCacheKey(opts: {
  taskType: string; input: unknown; projectId?: string | null;
  problemVersion?: string; moduleCatalogVersion?: string; model: string; scope: string;
}): string {
  const payload = JSON.stringify({
    t: opts.taskType,
    i: opts.input,
    p: opts.scope === "project" ? opts.projectId : null,
    pv: opts.problemVersion || "",
    mv: opts.moduleCatalogVersion || "",
    pr: PROMPT_VERSION,
    m: opts.model,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function inputHash(taskType: string, input: unknown): string {
  return createHash("sha256").update(taskType + JSON.stringify(input)).digest("hex").slice(0, 32);
}

export async function cacheGet(key: string): Promise<{ output: string; provider: string; model: string } | null> {
  try {
    await ensureSchema();
    const rs = await db().execute({
      sql: "SELECT output, provider, model FROM model_cache WHERE cache_key=? AND (expires_at IS NULL OR expires_at > now())",
      args: [key],
    });
    if (!rs.rows.length) return null;
    await db().execute({ sql: "UPDATE model_cache SET hit_count = hit_count + 1 WHERE cache_key=?", args: [key] }).catch(() => {});
    return { output: String(rs.rows[0].output), provider: String(rs.rows[0].provider || ""), model: String(rs.rows[0].model || "") };
  } catch { return null; }
}

export async function cacheSet(key: string, policy: TaskPolicy, output: string, provider: string, model: string): Promise<void> {
  if (!policy.allowCache || policy.cacheScope === "none") return;
  // 全局缓存（官方题目等）保留 30 天；项目级 7 天
  const days = policy.cacheScope === "global" ? 30 : 7;
  try {
    await db().execute({
      sql: `INSERT INTO model_cache (cache_key, task_type, scope, output, provider, model, expires_at)
            VALUES (?,?,?,?,?,?, now() + (? || ' days')::interval)
            ON CONFLICT (cache_key) DO UPDATE SET output=EXCLUDED.output, provider=EXCLUDED.provider,
              model=EXCLUDED.model, expires_at=EXCLUDED.expires_at`,
      args: [key, policy.taskType, policy.cacheScope, output.slice(0, 400_000), provider, model, String(days)],
    });
  } catch { /* 缓存写入失败不影响主流程 */ }
}
