import { neon } from "@neondatabase/serverless";

/**
 * Neon Postgres 数据层。
 * 对外保持与原 libsql 相同的接口：db().execute(sql | { sql, args }) → { rows }
 * 这样上层 21 处调用点无需改动；`?` 占位符在此处自动转换为 Postgres 的 $1..$n。
 */

type Stmt = string | { sql: string; args?: unknown[] };

let _sql: any = null;

function conn() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "缺少 DATABASE_URL。请在 Neon 控制台复制连接串（postgresql://...），本地写入 .env.local，线上配置到 Vercel 环境变量。"
    );
  }
  _sql = neon(url);
  return _sql;
}

function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function db() {
  return {
    async execute(stmt: Stmt): Promise<{ rows: Record<string, unknown>[] }> {
      const s = typeof stmt === "string" ? { sql: stmt, args: [] as unknown[] } : stmt;
      const rows = await conn().query(toPgPlaceholders(s.sql), (s.args ?? []) as unknown[]);
      return { rows: (Array.isArray(rows) ? rows : (rows?.rows ?? [])) as Record<string, unknown>[] };
    },
  };
}

/** 在单一数据库事务中执行一组语句（真事务：全成功或全回滚）。
 *
 *  Neon HTTP 的 neon() 是无状态的，BEGIN/COMMIT 分开发不共享会话，无法跨语句成事务。
 *  因此生产环境用 neon 的 Pool（有状态会话，支持真正的 BEGIN/COMMIT）。
 *  测试环境（pglite）本身有状态，直接在同一连接上 BEGIN/COMMIT 即可。
 *
 *  回调内 execute 立即执行并返回结果（可读取上一步 RETURNING），
 *  异常时整体 ROLLBACK。 */
export async function withTransaction<T>(fn: (tx: {
  execute(stmt: Stmt): Promise<{ rows: Record<string, unknown>[] }>;
}) => Promise<T>): Promise<T> {
  // pglite（测试）：conn() 已是有状态连接，直接用它跑 BEGIN/COMMIT
  if (process.env.PGLITE_TEST === "1" || !process.env.DATABASE_URL?.startsWith("postgres")) {
    return txOnConn(conn(), fn);
  }
  // 生产：用 neon Pool 取一个有状态 client
  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const clientConn = {
    query: async (sql: string, args: unknown[] = []) => {
      const r = await client.query(sql, args as any[]);
      return r.rows;
    },
  };
  try {
    return await txOnConn(clientConn, fn);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

async function txOnConn<T>(c: any, fn: (tx: {
  execute(stmt: Stmt): Promise<{ rows: Record<string, unknown>[] }>;
}) => Promise<T>): Promise<T> {
  const run = async (sql: string, args: unknown[] = []) => {
    const rows = await c.query(toPgPlaceholders(sql), args);
    return { rows: (Array.isArray(rows) ? rows : (rows?.rows ?? [])) as Record<string, unknown>[] };
  };
  const tx = {
    async execute(stmt: Stmt) {
      const s = typeof stmt === "string" ? { sql: stmt, args: [] as unknown[] } : stmt;
      return run(s.sql, (s.args ?? []) as unknown[]);
    },
  };
  await run("BEGIN");
  try {
    const result = await fn(tx);
    await run("COMMIT");
    return result;
  } catch (e) {
    await run("ROLLBACK").catch(() => { /* 回滚失败也要抛原始错误 */ });
    throw e;
  }
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  version TEXT DEFAULT '1.0.0',
  certification_status TEXT DEFAULT 'DRAFT',
  source_type TEXT DEFAULT 'lab',
  price DOUBLE PRECISION DEFAULT 0,
  data TEXT NOT NULL,
  downloads INTEGER DEFAULT 0,
  rating DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_modules_cat ON modules(category);
CREATE INDEX IF NOT EXISTS idx_modules_cert ON modules(certification_status);

CREATE TABLE IF NOT EXISTS module_reviews (
  review_id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  from_status TEXT, to_status TEXT,
  result TEXT NOT NULL,
  issues TEXT DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stage TEXT DEFAULT 'PREPARATION',
  problem_text TEXT,
  ezplm_project_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT,
  type TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  status TEXT DEFAULT 'draft',
  created_by TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_proj ON artifacts(project_id, type);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT,
  agent_type TEXT NOT NULL,
  objective TEXT,
  input TEXT, output TEXT,
  status TEXT DEFAULT 'ok',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  project_id TEXT, task_id TEXT,
  payload TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

export async function ensureSchema() {
  // 版本化迁移（lib/migrations.ts）；动态 import 避免循环依赖
  const { ensureMigrations } = await import("./migrations");
  await ensureMigrations();
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
