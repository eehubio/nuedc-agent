/** 压测结果验收门禁（CI 用）。
 *
 *  性能数字（延迟分位数等）只作为 Artifact 参考，不卡 CI；
 *  但功能性失败必须让 CI 红灯：
 *    - HTTP / DB 错误必须为 0
 *    - 去重错误必须为 0
 *    - 配额泄漏必须为 0（入队成功数 ≠ 唯一任务数即视为泄漏）
 *
 *  用法：node scripts/assert-load-result.mjs reports/load-test.json
 */

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("用法：node scripts/assert-load-result.mjs <report.json>");
  process.exit(2);
}

let r;
try {
  r = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`❌ 无法读取压测报告 ${path}：${e.message}`);
  console.error("   压测脚本可能未成功运行 —— 这本身就是失败。");
  process.exit(1);
}

const failures = [];

// 1) 入队必须全部成功（queue-only 不依赖模型，没有理由失败）
const attempted = r.enqueue?.attempted ?? 0;
const succeeded = r.enqueue?.succeeded ?? 0;
if (attempted === 0) failures.push("没有任何入队尝试 —— 压测未真正执行");
if (succeeded !== attempted) {
  failures.push(`入队失败：${succeeded}/${attempted} 成功（要求全部成功）`);
}

// 2) HTTP 错误必须为 0（4xx/5xx 与连接失败都算）
const httpDist = r.enqueue?.http_status ?? {};
const badHttp = Object.entries(httpDist).filter(([code]) => {
  const c = Number(code);
  return c === 0 || c >= 400;
});
if (badHttp.length) {
  failures.push(`存在 HTTP 错误：${badHttp.map(([c, n]) => `${c}×${n}`).join("、")}`);
}

// 3) DB 错误必须为 0
const dbErrors = r.db_query_errors ?? 0;
if (dbErrors > 0) failures.push(`DB 查询错误 ${dbErrors} 次（要求 0）`);

// 4) 去重必须正确
if (r.enqueue?.dedup_correct !== true) {
  failures.push(`去重错误：唯一任务数 ${r.enqueue?.unique_task_ids} ≠ 成功入队数 ${succeeded}`);
}

// 5) 配额泄漏：每个用户用不同 idempotency_key，唯一任务数必须等于成功入队数
const unique = r.enqueue?.unique_task_ids ?? 0;
if (succeeded > 0 && unique !== succeeded) {
  failures.push(`疑似配额泄漏：唯一任务 ${unique} ≠ 入队成功 ${succeeded}`);
}

// —— 输出 ——
console.log("\n=== 压测验收 ===");
console.log(`模式        : ${r.mode}`);
console.log(`用户数      : ${r.users}`);
console.log(`入队        : ${succeeded}/${attempted}`);
console.log(`HTTP 分布   : ${JSON.stringify(httpDist)}`);
console.log(`DB 错误     : ${dbErrors}`);
console.log(`去重正确    : ${r.enqueue?.dedup_correct}`);
console.log(`queue p95   : ${r.latency_ms?.queue_wait_p95 ?? "-"}ms（仅参考，不卡 CI）`);

if (failures.length) {
  console.error("\n❌ 验收未通过：");
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}

console.log("\n✅ 验收通过：功能性指标全部达标");
