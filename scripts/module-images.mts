/** 模块图片批量管理。
 *
 *  为什么需要它：模块图片是最直观的信息，但逐个进后台点开填 URL 很慢。
 *  这个脚本可以列出缺图模块、单个补图、或从 JSON 文件批量导入。
 *
 *  用法：
 *    列出缺图的模块
 *      DATABASE_URL=... npx tsx scripts/module-images.mts list
 *
 *    给单个模块设置图片（多张用逗号分隔）
 *      DATABASE_URL=... npx tsx scripts/module-images.mts set vision-k230-canmv https://a.jpg,https://b.jpg
 *
 *    从 JSON 批量导入（格式：{"模块id": ["url1","url2"], ...}）
 *      DATABASE_URL=... npx tsx scripts/module-images.mts import images.json
 *
 *    校验所有图片链接是否可访问（防盗链、404 会被标出）
 *      DATABASE_URL=... npx tsx scripts/module-images.mts check
 */
import { readFileSync } from "node:fs";
import { db, ensureSchema, closeDb } from "../lib/db";

const cmd = process.argv[2];

async function loadModules(): Promise<{ id: string; name: string; data: any }[]> {
  await ensureSchema();
  const rs = await db().execute({ sql: "SELECT id, name, data FROM modules ORDER BY id", args: [] });
  return rs.rows.map((r: any) => {
    let data: any = {};
    try { data = JSON.parse(String(r.data)); } catch { /* 忽略坏数据 */ }
    return { id: String(r.id), name: String(r.name), data };
  });
}

async function saveImages(id: string, images: string[]): Promise<boolean> {
  const rs = await db().execute({ sql: "SELECT data FROM modules WHERE id=?", args: [id] });
  if (!rs.rows.length) return false;
  let data: any = {};
  try { data = JSON.parse(String((rs.rows[0] as any).data)); } catch { /* 重建 */ }
  data.images = images;
  await db().execute({
    sql: "UPDATE modules SET data=?, updated_at=now() WHERE id=?",
    args: [JSON.stringify(data), id],
  });
  return true;
}

async function main() {
  if (cmd === "list") {
    const mods = await loadModules();
    const missing = mods.filter((m) => !(m.data.images || []).length);
    console.log(`共 ${mods.length} 个模块，其中 ${missing.length} 个缺图：\n`);
    for (const m of missing) console.log(`  ${m.id.padEnd(28)} ${m.name}`);
    if (missing.length) {
      console.log(`\n补图命令示例：`);
      console.log(`  npx tsx scripts/module-images.mts set ${missing[0].id} https://你的图床/xxx.jpg`);
    }
    const withImg = mods.filter((m) => (m.data.images || []).length);
    if (withImg.length) {
      console.log(`\n已有图片的模块（${withImg.length} 个）：`);
      for (const m of withImg) console.log(`  ${m.id.padEnd(28)} ${(m.data.images || []).length} 张`);
    }
    return;
  }

  if (cmd === "set") {
    const id = process.argv[3];
    const urls = (process.argv[4] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!id || !urls.length) {
      console.error("用法: module-images.mts set <模块id> <url1,url2,...>");
      process.exit(2);
    }
    const ok = await saveImages(id, urls);
    console.log(ok ? `✔ ${id} 已设置 ${urls.length} 张图片` : `✘ 模块 ${id} 不存在`);
    if (!ok) process.exit(1);
    return;
  }

  if (cmd === "import") {
    const file = process.argv[3];
    if (!file) { console.error("用法: module-images.mts import <images.json>"); process.exit(2); }
    const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string[]>;
    let ok = 0, miss = 0;
    for (const [id, urls] of Object.entries(map)) {
      const list = Array.isArray(urls) ? urls : [String(urls)];
      if (await saveImages(id, list)) { ok++; console.log(`✔ ${id} ← ${list.length} 张`); }
      else { miss++; console.log(`✘ ${id} 不存在，已跳过`); }
    }
    console.log(`\n完成：${ok} 个已更新${miss ? `，${miss} 个未找到` : ""}`);
    return;
  }

  if (cmd === "check") {
    const mods = await loadModules();
    const targets = mods.filter((m) => (m.data.images || []).length);
    if (!targets.length) { console.log("没有配置图片的模块"); return; }
    console.log(`检查 ${targets.length} 个模块的图片链接…\n`);
    let bad = 0;
    for (const m of targets) {
      for (const url of m.data.images as string[]) {
        try {
          const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
          const type = res.headers.get("content-type") || "";
          const isImg = type.startsWith("image/");
          if (!res.ok || !isImg) {
            bad++;
            console.log(`✘ ${m.id}: HTTP ${res.status} ${type || "无 content-type"} — ${url.slice(0, 70)}`);
          } else {
            console.log(`✓ ${m.id}: ${type}`);
          }
        } catch (e: any) {
          bad++;
          console.log(`✘ ${m.id}: ${String(e?.message || e).slice(0, 50)} — ${url.slice(0, 70)}`);
        }
      }
    }
    console.log(bad
      ? `\n⚠ ${bad} 个链接不可用。常见原因：防盗链（淘宝/京东图片直链通常无法外链）、需要登录、已失效。\n   建议上传到图床或对象存储后再填。`
      : "\n✓ 全部可访问");
    if (bad) process.exit(1);
    return;
  }

  console.log(`模块图片管理

  list              列出缺图模块与已有图片统计
  set <id> <urls>   给单个模块设置图片（逗号分隔多张）
  import <file>     从 JSON 批量导入 {"模块id": ["url"...]}
  check             校验所有图片链接是否可访问

示例：
  DATABASE_URL=... npx tsx scripts/module-images.mts list
  DATABASE_URL=... npx tsx scripts/module-images.mts set vision-k230-canmv https://img/k230.jpg`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
