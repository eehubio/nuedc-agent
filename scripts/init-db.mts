import { ensureSchema } from "../lib/db";
await ensureSchema();
console.log("✔ 数据库结构已初始化");
