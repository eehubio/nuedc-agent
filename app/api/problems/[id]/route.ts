import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { getProblem, saveExtraction } from "@/lib/problem-center";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const p = await getProblem(params.id);
  if (!p) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  const tier = resolveTier(req);
  const staff = tier === "admin" || tier === "lab";
  if (p.status !== "published" && !staff) {
    return NextResponse.json({ error: "该题目尚未发布" }, { status: 403 });
  }
  // 普通用户不返回原始 PDF 文本（版权），只给结构化结果
  if (!staff) delete (p as any).raw_text;
  return NextResponse.json({ problem: p });
}

/** 工作人员编辑提取结果（人工确认环节） */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (tier !== "admin" && tier !== "lab") return NextResponse.json({ error: "仅工作人员可编辑" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  await saveExtraction(params.id, {
    requirements: b.requirements, scoringItems: b.scoring_items,
    notes: b.notes, reportRequirements: b.report_requirements,
  });
  return NextResponse.json({ ok: true });
}
