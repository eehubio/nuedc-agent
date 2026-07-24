import { readFileSync } from "node:fs";
import { db, ensureSchema } from "../lib/db";
import { moduleInputSchema } from "../lib/module-schema";

await ensureSchema();
const raw = JSON.parse(readFileSync(new URL("../data/seed-modules.json", import.meta.url), "utf-8"));
let ok = 0;
let preserved = 0;

for (const item of raw) {
  const parsed = moduleInputSchema.safeParse(item);
  if (!parsed.success) { console.warn(`✘ ${item.id}:`, parsed.error.issues[0]?.message); continue; }
  const m = parsed.data;

  // 保护人工录入：数据库里已有的图片、证据记录不被种子数据覆盖
  const existing = await db().execute({ sql: "SELECT data FROM modules WHERE id=?", args: [m.id] });
  if (existing.rows.length) {
    try {
      const old = JSON.parse(String((existing.rows[0] as any).data));
      if (old.images?.length && !m.images?.length) { m.images = old.images; preserved++; }
      if (old.evidence_records?.length && !m.evidence_records?.length) m.evidence_records = old.evidence_records;
    } catch { /* 旧数据解析失败则按种子写入 */ }
  }

  await db().execute({
    sql: `INSERT INTO modules (id, name, category, version, certification_status, source_type, price, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data, certification_status=excluded.certification_status, updated_at=now()`,
    args: [m.id, m.name, m.category, m.version, m.certification_status, m.source_snapshot?.source || "lab", m.price, JSON.stringify(m)],
  });
  ok++;
}
console.log(`✔ 已写入 ${ok} 个种子模块${preserved ? `（保留了 ${preserved} 个模块的人工图片）` : ""}`);
