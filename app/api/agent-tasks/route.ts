import { NextRequest, NextResponse } from "next/server";
import { resolveTier, resolveTierAsync, resolveOwner, assertProjectAccess } from "@/lib/auth";
import { db, ensureSchema, uid } from "@/lib/db";
import type { AgentType } from "@/lib/types";
import { AGENT_TYPES } from "@/lib/types";

export const runtime = "nodejs";

/** 任务层（与 agent_runs 执行日志分离）：
 *  POST 建任务（幂等键去重）；GET ?project_id=&active=1 列活动任务（刷新恢复用）。 */
export async function POST(req: NextRequest) {
  const tier = await resolveTierAsync(req);
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

  // 并发去重：同项目同 Agent 已有活动任务 → 直接返回该任务（防止连点两下并行烧两次 LLM）
  if (projectId) {
    const act = await db().execute({
      sql: "SELECT task_id, status FROM agent_tasks WHERE project_id=? AND agent_type=? AND status IN ('queued','running') LIMIT 1",
      args: [projectId, agent],
    });
    if (act.rows.length) return NextResponse.json({ task_id: act.rows[0].task_id, status: act.rows[0].status, deduped: true }, { status: 200 });
  }

  // 幂等：同 key 已有任务直接返回，防重复扣费
  if (body.idempotency_key) {
    const ex = await db().execute({ sql: "SELECT task_id, status FROM agent_tasks WHERE idempotency_key=?", args: [body.idempotency_key] });
    if (ex.rows.length) return NextResponse.json({ task_id: ex.rows[0].task_id, status: ex.rows[0].status, deduped: true }, { status: 200 });
  }

  const taskId = uid("TASK");
  const model = process.env.LLM_PROVIDER === "gemini" ? (process.env.GEMINI_MODEL || "gemini-2.0-flash")
    : process.env.LLM_PROVIDER === "openai" ? (process.env.OPENAI_MODEL || "gpt-4o-mini")
    : (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6");
  await db().execute({
    sql: "INSERT INTO agent_tasks (task_id, project_id, agent_type, status, input, tier, idempotency_key, model) VALUES (?,?,?,?,?,?,?,?)",
    args: [taskId, projectId, agent, "queued", JSON.stringify(body.input || {}), tier, body.idempotency_key || null, model],
  });
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
