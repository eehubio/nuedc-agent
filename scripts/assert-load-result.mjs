#!/usr/bin/env node
/** 压测结果门禁：读取 load-test 输出的 JSON，逐项校验后决定 CI 红绿。
 *  用法：node scripts/assert-load-result.mjs reports/load-test.json */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("用法: node scripts/assert-load-result.mjs <load-test.json>");
  process.exit(2);
}

let r;
try {
  r = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`❌ 无法读取压测结果 ${file}：${e.message}`);
  console.error("   （压测可能在写出结果前就崩溃了，请检查上一步日志）");
  process.exit(1);
}

const minSuccess = Number(process.env.ASSERT_MIN_SUCCESS_RATE || r.thresholds?.min_success_rate || 0.9);
const maxP95 = Number(process.env.ASSERT_MAX_P95_SECONDS || r.thresholds?.max_p95_seconds || 180);
const maxDbErrors = Number(process.env.ASSERT_MAX_DB_ERRORS || 0);
const max429 = Number(process.env.ASSERT_MAX_429 || Math.ceil(r.users * 0.05));

const checks = [
  ["成功率", r.success_rate >= minSuccess, `${(r.success_rate * 100).toFixed(1)}% (要求 ≥${(minSuccess * 100).toFixed(0)}%)`],
  ["P95 完成时间", r.p95_seconds <= maxP95, `${r.p95_seconds.toFixed(1)}s (要求 ≤${maxP95}s)`],
  ["数据库错误", r.db_errors <= maxDbErrors, `${r.db_errors} (要求 ≤${maxDbErrors})`],
  ["HTTP 429", r.http_429 <= max429, `${r.http_429} (要求 ≤${max429})`],
];

console.log(`\n压测门禁 · 模式 ${r.mode} · ${r.users} 并发 · 耗时 ${Number(r.wall_seconds).toFixed(1)}s`);
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(14)} ${detail}`);
  if (!ok) failed++;
}

if (r.error_distribution && Object.keys(r.error_distribution).length) {
  console.log("\n错误分布：");
  for (const [k, v] of Object.entries(r.error_distribution)) console.log(`   ${v} × ${k}`);
}
if (r.total_cost_usd > 0) {
  console.log(`\n⚠ 本次压测产生真实费用 $${r.total_cost_usd.toFixed(4)}（应使用 mock provider）`);
}

if (failed) {
  console.error(`\n❌ ${failed} 项未达标`);
  process.exit(1);
}
console.log("\n✓ 全部达标");
