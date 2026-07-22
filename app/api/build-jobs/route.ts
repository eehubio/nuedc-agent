import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, uid } from "@/lib/db";
import { assertProjectAccess, resolveTier } from "@/lib/auth";
import { validateBuildFiles } from "@/lib/build-limits";

export const runtime = "nodejs";

const BUILD_TARGETS = ["mspm0", "stm32", "esp32"];

/** 编译任务：POST 提交（queued）→ 由执行器（CI / 本地 npm run build:runner）编译并回写
 *  日志、Flash/RAM 占用与 ELF/BIN。Vercel 无交叉工具链，执行器在有工具链的环境跑。 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.target || !BUILD_TARGETS.includes(body.target)) {
    return NextResponse.json({ error: `target 必须是 ${BUILD_TARGETS.join(" / ")}` }, { status: 400 });
  }
  const bad = validateBuildFiles(body.files || []);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  await ensureSchema();
  if (body.project_id) {
    const denied = await assertProjectAccess(req, body.project_id);
    if (denied) return denied;
  }
  const id = uid("BUILD");
  await db().execute({
    sql: "INSERT INTO build_jobs (job_id, project_id, target, status, files) VALUES (?,?,?,?,?)",
    args: [id, body.project_id || null, body.target, "queued", JSON.stringify(body.files)],
  });
  return NextResponse.json({ job_id: id, status: "queued" }, { status: 202 });
}

/** GET ?project_id= 列任务；?claim=1（执行器专用，需 admin）原子认领最老的 queued 任务 */
export async function GET(req: NextRequest) {
  await ensureSchema();
  const sp = new URL(req.url).searchParams;
  if (sp.get("claim") === "1") {
    if (resolveTier(req) !== "admin") return NextResponse.json({ error: "认领需要 ADMIN_API_KEY" }, { status: 403 });
    const rs = await db().execute({
      sql: `UPDATE build_jobs SET status='running', claimed_by=?, updated_at=now()
            WHERE job_id = (SELECT job_id FROM build_jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
            AND status='queued'
            RETURNING job_id, target, files, project_id`,
      args: [sp.get("runner") || "runner"],
    });
    return NextResponse.json({ job: rs.rows[0] || null });
  }
  const projectId = sp.get("project_id");
  if (!projectId) return NextResponse.json({ error: "缺少 project_id" }, { status: 400 });
  const denied = await assertProjectAccess(req, projectId);
  if (denied) return denied;
  const rs = await db().execute({
    sql: "SELECT job_id, target, status, flash_bytes, ram_bytes, created_at, updated_at FROM build_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 10",
    args: [projectId],
  });
  return NextResponse.json({ jobs: rs.rows });
}
