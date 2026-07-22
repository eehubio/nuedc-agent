import { NextRequest, NextResponse } from "next/server";
import "@/lib/agents/index";
import { runAgent } from "@/lib/agents/base";
import { db, ensureSchema } from "@/lib/db";
import type { AgentType, ProjectStage } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 点火：原子认领 queued 任务并同步执行（每次尝试在 agent_runs 各留一条执行日志）。 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const claim = await db().execute({
    sql: "UPDATE agent_tasks SET status='running', attempts=attempts+1, updated_at=now() WHERE task_id=? AND status='queued' RETURNING agent_type, project_id, input, tier, cancel_requested",
    args: [params.id],
  });
  if (!claim.rows.length) {
    const rs = await db().execute({ sql: "SELECT status FROM agent_tasks WHERE task_id=?", args: [params.id] });
    if (!rs.rows.length) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
    return NextResponse.json({ task_id: params.id, status: rs.rows[0].status });   // 幂等
  }

  const row = claim.rows[0];
  const agent = String(row.agent_type) as AgentType;
  const input = row.input ? JSON.parse(String(row.input)) : {};
  const tier = String(row.tier || "free") as any;
  const projectId = row.project_id ? String(row.project_id) : null;

  let stage: ProjectStage = "PREPARATION";
  if (projectId) {
    const rs = await db().execute({ sql: "SELECT stage FROM projects WHERE project_id=?", args: [projectId] });
    if (rs.rows.length) stage = String(rs.rows[0].stage) as ProjectStage;
  }

  try {
    const result = await runAgent(agent, input, { projectId, stage, tier });
    // 执行期间被请求取消：结果作废，状态记 canceled（LLM 调用无法中途打断，只能事后作废）
    const c = await db().execute({ sql: "SELECT cancel_requested FROM agent_tasks WHERE task_id=?", args: [params.id] });
    const canceled = Number(c.rows[0]?.cancel_requested || 0) === 1;
    await db().execute({
      sql: "UPDATE agent_tasks SET status=?, output=?, error=?, last_run_id=?, updated_at=now() WHERE task_id=?",
      args: [canceled ? "canceled" : result.ok ? "ok" : "error", JSON.stringify(result),
        canceled ? "已取消（结果作废）" : result.ok ? null : result.message || "failed", result.run_id || null, params.id],
    });
    return NextResponse.json({ task_id: params.id, status: canceled ? "canceled" : result.ok ? "ok" : "error" });
  } catch (e: any) {
    await db().execute({
      sql: "UPDATE agent_tasks SET status='error', error=?, updated_at=now() WHERE task_id=?",
      args: [String(e?.message || e).slice(0, 2000), params.id],
    }).catch(() => {});
    return NextResponse.json({ task_id: params.id, status: "error" });
  }
}
