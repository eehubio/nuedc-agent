import { vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/** 真·内存 Postgres 集成测试底座。
 *
 *  lib/db.ts 通过 neon(url) 得到一个 query(sql, params) 函数，并把 `?` 占位符
 *  转成 $1..$n 后调用它。我们用 pglite（进程内 Postgres）替换 neon，从而让
 *  ON CONFLICT / interval / 部分唯一索引 / FOR UPDATE 等真实 SQL 语义被完整执行，
 *  而不是靠字符串匹配「假装」测过。
 *
 *  用法：
 *    import { setupMockDb } from "./helpers/mock-db";
 *    const ctx = await setupMockDb();      // 建库 + 跑全部迁移
 *    ...
 *    await ctx.reset();                    // 每个用例前清空数据
 */

export interface MockDbContext {
  pg: PGlite;
  reset: () => Promise<void>;
  raw: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

let active: PGlite | null = null;

/** neon() 的替身：真实 neon 返回的对象既可作 tagged-template 调用，也带 .query(sql, params)。
 *  lib/db.ts 用的是 conn().query(sql, params)，所以这里挂一个 query 方法转发到 pglite。 */
function neonShim(): any {
  const query = async (sql: string, params: unknown[] = []) => {
    if (!active) throw new Error("mock db not initialized");
    const res = await active.query(sql, params as any[]);
    return res.rows;
  };
  const fn: any = (...args: any[]) => query(String(args[0]));
  fn.query = query;
  return fn;
}

// 顶层 mock：vitest 会把它提升到所有 import 之前执行
vi.mock("@neondatabase/serverless", () => ({ neon: () => neonShim() }));

export async function setupMockDb(): Promise<MockDbContext> {
  // 必须在 import lib/db 之前把 DATABASE_URL 设好，否则 conn() 会抛错
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://mock/mock";
  // 让 withTransaction 走 pglite 有状态路径，而非 neon Pool
  process.env.PGLITE_TEST = "1";

  // 同一测试文件内复用同一个 pglite 实例与已跑过的迁移
  if (!active) {
    active = new PGlite();
    const { ensureMigrations } = await import("@/lib/migrations");
    await ensureMigrations();
  }

  return {
    pg: active,
    raw: async (sql, params = []) => {
      const res = await active!.query(sql, params as any[]);
      return { rows: res.rows as any[] };
    },
    reset: async () => {
      // 只清空「已存在」的业务表，避免因引用尚未建的表（迁移未到）导致整条 TRUNCATE 失败
      const want = [
        "agent_tasks", "artifacts", "artifact_dependencies", "llm_usage", "llm_usage_events",
        "quota_counters", "provider_health", "model_cache", "agent_runs",
        "problem_versions", "problem_requirements", "problem_scoring_items", "problem_notes",
        "problem_reviews", "problem_review_diffs", "official_problems", "projects",
        "worker_heartbeats", "provider_task_health",
      ];
      const existing = await active!.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
        [want],
      );
      const names = (existing.rows as any[]).map((r) => r.table_name);
      if (names.length) {
        await active!.exec(`TRUNCATE ${names.join(", ")} RESTART IDENTITY CASCADE;`);
      }
    },
  };
}

/** 关闭并释放实例（afterAll） */
export async function teardownMockDb(): Promise<void> {
  if (active) { await active.close().catch(() => {}); active = null; }
}
