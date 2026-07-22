import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { getProblem, saveExtraction, diffExtractions, saveDiffs } from "@/lib/problem-center";
import { modelGateway } from "@/lib/model-gateway";
import { problemInterpretationSchema } from "@/lib/agent-schemas";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const EXTRACT_PROMPT = `你是电赛赛题结构化专家。把赛题原文拆成可核对的结构化数据。
1. requirements：逐条列出，区分 priority（mandatory=基本要求 / bonus=发挥部分）
2. 量化指标写入 target + unit，允许误差写入 tolerance（如 "±1%" / "≤5cm"）
3. source 必须引用赛题原文对应表述，不要改写；题面带【第N页】标记时把页码写入 source_page
4. scoring_items 只能来自题面评分表：题面写明分值的 points_type="official" 并填 points；
   题面有评分项但未写分值的 points=null 且 points_type="estimated"；禁止编造分值
5. 每个评分项用 requirement_ids 关联到对应 REQ 编号
6. ambiguities 列出题面未明确、需要出题方澄清的点
只输出 JSON。`;

/** 双模复核提取：Provider A 提取 → Provider B 复核 → 程序对比差异 → 待人工确认。
 *  这是唯一允许默认双模型的场景（后台工作人员任务），普通用户请求不走这条路径。 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (tier !== "admin" && tier !== "lab") return NextResponse.json({ error: "仅工作人员可执行提取" }, { status: 403 });

  const p = await getProblem(params.id);
  if (!p) return NextResponse.json({ error: "题目不存在" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const text: string = body.raw_text || p.raw_text || "";
  const pdfBase64: string | undefined = body.data_base64;
  if (!text && !pdfBase64) return NextResponse.json({ error: "缺少题面文本或 PDF" }, { status: 400 });

  const schema = z.object({ ...problemInterpretationSchema.shape });
  const dual = body.dual_review !== false;   // 默认双模复核

  // 第一遍：主提取（有 PDF 走多模态，否则纯文本）
  const runA = await modelGateway.run({
    taskType: pdfBase64 ? "PDF_EXTRACT" : "PROBLEM_STRUCTURE",
    system: EXTRACT_PROMPT,
    messages: [{ role: "user", content: text ? `赛题原文：\n${text.slice(0, 30000)}` : "请提取该赛题 PDF 的结构化需求与评分项" }],
    pdfBase64,
    schema,
    owner: `staff:${tier}`,
    problemVersion: `${params.id}:v${p.problem_version}`,
    allowCache: true,
  });
  if (!runA.ok || !runA.output) {
    return NextResponse.json({ error: runA.message || "提取失败", degraded: runA.degraded }, { status: 502 });
  }
  const a: any = runA.output;

  await saveExtraction(params.id, {
    requirements: a.requirements || [],
    scoringItems: a.scoring_items || [],
    rawText: text || undefined,
  });

  if (!dual) {
    return NextResponse.json({
      ok: true, provider_a: runA.provider, dual_review: false,
      requirements: a.requirements?.length || 0, scoring_items: a.scoring_items?.length || 0,
    });
  }

  // 第二遍：换一家 Provider 复核（明确排除第一家）
  const runB = await modelGateway.run({
    taskType: "PROBLEM_STRUCTURE",
    system: EXTRACT_PROMPT + "\n注意：这是独立复核，请依据原文自行提取，不要参考他人结果。",
    messages: [{ role: "user", content: text ? `赛题原文：\n${text.slice(0, 30000)}` : "请提取该赛题的结构化需求与评分项" }],
    schema,
    owner: `staff:${tier}`,
    providerHint: pickOther(runA.provider),
    allowCache: false,     // 复核必须真跑，不能命中第一遍的缓存
  });

  if (!runB.ok || !runB.output) {
    return NextResponse.json({
      ok: true, provider_a: runA.provider, dual_review: false,
      warning: `复核未成功（${runB.message}），已保存主提取结果，请人工逐条核对`,
      requirements: a.requirements?.length || 0,
    });
  }

  const b: any = runB.output;
  const diffs = diffExtractions(
    { requirements: a.requirements || [], scoring_items: a.scoring_items || [] },
    { requirements: b.requirements || [], scoring_items: b.scoring_items || [] },
  );
  await saveDiffs(params.id, diffs, runA.provider, runB.provider);

  return NextResponse.json({
    ok: true, dual_review: true,
    provider_a: runA.provider, provider_b: runB.provider,
    requirements: a.requirements?.length || 0,
    scoring_items: a.scoring_items?.length || 0,
    diffs: diffs.length,
    critical_diffs: diffs.filter((d) => d.severity === "critical").length,
  });
}

function pickOther(used: string): string | null {
  const chain = (process.env.MODEL_PROVIDER_FALLBACK || "").split(",").map((s) => s.trim()).filter(Boolean);
  const primary = process.env.MODEL_PROVIDER_PRIMARY || "gemini";
  const all = [primary, ...chain];
  return all.find((p) => p !== used) || null;
}
