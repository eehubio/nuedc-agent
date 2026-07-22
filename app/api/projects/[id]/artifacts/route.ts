import { NextRequest, NextResponse } from "next/server";
import { assertProjectAccess } from "@/lib/auth";
import { saveArtifact, listVersions } from "@/lib/artifacts";

export const runtime = "nodejs";

/** GET ?type=xxx → 该类型版本列表；POST {type, content} → 存为新版本
 *  （前端的需求编辑、方案确认、测试记录都经此持久化） */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  const type = new URL(req.url).searchParams.get("type");
  if (!type) return NextResponse.json({ error: "缺少 type" }, { status: 400 });
  return NextResponse.json({ versions: await listVersions(params.id, type) });
}

const SAVABLE = new Set(["requirements", "solution", "solution_proposal", "bom", "integration_report", "code_bundle", "test_plan", "test_record", "score", "report"]);

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body?.type || body.content === undefined) return NextResponse.json({ error: "需要 { type, content }" }, { status: 400 });
  if (!SAVABLE.has(body.type)) return NextResponse.json({ error: `不支持的产物类型：${body.type}` }, { status: 400 });
  const saved = await saveArtifact({ projectId: params.id, type: body.type, content: body.content, createdBy: "user_edit" });
  return NextResponse.json(saved, { status: 201 });
}
