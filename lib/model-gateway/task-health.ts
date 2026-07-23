import { db, ensureSchema } from "../db";

/** Provider × Model × TaskType 的分维度质量健康。
 *
 *  痛点：一个 Provider 可能 HTTP 一直 200，但对某个 TaskType 的 JSON 解析或 Schema
 *  校验长期失败 —— 传输层健康表（health.ts）看不出问题，仍会把它选给该 TaskType。
 *
 *  本模块按五个维度分别计数（按小时滚动窗口）：
 *    transport（传输是否 200） / parse（能否解析 JSON） / schema（是否通过校验）
 *    timeout / 429
 *  并据此判定「某 Provider 是否还应承担某 TaskType」。 */

const WINDOW_MS = 60 * 60_000;        // 1 小时窗口
const LOOKBACK_MS = 3 * 60 * 60_000;  // 判定时回看 3 小时
const MIN_SAMPLES = 8;                 // 样本不足不下结论（避免冷启动误判）
const SCHEMA_FLOOR = 0.5;              // schema 成功率低于此值 → 停止承担该 TaskType
const PARSE_FLOOR = 0.5;

export type HealthDimension = "transport" | "parse" | "schema" | "timeout" | "rate429";

function windowStart(now = Date.now()): string {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS).toISOString();
}

/** 记录一次调用在某维度的结果。ok 仅对 transport/parse/schema 有意义。 */
export async function recordTaskCall(opts: {
  provider: string; model: string; taskType: string;
  dimension: HealthDimension; ok?: boolean;
}): Promise<void> {
  try {
    await ensureSchema();
    const ws = windowStart();
    const okInc = opts.ok ? 1 : 0;
    const cols: Record<HealthDimension, { ok?: string; total?: string; counter?: string }> = {
      transport: { ok: "transport_ok", total: "transport_total" },
      parse: { ok: "parse_ok", total: "parse_total" },
      schema: { ok: "schema_ok", total: "schema_total" },
      timeout: { counter: "timeout_n" },
      rate429: { counter: "rate429_n" },
    };
    const c = cols[opts.dimension];
    // 构造 upsert 的自增片段
    let setInit = "";
    let setUpd = "";
    const args: any[] = [opts.provider, opts.model, opts.taskType, ws];
    if (c.counter) {
      setInit = `${c.counter}`;
      // INSERT 值列与冲突更新
      await db().execute({
        sql: `INSERT INTO provider_task_health (provider, model, task_type, window_start, ${c.counter}, updated_at)
              VALUES (?,?,?,?, 1, now())
              ON CONFLICT (provider, model, task_type, window_start)
              DO UPDATE SET ${c.counter} = provider_task_health.${c.counter} + 1, updated_at = now()`,
        args,
      });
      return;
    }
    // ok/total 维度
    await db().execute({
      sql: `INSERT INTO provider_task_health (provider, model, task_type, window_start, ${c.total}, ${c.ok}, updated_at)
            VALUES (?,?,?,?, 1, ?, now())
            ON CONFLICT (provider, model, task_type, window_start)
            DO UPDATE SET ${c.total} = provider_task_health.${c.total} + 1,
                          ${c.ok} = provider_task_health.${c.ok} + ?,
                          updated_at = now()`,
      args: [...args, okInc, okInc],
    });
  } catch { /* 健康记账失败不影响主流程 */ }
}

export interface TaskHealth {
  samples: number;
  transportRate: number;
  parseRate: number;
  schemaRate: number;
  timeoutRate: number;
  rate429: number;
}

/** 聚合某 provider+model+taskType 最近若干小时的分维度成功率 */
export async function taskHealth(provider: string, model: string, taskType: string): Promise<TaskHealth> {
  await ensureSchema();
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const rs = await db().execute({
    sql: `SELECT
            COALESCE(SUM(transport_total),0) tt, COALESCE(SUM(transport_ok),0) to_,
            COALESCE(SUM(parse_total),0) pt, COALESCE(SUM(parse_ok),0) po,
            COALESCE(SUM(schema_total),0) st, COALESCE(SUM(schema_ok),0) so,
            COALESCE(SUM(timeout_n),0) tn, COALESCE(SUM(rate429_n),0) rn
          FROM provider_task_health
          WHERE provider=? AND model=? AND task_type=? AND window_start >= ?`,
    args: [provider, model, taskType, since],
  }).catch(() => ({ rows: [{}] as any[] }));
  const r: any = rs.rows[0] || {};
  const tt = Number(r.tt || 0), st = Number(r.st || 0), pt = Number(r.pt || 0);
  return {
    samples: tt,
    transportRate: tt ? Number(r.to_) / tt : 1,
    parseRate: pt ? Number(r.po) / pt : 1,
    schemaRate: st ? Number(r.so) / st : 1,
    timeoutRate: tt ? Number(r.tn) / tt : 0,
    rate429: tt ? Number(r.rn) / tt : 0,
  };
}

/** 该 Provider 是否仍应承担该 TaskType。
 *  样本充足且 schema/parse 成功率低于阈值 → 返回 false（即便 HTTP 一直 200）。 */
export async function taskTypeHealthy(provider: string, model: string, taskType: string): Promise<boolean> {
  try {
    const h = await taskHealth(provider, model, taskType);
    if (h.samples < MIN_SAMPLES) return true;        // 样本不足，不下结论
    if (h.schemaRate < SCHEMA_FLOOR) return false;   // schema 长期失败
    if (h.parseRate < PARSE_FLOOR) return false;     // 解析长期失败
    return true;
  } catch { return true; }
}

/** 运营后台快照：列出各 provider×model×taskType 的分维度健康 */
export async function taskHealthSnapshot(): Promise<Array<TaskHealth & { provider: string; model: string; taskType: string; healthy: boolean }>> {
  await ensureSchema();
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const rs = await db().execute({
    sql: `SELECT provider, model, task_type,
            SUM(transport_total) tt, SUM(transport_ok) to_,
            SUM(parse_total) pt, SUM(parse_ok) po,
            SUM(schema_total) st, SUM(schema_ok) so,
            SUM(timeout_n) tn, SUM(rate429_n) rn
          FROM provider_task_health WHERE window_start >= ?
          GROUP BY provider, model, task_type
          ORDER BY provider, task_type`,
    args: [since],
  }).catch(() => ({ rows: [] as any[] }));
  return (rs.rows as any[]).map((r) => {
    const tt = Number(r.tt || 0), st = Number(r.st || 0), pt = Number(r.pt || 0);
    const schemaRate = st ? Number(r.so) / st : 1;
    const parseRate = pt ? Number(r.po) / pt : 1;
    return {
      provider: String(r.provider), model: String(r.model), taskType: String(r.task_type),
      samples: tt,
      transportRate: tt ? Number(r.to_) / tt : 1,
      parseRate, schemaRate,
      timeoutRate: tt ? Number(r.tn) / tt : 0,
      rate429: tt ? Number(r.rn) / tt : 0,
      healthy: tt < MIN_SAMPLES ? true : (schemaRate >= SCHEMA_FLOOR && parseRate >= PARSE_FLOOR),
    };
  });
}
