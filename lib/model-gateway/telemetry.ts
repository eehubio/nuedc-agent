import { db, ensureSchema } from "../db";
import { getProvider } from "./providers";

/** 每次模型调用的可追踪记账：用户 / 项目 / 任务 / taskType / Provider / token / 成本。 */
export interface UsageEvent {
  owner?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  taskType: string;
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  latencyMs: number;
  status: "success" | "error" | "cache_hit";
  errorCode?: string | null;
  fallbackUsed?: boolean;
  cacheHit?: boolean;
}

export function estimateCost(provider: string, inputTokens: number, outputTokens: number): number {
  const p = getProvider(provider);
  if (!p) return 0;
  return (inputTokens / 1e6) * p.pricing.inputPerMillion + (outputTokens / 1e6) * p.pricing.outputPerMillion;
}

export async function recordUsageEvent(e: UsageEvent): Promise<number> {
  const cost = estimateCost(e.provider, e.inputTokens, e.outputTokens);
  try {
    await ensureSchema();
    await db().execute({
      sql: `INSERT INTO llm_usage_events
        (owner, project_id, task_id, task_type, provider, model, input_tokens, output_tokens,
         cached_tokens, estimated_cost, latency_ms, status, error_code, fallback_used, cache_hit)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        e.owner ?? null, e.projectId ?? null, e.taskId ?? null, e.taskType, e.provider, e.model ?? null,
        e.inputTokens, e.outputTokens, e.cachedTokens ?? 0, cost, e.latencyMs, e.status,
        e.errorCode ?? null, e.fallbackUsed ? 1 : 0, e.cacheHit ? 1 : 0,
      ],
    });
  } catch { /* 记账失败不影响主流程 */ }
  return cost;
}

/** 预算门禁：返回 null 放行，返回字符串为拒绝原因 */
export async function checkBudget(owner: string, projectId?: string | null): Promise<string | null> {
  const perUser = Number(process.env.PER_USER_DAILY_BUDGET_USD || 0);
  const perProject = Number(process.env.PER_PROJECT_DAILY_BUDGET_USD || 0);
  const global = Number(process.env.GLOBAL_DAILY_BUDGET_USD || 0);
  if (!perUser && !perProject && !global) return null;

  try {
    await ensureSchema();
    if (perUser) {
      const rs = await db().execute({
        sql: "SELECT COALESCE(SUM(estimated_cost),0) AS c FROM llm_usage_events WHERE owner=? AND created_at >= date_trunc('day', now())",
        args: [owner],
      });
      if (Number(rs.rows[0]?.c || 0) >= perUser) return `今日个人预算已用尽（$${perUser}）。规则工具与项目编辑仍可使用。`;
    }
    if (perProject && projectId) {
      const rs = await db().execute({
        sql: "SELECT COALESCE(SUM(estimated_cost),0) AS c FROM llm_usage_events WHERE project_id=? AND created_at >= date_trunc('day', now())",
        args: [projectId],
      });
      if (Number(rs.rows[0]?.c || 0) >= perProject) return `本项目今日预算已用尽（$${perProject}）。`;
    }
    if (global) {
      const rs = await db().execute({
        sql: "SELECT COALESCE(SUM(estimated_cost),0) AS c FROM llm_usage_events WHERE created_at >= date_trunc('day', now())",
        args: [],
      });
      if (Number(rs.rows[0]?.c || 0) >= global) return `系统今日总预算已用尽，AI 生成暂停；规则工具与项目编辑不受影响。`;
    }
  } catch { /* 预算表不可用时放行 */ }
  return null;
}

export async function usageSummary(opts: { owner?: string; days?: number } = {}) {
  await ensureSchema();
  const since = `now() - interval '${opts.days || 1} days'`;
  const args: any[] = [];
  let where = `created_at >= ${since}`;
  if (opts.owner) { where += " AND owner=?"; args.push(opts.owner); }

  const [byProvider, byTask, totals] = await Promise.all([
    db().execute({ sql: `SELECT provider, COUNT(*) n, SUM(input_tokens) ti, SUM(output_tokens) to_, SUM(estimated_cost) cost FROM llm_usage_events WHERE ${where} GROUP BY provider`, args }),
    db().execute({ sql: `SELECT task_type, COUNT(*) n, SUM(input_tokens) ti, SUM(output_tokens) to_, SUM(estimated_cost) cost FROM llm_usage_events WHERE ${where} GROUP BY task_type ORDER BY cost DESC`, args }),
    db().execute({ sql: `SELECT COUNT(*) n, SUM(input_tokens) ti, SUM(output_tokens) to_, SUM(estimated_cost) cost, SUM(cache_hit) hits FROM llm_usage_events WHERE ${where}`, args }),
  ]);
  const t = totals.rows[0] || {};
  return {
    total: {
      requests: Number(t.n || 0), inputTokens: Number(t.ti || 0), outputTokens: Number(t.to_ || 0),
      costUsd: Number(t.cost || 0), cacheHits: Number(t.hits || 0),
    },
    byProvider: byProvider.rows.map((r: any) => ({ provider: r.provider, requests: Number(r.n), inputTokens: Number(r.ti || 0), outputTokens: Number(r.to_ || 0), costUsd: Number(r.cost || 0) })),
    byTaskType: byTask.rows.map((r: any) => ({ taskType: r.task_type, requests: Number(r.n), inputTokens: Number(r.ti || 0), outputTokens: Number(r.to_ || 0), costUsd: Number(r.cost || 0) })),
  };
}
