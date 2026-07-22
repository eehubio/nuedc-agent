import { db, ensureSchema } from "./db";
import type { UserTier } from "./types";

/** 各能力的每日配额（按 tier）。-1 = 不限。 */
export const DAILY_QUOTA: Record<string, Record<UserTier, number>> = {
  pdf_extract: { free: 2, paid: 20, lab: -1, admin: -1 },
};

export function quotaFor(kind: string, tier: UserTier): number {
  return DAILY_QUOTA[kind]?.[tier] ?? 0;
}

/** 今日已用次数（UTC 日界，够用且实现简单） */
export async function usedToday(owner: string, kind: string): Promise<number> {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT COUNT(*) AS n FROM llm_usage WHERE owner=? AND kind=? AND created_at >= date_trunc('day', now())",
    args: [owner, kind],
  });
  return Number(rs.rows[0]?.n || 0);
}

export async function recordUsage(owner: string, kind: string, detail?: string): Promise<void> {
  await db().execute({
    sql: "INSERT INTO llm_usage (owner, kind, detail) VALUES (?,?,?)",
    args: [owner, kind, (detail || "").slice(0, 500)],
  });
}

/** 检查并占用一次配额。超限返回拒绝原因。 */
export async function checkAndConsume(owner: string, kind: string, tier: UserTier): Promise<string | null> {
  const quota = quotaFor(kind, tier);
  if (quota === -1) { await recordUsage(owner, kind); return null; }
  if (quota === 0) return "该能力未对当前账户开放";
  const used = await usedToday(owner, kind);
  if (used >= quota) return `今日配额已用完（${used}/${quota}）。付费账户配额更高；明日自动重置。`;
  await recordUsage(owner, kind);
  return null;
}
