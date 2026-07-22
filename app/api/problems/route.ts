import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { listProblems, createProblem, findByPdfHash, pdfHash } from "@/lib/problem-center";

export const runtime = "nodejs";

/** GET：普通用户只见已发布题目；管理员/实验室可见全部（含草稿与复核中） */
export async function GET(req: NextRequest) {
  const tier = resolveTier(req);
  const sp = new URL(req.url).searchParams;
  const staff = tier === "admin" || tier === "lab";
  const rows = await listProblems({
    publishedOnly: !staff,
    status: staff ? sp.get("status") || undefined : undefined,
    year: sp.get("year") ? Number(sp.get("year")) : undefined,
  });
  return NextResponse.json({ problems: rows, staff });
}

/** POST：工作人员创建题目条目（可带 PDF 文本或哈希，重复 PDF 会直接返回既有题目） */
export async function POST(req: NextRequest) {
  const tier = resolveTier(req);
  if (tier !== "admin" && tier !== "lab") {
    return NextResponse.json({ error: "仅工作人员可创建官方题目" }, { status: 403 });
  }
  const b = await req.json().catch(() => ({}));
  if (!b.year || !b.code || !b.title) {
    return NextResponse.json({ error: "需要 { year, code, title }" }, { status: 400 });
  }
  // 同一份 PDF 只解析一次：已存在直接复用
  if (b.data_base64) {
    const h = pdfHash(b.data_base64);
    const existing = await findByPdfHash(h);
    if (existing) {
      return NextResponse.json({ problem_id: existing.problem_id, existing: true, status: existing.status });
    }
  }
  const id = await createProblem({
    year: Number(b.year), code: String(b.code).toUpperCase(), title: b.title,
    groupName: b.group_name, rawText: b.raw_text,
    pdfHash: b.data_base64 ? pdfHash(b.data_base64) : undefined,
    createdBy: tier,
  });
  return NextResponse.json({ problem_id: id }, { status: 201 });
}
