import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { usageSummary } from "@/lib/model-gateway";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (resolveTier(req) !== "admin") return NextResponse.json({ error: "需要管理员身份" }, { status: 403 });
  const days = Number(new URL(req.url).searchParams.get("days") || 1);
  await ensureSchema();
  const [summary, topUsers, cache] = await Promise.all([
    usageSummary({ days }),
    db().execute({
      sql: `SELECT owner, COUNT(*) n, SUM(estimated_cost) cost FROM llm_usage_events
            WHERE created_at > now() - (? || ' days')::interval AND owner IS NOT NULL
            GROUP BY owner ORDER BY cost DESC LIMIT 10`,
      args: [String(days)],
    }).catch(() => ({ rows: [] as any[] })),
    db().execute({
      sql: "SELECT COUNT(*) n, COALESCE(SUM(hit_count),0) hits FROM model_cache",
      args: [],
    }).catch(() => ({ rows: [{}] as any[] })),
  ]);
  return NextResponse.json({
    ...summary,
    topUsers: topUsers.rows.map((r: any) => ({ owner: String(r.owner).slice(0, 14) + "…", requests: Number(r.n), costUsd: Number(r.cost || 0) })),
    cache: { entries: Number(cache.rows[0]?.n || 0), hits: Number(cache.rows[0]?.hits || 0) },
    budgets: {
      perUserDaily: Number(process.env.PER_USER_DAILY_BUDGET_USD || 0) || null,
      perProjectDaily: Number(process.env.PER_PROJECT_DAILY_BUDGET_USD || 0) || null,
      globalDaily: Number(process.env.GLOBAL_DAILY_BUDGET_USD || 0) || null,
    },
  });
}
