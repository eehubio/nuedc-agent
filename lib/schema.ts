/** 基础表结构（迁移 1 的内容）。
 *
 *  单独成文件是为了打破 db.ts ⇄ migrations.ts 的循环依赖：
 *  过去 migrations.ts 从 db.ts 取 SCHEMA_SQL，db.ts 又要动态 import migrations.ts。
 *  那个动态 import 在 tsx 下会失败 —— .mts（ESM）入口加载 CJS 的 lib 文件时，
 *  tsx 把后者编译成 data: URL，而 data: URL 无法解析相对说明符
 *  （ERR_UNSUPPORTED_RESOLVE_REQUEST，Node 20 上必现）。
 *
 *  现在依赖是单向的：schema.ts ← db.ts，schema.ts ← migrations.ts，无环，
 *  db.ts 因而可以静态 import migrations.ts。 */

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
