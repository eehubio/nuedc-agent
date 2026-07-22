import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { healthSnapshot, routingSnapshot, enableProvider, disableProvider } from "@/lib/model-gateway";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (resolveTier(req) !== "admin") return NextResponse.json({ error: "需要管理员身份" }, { status: 403 });
  await ensureSchema();
  const [health, routing, queue] = await Promise.all([
    healthSnapshot(),
    routingSnapshot(),
    db().execute({
      sql: `SELECT status, priority, COUNT(*) n FROM agent_tasks
            WHERE created_at > now() - interval '1 hour' GROUP BY status, priority ORDER BY priority`,
      args: [],
    }).catch(() => ({ rows: [] as any[] })),
  ]);
  return NextResponse.json({
    health, routing,
    queue: queue.rows.map((r: any) => ({ status: r.status, priority: Number(r.priority), count: Number(r.n) })),
  });
}

/** 手工启用/禁用 Provider */
export async function POST(req: NextRequest) {
  if (resolveTier(req) !== "admin") return NextResponse.json({ error: "需要管理员身份" }, { status: 403 });
  const { provider, action, minutes } = await req.json().catch(() => ({}));
  if (!provider || !["enable", "disable"].includes(action)) {
    return NextResponse.json({ error: "需要 { provider, action: enable|disable }" }, { status: 400 });
  }
  if (action === "enable") await enableProvider(provider);
  else await disableProvider(provider, "管理员手工禁用", (minutes || 60) * 60_000);
  return NextResponse.json({ ok: true });
}
