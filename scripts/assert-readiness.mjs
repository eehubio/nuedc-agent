/** 压测前置 readiness 检查（管理员接口）。
 *
 *  不同压测模式对"就绪"的要求不同，这个差异交给服务端的 profile 参数表达，
 *  而不是"API 说 ready=false，脚本再自行忽略" —— 那样两边语义会打架：
 *    queue-only    → ?profile=queue-only，服务端只要求 Web + DB
 *    mock-provider → ?profile=full，服务端要求 Web + DB + Worker + Provider + Queue
 *    report-only   仅抓取快照，不做断言（压测后使用），但网络/HTTP 错误仍要报告
 *
 *  用法：
 *    node scripts/assert-readiness.mjs --mode=queue-only \
 *      --url=http://127.0.0.1:3000/api/admin/readiness --out=reports/readiness-before.json
 *
 *  需要环境变量 ADMIN_API_KEY（readiness 是管理员接口）。
 *  注意：不静默吞错 —— 抓取失败会写入错误详情并以非零码退出（report-only 模式除外，
 *  它只在 stderr 打印警告，避免掩盖压测本身的结果）。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
);

const MODE = args.mode || "queue-only";
const BASE_URL_ = args.url || "http://127.0.0.1:3000/api/admin/readiness";
/** 模式 → 服务端 profile。report-only 用 full 抓完整快照但不断言。 */
const PROFILE = MODE === "queue-only" ? "queue-only" : "full";
const URL_ = BASE_URL_ + (BASE_URL_.includes("?") ? "&" : "?") + "profile=" + PROFILE;
const OUT = args.out || "";
const ADMIN = process.env.ADMIN_API_KEY || "";

const VALID_MODES = ["queue-only", "mock-provider", "report-only"];
if (!VALID_MODES.includes(MODE)) {
  console.error(`未知 mode：${MODE}（可选：${VALID_MODES.join(" | ")}）`);
  process.exit(2);
}

function save(obj) {
  if (!OUT) return;
  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error(`写入 ${OUT} 失败：${e.message}`);
  }
}

const reportOnly = MODE === "report-only";

let res, body;
try {
  res = await fetch(URL_, { headers: { "X-Api-Key": ADMIN } });
} catch (e) {
  const err = { error: "readiness 请求失败", detail: String(e?.message || e), url: URL_ };
  save(err);
  console.error(`❌ ${err.error}：${err.detail}`);
  // report-only 不因抓取失败而让整个 job 变红（压测结果更重要），但必须显式报告
  process.exit(reportOnly ? 0 : 1);
}

try {
  body = await res.json();
} catch (e) {
  const err = { error: "readiness 响应不是合法 JSON", status: res.status };
  save(err);
  console.error(`❌ ${err.error}（status=${res.status}）`);
  process.exit(reportOnly ? 0 : 1);
}

save(body);

if (reportOnly) {
  console.log(`readiness 快照已保存（status=${res.status}, ready=${body?.ready}）`);
  if (res.status !== 200) console.error(`⚠ readiness 返回 ${res.status}`);
  process.exit(0);
}

// —— 断言 ——
const failures = [];

if (res.status !== 200) {
  failures.push(`HTTP ${res.status}（期望 200）${res.status === 403 ? " —— 检查 ADMIN_API_KEY" : ""}`);
}
if (body?.database?.ok !== true) {
  failures.push(`数据库不可达：${JSON.stringify(body?.database || null)}`);
}
// 直接采信服务端在该 profile 下的结论 —— 不再"忽略 API 的 ready"
if (body?.ready !== true) {
  failures.push(`ready=false（profile=${body?.profile ?? PROFILE}），errors=${JSON.stringify(body?.errors || [])}`);
}

// full profile 下服务端已把"无 Live Worker"计为 error，这里再确认一次数值，
// 便于失败时直接看到具体数字
if (PROFILE === "full") {
  const live = Number(body?.workers?.live || 0);
  if (live < 1) {
    failures.push(`没有存活的 Worker（live=${live}）—— mock-provider 的任务不会被执行`);
  }
}

console.log("\n=== readiness 前置检查 ===");
console.log(`模式        : ${MODE}（profile=${PROFILE}）`);
console.log(`HTTP        : ${res.status}`);
console.log(`ready       : ${body?.ready}`);
console.log(`db_driver   : ${body?.db_driver ?? "-"}`);
console.log(`database.ok : ${body?.database?.ok}`);
console.log(`workers.live: ${body?.workers?.live ?? "-"}`);
console.log(`queued      : ${body?.queue?.total_queued ?? "-"}`);
if (body?.warnings?.length) console.log(`warnings    : ${JSON.stringify(body.warnings)}`);

if (failures.length) {
  console.error("\n❌ 前置检查未通过：");
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("\n✅ 前置检查通过");
