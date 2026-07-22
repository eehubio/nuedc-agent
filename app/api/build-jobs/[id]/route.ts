import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { assertProjectAccess, resolveTier } from "@/lib/auth";

export const runtime = "nodejs";

/** GET 任务详情（含日志；?bin=1 下载 BIN）；PATCH 执行器回写结果（需 admin） */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const rs = await db().execute({ sql: "SELECT * FROM build_jobs WHERE job_id=?", args: [params.id] });
  if (!rs.rows.length) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const j = rs.rows[0];
  if (j.project_id) {
    const denied = await assertProjectAccess(req, String(j.project_id));
    if (denied) return denied;
  }
  const sp = new URL(req.url).searchParams;
  if (sp.get("bin") === "1" && j.bin_b64) {
    return new NextResponse(Buffer.from(String(j.bin_b64), "base64"), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="firmware-${params.id}.bin"` },
    });
  }
  const { files, elf_b64, bin_b64, ...rest } = j as any;
  return NextResponse.json({ ...rest, has_elf: !!elf_b64, has_bin: !!bin_b64 });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (resolveTier(req) !== "admin") return NextResponse.json({ error: "回写需要 ADMIN_API_KEY" }, { status: 403 });
  await ensureSchema();
  const b = await req.json().catch(() => ({}));
  await db().execute({
    sql: `UPDATE build_jobs SET status=?, log=?, flash_bytes=?, ram_bytes=?, elf_b64=?, bin_b64=?, updated_at=now() WHERE job_id=?`,
    args: [b.status || "failed", (b.log || "").slice(0, 200000), b.flash_bytes ?? null, b.ram_bytes ?? null,
      b.elf_b64 || null, b.bin_b64 || null, params.id],
  });
  return NextResponse.json({ ok: true });
}
