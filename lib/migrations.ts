import { db } from "./db";
import { SCHEMA_SQL } from "./db";

/** 版本化数据库迁移（诊断 5.4）。
 *  - 每个迁移一个编号，执行过的记录在 schema_migrations 表
 *  - `npm run db:init` 与运行时 ensureMigrations() 都只补跑缺失的迁移
 *  - 修改表结构：追加新迁移，禁止改动已发布的旧迁移 */

export interface Migration { id: number; name: string; sql: string }

export const MIGRATIONS: Migration[] = [
  { id: 1, name: "base_schema", sql: SCHEMA_SQL },
  {
    id: 2,
    name: "agent_runs_model_and_project_owner",
    sql: `
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner);
`,
  },
  {
    id: 3,
    name: "module_revisions",
    sql: `
CREATE TABLE IF NOT EXISTS module_revisions (
  revision_id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  revision_code TEXT NOT NULL,
  identified_chip TEXT,
  changes TEXT,
  source_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revisions_module ON module_revisions(module_id);
`,
  },
];

let applied = false;

export async function ensureMigrations(): Promise<void> {
  if (applied) return;
  const c = db();
  await c.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ DEFAULT now()
  )`);
  const rs = await c.execute("SELECT id FROM schema_migrations");
  const done = new Set(rs.rows.map((r) => Number(r.id)));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    for (const stmt of m.sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      await c.execute(stmt);
    }
    await c.execute({ sql: "INSERT INTO schema_migrations (id, name) VALUES (?, ?)", args: [m.id, m.name] });
  }
  applied = true;
}
