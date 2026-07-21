import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

// GET /api/report?project_id=xxx → 下载最新报告 Markdown
export async function GET(req: NextRequest) {
  await ensureSchema();
  const projectId = new URL(req.url).searchParams.get("project_id");
  if (!projectId) return NextResponse.json({ error: "缺少 project_id" }, { status: 400 });
  const rs = await db().execute({
    sql: "SELECT content FROM artifacts WHERE project_id=? AND type='report' ORDER BY created_at DESC LIMIT 1",
    args: [projectId],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "该项目还没有生成报告" }, { status: 404 });
  const content = JSON.parse(String(rs.rows[0].content));
  return new NextResponse(content.markdown || "", {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="design_report_${projectId}.md"`,
    },
  });
}
