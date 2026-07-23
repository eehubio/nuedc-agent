import { NextRequest, NextResponse } from "next/server";
import { resolveOwner, assertProjectAccess } from "@/lib/auth";
import { getRequestIdentity } from "@/lib/identity";
import { db, ensureSchema, uid } from "@/lib/db";
import type { AgentType } from "@/lib/types";
import { AGENT_TYPES } from "@/lib/types";

export const runtime = "nodejs";

/** 任务层（与 agent_runs 执行日志分离）：
 *  POST 建任务（幂等键去重）；GET ?project_id=&active=1 列活动任务（刷新恢复用）。 */
export async function POST(req: NextRequest) {
  const id = await getRequestIdentity(req);
  const tier = id.tier;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 }); }

  const agent = body.agent as AgentType;
  if (!AGENT_TYPES.includes(agent)) return NextResponse.json({ error: `未知 agent` }, { status: 400 });
  const paidAgents: AgentType[] = ["code_generator", "report_composer", "labsight_debug"];
  if (tier === "free" && paidAgents.includes(agent)) return NextResponse.json({ error: "该能力需要付费账户。" }, { status: 402 });

  await ensureSchema();
  const projectId: string | null = body.project_id || null;
  if (projectId) {
    const denied = await assertProjectAccess(req, projectId);
    if (denied) return denied;
  }

  // taskType 与优先级来自策略表；inputHash + 去重键严格限定到本用户/项目/agent/Tier
  const { AGENT_TASK_TYPE, policyFor } = await import("@/lib/model-gateway/task-policy");
  const { modelGateway } = await import("@/lib/model-gateway");
  const taskType = AGENT_TASK_TYPE[agent] || "GENERAL_QA";
  const policy = policyFor(taskType as any);
  const hash = modelGateway.inputHash(taskType, { input: body.input || {}, project: projectId });
  // 去重键把「相同输入」限定在同一 owner+project+agent+tier 之内，杜绝跨用户命中
  const dedupKey = modelGateway.taskDedupKey({
    ownerRef: id.owner, projectId, agentType: agent, tier, inputHash: hash,
  });

  // 幂等键：按用户唯一（迁移 16 的 UNIQUE(owner_ref, idempotency_key)）。
  // 不同用户可用相同 key，互不覆盖。
  if (body.idempotency_key) {
    const ex = await db().execute({
      sql: "SELECT task_id, status FROM agent_tasks WHERE owner_ref=? AND idempotency_key=?",
      args: [id.owner, body.idempotency_key],
    });
    if (ex.rows.length) return NextResponse.json({ task_id: ex.rows[0].task_id, status: ex.rows[0].status, deduped: true, reason: "idempotency_key" }, { status: 200 });
  }

  // 每用户重型任务并发上限
  const { getPeakConfig } = await import("@/lib/system-mode");
  const peak = await getPeakConfig();
  if (policy.concurrencyClass === "heavy") {
    const running = await db().execute({
      sql: `SELECT COUNT(*) n FROM agent_tasks WHERE owner_ref=? AND status IN ('queued','running')
              AND task_type IN (SELECT unnest(?::text[]))`,
      args: [id.owner, `{${Object.entries(AGENT_TASK_TYPE).filter(([, t]) => policyFor(t as any).concurrencyClass === "heavy").map(([, t]) => t).join(",")}}`],
    }).catch(() => ({ rows: [{ n: 0 }] as any[] }));
    if (Number(running.rows[0]?.n || 0) >= peak.maxPerUserConcurrency) {
      return NextResponse.json({
        error: `你已有 ${running.rows[0].n} 个生成任务在进行中，请等待完成后再提交（每人同时最多 ${peak.maxPerUserConcurrency} 个重型任务）。`,
      }, { status: 429 });
    }
  }

  // 系统模式门禁：降级/仅规则模式下明确拒绝并说明仍可用的能力
  const { getSystemMode, allowsPriority } = await import("@/lib/system-mode");
  const mode = await getSystemMode();
  const gate = allowsPriority(mode, policy.priority);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason, system_mode: mode, degraded: true }, { status: 503 });
  }

  // 配额预占与任务绑定：任务终态时统一 commit/refund，Worker 崩溃也不会重复扣费
  const taskId = uid("TASK");
  let quotaRef: string | null = null;
  const quotaKind = policy.costClass === "high" ? "heavy_task" : null;
  if (quotaKind) {
    const { reserveQuota } = await import("@/lib/usage");
    const { reservation, error: qerr } = await reserveQuota(id.owner, quotaKind, tier);
    if (!reservation) return NextResponse.json({ error: qerr }, { status: 429 });
    quotaRef = reservation.ref;
  }
  // 模型名不在建单时臆测（选路由网关在执行时决定，可能容灾切换）——执行完成后回写实际值
  const model: string | null = null;

  // 原子幂等去重：依赖迁移 16 的两个唯一约束
  //   1) 部分唯一索引 idx_tasks_active_dedup: UNIQUE(dedup_key) WHERE status IN ('queued','running')
  //   2) idx_tasks_idem_owner: UNIQUE(owner_ref, idempotency_key)
  // ON CONFLICT 只能声明一个冲突目标，因此 dedup_key 走 ON CONFLICT DO NOTHING，
  // idempotency_key 的唯一冲突由 catch 捕获 —— 两条并发请求都通过了上面的 SELECT 时，
  // 其中一条必然在这里撞唯一约束，必须退还它预占的配额并返回既有任务，而不是抛 500。
  let ins: { rows: Record<string, unknown>[] };
  let idemConflict = false;
  try {
    ins = await db().execute({
      sql: `INSERT INTO agent_tasks (task_id, project_id, agent_type, status, input, tier, idempotency_key, model,
              task_type, priority, input_hash, dedup_key, owner_ref, queue_name, cost_class, quota_ref, quota_kind, scheduled_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, now())
            ON CONFLICT (dedup_key) WHERE status IN ('queued','running') AND dedup_key IS NOT NULL DO NOTHING
            RETURNING task_id`,
      args: [taskId, projectId, agent, "queued", JSON.stringify(body.input || {}), tier, body.idempotency_key || null, model,
        taskType, policy.priority, hash, dedupKey, id.owner, policy.concurrencyClass, policy.costClass, quotaRef, quotaKind],
    });
  } catch (e: any) {
    // 23505 = unique_violation。判定是否为 idempotency_key 冲突（约束名或列名匹配）
    const msg = String(e?.message || e);
    const code = String(e?.code || "");
    if (code === "23505" || /duplicate key|unique constraint|already exists/i.test(msg)) {
      idemConflict = true;
      ins = { rows: [] };
    } else {
      // 非唯一冲突的意外错误：退还预占，避免配额泄漏
      if (quotaRef && quotaKind) {
        const { refundQuota } = await import("@/lib/usage");
        await refundQuota(id.owner, quotaKind, quotaRef).catch(() => {});
      }
      throw e;
    }
  }

  if (idemConflict) {
    // 并发幂等冲突：退还本次预占，返回先到那一条已存在的任务（同一个 task_id）
    if (quotaRef && quotaKind) {
      const { refundQuota } = await import("@/lib/usage");
      await refundQuota(id.owner, quotaKind, quotaRef).catch(() => {});
    }
    const exist = await db().execute({
      sql: "SELECT task_id, status FROM agent_tasks WHERE owner_ref=? AND idempotency_key=?",
      args: [id.owner, body.idempotency_key || null],
    });
    if (exist.rows.length) {
      return NextResponse.json({ task_id: exist.rows[0].task_id, status: exist.rows[0].status, deduped: true, reason: "idempotency_key" }, { status: 200 });
    }
    // 极端竞态：冲突行在两句之间消失，让客户端重试（不返回 500）
    return NextResponse.json({ error: "任务提交冲突，请重试" }, { status: 409 });
  }

  if (!ins.rows.length) {
    // 去重命中：已有活动任务在跑。退还刚预占的配额，返回既有任务。
    if (quotaRef && quotaKind) {
      const { refundQuota } = await import("@/lib/usage");
      await refundQuota(id.owner, quotaKind, quotaRef);
    }
    const exist = await db().execute({
      sql: `SELECT task_id, status FROM agent_tasks
            WHERE dedup_key=? AND status IN ('queued','running')
            ORDER BY created_at DESC LIMIT 1`,
      args: [dedupKey],
    });
    if (exist.rows.length) {
      return NextResponse.json({ task_id: exist.rows[0].task_id, status: exist.rows[0].status, deduped: true, reason: "active_dedup" }, { status: 200 });
    }
    // 极端竞态：活动任务在两句之间已终态 —— 让客户端重试
    return NextResponse.json({ error: "任务提交冲突，请重试" }, { status: 409 });
  }
  return NextResponse.json({ task_id: taskId, status: "queued", model }, { status: 202 });
}

export async function GET(req: NextRequest) {
  await ensureSchema();
  const sp = new URL(req.url).searchParams;
  const projectId = sp.get("project_id");
  if (!projectId) return NextResponse.json({ error: "缺少 project_id" }, { status: 400 });
  const denied = await assertProjectAccess(req, projectId);
  if (denied) return denied;
  const active = sp.get("active") === "1";
  const rs = await db().execute({
    sql: active
      ? "SELECT task_id, agent_type, status, attempts, created_at FROM agent_tasks WHERE project_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 10"
      : "SELECT task_id, agent_type, status, attempts, error, created_at FROM agent_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 30",
    args: [projectId],
  });
  return NextResponse.json({ tasks: rs.rows });
}
