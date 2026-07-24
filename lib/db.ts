import { neon } from "@neondatabase/serverless";
import { ensureMigrations } from "./migrations";

/**
 * Neon Postgres 数据层。
 * 对外保持与原 libsql 相同的接口：db().execute(sql | { sql, args }) → { rows }
 * 这样上层 21 处调用点无需改动；`?` 占位符在此处自动转换为 Postgres 的 $1..$n。
 */

type Stmt = string | { sql: string; args?: unknown[] };

/** 可执行 SQL 的对象：既可以是全局 db()，也可以是事务内的 tx。
 *  需要「既能独立调用、又能参与外部事务」的函数应接受一个 Executor 参数，
 *  默认取 db()，在事务中由调用方传入 tx —— 否则函数内部的读取会走另一条连接，
 *  看不到事务内的未提交改动，也不受 FOR UPDATE 锁保护（脏读 / 快照不一致）。 */
export interface Executor {
  execute(stmt: Stmt): Promise<{ rows: Record<string, unknown>[] }>;
}

let _sql: any = null;

/** 数据库驱动种类。
 *  neon_http     —— Neon 的 HTTP /sql API（Vercel 生产用，Serverless 友好）
 *  postgres_pool —— node-postgres 的 TCP 连接池（CI、自建 Postgres）
 *  pglite        —— 进程内 Postgres（测试）
 *
 *  显式配置优先；未配置时才按 DATABASE_URL 自动判断。
 *  普通查询与事务必须解析到同一种驱动 —— 否则会出现"查询走 A、事务走 B"，
 *  事务里看不到查询写入的数据。 */
export type DbDriver = "neon_http" | "postgres_pool" | "pglite";

/** 是否为 Neon 云端点。
 *  neon() 是 HTTP 驱动，只能连 Neon 的 /sql API —— 它会把 host 拼成
 *  https://api.<host>/sql。指向标准 Postgres（如 CI 里的 127.0.0.1:5432）
 *  会得到 "Failed to parse URL from https://api.0.0.1/sql" 这类错误。 */
function isNeonHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)neon\.(tech|build)$/i.test(h) || /neon\.tech$/i.test(h);
  } catch {
    return false;
  }
}

/** 解析当前应使用的驱动。查询路径与事务路径都调用它，保证一致。 */
export function resolveDbDriver(): DbDriver {
  const explicit = (process.env.DB_DRIVER || "").trim().toLowerCase();
  if (explicit) {
    if (explicit === "neon_http" || explicit === "postgres_pool" || explicit === "pglite") {
      return explicit;
    }
    throw new Error(
      `DB_DRIVER 取值非法：${explicit}。可选：neon_http | postgres_pool | pglite`
    );
  }
  // 未显式配置：向后兼容的自动判断
  if (process.env.PGLITE_TEST === "1") return "pglite";
  const url = process.env.DATABASE_URL || "";
  if (!url.startsWith("postgres")) return "pglite";
  return isNeonHost(url) ? "neon_http" : "postgres_pool";
}

/** 标准 Postgres（CI / 自建）走 node-postgres 的 Pool。
 *  不能用 @neondatabase/serverless 的 Pool —— 它基于 WebSocket，
 *  同样连不上普通的 TCP Postgres。pg 已在 dependencies，
 *  因此 npm ci --omit=dev 的生产环境也能加载。 */
function pgPoolConn(url: string) {
  let Pool: any;
  try {
    ({ Pool } = require("pg"));
  } catch {
    throw new Error(
      "DB_DRIVER=postgres_pool 需要 node-postgres 驱动，但 require(\"pg\") 失败。请确认 pg 在 dependencies 中。"
    );
  }
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.DB_POOL_CONN_TIMEOUT_MS || 10_000),
  });
  pool.on?.("error", (e: any) => console.error("[pg pool] idle client error:", e?.message || e));
  _queryPool = pool;
  return {
    query: async (sql: string, args: unknown[] = []) => {
      const r = await pool.query(sql, args as any[]);
      return r.rows;
    },
  };
}

let _queryPool: any = null;

function conn() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "缺少 DATABASE_URL。请在 Neon 控制台复制连接串（postgresql://...），本地写入 .env.local，线上配置到 Vercel 环境变量。"
    );
  }
  const driver = resolveDbDriver();
  // pglite（测试）：neon 模块已被 mock 成进程内 Postgres，必须走 neon() 这条分支
  if (driver === "pglite" || driver === "neon_http") {
    _sql = neon(url);
    return _sql;
  }
  _sql = pgPoolConn(url);
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

/* ============ 事务连接池（进程级共享） ============ */

let _pool: any = null;
let _poolClosing = false;

/** 事务用的进程级共享连接池。
 *
 *  旧实现每次事务 new Pool + pool.end：每笔事务都要完整建连（TLS 握手 + 认证），
 *  在 Worker 并发场景下既慢又会把 Neon 的连接数打满。改为进程级共享：
 *  Web 实例与 Worker 进程各自维护一个，事务只做 connect/release。 */
export function txPool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("缺少 DATABASE_URL");
  // 与 conn() 同理：Neon 云端用其 WebSocket Pool，标准 Postgres 用 node-postgres
  // 与 conn() 使用同一套驱动解析，保证查询与事务落在同一种驱动上
  const driver = resolveDbDriver();
  const { Pool } = driver === "neon_http" ? require("@neondatabase/serverless") : require("pg");
  _pool = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 10),                     // 连接上限
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS || 30_000),      // 空闲回收
    connectionTimeoutMillis: Number(process.env.DB_POOL_CONN_TIMEOUT_MS || 10_000), // 取连接超时
  });
  _pool.on?.("error", (e: any) => {
    // 池内空闲连接报错不应崩进程（Neon 会主动断开空闲连接）
    console.error("[txPool] idle client error:", e?.message || e);
  });
  return _pool;
}

/** 进程退出时关闭连接池（Worker 的 SIGTERM 处理里调用） */
export async function closeTxPool(): Promise<void> {
  if (_queryPool) {
    try { await _queryPool.end(); } catch { /* 忽略 */ }
    _queryPool = null;
    _sql = null;
  }
  if (!_pool || _poolClosing) return;
  _poolClosing = true;
  try { await _pool.end(); } catch { /* 关闭失败不阻塞退出 */ }
  _pool = null;
  _poolClosing = false;
}

/** 连接池观测指标（readiness / 压测用） */
export function txPoolStats(): { total: number; idle: number; waiting: number; max: number } | null {
  if (!_pool) return null;
  return {
    total: Number(_pool.totalCount ?? 0),
    idle: Number(_pool.idleCount ?? 0),
    waiting: Number(_pool.waitingCount ?? 0),
    max: Number(process.env.DB_POOL_MAX || 10),
  };
}

/** 在单一数据库事务中执行一组语句（真事务：全成功或全回滚）。
 *
 *  Neon HTTP 的 neon() 是无状态的，BEGIN/COMMIT 分开发不共享会话，无法跨语句成事务。
 *  因此生产环境从共享 Pool 取一条有状态连接。
 *  测试环境（pglite）本身有状态，直接在同一连接上 BEGIN/COMMIT 即可。 */
export async function withTransaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  // pglite（测试）：conn() 已是有状态连接，直接用它跑 BEGIN/COMMIT
  if (resolveDbDriver() === "pglite") {
    return txOnConn(conn(), fn);
  }
  const pool = txPool();
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
    // 只归还连接，不销毁池 —— 池由进程生命周期管理
    client.release();
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

// SCHEMA_SQL 已移到 lib/schema.ts（打破与 migrations.ts 的循环依赖），此处仅转出以兼容既有引用
export { SCHEMA_SQL } from "./schema";

export async function ensureSchema() {
  // 静态 import（见文件顶部）：动态 import 在 tsx 的 data: URL 编译模式下无法解析相对路径
  await ensureMigrations();
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
