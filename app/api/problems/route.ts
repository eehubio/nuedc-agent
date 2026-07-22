import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { listProblems, createProblem, createDraftVersion, findVersionByPdf, pdfSha256 } from "@/lib/problem-center";

export const runtime = "nodejs";

const isStaff = (t: string) => t === "admin" || t === "lab";

/** GET：普通用户只见已发布题目；工作人员可见全部 */
export async function GET(req: NextRequest) {
  const staff = isStaff(resolveTier(req));
  const sp = new URL(req.url).searchParams;
  const rows = await listProblems({
    publishedOnly: !staff,
    year: sp.get("year") ? Number(sp.get("year")) : undefined,
  });
  return NextResponse.json({ problems: rows, staff });
}

/** POST：工作人员创建题目。带 PDF 时同一份文件不重复解析。 */
export async function POST(req: NextRequest) {
  const tier = resolveTier(req);
  if (!isStaff(tier)) return NextResponse.json({ error: "仅工作人员可创建官方题目" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  if (!b.year || !b.code || !b.title) {
    return NextResponse.json({ error: "需要 { year, code, title }" }, { status: 400 });
  }

  if (b.data_base64) {
    const sha = pdfSha256(b.data_base64);
    const existing = await findVersionByPdf(sha);
    if (existing) {
      return NextResponse.json({
        problem_id: (existing as any).problem_id, version_id: (existing as any).version_id,
        existing: true, message: "同一份 PDF 已解析过，直接复用已有版本",
      });
    }
  }

  const problemId = await createProblem({
    year: Number(b.year), code: b.code, title: b.title, groupName: b.group_name, createdBy: tier,
  });
  const versionId = await createDraftVersion(problemId, {
    rawText: b.raw_text,
    pdfSha: b.data_base64 ? pdfSha256(b.data_base64) : undefined,
  });
  return NextResponse.json({ problem_id: problemId, version_id: versionId }, { status: 201 });
}
