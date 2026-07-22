import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getRequestIdentity, withIdentityCookie } from "@/lib/identity";
import { db, ensureSchema } from "@/lib/db";
import { DAILY_QUOTA, quotaFor } from "@/lib/usage";

export const runtime = "nodejs";

const MAX_ATTEMPTS_PER_HOUR = 5;   // 兑换码爆破防护（诊断 P0-4）

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export async function GET(req: NextRequest) {
  await ensureSchema();
  const id = await getRequestIdentity(req);
  const usage = await db().execute({
    sql: `SELECT kind, used FROM quota_counters WHERE owner=? AND day=CURRENT_DATE`,
    args: [id.owner],
  }).catch(() => ({ rows: [] as any[] }));

  const ent = await db().execute({
    sql: `SELECT tier, source, granted_at, expires_at FROM user_entitlements
          WHERE owner=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          ORDER BY granted_at DESC LIMIT 1`,
    args: [id.owner],
  }).catch(() => ({ rows: [] as any[] }));

  return withIdentityCookie(NextResponse.json({
    owner_masked: id.owner.slice(0, 12) + "…",
    tier: id.tier,
    source: id.source,
    entitlement: ent.rows[0] || null,
    capabilities: {
      code_generation: id.tier !== "free",
      report_generation: id.tier !== "free",
      debug_assistant: id.tier !== "free",
      asset_download: ["paid", "lab", "admin"].includes(id.tier),
      module_upload: id.tier !== "free",
    },
    quotas: Object.fromEntries(Object.keys(DAILY_QUOTA).map((k) => {
      const limit = quotaFor(k, id.tier);
      const used = Number(usage.rows.find((r: any) => r.kind === k)?.used || 0);
      return [k, { used, limit: limit === -1 ? null : limit }];
    })),
    upgrade_available: id.tier === "free",
  }), id);
}

/** 兑换码升级：优先查 access_codes 表（支持次数/有效期/撤销），
 *  回退到 PAID_ACCESS_CODE 环境变量（单机部署便捷方案）。带每小时尝试次数限制。 */
export async function POST(req: NextRequest) {
  await ensureSchema();
  const id = await getRequestIdentity(req);
  const { access_code } = await req.json().catch(() => ({}));
  const code = String(access_code || "").trim();
  if (!code) return NextResponse.json({ error: "请输入兑换码" }, { status: 400 });

  // 防爆破：同一 owner 每小时最多 5 次失败尝试
  const att = await db().execute({
    sql: "SELECT COUNT(*) AS n FROM redeem_attempts WHERE owner=? AND ok=0 AND created_at > now() - interval '1 hour'",
    args: [id.owner],
  }).catch(() => ({ rows: [{ n: 0 }] as any[] }));
  if (Number(att.rows[0]?.n || 0) >= MAX_ATTEMPTS_PER_HOUR) {
    return NextResponse.json({ error: "尝试次数过多，请 1 小时后再试" }, { status: 429 });
  }

  const hash = hashCode(code);
  let grantTier: string | null = null;
  let source = "access_code";

  // 1) 数据库兑换码（原子占用一次，防并发超发）
  const claim = await db().execute({
    sql: `UPDATE access_codes SET used_count = used_count + 1
          WHERE code_hash = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND (max_uses IS NULL OR used_count < max_uses)
          RETURNING tier`,
    args: [hash],
  }).catch(() => ({ rows: [] as any[] }));
  if (claim.rows.length) grantTier = String(claim.rows[0].tier);

  // 2) 环境变量兜底
  if (!grantTier && process.env.PAID_ACCESS_CODE) {
    const envHash = hashCode(process.env.PAID_ACCESS_CODE);
    if (envHash === hash) { grantTier = "paid"; source = "env_code"; }
  }

  await db().execute({
    sql: "INSERT INTO redeem_attempts (owner, ok) VALUES (?, ?)",
    args: [id.owner, grantTier ? 1 : 0],
  }).catch(() => {});

  if (!grantTier) return NextResponse.json({ error: "兑换码无效、已过期或已用完" }, { status: 401 });

  await db().execute({
    sql: "INSERT INTO user_entitlements (owner, tier, source) VALUES (?,?,?)",
    args: [id.owner, grantTier, source],
  });
  return withIdentityCookie(NextResponse.json({ ok: true, tier: grantTier }), id);
}
