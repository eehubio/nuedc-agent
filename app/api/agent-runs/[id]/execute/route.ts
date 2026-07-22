import { NextRequest, NextResponse } from "next/server";
import "@/lib/agents/index";
import { runAgent } from "@/lib/agents/base";
import { db, ensureSchema } from "@/lib/db";
import type { AgentType, ProjectStage } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 点火端点：认领 queued 任务并同步执行。
 *  原子认领（WHERE status='queued'）防止重复点击重复执行、重复扣费。 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const claim = await db().execute({
    sql: "UPDATE agent_runs SET status='running' WHERE run_id=? AND status='queued' RETURNING run_id, agent_type, project_id, input, objective",
    args: [params.id],
  });
  if (!claim.rows.length) {
    // 已被认领或不存在 —— 幂等返回当前状态
    const rs = await db().execute({ sql: "SELECT status FROM agent_runs WHERE run_id=?", args: [params.id] });
    if (!rs.rows.length) return NextResponse.json({ error: "运行不存在" }, { status: 404 });
    return NextResponse.json({ run_id: params.id, status: rs.rows[0].status });
  }

  const row = claim.rows[0];
  const agent = String(row.agent_type) as AgentType;
  const input = row.input ? JSON.parse(String(row.input)) : {};
  const tier = (() => { try { return JSON.parse(String(row.objective || "{}")).tier || "free"; } catch { return "free"; } })();
  const projectId = row.project_id ? String(row.project_id) : null;

  let stage: ProjectStage = "PREPARATION";
  if (projectId) {
    const rs = await db().execute({ sql: "SELECT stage FROM projects WHERE project_id=?", args: [projectId] });
    if (rs.rows.length) stage = String(rs.rows[0].stage) as ProjectStage;
  }

  try {
    const result = await runAgent(agent, input, { projectId, stage, tier });
    await db().execute({
      sql: "UPDATE agent_runs SET status=?, output=?, error=? WHERE run_id=?",
      args: [result.ok ? "ok" : "error", JSON.stringify(result), result.ok ? null : result.message || "failed", params.id],
    });
    return NextResponse.json({ run_id: params.id, status: result.ok ? "ok" : "error" });
  } catch (e: any) {
    await db().execute({
      sql: "UPDATE agent_runs SET status='error', error=? WHERE run_id=?",
      args: [String(e?.message || e).slice(0, 2000), params.id],
    }).catch(() => {});
    return NextResponse.json({ run_id: params.id, status: "error" });
  }
}
