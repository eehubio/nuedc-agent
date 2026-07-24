import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, dbDriver } from "@/lib/db";
import { resolveTier } from "@/lib/auth";
import { configuredProviders } from "@/lib/model-gateway";
import { getSystemMode } from "@/lib/system-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 就绪探针：检查依赖是否真正可用（数据库连通、迁移已应用、模型链路已配置）。
 *  公开部分只回 ok/fail，不泄露连接串与模型细节；
 *  管理员（或 CI 用 ADMIN_API_KEY）可看到快照，便于确认服务连的是哪个库、用的什么 Provider。 */
export async function GET(req: NextRequest) {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  let ready = true;

  // 1) 数据库连通与迁移状态
  try {
    await ensureSchema();
    const rs = await db().execute({ sql: "SELECT COUNT(*) AS n FROM schema_migrations", args: [] });
    const applied = Number((rs.rows[0] as any)?.n || 0);
    checks.database = { ok: applied > 0, detail: `${applied} 个迁移已应用` };
    if (applied === 0) ready = false;
  } catch (e: any) {
    checks.database = { ok: false, detail: String(e?.message || e).slice(0, 160) };
    ready = false;
  }

  // 2) 模型链路：至少配置一家 Provider（mock 也算，用于 CI）
  const providers = configuredProviders();
  checks.model_gateway = { ok: providers.length > 0, detail: `${providers.length} 家已配置` };
  if (!providers.length) ready = false;

  // 3) 任务队列可用性（Worker 未部署不算不就绪，但要能查）
  try {
    const rs = await db().execute({
      sql: "SELECT COUNT(*) AS n FROM agent_tasks WHERE status IN ('queued','running')", args: [],
    });
    checks.task_queue = { ok: true, detail: `${Number((rs.rows[0] as any)?.n || 0)} 个活动任务` };
  } catch {
    checks.task_queue = { ok: false, detail: "任务表不可访问" };
    ready = false;
  }

  const body: Record<string, unknown> = { ready, checks };

  // 管理员/CI 可见的运行快照
  if (resolveTier(req) === "admin") {
    body.snapshot = {
      mode: await getSystemMode(),
      providers,
      mock_enabled: process.env.ENABLE_MOCK_PROVIDER === "1",
      db_driver: dbDriver(),
      db_host: (() => {
        try { return new URL(process.env.DATABASE_URL || "").host || null; } catch { return null; }
      })(),
      worker_inline_allowed: process.env.ALLOW_INLINE_EXECUTE === "1",
      node: process.version,
    };
  }

  return NextResponse.json(body, { status: ready ? 200 : 503 });
}
