import { ensureMigrations } from "../lib/migrations";

await ensureMigrations();
console.log("数据库迁移已应用（版本化 schema_migrations）");
