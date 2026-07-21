import { createClient, type Client } from "@libsql/client";

let _db: Client | null = null;

export function db(): Client {
  if (_db) return _db;
  const url = process.env.TURSO_DATABASE_URL || "file:local.db";
  _db = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
  return _db;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  version TEXT DEFAULT '1.0.0',
  certification_status TEXT DEFAULT 'DRAFT',
  source_type TEXT DEFAULT 'lab',
  price REAL DEFAULT 0,
  data TEXT NOT NULL,               -- 完整模块 JSON（moduleInputSchema）
  downloads INTEGER DEFAULT 0,
  rating REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_modules_cat ON modules(category);
CREATE INDEX IF NOT EXISTS idx_modules_cert ON modules(certification_status);

CREATE TABLE IF NOT EXISTS module_reviews (
  review_id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  from_status TEXT, to_status TEXT,
  result TEXT NOT NULL,             -- approved | changes_required | rejected
  issues TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stage TEXT DEFAULT 'PREPARATION',
  problem_text TEXT,                -- 赛题原文
  ezplm_project_id TEXT,            -- 关联 ezPLM 项目
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT,
  type TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  status TEXT DEFAULT 'draft',
  created_by TEXT,
  content TEXT NOT NULL,            -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_proj ON artifacts(project_id, type);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT,
  agent_type TEXT NOT NULL,
  objective TEXT,
  input TEXT, output TEXT,
  status TEXT DEFAULT 'ok',         -- ok | error | blocked_by_stage
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  project_id TEXT, task_id TEXT,
  payload TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export async function ensureSchema() {
  const c = db();
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await c.execute(stmt);
  }
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
