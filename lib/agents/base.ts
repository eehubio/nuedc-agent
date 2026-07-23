import { AsyncLocalStorage } from "node:async_hooks";
import { db, uid, ensureSchema } from "../db";
import type { AgentType, ProjectStage } from "../types";
import { STAGE_ALLOWED_AGENTS } from "../types";
import { saveArtifact } from "../artifacts";
import { AGENT_CONSUMES } from "../artifact-graph";

export interface AgentContext {
  owner?: string | null;
  taskId?: string | null;
  projectId: string | null;
  stage: ProjectStage;
  tier: string;
  /** 外部取消信号：透传到网关，取消时中断正在进行的 Provider 调用 */
  signal?: AbortSignal;
}

/** 结构化错误码。Worker 据此决定 completeTask(error) 还是 failTask(retry)。
 *  可重试：瞬时性、外部依赖抖动；不可重试：输入/权限/门禁/网关内部已耗尽重试的结构错误。 */
export type AgentErrorCode =
  // —— 可重试 ——
  | "RATE_LIMIT"            // 429
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER"               // 502/503/504
  | "PROVIDER_UNAVAILABLE"
  | "TEMPORARY_DATABASE_ERROR"
  // —— 不可重试 ——
  | "SCHEMA_INVALID"       // 网关内部重试上限后仍不合法结构
  | "INVALID_INPUT"
  | "PERMISSION_DENIED"
  | "STAGE_BLOCKED"
  | "REQUIREMENT_NOT_CONFIRMED"
  | "NO_PROVIDER"
  | "BUDGET_EXCEEDED"
  | "SYSTEM_MODE"
  | "UNKNOWN";

const RETRYABLE_CODES: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  "RATE_LIMIT", "TIMEOUT", "NETWORK", "SERVER", "PROVIDER_UNAVAILABLE", "TEMPORARY_DATABASE_ERROR",
]);

/** 是否可重试。未知错误默认不可重试（宁可让用户重发，也不无谓烧钱）。 */
export function isRetryable(code?: AgentErrorCode | string | null): boolean {
  return !!code && RETRYABLE_CODES.has(code as AgentErrorCode);
}

/** 把网关 errorCode / provider 错误码映射为 Agent 结构化错误码。
 *  同时识别中英文关键词，因为 message 可能是中文（如"请求超时"）。 */
export function classifyAgentError(raw?: string | null): AgentErrorCode {
  const orig = String(raw || "");
  const s = orig.toUpperCase();
  if (!s) return "UNKNOWN";
  if (s.includes("RATE_LIMIT") || s.includes("429") || orig.includes("限流")) return "RATE_LIMIT";
  if (s.includes("TIMEOUT") || orig.includes("超时")) return "TIMEOUT";
  if (s.includes("NETWORK") || s.includes("ECONN") || s.includes("FETCH FAILED") || s.includes("SOCKET") || orig.includes("网络")) return "NETWORK";
  if (s.includes("502") || s.includes("503") || s.includes("504") || s === "SERVER" || s.includes("SERVER")) return "SERVER";
  if (s.includes("NO_PROVIDER") || s.includes("PROVIDER_UNAVAILABLE") || orig.includes("不可用")) return "PROVIDER_UNAVAILABLE";
  if (s.includes("TEMPORARY_DATABASE") || s.includes("DB_TEMP")) return "TEMPORARY_DATABASE_ERROR";
  if (s.includes("SCHEMA")) return "SCHEMA_INVALID";
  if (s.includes("INVALID_INPUT") || s.includes("BAD_INPUT")) return "INVALID_INPUT";
  if (s.includes("PERMISSION") || s.includes("AUTH") || s.includes("REGION_BLOCKED")) return "PERMISSION_DENIED";
  if (s.includes("STAGE") || s.includes("BLOCKED_BY_STAGE")) return "STAGE_BLOCKED";
  if (s.includes("REQUIREMENT_NOT_CONFIRMED")) return "REQUIREMENT_NOT_CONFIRMED";
  if (s.includes("BUDGET")) return "BUDGET_EXCEEDED";
  if (s.includes("SYSTEM_MODE")) return "SYSTEM_MODE";
  return "UNKNOWN";
}

export interface AgentResult {
  ok: boolean;
  artifact_type?: string;
  output: unknown;
  human_review_required?: boolean;
  message?: string;
  /** 结构化错误码（ok=false 时有意义），Worker 据此决定是否重试 */
  error_code?: AgentErrorCode;
  /** 是否可重试。未显式给出时由 error_code 推断 */
  retryable?: boolean;
  /** 底层 Provider 原始错误码（诊断用，如 RATE_LIMIT/SERVER/TIMEOUT） */
  provider_error_code?: string | null;
}

export type AgentFn = (input: any, ctx: AgentContext) => Promise<AgentResult>;

const registry = new Map<AgentType, AgentFn>();

export function registerAgent(type: AgentType, fn: AgentFn) {
  registry.set(type, fn);
}

/** Agent 运行上下文。
 *  必须用 AsyncLocalStorage：模块级变量在同一 Node 实例并发处理多请求时会串用户、
 *  把 A 用户的 token 用量记到 B 用户的项目上。ALS 保证每条异步调用链各自隔离。 */
export interface AgentRunContext {
  owner?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  agent?: string;
  /** 本次运行中网关是否返回过 partial 结果（截断后修复）。
   *  放在 ALS 上下文里而非模块级变量，避免并发串线。 */
  partialSeen?: { value: boolean };
  /** 外部取消信号，llmJson 读取后透传给网关 */
  signal?: AbortSignal;
}

const agentContextStore = new AsyncLocalStorage<AgentRunContext>();

/** 读取当前调用链的上下文；不在 Agent 执行链中时返回空对象（退化为不记账，绝不串线） */
export function currentAgentContext(): AgentRunContext {
  return agentContextStore.getStore() ?? {};
}

/** 在隔离的上下文中执行 —— 所有 Agent 执行必须经此包裹 */
export function withAgentContext<T>(ctx: AgentRunContext, fn: () => Promise<T>): Promise<T> {
  return agentContextStore.run(ctx, fn);
}

/** 执行 Agent。整个调用链在独立的 AsyncLocalStorage 上下文中运行，
 *  确保并发请求之间的 owner/project/task 绝不互相污染。 */
export function runAgent(
  type: AgentType,
  input: any,
  ctx: AgentContext
): Promise<AgentResult & { run_id: string }> {
  return withAgentContext(
    { owner: ctx.owner ?? null, projectId: ctx.projectId, taskId: ctx.taskId ?? null, agent: type,
      partialSeen: { value: false }, signal: ctx.signal },
    () => runAgentInner(type, input, ctx),
  );
}

async function runAgentInner(
  type: AgentType,
  input: any,
  ctx: AgentContext
): Promise<AgentResult & { run_id: string }> {
  await ensureSchema();
  const runId = uid("RUN");
  const t0 = Date.now();


  // 状态门禁：项目状态机决定允许调用哪些 Agent
  const allowed = STAGE_ALLOWED_AGENTS[ctx.stage] || [];
  if (ctx.projectId && !allowed.includes(type)) {
    const result: AgentResult = {
      ok: false,
      output: null,
      message: `项目当前阶段 ${ctx.stage} 不允许调用 ${type}。允许的 Agent：${allowed.join("、")}`,
      error_code: "STAGE_BLOCKED",
      retryable: false,
    };
    await logRun(runId, ctx, type, input, result, Date.now() - t0, "blocked_by_stage");
    return { ...result, run_id: runId };
  }

  const fn = registry.get(type);
  if (!fn) {
    return { ok: false, output: null, message: `未知 Agent：${type}`, error_code: "INVALID_INPUT", retryable: false, run_id: runId };
  }

  try {
    const result = await fn(input, ctx);
    // 归一化错误码：Agent 未显式给出 error_code 时，从 message 推断；retryable 从码推断
    if (!result.ok) {
      const code = result.error_code || classifyAgentError(result.provider_error_code || result.message);
      result.error_code = code;
      if (result.retryable === undefined) result.retryable = isRetryable(code);
    }
    await logRun(runId, ctx, type, input, result, Date.now() - t0, "ok");
    // Artifact 落库：版本递增 + 方案变更自动级联失效下游
    if (result.ok && result.artifact_type) {
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

      // Partial 统一由落库层判定：只要本次运行出现过截断修复，一律 draft + 需人工确认，
      // 禁止自动 reviewed。不依赖每个 Agent 自己在 output 里塞 partial 字段。
      const partial = sawPartial();
      const humanReview = partial || result.human_review_required === true;
      const status = humanReview ? "draft" : "reviewed";
      const metadata = partial
        ? { partial_output: true, repair_applied: true, review_hint: "不完整输出，需要人工确认" }
        : undefined;

      await saveArtifact({
        projectId: ctx.projectId, type: result.artifact_type, content: result.output,
        createdBy: type, status,
        humanReviewRequired: humanReview,
        metadata,
        sourceArtifactIds: sourceIds, changeReason: `run:${type}`,
      });
      // 把落库层的判定回传给调用方（Worker/前端据此展示"需人工确认"）
      result.human_review_required = humanReview;
    }
    return { ...result, run_id: runId };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = classifyAgentError(msg);
    const result: AgentResult = { ok: false, output: null, message: msg, error_code: code, retryable: isRetryable(code) };
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


/** 标记本次 Agent 运行收到过不完整（截断修复）的模型输出 */
export function markPartial(): void {
  const c = currentAgentContext();
  if (c.partialSeen) c.partialSeen.value = true;
}

/** 本次 Agent 运行是否出现过 partial 输出 */
export function sawPartial(): boolean {
  return currentAgentContext().partialSeen?.value === true;
}
