import { NextRequest, NextResponse } from "next/server";
import { assertProjectAccess } from "@/lib/auth";
import { getProblem } from "@/lib/problem-center";
import { saveArtifact } from "@/lib/artifacts";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

/** 项目采用官方题目：直接复制已发布的结构化需求与评分项。
 *  全程不调用任何模型 —— 这是"同一题目只解析一次"的落地点。 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  const { problem_id } = await req.json().catch(() => ({}));
  if (!problem_id) return NextResponse.json({ error: "需要 problem_id" }, { status: 400 });

  const p = await getProblem(problem_id);
  if (!p) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  if (p.status !== "published") return NextResponse.json({ error: "该题目尚未发布" }, { status: 409 });

  await ensureSchema();
  await db().execute({
    sql: "UPDATE projects SET problem_id=?, problem_version=?, name=?, stage='REQUIREMENTS_PARSED', updated_at=now() WHERE project_id=?",
    args: [problem_id, p.problem_version, `${p.year} 年 ${p.code} 题 · ${p.title}`, params.id],
  });

  // 需求进入项目产物（用户仍需逐条确认，但不消耗模型）
  const content = {
    project_name: `${p.year} 年 ${p.code} 题：${p.title}`,
    system_overview: p.notes || "",
    requirements: p.requirements,
    scoring_items: p.scoring_items,
    ambiguities: [],
    source: { problem_id, problem_version: p.problem_version, official: true },
  };
  const saved = await saveArtifact({
    projectId: params.id, type: "requirements", content,
    createdBy: "official_problem", changeReason: `采用官方题目 ${p.year}-${p.code} v${p.problem_version}`,
  });

  return NextResponse.json({
    ok: true, ...saved,
    requirements: p.requirements.length,
    scoring_items: p.scoring_items.length,
    llm_calls: 0,
  }, { status: 201 });
}
