import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db, ensureSchema } from "./db";
import { resolveTier, resolveOwner } from "./auth";
import type { UserTier } from "./types";

/** 统一身份（诊断第五节）：所有 API 只调这一个函数，消除三套 tier 判断。 */
export interface Identity {
  owner: string;
  tier: UserTier;
  source: "admin_key" | "admin_session" | "ezplm" | "entitlement" | "anonymous";
  isNewOwner: boolean;
}

export async function getRequestIdentity(req: NextRequest): Promise<Identity> {
  const base = resolveTier(req);          // admin cookie / ADMIN_API_KEY / ezPLM 头
  const { owner, isNew } = resolveOwner(req);
  if (base !== "free") {
    const source = req.headers.get("x-api-key") ? (base === "admin" ? "admin_key" : "ezplm") : "admin_session";
    return { owner, tier: base, source, isNewOwner: isNew };
  }
  // 权益表：兑换码/订阅授予的 tier（支持到期与撤销）
  try {
    await ensureSchema();
    const rs = await db().execute({
      sql: `SELECT tier FROM user_entitlements
            WHERE owner=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
            ORDER BY granted_at DESC LIMIT 1`,
      args: [owner],
    });
    if (rs.rows.length) {
      return { owner, tier: String(rs.rows[0].tier) as UserTier, source: "entitlement", isNewOwner: isNew };
    }
  } catch { /* 数据库不可用时降级为 free */ }
  return { owner, tier: "free", source: "anonymous", isNewOwner: isNew };
}

/** 首次访问的匿名身份需要下发 cookie */
export function withIdentityCookie<T extends NextResponse>(res: T, id: Identity): T {
  if (id.isNewOwner && id.owner.startsWith("anon:")) {
    res.cookies.set("nuedc_uid", id.owner, { httpOnly: true, sameSite: "lax", maxAge: 400 * 24 * 3600, path: "/" });
  }
  return res;
}
