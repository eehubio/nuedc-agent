import { readFileSync } from "node:fs";
import { db, ensureSchema } from "../lib/db";
import { moduleInputSchema } from "../lib/module-schema";

await ensureSchema();
const raw = JSON.parse(readFileSync(new URL("../data/seed-modules.json", import.meta.url), "utf-8"));
let ok = 0;
for (const item of raw) {
  const parsed = moduleInputSchema.safeParse(item);
  if (!parsed.success) { console.warn(`✘ ${item.id}:`, parsed.error.issues[0]?.message); continue; }
  const m = parsed.data;
  await db().execute({
    sql: `INSERT INTO modules (id, name, category, version, certification_status, source_type, price, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data, certification_status=excluded.certification_status, updated_at=now()`,
    args: [m.id, m.name, m.category, m.version, m.certification_status, m.source_snapshot?.source || "lab", m.price, JSON.stringify(m)],
  });
  ok++;
}
console.log(`✔ 已写入 ${ok} 个种子模块`);
