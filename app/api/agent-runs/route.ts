import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import "@/lib/agents/index";
import { runAgent } from "@/lib/agents/base";
import { resolveTier } from "@/lib/auth";
import { db, ensureSchema, uid } from "@/lib/db";
import type { AgentType, ProjectStage } from "@/lib/types";
import { AGENT_TYPES } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 异步 Agent 运行（诊断 5.3）：
 *  POST 立即返回 run_id，实际执行由 waitUntil 在后台继续，
 *  前端轮询 GET /api/agent-runs/:id。避免 120s 长请求被浏览器/网关掐断、
 *  重复点击重复扣费、中断后无法恢复。 */
export async function POST(req: NextRequest) {
  const tier = resolveTier(req);
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 }); }

  const agent = body.agent as AgentType;
  if (!AGENT_TYPES.includes(agent)) {
    return NextResponse.json({ error: `未知 agent，可选：${AGENT_TYPES.join(", ")}` }, { status: 400 });
  }
  const paidAgents: AgentType[] = ["code_generator", "report_composer", "labsight_debug"];
  if (tier === "free" && paidAgents.includes(agent)) {
    return NextResponse.json({ error: "该能力需要付费账户。" }, { status: 402 });
  }

  await ensureSchema();
  let stage: ProjectStage = "PREPARATION";
  const projectId: string | null = body.project_id || null;
  if (projectId) {
    const rs = await db().execute({ sql: "SELECT stage FROM projects WHERE project_id=?", args: [projectId] });
    if (rs.rows.length) stage = String(rs.rows[0].stage) as ProjectStage;
  }

  // 排队记录（runAgent 内部会另写一条完成记录；这条是任务壳，run_id 即凭据）
  const taskId = uid("TASK");
  const model = process.env.LLM_PROVIDER === "gemini" ? (process.env.GEMINI_MODEL || "gemini-2.0-flash")
    : process.env.LLM_PROVIDER === "openai" ? (process.env.OPENAI_MODEL || "gpt-4o-mini")
    : (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6");
  await db().execute({
    sql: "INSERT INTO agent_runs (run_id, project_id, agent_type, objective, input, status, model) VALUES (?,?,?,?,?,?,?)",
    args: [taskId, projectId, agent, "async", JSON.stringify(body.input || {}).slice(0, 20000), "running", model],
  });

  waitUntil((async () => {
    try {
      const result = await runAgent(agent, body.input || {}, { projectId, stage, tier });
      await db().execute({
        sql: "UPDATE agent_runs SET status=?, output=?, error=? WHERE run_id=?",
        args: [result.ok ? "ok" : "error", JSON.stringify(result), result.ok ? null : result.message || "failed", taskId],  // Postgres TEXT 无需截断；截断会切坏 JSON
      });
    } catch (e: any) {
      await db().execute({
        sql: "UPDATE agent_runs SET status='error', error=? WHERE run_id=?",
        args: [String(e?.message || e).slice(0, 2000), taskId],
      }).catch(() => {});
    }
  })());

  return NextResponse.json({ run_id: taskId, status: "running", model }, { status: 202 });
}
