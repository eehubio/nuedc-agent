/** 容器健康检查：判断本 Worker 的心跳是否新鲜。
 *
 *  Worker 是常驻进程而非 HTTP 服务，因此健康以「是否还在写心跳」为准：
 *  worker_heartbeats.last_beat_at 超过阈值未更新 → 退出码 1，编排系统重启容器。
 *
 *  用法（Dockerfile HEALTHCHECK 已配置）：
 *    npx tsx scripts/worker-healthcheck.mts
 *
 *  环境变量：
 *    WORKER_ID              与 Worker 进程一致（默认 hostname:pid 无法跨进程匹配，
 *                           容器内建议显式设置，或依赖 host 字段回退匹配）
 *    WORKER_STALE_MS        心跳过期阈值，默认 180000（3 个租约周期） */

import { hostname } from "node:os";
import { db, ensureSchema } from "../lib/db";

const STALE_MS = Number(process.env.WORKER_STALE_MS || 180_000);

async function main() {
  await ensureSchema();
  const workerId = process.env.WORKER_ID;

  // 优先按 WORKER_ID 精确匹配；未设置时按 host 匹配本容器的任意 Worker
  const rs = workerId
    ? await db().execute({
        sql: "SELECT worker_id, last_beat_at FROM worker_heartbeats WHERE worker_id=?",
        args: [workerId],
      })
    : await db().execute({
        sql: "SELECT worker_id, last_beat_at FROM worker_heartbeats WHERE host=? ORDER BY last_beat_at DESC LIMIT 1",
        args: [hostname()],
      });

  if (!rs.rows.length) {
    console.error(`unhealthy: 未找到心跳记录（worker_id=${workerId || "-"} host=${hostname()}）`);
    process.exit(1);
  }

  const last = new Date(String((rs.rows[0] as any).last_beat_at)).getTime();
  const age = Date.now() - last;
  if (age > STALE_MS) {
    console.error(`unhealthy: 心跳已过期 ${Math.round(age / 1000)}s（阈值 ${Math.round(STALE_MS / 1000)}s）`);
    process.exit(1);
  }

  console.log(`healthy: 心跳 ${Math.round(age / 1000)}s 前`);
  process.exit(0);
}

main().catch((e) => {
  console.error("unhealthy: 健康检查异常:", e?.message || e);
  process.exit(1);
});
