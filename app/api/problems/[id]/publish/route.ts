import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { publishProblem } from "@/lib/problem-center";

export const runtime = "nodejs";

/** 发布标准题目。发布后用户项目引用它，不再调用模型解析。 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (tier !== "admin") return NextResponse.json({ error: "仅管理员可发布官方题目" }, { status: 403 });
  const r = await publishProblem(params.id, tier);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
