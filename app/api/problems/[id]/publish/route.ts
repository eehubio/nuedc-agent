import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { publishVersion, getDraftVersion, publicationChecklist } from "@/lib/problem-center";

export const runtime = "nodejs";

/** 发布标准题目。发布后用户项目引用它，不再调用模型解析。 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (tier !== "admin") return NextResponse.json({ error: "仅管理员可发布官方题目" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const versionId = b.version_id || (await getDraftVersion(params.id) as any)?.version_id;
  if (!versionId) return NextResponse.json({ error: "没有可发布的版本" }, { status: 404 });

  const r = await publishVersion(String(versionId), `admin:${tier}`, b.override === true);
  if (!r.ok) return NextResponse.json({ error: r.error, checklist: r.checklist }, { status: 409 });
  return NextResponse.json({ ok: true, version_id: versionId, checklist: r.checklist });
}

/** GET：查看发布清单（发布前预检） */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (tier !== "admin" && tier !== "lab") return NextResponse.json({ error: "需要工作人员身份" }, { status: 403 });
  const versionId = new URL(req.url).searchParams.get("version_id")
    || (await getDraftVersion(params.id) as any)?.version_id;
  if (!versionId) return NextResponse.json({ error: "没有版本" }, { status: 404 });
  return NextResponse.json(await publicationChecklist(String(versionId)));
}
