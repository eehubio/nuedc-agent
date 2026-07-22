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
  {
    id: 4,
    name: "build_jobs",
    sql: `
CREATE TABLE IF NOT EXISTS build_jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT,
  target TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  files TEXT NOT NULL,
  log TEXT,
  flash_bytes INTEGER,
  ram_bytes INTEGER,
  elf_b64 TEXT,
  bin_b64 TEXT,
  claimed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_build_project ON build_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_build_status ON build_jobs(status);
`,
  },
  {
    id: 5,
    name: "legacy_projects_to_admin",
    sql: `
UPDATE projects SET owner='admin:legacy' WHERE owner IS NULL;
`,
  },
  {
    id: 6,
    name: "agent_tasks",
    sql: `
CREATE TABLE IF NOT EXISTS agent_tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT,
  agent_type TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  input TEXT,
  output TEXT,
  error TEXT,
  tier TEXT DEFAULT 'free',
  idempotency_key TEXT,
  attempts INTEGER DEFAULT 0,
  cancel_requested INTEGER DEFAULT 0,
  last_run_id TEXT,
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON agent_tasks(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem ON agent_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
`,
  },
  {
    id: 7,
    name: "artifact_provenance_snapshots_members_task_policy",
    sql: `
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_artifact_ids TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS schema_version INTEGER DEFAULT 1;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS change_reason TEXT;
CREATE TABLE IF NOT EXISTS artifact_dependencies (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT,
  artifact_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deps_artifact ON artifact_dependencies(artifact_id);
CREATE INDEX IF NOT EXISTS idx_deps_source ON artifact_dependencies(source_artifact_id);
CREATE TABLE IF NOT EXISTS project_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT,
  manifest TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON project_snapshots(project_id);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_ref TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, user_ref)
);
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 5;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS max_attempts INTEGER DEFAULT 3;
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
