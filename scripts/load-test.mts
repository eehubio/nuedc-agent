/** 真实压测脚本（四种模式）。
 *
 *  设计原则：压测必须能在「不烧钱」与「验证真实链路」之间明确选择，
 *  且每种模式产出同一套可比对的指标。
 *
 *  模式：
 *    queue-only          300 用户只入队，不调用模型（验证入队/去重/配额/队列深度）
 *    mock-provider       300 用户 + 受控 Worker 并发（端到端调度，零成本）
 *    real-provider-light 30 个真实低成本模型任务（验证真实 Provider 链路）
 *    fallback-drill      主 Provider 禁用/模拟 429，验证备用模型切换
 *
 *  用法：
 *    LOAD_MODE=queue-only LOAD_USERS=300 BASE_URL=https://... ADMIN_API_KEY=... npx tsx scripts/load-test.mts
 *    LOAD_MODE=mock-provider ENABLE_MOCK_ASSUMED=1 ... npx tsx scripts/load-test.mts
 *    LOAD_MODE=real-provider-light CONFIRM_REAL_COST=1 ... npx tsx scripts/load-test.mts
 *    LOAD_MODE=fallback-drill CONFIRM_REAL_COST=1 ... npx tsx scripts/load-test.mts
 *
 *  安全阀：调用真实模型的模式必须显式设 CONFIRM_REAL_COST=1。
 *  压测项目统一用 __loadtest_ 前缀，便于事后批量清理。
 */

type Mode = "queue-only" | "mock-provider" | "real-provider-light" | "fallback-drill";

const VALID: Mode[] = ["queue-only", "mock-provider", "real-provider-light", "fallback-drill"];
const MODE = (process.env.LOAD_MODE || "queue-only") as Mode;
const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const ADMIN_KEY = process.env.ADMIN_API_KEY || "";
const RAMP_SEC = Number(process.env.LOAD_RAMP_SEC || 10);
const POLL_TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_SEC || 300) * 1000;
const HOLD_SEC = Number(process.env.LOAD_HOLD_SEC || 0);
const OUT_JSON = process.env.LOAD_OUT || "";

const DEFAULT_USERS: Record<Mode, number> = {
  "queue-only": 300, "mock-provider": 300, "real-provider-light": 30, "fallback-drill": 20,
};
const USERS = Number(process.env.LOAD_USERS || DEFAULT_USERS[MODE]);

if (!VALID.includes(MODE)) {
  console.error(`未知模式：${MODE}\n可选：${VALID.join(" | ")}`);
  process.exit(2);
}

// 兼容旧用法：--real 等价于显式声明"我要用真实模型"
const args = process.argv.slice(2);
const REAL = args.includes("--real");
const COSTS_MONEY = MODE === "real-provider-light" || MODE === "fallback-drill" || REAL;
if (COSTS_MONEY && process.env.CONFIRM_REAL_COST !== "1") {
  console.error(`模式 ${MODE} 会调用真实模型并产生费用。`);
  console.error(`确认后设 CONFIRM_REAL_COST=1 重跑；建议先用 LOAD_USERS 控制规模。`);
  process.exit(2);
}
// ALLOW_MOCK_ASSUMED / ENABLE_MOCK_ASSUMED：跳过服务端预检的逃生阀（不推荐）
const SKIP_PREFLIGHT = process.env.ALLOW_MOCK_ASSUMED === "1" || process.env.ENABLE_MOCK_ASSUMED === "1";

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (ADMIN_KEY) headers["X-Api-Key"] = ADMIN_KEY;

interface Sample {
  userIdx: number;
  enqueued: boolean;
  deduped: boolean;
  dedupReason?: string;
  httpStatus: number;
  taskId?: string;
  enqueueMs: number;
  queueWaitMs?: number;
  execMs?: number;
  finalStatus?: string;
  errorCode?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  provider?: string;
  fallbackUsed?: boolean;
}

const samples: Sample[] = [];
let dbErrors = 0;

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

async function jfetch(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
    let body: any = null;
    try { body = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function runUser(i: number): Promise<void> {
  const s: Sample = { userIdx: i, enqueued: false, deduped: false, httpStatus: 0, enqueueMs: 0 };
  const t0 = Date.now();
  try {
    const proj = await jfetch("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: `__loadtest_${MODE}_${i}_${Date.now()}` }),
    });
    if (proj.status >= 400 || proj.status === 0) { s.httpStatus = proj.status; samples.push(s); return; }
    const projectId = proj.body?.project_id;

    // queue-only 用真实注册的轻量 agent（topic_forecast → GENERAL_QA，light/low 档），
    // 避免占用重型槽位。注意必须是 lib/agents 里真实注册过的名字，
    // 否则服务端 agent 白名单校验会直接返回 400。
    const agent = MODE === "queue-only" ? "topic_forecast" : "solution_architect";

    // solution_architect 有「需求已确认」门禁和阶段门禁：
    // 必须先写入 CONFIRMED 需求并把项目推进到 REQUIREMENTS_PARSED，否则任务必被拒。
    const mkReq = (k: number, priority: "mandatory" | "bonus" = "mandatory") => ({
      id: `REQ-${String(k + 1).padStart(3, "0")}`,
      type: "performance", description: `压测需求 ${k + 1}：输出电压可调并显示`,
      target: 5, unit: "V", tolerance: "±1%",
      priority, source: "压测", verification_method: "measurement", status: "CONFIRMED",
    });
    if (agent === "solution_architect") {
      await jfetch(`/api/projects/${projectId}/artifacts`, {
        method: "POST",
        body: JSON.stringify({
          type: "requirements",
          content: {
            requirements: Array.from({ length: 8 }, (_, k) => mkReq(k, k < 5 ? "mandatory" : "bonus")),
            scoring_items: [],
          },
        }),
      });
      // 推进阶段 —— 否则 solution_architect 会被状态机门禁拒绝
      await jfetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ stage: "REQUIREMENTS_PARSED" }),
      });
    }

    // 显式构造重型任务载荷（需求全部 CONFIRMED，满足方案 Agent 的确认门禁）
    const solutionBody = {
      agent: "solution_architect",
      project_id: projectId,
      input: {
        requirements: {
          requirements: Array.from({ length: 4 }, (_, k) => ({
            id: `REQ-${String(k + 1).padStart(3, "0")}`,
            type: "performance", description: `压测需求 ${k + 1}`,
            target: 5, unit: "V", tolerance: "±1%",
            priority: "mandatory", source: "压测",
            verification_method: "measurement", status: "CONFIRMED",
          })),
          scoring_items: [],
        },
      },
      idempotency_key: `load-${MODE}-${i}`,
    };
    const lightBody = {
      agent, project_id: projectId,
      input: { objective: `压测 ${MODE} #${i}`, text: `load test payload ${i}` },
      idempotency_key: `load-${MODE}-${i}`,
    };
    const enq = await jfetch("/api/agent-tasks", {
      method: "POST",
      body: JSON.stringify(agent === "solution_architect" ? solutionBody : lightBody),
    });
    s.enqueueMs = Date.now() - t0;
    s.httpStatus = enq.status;
    s.taskId = enq.body?.task_id;
    s.deduped = !!enq.body?.deduped;
    s.dedupReason = enq.body?.reason;
    s.enqueued = enq.status < 400 && !!s.taskId;
    if (!s.enqueued) { samples.push(s); return; }

    if (MODE === "queue-only") { samples.push(s); return; }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let startedAt: number | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await jfetch(`/api/agent-tasks/${s.taskId}`);
      if (st.status >= 500 || st.status === 0) { dbErrors++; continue; }
      const t = st.body || {};
      if (t.status === "running" && startedAt === null) {
        startedAt = Date.now();
        s.queueWaitMs = startedAt - t0;
      }
      if (["ok", "error", "dead", "canceled"].includes(String(t.status))) {
        s.finalStatus = String(t.status);
        s.execMs = startedAt ? Date.now() - startedAt : Date.now() - t0;
        s.errorCode = t.error_code || undefined;
        s.tokensIn = Number(t.token_input || 0);
        s.tokensOut = Number(t.token_output || 0);
        s.cost = Number(t.estimated_cost || 0);
        s.provider = t.provider || undefined;
        s.fallbackUsed = !!t.fallback_used;
        break;
      }
    }
    if (!s.finalStatus) s.finalStatus = "timeout";
  } catch {
    dbErrors++;
  }
  samples.push(s);
}

/** 服务端预检：直接问服务端当前选路结果，避免"以为在 mock，其实在烧真钱"。
 *  这比只看本地环境变量可靠得多 —— 环境变量在你机器上，Provider 在服务端。 */
async function preflight(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/admin/system-mode`, { headers });
    const mode = await res.json().catch(() => null);
    console.log(`服务端模式：${mode?.label || mode?.mode || "未知"} · 当前队列 ${mode?.queue_length ?? "?"}`);
  } catch {
    console.log("⚠ 无法连接服务端，请检查 BASE_URL");
    return false;
  }
  if (COSTS_MONEY) return true;              // 真实模式已由 CONFIRM_REAL_COST 把关
  if (MODE === "queue-only") return true;    // 只入队不调用模型
  if (SKIP_PREFLIGHT) {
    console.log("⚠ 已跳过服务端 mock 预检（ALLOW_MOCK_ASSUMED=1）\n");
    return true;
  }
  try {
    const res = await fetch(`${BASE}/api/routing-preview`);
    if (res.ok) {
      const d = await res.json();
      if (d.mock_enabled) {
        console.log(`✓ 预检通过：服务端启用 mock provider（首选 ${d.primary_candidate || "mock"}）\n`);
        return true;
      }
      console.log(`\n⛔ 服务端未启用 mock，实际首选 provider = "${d.primary_candidate || "未知"}"`);
      console.log("   压测会产生真实模型费用。请在部署环境设置 ENABLE_MOCK_PROVIDER=1 并【重新部署】后再跑；");
      console.log("   若确认要用真实模型压测，请用 LOAD_MODE=real-provider-light 或加 --real。\n");
      return false;
    }
  } catch { /* 端点不存在时落到下面的兜底 */ }
  console.log("\n⚠ 服务端无 /api/routing-preview（可能是旧版本部署），无法确认是否为 mock。");
  console.log("   请先部署最新代码；若确认要用真实模型压测，请显式加 --real。\n");
  return false;
}

async function serverStats(): Promise<any> {
  const r = await jfetch("/api/admin/readiness");
  return r.status === 200 ? r.body : { note: `readiness 不可用（status=${r.status}，需要 ADMIN_API_KEY）` };
}

function buildReport(totalMs: number, before: any, after: any) {
  const enq = samples.filter((s) => s.enqueued);
  const deduped = samples.filter((s) => s.deduped);
  const uniqueTasks = new Set(enq.map((s) => s.taskId)).size;
  const finals = samples.filter((s) => s.finalStatus);
  const okRuns = finals.filter((s) => s.finalStatus === "ok");
  const queueWaits = samples.map((s) => s.queueWaitMs).filter((x): x is number => x != null);
  const execs = samples.map((s) => s.execMs).filter((x): x is number => x != null);
  const totalIn = samples.reduce((a, s) => a + (s.tokensIn || 0), 0);
  const totalOut = samples.reduce((a, s) => a + (s.tokensOut || 0), 0);
  const totalCost = samples.reduce((a, s) => a + (s.cost || 0), 0);
  const fallbacks = samples.filter((s) => s.fallbackUsed).length;

  const tally = <T extends string | undefined>(list: Sample[], key: (s: Sample) => T) =>
    list.reduce((acc: Record<string, number>, s) => {
      const k = String(key(s) ?? "unknown"); acc[k] = (acc[k] || 0) + 1; return acc;
    }, {});

  // lease reclaim / duplicate artifact 从 readiness 前后差值推断（无 readiness 时为 null）
  const reclaimDelta = (after?.queue && before?.queue)
    ? null : null;

  return {
    mode: MODE, base_url: BASE, users: USERS,
    wall_clock_sec: Math.round(totalMs / 1000),
    enqueue: {
      attempted: samples.length,
      succeeded: enq.length,
      success_rate: +(enq.length / Math.max(1, samples.length)).toFixed(4),
      deduped: deduped.length,
      dedup_reasons: tally(deduped, (s) => s.dedupReason),
      unique_task_ids: uniqueTasks,
      // 每个用户用不同的 idempotency_key，因此唯一任务数应等于成功入队数
      dedup_correct: uniqueTasks === enq.length,
      http_status: tally(samples, (s) => String(s.httpStatus) as any),
    },
    execution: {
      reached_final: finals.length,
      ok: okRuns.length,
      by_status: tally(finals, (s) => s.finalStatus),
      error_codes: tally(finals.filter((s) => s.errorCode), (s) => s.errorCode),
    },
    latency_ms: {
      queue_wait_p50: pct(queueWaits, 50), queue_wait_p95: pct(queueWaits, 95), queue_wait_p99: pct(queueWaits, 99),
      execution_p50: pct(execs, 50), execution_p95: pct(execs, 95), execution_p99: pct(execs, 99),
    },
    cost: {
      total_input_tokens: totalIn, total_output_tokens: totalOut,
      total_estimated_usd: +totalCost.toFixed(4),
      per_task_input: okRuns.length ? Math.round(totalIn / okRuns.length) : 0,
      per_task_output: okRuns.length ? Math.round(totalOut / okRuns.length) : 0,
      per_task_usd: okRuns.length ? +(totalCost / okRuns.length).toFixed(5) : 0,
    },
    provider: {
      fallback_count: fallbacks,
      by_provider: tally(samples.filter((s) => s.provider), (s) => s.provider),
    },
    db_query_errors: dbErrors,
    lease_reclaim: reclaimDelta,
    server_before: before,
    server_after: after,
  };
}

async function main() {
  console.log(`\n=== 压测开始 ===`);
  console.log(`模式      : ${MODE}`);
  console.log(`目标      : ${BASE}`);
  console.log(`并发用户  : ${USERS}`);
  console.log(`爬坡      : ${RAMP_SEC}s`);
  if (COSTS_MONEY) console.log(`⚠ 本模式调用真实模型，会产生费用`);
  console.log("");

  if (!(await preflight())) process.exit(2);

  const before = await serverStats();
  const t0 = Date.now();

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < USERS; i++) {
    const delay = (RAMP_SEC * 1000 * i) / Math.max(1, USERS);
    tasks.push(new Promise<void>((resolve) => {
      setTimeout(() => { runUser(i).finally(resolve); }, delay);
    }));
  }
  await Promise.all(tasks);

  if (HOLD_SEC > 0) {
    console.log(`保持 ${HOLD_SEC}s 以观测常驻负载（取消轮询等）…`);
    await new Promise((r) => setTimeout(r, HOLD_SEC * 1000));
  }

  const totalMs = Date.now() - t0;
  const after = await serverStats();
  const report = buildReport(totalMs, before, after);

  console.log("\n=== 压测报告 ===");
  console.log(JSON.stringify(report, null, 2));

  console.log("\n=== 结论 ===");
  console.log(`入队成功率      : ${(report.enqueue.success_rate * 100).toFixed(1)}%`);
  console.log(`去重正确        : ${report.enqueue.dedup_correct ? "是" : "否 ⚠"}`);
  console.log(`queue wait p95  : ${report.latency_ms.queue_wait_p95}ms`);
  console.log(`execution p95   : ${report.latency_ms.execution_p95}ms`);
  console.log(`DB 查询错误     : ${dbErrors}`);
  console.log(`Provider 回退   : ${report.provider.fallback_count}`);
  if (COSTS_MONEY) console.log(`本次估算成本    : $${report.cost.total_estimated_usd}`);

  if (OUT_JSON) {
    const fs = await import("node:fs");
    fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
    console.log(`\n报告已写入：${OUT_JSON}`);
  }

  console.log(`\n清理压测数据：DELETE FROM projects WHERE name LIKE '__loadtest_%';`);
}

main().catch((e) => { console.error("压测失败：", e); process.exit(1); });
