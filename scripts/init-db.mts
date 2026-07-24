import { db } from "../lib/db";
import { ensureMigrations } from "../lib/migrations";

await ensureMigrations(db());
console.log("数据库迁移已应用（版本化 schema_migrations）");
