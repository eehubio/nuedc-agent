/** 压测后的数据库统计采集。
 *
 *  不依赖 psql —— GitHub Runner 是否预装 postgresql-client 并不保证，
 *  而 db stats 是本轮要求的交付物之一，缺失就等于没做到。
 *  这里直接用项目已有的 pg 驱动（已在 dependencies）查询。
 *
 *  用法：
 *    node scripts/collect-db-stats.mjs --mode=queue-only --out=reports/db-stats.txt
 *    node scripts/collect-db-stats.mjs --mode=mock-provider --out=reports/db-stats.txt
 *
 *  需要 DATABASE_URL。采集失败会打印错误并以非零码退出，不静默吞掉。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
);

const MODE = args.mode || "queue-only";
const OUT = args.out || "reports/db-stats.txt";
const URL_ = process.env.DATABASE_URL;

if (!URL_) {
  console.error("缺少 DATABASE_URL");
  process.exit(2);
}

/** 各模式关注的指标不同：queue-only 看队列堆积，mock-provider 看执行结果 */
const QUERIES = {
  "queue-only": [
    ["队列深度（按优先级）",
      "SELECT priority, status, COUNT(*) AS n FROM agent_tasks GROUP BY 1,2 ORDER BY 1,2"],
    ["最老排队任务（秒）",
      "SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now()-created_at))),0)::int AS oldest_queued_sec FROM agent_tasks WHERE status='queued'"],
    ["唯一任务数",
      "SELECT COUNT(DISTINCT task_id) AS unique_tasks, COUNT(*) AS rows FROM agent_tasks"],
    ["去重键分布（应无重复活动任务）",
      "SELECT dedup_key, COUNT(*) AS n FROM agent_tasks WHERE status IN ('queued','running') AND dedup_key IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1"],
    ["配额计数",
      "SELECT owner, kind, used FROM quota_counters ORDER BY used DESC LIMIT 20"],
  ],
  "mock-provider": [
    ["任务状态分布",
      "SELECT status, COUNT(*) AS n FROM agent_tasks GROUP BY 1 ORDER BY 2 DESC"],
    ["lease reclaim（重试过的任务）",
      "SELECT COUNT(*) AS reclaimed FROM agent_tasks WHERE attempts > 1"],
    ["错误码分布",
      "SELECT error_code, COUNT(*) AS n FROM agent_tasks WHERE error_code IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"],
    ["duplicate artifacts（同项目同类型同版本应唯一）",
      "SELECT project_id, type, version, COUNT(*) AS n FROM artifacts GROUP BY 1,2,3 HAVING COUNT(*)>1"],
    ["产物总数",
      "SELECT COUNT(*) AS artifacts FROM artifacts"],
    ["Worker 心跳",
      "SELECT worker_id, heavy_slots, light_slots, in_flight FROM worker_heartbeats"],
    ["配额计数",
      "SELECT owner, kind, used FROM quota_counters ORDER BY used DESC LIMIT 20"],
  ],
};

const queries = QUERIES[MODE];
if (!queries) {
  console.error(`未知 mode：${MODE}（可选：${Object.keys(QUERIES).join(" | ")}）`);
  process.exit(2);
}

function fmt(rows) {
  if (!rows.length) return "  (无数据)";
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals) =>
    "  " + vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  return [line(cols), "  " + widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
}

let Pool;
try {
  ({ Pool } = require("pg"));
} catch (e) {
  console.error("require(\"pg\") 失败 —— pg 应在 dependencies 中：" + e.message);
  process.exit(1);
}

const pool = new Pool({ connectionString: URL_, max: 2, connectionTimeoutMillis: 10_000 });
const out = [`=== DB stats (${MODE}) ===`, `时间：${new Date().toISOString()}`, ""];
let failed = 0;

for (const [title, sql] of queries) {
  out.push(`=== ${title} ===`);
  try {
    const r = await pool.query(sql);
    out.push(fmt(r.rows));
  } catch (e) {
    failed++;
    out.push(`  查询失败：${e.message}`);
  }
  out.push("");
}

await pool.end().catch(() => {});

const text = out.join("\n");
try {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
} catch (e) {
  console.error(`写入 ${OUT} 失败：${e.message}`);
  process.exit(1);
}
console.log(text);

if (failed) {
  console.error(`\n${failed} 条统计查询失败（详见上方）`);
  process.exit(1);
}
