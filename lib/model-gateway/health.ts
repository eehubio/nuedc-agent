import { db, ensureSchema } from "../db";

/** Provider 健康与熔断。
 *  熔断条件：连续 5 次 429 / 5 分钟失败率 > 30% / 认证失败 / 模型不存在 / 区域限制。
 *  熔断后禁用 5 分钟，到期自动半开重试。 */

const BREAK_MS = 5 * 60_000;
const WINDOW_MS = 5 * 60_000;
const MAX_CONSECUTIVE_429 = 5;
const FAIL_RATE_THRESHOLD = 0.3;
const MIN_SAMPLES = 5;

export interface HealthRow {
  provider: string;
  status: "healthy" | "degraded" | "disabled";
  successRate: number;
  rate429: number;
  latencyP95: number;
  consecutive429: number;
  disabledUntil: string | null;
  samples: number;
}

export async function isAvailable(provider: string): Promise<boolean> {
  try {
    await ensureSchema();
    const rs = await db().execute({
      sql: "SELECT disabled_until FROM provider_health WHERE provider=?", args: [provider],
    });
    const until = rs.rows[0]?.disabled_until;
    if (!until) return true;
    return new Date(String(until)).getTime() <= Date.now();
  } catch { return true; }   // 健康表不可用时不阻断业务
}

/** 记录一次调用结果，并按规则判断是否熔断 */
export async function recordCall(opts: {
  provider: string; ok: boolean; latencyMs: number; errorCode?: string;
}): Promise<void> {
  try {
    await ensureSchema();
    const fatal = ["AUTH", "MODEL_NOT_FOUND", "REGION_BLOCKED"].includes(opts.errorCode || "");
    const is429 = opts.errorCode === "RATE_LIMIT";

    await db().execute({
      sql: `INSERT INTO provider_health (provider, status, consecutive_429, updated_at)
            VALUES (?, 'healthy', ?, now())
            ON CONFLICT (provider) DO UPDATE SET
              consecutive_429 = CASE WHEN ? THEN provider_health.consecutive_429 + 1 ELSE 0 END,
              updated_at = now()`,
      args: [opts.provider, is429 ? 1 : 0, is429],
    });

    // 认证/模型/区域类错误立即熔断（重试无意义）
    if (fatal) { await disable(opts.provider, `${opts.errorCode}`, 30 * 60_000); return; }

    const rs = await db().execute({
      sql: "SELECT consecutive_429 FROM provider_health WHERE provider=?", args: [opts.provider],
    });
    if (Number(rs.rows[0]?.consecutive_429 || 0) >= MAX_CONSECUTIVE_429) {
      await disable(opts.provider, "连续限流", BREAK_MS);
      return;
    }

    // 滑动窗口失败率
    const win = await db().execute({
      sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS fails
            FROM llm_usage_events WHERE provider=? AND created_at > now() - interval '5 minutes'`,
      args: [opts.provider],
    });
    const n = Number(win.rows[0]?.n || 0);
    const fails = Number(win.rows[0]?.fails || 0);
    if (n >= MIN_SAMPLES && fails / n > FAIL_RATE_THRESHOLD) {
      await disable(opts.provider, `${WINDOW_MS / 60000} 分钟失败率 ${(fails / n * 100).toFixed(0)}%`, BREAK_MS);
    }
  } catch { /* 健康记账失败不影响主流程 */ }
}

export async function disable(provider: string, reason: string, ms: number): Promise<void> {
  await db().execute({
    sql: `INSERT INTO provider_health (provider, status, disabled_until, last_error, updated_at)
          VALUES (?, 'disabled', now() + (? || ' milliseconds')::interval, ?, now())
          ON CONFLICT (provider) DO UPDATE SET
            status='disabled',
            disabled_until = now() + (? || ' milliseconds')::interval,
            last_error = EXCLUDED.last_error, updated_at = now()`,
    args: [provider, String(ms), reason.slice(0, 200), String(ms)],
  }).catch(() => {});
}

export async function enable(provider: string): Promise<void> {
  await db().execute({
    sql: `INSERT INTO provider_health (provider, status, disabled_until, consecutive_429, updated_at)
          VALUES (?, 'healthy', NULL, 0, now())
          ON CONFLICT (provider) DO UPDATE SET status='healthy', disabled_until=NULL, consecutive_429=0, updated_at=now()`,
    args: [provider],
  }).catch(() => {});
}

export async function healthSnapshot(): Promise<HealthRow[]> {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT h.provider, h.status, h.consecutive_429, h.disabled_until, h.last_error,
            COALESCE(s.n, 0) AS n, COALESCE(s.ok_n, 0) AS ok_n,
            COALESCE(s.r429, 0) AS r429, COALESCE(s.p95, 0) AS p95
          FROM provider_health h
          LEFT JOIN (
            SELECT provider, COUNT(*) AS n,
              SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS ok_n,
              SUM(CASE WHEN error_code='RATE_LIMIT' THEN 1 ELSE 0 END) AS r429,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
            FROM llm_usage_events WHERE created_at > now() - interval '15 minutes'
            GROUP BY provider
          ) s ON s.provider = h.provider`,
    args: [],
  });
  return rs.rows.map((r: any) => ({
    provider: String(r.provider),
    status: (r.disabled_until && new Date(String(r.disabled_until)).getTime() > Date.now()) ? "disabled" : String(r.status) as any,
    successRate: Number(r.n) ? Number(r.ok_n) / Number(r.n) : 1,
    rate429: Number(r.n) ? Number(r.r429) / Number(r.n) : 0,
    latencyP95: Math.round(Number(r.p95) || 0),
    consecutive429: Number(r.consecutive_429 || 0),
    disabledUntil: r.disabled_until ? String(r.disabled_until) : null,
    samples: Number(r.n),
  }));
}
