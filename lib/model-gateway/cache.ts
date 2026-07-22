import { createHash } from "node:crypto";
import { db, ensureSchema } from "../db";
import type { TaskPolicy } from "./task-policy";

/** 结果缓存。Key 包含 promptVersion 与 model，避免升级后返回陈旧结果。 */
export const PROMPT_VERSION = "v2";
/** Schema 结构版本：schema 变更后旧缓存必须失效，否则会返回不再合法的旧结构 */
export const SCHEMA_VERSION = "s1";

export function buildCacheKey(opts: {
  taskType: string; input: unknown; projectId?: string | null;
  problemVersion?: string; moduleCatalogVersion?: string;
  provider?: string; model: string; scope: string;
}): string {
  const payload = JSON.stringify({
    t: opts.taskType,
    i: opts.input,
    p: opts.scope === "project" ? opts.projectId : null,
    pv: opts.problemVersion || "",
    mv: opts.moduleCatalogVersion || "",
    pr: PROMPT_VERSION,
    sv: SCHEMA_VERSION,
    // 缓存归属到「实际产出结果的 provider:model」，
    // 否则 Gemini 失败 → Qwen 成功后会把结果写进 Gemini 的 key（读取时张冠李戴）
    m: `${opts.provider || ""}:${opts.model}`,
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


/** 删除某条缓存（Schema 校验失败时清理坏结果） */
export async function cacheDelete(key: string): Promise<void> {
  try {
    await db().execute({ sql: "DELETE FROM model_cache WHERE cache_key=?", args: [key] });
  } catch { /* 忽略 */ }
}
