import { db, uid, ensureSchema } from "../db";
import type { AgentType, ProjectStage } from "../types";
import { STAGE_ALLOWED_AGENTS } from "../types";

export interface AgentContext {
  owner?: string | null;
  taskId?: string | null;
  projectId: string | null;
  stage: ProjectStage;
  tier: string;
}

export interface AgentResult {
  ok: boolean;
  artifact_type?: string;
  output: unknown;
  human_review_required?: boolean;
  message?: string;
}

export type AgentFn = (input: any, ctx: AgentContext) => Promise<AgentResult>;

const registry = new Map<AgentType, AgentFn>();

export function registerAgent(type: AgentType, fn: AgentFn) {
  registry.set(type, fn);
}

/** 当前 Agent 运行上下文（供 llmJson 记账到用户/项目/任务）。
 *  Node 单请求内串行执行，用模块级变量即可；跨请求不共享。 */
let _ctx: { owner?: string | null; projectId?: string | null; taskId?: string | null; agent?: string } = {};
export function currentAgentContext() { return _ctx; }
export function setAgentContext(c: typeof _ctx) { _ctx = c; }

export async function runAgent(
  type: AgentType,
  input: any,
  ctx: AgentContext
): Promise<AgentResult & { run_id: string }> {
  await ensureSchema();
  const runId = uid("RUN");
  const t0 = Date.now();
  setAgentContext({ owner: (ctx as any).owner ?? null, projectId: ctx.projectId, taskId: (ctx as any).taskId ?? null, agent: type });

  // 状态门禁：项目状态机决定允许调用哪些 Agent
  const allowed = STAGE_ALLOWED_AGENTS[ctx.stage] || [];
  if (ctx.projectId && !allowed.includes(type)) {
    const result: AgentResult = {
      ok: false,
      output: null,
      message: `项目当前阶段 ${ctx.stage} 不允许调用 ${type}。允许的 Agent：${allowed.join("、")}`,
    };
    await logRun(runId, ctx, type, input, result, Date.now() - t0, "blocked_by_stage");
    return { ...result, run_id: runId };
  }

  const fn = registry.get(type);
  if (!fn) {
    return { ok: false, output: null, message: `未知 Agent：${type}`, run_id: runId };
  }

  try {
    const result = await fn(input, ctx);
    await logRun(runId, ctx, type, input, result, Date.now() - t0, "ok");
    // Artifact 落库：版本递增 + 方案变更自动级联失效下游
    if (result.ok && result.artifact_type) {
      const { saveArtifact } = await import("../artifacts");
      const { AGENT_CONSUMES } = await import("../artifact-graph");
      // 实例级溯源：查本 Agent 消费的上游类型当前最新版本 id
      let sourceIds: string[] = [];
      if (ctx.projectId && AGENT_CONSUMES[type]?.length) {
        const placeholders = AGENT_CONSUMES[type].map(() => "?").join(",");
        const rs = await db().execute({
          sql: `SELECT a.artifact_id FROM artifacts a
                JOIN (SELECT type, MAX(version) v FROM artifacts WHERE project_id=? AND type IN (${placeholders}) GROUP BY type) m
                ON a.type=m.type AND a.version=m.v WHERE a.project_id=?`,
          args: [ctx.projectId, ...AGENT_CONSUMES[type], ctx.projectId],
        });
        sourceIds = rs.rows.map((r) => String(r.artifact_id));
      }
      await saveArtifact({
        projectId: ctx.projectId, type: result.artifact_type, content: result.output,
        createdBy: type, status: result.human_review_required ? "draft" : "reviewed",
        sourceArtifactIds: sourceIds, changeReason: `run:${type}`,
      });
    }
    return { ...result, run_id: runId };
  } catch (e: any) {
    const result: AgentResult = { ok: false, output: null, message: e?.message || String(e) };
    await logRun(runId, ctx, type, input, result, Date.now() - t0, "error");
    return { ...result, run_id: runId };
  }
}

async function logRun(
  runId: string,
  ctx: AgentContext,
  type: AgentType,
  input: any,
  result: AgentResult,
  ms: number,
  status: string
) {
  try {
    await db().execute({
      sql: `INSERT INTO agent_runs (run_id, project_id, agent_type, objective, input, output, status, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        runId,
        ctx.projectId,
        type,
        input?.objective ?? "",
        JSON.stringify(input).slice(0, 20000),
        JSON.stringify(result.output ?? result.message ?? "").slice(0, 100000),
        status,
        ms,
      ],
    });
  } catch { /* 日志失败不阻断主流程 */ }
}

/** 从模块表构造检索上下文（给需要模块知识的 Agent 用） */
export async function loadModuleIndex(limit = 200): Promise<Record<string, any>> {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT id, data FROM modules WHERE certification_status != 'DEPRECATED' LIMIT ?`,
    args: [limit],
  });
  const index: Record<string, any> = {};
  for (const row of rs.rows) {
    try { index[String(row.id)] = JSON.parse(String(row.data)); } catch { /* skip */ }
  }
  return index;
}

/** 给 LLM 的精简模块目录（控制 token） */
/** 模块目录 → 提示词文本。
 *  库大了会挤占输出预算导致截断，因此按相关性裁剪：
 *  优先模块置顶，其余按认证等级排序，超过 limit 条则截断并注明。 */
export function moduleCatalogForLlm(
  index: Record<string, any>,
  opts: { preferred?: string[]; limit?: number } = {}
): string {
  const limit = opts.limit ?? 40;
  const CERT_RANK: Record<string, number> = {
    COMPETITION_READY: 0, BENCHMARKED: 1, FUNCTION_TESTED: 2,
    POWER_TESTED: 3, DOCUMENTED: 4, DRAFT: 5, DEPRECATED: 9,
  };
  const preferred = new Set(opts.preferred || []);
  const all = Object.values(index) as any[];
  const sorted = [...all].sort((a, b) => {
    const pa = preferred.has(a.id) ? 0 : 1, pb = preferred.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (CERT_RANK[a.certification_status] ?? 6) - (CERT_RANK[b.certification_status] ?? 6);
  });
  const shown = sorted.slice(0, limit);
  const omitted = all.length - shown.length;
  const body = shown
    .map((m: any) => {
      const ifaces = (m.interfaces || [])
        .map((i: any) => `${i.name}:${i.interface_type}@${i.voltage_level ?? "?"}V`)
        .join(",");
      const power = m.power
        ? `供电${(m.power.input_voltage_range || []).join("-")}V/典型${m.power.typical_current_ma ?? "?"}mA/峰值${m.power.peak_current_ma ?? "?"}mA`
        : "";
      return `- id=${m.id} | ${m.name} | ${m.category} | 芯片:${m.main_chip ?? "?"} | 接口:[${ifaces}] | ${power} | 认证:${m.certification_status}`;
    })
    .join("\n");
  return omitted > 0 ? `${body}\n（另有 ${omitted} 个模块未列出，如需其他器件可将 module_id 留空并在 name 中说明）` : body;
}
