import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { db, ensureSchema, uid } from "@/lib/db";
import type { AgentType, ProjectStage } from "@/lib/types";
import { AGENT_TYPES } from "@/lib/types";

export const runtime = "nodejs";

/** 异步 Agent 运行 · 两段式（不依赖 waitUntil，可移植且可靠）：
 *  1) POST /api/agent-runs        —— 落一条 queued 任务，秒回 run_id
 *  2) POST /api/agent-runs/:id/execute —— 前端点火，普通函数内同步执行（maxDuration 300）
 *  3) GET  /api/agent-runs/:id    —— 轮询状态；页面刷新也不丢任务 */
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
  const taskId = uid("TASK");
  const model = process.env.LLM_PROVIDER === "gemini" ? (process.env.GEMINI_MODEL || "gemini-2.0-flash")
    : process.env.LLM_PROVIDER === "openai" ? (process.env.OPENAI_MODEL || "gpt-4o-mini")
    : (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6");
  await db().execute({
    sql: "INSERT INTO agent_runs (run_id, project_id, agent_type, objective, input, status, model) VALUES (?,?,?,?,?,?,?)",
    args: [taskId, body.project_id || null, agent, JSON.stringify({ tier }), JSON.stringify(body.input || {}), "queued", model],
  });
  return NextResponse.json({ run_id: taskId, status: "queued", model }, { status: 202 });
}
