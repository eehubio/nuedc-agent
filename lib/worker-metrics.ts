/** Worker 运行时指标（进程内计数，供压测与容量判断）。
 *
 *  目的：在引入 Redis / 事件推送之前，先用真实数据判断 3 秒取消轮询
 *  到底产生多少 DB QPS、是否值得为它增加基础设施。
 *
 *  这些指标是「进程级」的，Worker 重启即清零；压测时通过
 *  scripts/load-test.mts 汇总，或由 /api/admin/readiness 聚合多 Worker 心跳。 */

export interface WorkerMetrics {
  /** 取消轮询产生的 DB 查询次数 */
  cancel_poll_queries: number;
  /** 取消轮询失败次数（DB 错误） */
  cancel_poll_db_errors: number;
  /** 当前在执行的任务数 */
  active_worker_tasks: number;
  /** 收到的取消请求数 */
  cancel_requests: number;
  /** 从「检测到取消」到「abort 生效」的延迟样本（毫秒） */
  cancel_abort_latencies: number[];
  /** 心跳续租次数 */
  heartbeat_queries: number;
  /** 任务认领查询次数 */
  claim_queries: number;
  since: number;
}

const m: WorkerMetrics = {
  cancel_poll_queries: 0,
  cancel_poll_db_errors: 0,
  active_worker_tasks: 0,
  cancel_requests: 0,
  cancel_abort_latencies: [],
  heartbeat_queries: 0,
  claim_queries: 0,
  since: Date.now(),
};

export const metrics = {
  cancelPoll() { m.cancel_poll_queries++; },
  cancelPollError() { m.cancel_poll_db_errors++; },
  cancelRequested() { m.cancel_requests++; },
  cancelAbortLatency(ms: number) {
    m.cancel_abort_latencies.push(ms);
    // 只保留最近 1000 个样本，避免长跑内存增长
    if (m.cancel_abort_latencies.length > 1000) m.cancel_abort_latencies.shift();
  },
  heartbeat() { m.heartbeat_queries++; },
  claim() { m.claim_queries++; },
  taskStarted() { m.active_worker_tasks++; },
  taskEnded() { m.active_worker_tasks = Math.max(0, m.active_worker_tasks - 1); },
  reset() {
    m.cancel_poll_queries = 0; m.cancel_poll_db_errors = 0;
    m.cancel_requests = 0; m.cancel_abort_latencies = [];
    m.heartbeat_queries = 0; m.claim_queries = 0;
    m.since = Date.now();
  },
  snapshot,
};

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/** 汇总快照：含取消延迟分位数与各类查询的 QPS */
export function snapshot() {
  const elapsedSec = Math.max(1, (Date.now() - m.since) / 1000);
  const lat = [...m.cancel_abort_latencies].sort((a, b) => a - b);
  return {
    window_sec: Math.round(elapsedSec),
    active_worker_tasks: m.active_worker_tasks,
    cancel_requests: m.cancel_requests,
    cancel_poll_queries: m.cancel_poll_queries,
    cancel_poll_db_errors: m.cancel_poll_db_errors,
    cancel_abort_latency_p50: pct(lat, 50),
    cancel_abort_latency_p95: pct(lat, 95),
    heartbeat_queries: m.heartbeat_queries,
    claim_queries: m.claim_queries,
    qps: {
      cancel_poll: +(m.cancel_poll_queries / elapsedSec).toFixed(2),
      heartbeat: +(m.heartbeat_queries / elapsedSec).toFixed(2),
      claim: +(m.claim_queries / elapsedSec).toFixed(2),
      total: +((m.cancel_poll_queries + m.heartbeat_queries + m.claim_queries) / elapsedSec).toFixed(2),
    },
  };
}
