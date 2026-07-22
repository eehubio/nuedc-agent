import { db, ensureSchema } from "./db";

/** 系统运行模式。模型不可用时降级而不是白屏。 */
export const SYSTEM_MODES = ["NORMAL", "DEGRADED", "RULES_ONLY", "READ_ONLY"] as const;
export type SystemMode = (typeof SYSTEM_MODES)[number];

export const MODE_LABEL: Record<SystemMode, string> = {
  NORMAL: "正常",
  DEGRADED: "降级（暂停低优先级 AI 任务）",
  RULES_ONLY: "仅规则（AI 生成暂停，项目编辑与规则工具正常）",
  READ_ONLY: "只读（仅查看与导出）",
};

let cached: { mode: SystemMode; at: number } | null = null;

export async function getSystemMode(): Promise<SystemMode> {
  // 10 秒本地缓存，避免每次调用都查库
  if (cached && Date.now() - cached.at < 10_000) return cached.mode;
  const envMode = process.env.SYSTEM_MODE as SystemMode | undefined;
  if (envMode && SYSTEM_MODES.includes(envMode)) { cached = { mode: envMode, at: Date.now() }; return envMode; }
  try {
    await ensureSchema();
    const rs = await db().execute({ sql: "SELECT value FROM system_config WHERE key='system_mode'", args: [] });
    const v = rs.rows.length ? String(rs.rows[0].value) : "NORMAL";
    const mode = (SYSTEM_MODES.includes(v as SystemMode) ? v : "NORMAL") as SystemMode;
    cached = { mode, at: Date.now() };
    return mode;
  } catch { return "NORMAL"; }
}

export async function setSystemMode(mode: SystemMode): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO system_config (key, value, updated_at) VALUES ('system_mode', ?, now())
          ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    args: [mode],
  });
  cached = { mode, at: Date.now() };
}

/** 当前模式下该优先级的任务是否允许执行 */
export function allowsPriority(mode: SystemMode, priority: number): { allowed: boolean; reason?: string } {
  if (mode === "READ_ONLY") return { allowed: false, reason: "系统处于只读模式，AI 生成暂停；可继续查看与导出。" };
  if (mode === "RULES_ONLY") return { allowed: false, reason: "AI 生成服务繁忙，已切换到仅规则模式。项目数据、模块库、BOM 编辑、接口检查、测试评分与报告编辑均可正常使用。" };
  if (mode === "DEGRADED" && priority >= 2) {
    return { allowed: false, reason: "当前使用人数较多，已暂停低优先级 AI 任务（备选方案、报告润色、一般问答）。主方案与代码修复不受影响。" };
  }
  return { allowed: true };
}

/** 高峰模式配置 */
export async function getPeakConfig() {
  const def = {
    enabled: false,
    maxGlobalHeavyConcurrency: Number(process.env.MAX_GLOBAL_HEAVY_CONCURRENCY || 20),
    maxPerUserConcurrency: Number(process.env.MAX_PER_USER_CONCURRENCY || 1),
    queueWarningThreshold: Number(process.env.QUEUE_WARNING_THRESHOLD || 20),
  };
  try {
    await ensureSchema();
    const rs = await db().execute({ sql: "SELECT value FROM system_config WHERE key='peak_mode'", args: [] });
    if (rs.rows.length) return { ...def, ...JSON.parse(String(rs.rows[0].value)) };
  } catch { /* 用默认值 */ }
  return def;
}
