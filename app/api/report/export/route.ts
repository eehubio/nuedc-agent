import { NextRequest, NextResponse } from "next/server";
import { assertProjectAccess } from "@/lib/auth";
import { latestArtifacts, saveArtifact } from "@/lib/artifacts";
import { markdownToDocxBuffer } from "@/lib/report-export";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 报告导出：?format=md|docx，内容取项目最新 report 产物（或请求体传入的编辑后正文）。
 *  PDF 由前端打印视图生成（浏览器原生导出，中文字体最可靠）。 */
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const projectId = sp.get("project_id");
  if (!projectId) return NextResponse.json({ error: "缺少 project_id" }, { status: 400 });
  const denied = await assertProjectAccess(req, projectId);
  if (denied) return denied;

  const latest = await latestArtifacts(projectId);
  const rep = latest.find((a) => a.type === "report");
  const md: string = rep?.content?.markdown || rep?.content?.content || "";
  if (!md) return NextResponse.json({ error: "该项目还没有生成报告" }, { status: 404 });

  const title = rep?.content?.title || "电赛设计报告";
  const format = sp.get("format") || "md";
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "docx") {
    const buf = await markdownToDocxBuffer(md, title);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${title}-${stamp}.docx`)}`,
      },
    });
  }
  return new NextResponse(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${title}-${stamp}.md`)}`,
    },
  });
}

/** 保存用户编辑后的报告正文（存为新版本，可回溯） */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.project_id || typeof body.markdown !== "string") {
    return NextResponse.json({ error: "需要 { project_id, markdown }" }, { status: 400 });
  }
  const denied = await assertProjectAccess(req, body.project_id);
  if (denied) return denied;

  const latest = await latestArtifacts(body.project_id);
  const prev = latest.find((a) => a.type === "report");
  const content = { ...(prev?.content || {}), markdown: body.markdown, edited_by_user: true };
  const saved = await saveArtifact({
    projectId: body.project_id, type: "report", content,
    createdBy: "user_edit", changeReason: "手动编辑报告正文",
  });
  return NextResponse.json(saved, { status: 201 });
}
