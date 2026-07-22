import { NextRequest, NextResponse } from "next/server";
import { resolveTier, resolveOwner, withOwnerCookie, safeEqualStr } from "@/lib/auth";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

/** 账户与套餐。
 *  GET  → 当前身份、tier、可用能力、今日用量
 *  POST { access_code } → 用兑换码升级为 paid（码由 PAID_ACCESS_CODE 环境变量配置）
 *  正式收费接入 ezPLM 后由其下发 X-User-Tier，此处仅为独立部署时的过渡方案。 */
export async function GET(req: NextRequest) {
  await ensureSchema();
  const { owner, isNew } = resolveOwner(req);
  const tier = await effectiveTier(req, owner);
  const usage = await db().execute({
    sql: "SELECT kind, COUNT(*) AS n FROM llm_usage WHERE owner=? AND created_at >= date_trunc('day', now()) GROUP BY kind",
    args: [owner],
  }).catch(() => ({ rows: [] as any[] }));
  return withOwnerCookie(NextResponse.json({
    owner_masked: owner.slice(0, 12) + "…",
    tier,
    capabilities: {
      code_generation: tier !== "free",
      report_generation: tier !== "free",
      debug_assistant: tier !== "free",
      asset_download: tier === "paid" || tier === "lab" || tier === "admin",
      module_upload: tier !== "free",
    },
    usage_today: Object.fromEntries(usage.rows.map((r: any) => [r.kind, Number(r.n)])),
    upgrade_available: !!process.env.PAID_ACCESS_CODE && tier === "free",
  }), owner, isNew);
}

export async function POST(req: NextRequest) {
  const expected = process.env.PAID_ACCESS_CODE;
  if (!expected) return NextResponse.json({ error: "本部署未开启兑换码升级（未配置 PAID_ACCESS_CODE）" }, { status: 400 });
  const { access_code } = await req.json().catch(() => ({}));
  if (!safeEqualStr(String(access_code || ""), expected)) {
    return NextResponse.json({ error: "兑换码不正确" }, { status: 401 });
  }
  await ensureSchema();
  const { owner, isNew } = resolveOwner(req);
  await db().execute({
    sql: `INSERT INTO llm_usage (owner, kind, detail) VALUES (?, 'tier_grant', 'paid')`,
    args: [owner],
  });
  return withOwnerCookie(NextResponse.json({ ok: true, tier: "paid" }), owner, isNew);
}

/** 有效 tier：管理员/ezPLM 头 > 兑换码授予 > free */
async function effectiveTier(req: NextRequest, owner: string) {
  const base = resolveTier(req);
  if (base !== "free") return base;
  const rs = await db().execute({
    sql: "SELECT 1 AS x FROM llm_usage WHERE owner=? AND kind='tier_grant' LIMIT 1",
    args: [owner],
  }).catch(() => ({ rows: [] as any[] }));
  return rs.rows.length ? "paid" : "free";
}
