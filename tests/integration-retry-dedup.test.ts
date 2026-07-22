import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { setupMockDb, teardownMockDb, type MockDbContext } from "./helpers/mock-db";

/** Commit 1 集成测试（真·内存 Postgres）：
 *  - 结构化错误码与可重试判定
 *  - Worker 重试：Provider 503 → 重新入队；第二次成功只扣一次配额
 *  - 达到 max_attempts → 进 dead 并退款
 *  - 跨用户去重隔离（原子 ON CONFLICT）
 *  - Partial 结果统一 draft + 需人工确认 */

let ctx: MockDbContext;

// 建一条排队任务的辅助
async function insertTask(over: Record<string, any> = {}) {
  const t = {
    task_id: over.task_id || `TASK-${Math.random().toString(36).slice(2, 9)}`,
    owner_ref: over.owner_ref ?? "owner:A",
    project_id: over.project_id ?? "PRJ-1",
    agent_type: over.agent_type ?? "solution_architect",
    tier: over.tier ?? "free",
    input_hash: over.input_hash ?? "hash-1",
    dedup_key: over.dedup_key ?? null,
    max_attempts: over.max_attempts ?? 3,
    quota_ref: over.quota_ref ?? null,
    quota_kind: over.quota_kind ?? null,
    queue_name: over.queue_name ?? "heavy",
    status: over.status ?? "queued",
  };
  await ctx.raw(
    `INSERT INTO agent_tasks (task_id, owner_ref, project_id, agent_type, tier, input_hash, dedup_key,
        status, max_attempts, quota_ref, quota_kind, queue_name, priority, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,5, now())`,
    [t.task_id, t.owner_ref, t.project_id, t.agent_type, t.tier, t.input_hash, t.dedup_key,
      t.status, t.max_attempts, t.quota_ref, t.quota_kind, t.queue_name],
  );
  return t.task_id;
}

beforeEach(async () => {
  ctx = await setupMockDb();
  await ctx.reset();
});
afterAll(teardownMockDb);

describe("结构化错误码与可重试判定", () => {
  it("瞬时错误可重试，业务错误不可重试", async () => {
    const { isRetryable, classifyAgentError } = await import("@/lib/agents/base");
    for (const c of ["RATE_LIMIT", "TIMEOUT", "NETWORK", "SERVER", "PROVIDER_UNAVAILABLE", "TEMPORARY_DATABASE_ERROR"]) {
      expect(isRetryable(c)).toBe(true);
    }
    for (const c of ["SCHEMA_INVALID", "INVALID_INPUT", "PERMISSION_DENIED", "STAGE_BLOCKED", "REQUIREMENT_NOT_CONFIRMED"]) {
      expect(isRetryable(c)).toBe(false);
    }
    expect(classifyAgentError("HTTP 503 service unavailable")).toBe("SERVER");
    expect(classifyAgentError("请求超时（90000ms）")).toBe("TIMEOUT");
    expect(classifyAgentError("Schema 校验失败：blocks 缺失")).toBe("SCHEMA_INVALID");
    expect(isRetryable(classifyAgentError("unknown weird error"))).toBe(false);
  });
});

describe("Worker 重试与配额一致性", () => {
  it("Provider 503 → failTask 让任务重新入队（未达上限）", async () => {
    const { claimTask, failTask } = await import("@/lib/task-queue");
    const id = await insertTask();
    const claimed = await claimTask("w1", { heavy: true });
    expect(claimed?.task_id).toBe(id);
    expect(claimed?.attempts).toBe(1);

    const outcome = await failTask({
      taskId: id, workerId: "w1", message: "503", errorCode: "SERVER", retryable: true,
    });
    expect(outcome).toBe("requeued");
    const rs = await ctx.raw("SELECT status, worker_id FROM agent_tasks WHERE task_id=$1", [id]);
    expect(rs.rows[0].status).toBe("queued");
    expect(rs.rows[0].worker_id).toBeNull();
  });

  it("第二次执行成功后只扣一次配额", async () => {
    const { claimTask, failTask, completeTask } = await import("@/lib/task-queue");
    const { reserveQuota } = await import("@/lib/usage");
    // 预占一次配额并绑定到任务
    const { reservation } = await reserveQuota("owner:A", "heavy_task", "free");
    const id = await insertTask({ quota_ref: reservation!.ref, quota_kind: "heavy_task" });

    // 第一次认领 → 503 重新入队
    await claimTask("w1", { heavy: true });
    await failTask({ taskId: id, workerId: "w1", message: "503", errorCode: "SERVER", retryable: true });
    // 清掉调度延迟，便于立刻再认领
    await ctx.raw("UPDATE agent_tasks SET scheduled_at=now() WHERE task_id=$1", [id]);

    // 第二次认领 → 成功
    const again = await claimTask("w2", { heavy: true });
    expect(again?.task_id).toBe(id);
    expect(again?.attempts).toBe(2);
    await completeTask({ taskId: id, workerId: "w2", ok: true, result: { ok: true } });

    // 配额计数器只 +1（未因重试重复扣费）
    const q = await ctx.raw("SELECT used FROM quota_counters WHERE owner=$1 AND kind='heavy_task' AND day=CURRENT_DATE", ["owner:A"]);
    expect(Number(q.rows[0].used)).toBe(1);
    // 预占已 commit
    const u = await ctx.raw("SELECT status FROM llm_usage WHERE ref=$1", [reservation!.ref]);
    expect(u.rows[0].status).toBe("success");
  });

  it("达到 max_attempts 后进入 dead 并退款", async () => {
    const { claimTask, failTask } = await import("@/lib/task-queue");
    const { reserveQuota } = await import("@/lib/usage");
    const { reservation } = await reserveQuota("owner:A", "heavy_task", "free");
    const id = await insertTask({ max_attempts: 2, quota_ref: reservation!.ref, quota_kind: "heavy_task" });

    // attempt 1
    await claimTask("w1", { heavy: true });
    let out = await failTask({ taskId: id, workerId: "w1", message: "503", errorCode: "SERVER", retryable: true });
    expect(out).toBe("requeued");
    await ctx.raw("UPDATE agent_tasks SET scheduled_at=now() WHERE task_id=$1", [id]);
    // attempt 2 → 已达上限，进 dead
    await claimTask("w2", { heavy: true });
    out = await failTask({ taskId: id, workerId: "w2", message: "503", errorCode: "SERVER", retryable: true });
    expect(out).toBe("dead");

    const rs = await ctx.raw("SELECT status FROM agent_tasks WHERE task_id=$1", [id]);
    expect(rs.rows[0].status).toBe("dead");
    // 退款：计数器回到 0，用量标 refunded
    const q = await ctx.raw("SELECT used FROM quota_counters WHERE owner=$1 AND kind='heavy_task' AND day=CURRENT_DATE", ["owner:A"]);
    expect(Number(q.rows[0].used)).toBe(0);
    const u = await ctx.raw("SELECT status FROM llm_usage WHERE ref=$1", [reservation!.ref]);
    expect(u.rows[0].status).toBe("refunded");
  });
});

describe("跨用户任务去重隔离（原子 ON CONFLICT）", () => {
  async function tryInsert(dedupKey: string, taskId: string, owner: string) {
    const rs = await ctx.raw(
      `INSERT INTO agent_tasks (task_id, owner_ref, project_id, agent_type, tier, input_hash, dedup_key,
          status, priority, scheduled_at)
       VALUES ($1,$2,'PRJ-1','solution_architect','free','h', $3, 'queued', 5, now())
       ON CONFLICT (dedup_key) WHERE status IN ('queued','running') AND dedup_key IS NOT NULL DO NOTHING
       RETURNING task_id`,
      [taskId, owner, dedupKey],
    );
    return rs.rows.length ? rs.rows[0].task_id : null;
  }

  function key(owner: string, project: string, agent: string, tier: string, h: string) {
    return createHash("sha256").update(JSON.stringify({ o: owner, p: project, a: agent, t: tier, h })).digest("hex").slice(0, 40);
  }

  it("两个用户相同输入 → 两个独立任务", async () => {
    const a = await tryInsert(key("owner:A", "PRJ-1", "solution_architect", "free", "h"), "T-A", "owner:A");
    const b = await tryInsert(key("owner:B", "PRJ-1", "solution_architect", "free", "h"), "T-B", "owner:B");
    expect(a).toBe("T-A");
    expect(b).toBe("T-B");   // 不同 owner → 不同 dedup_key → 都插入成功
  });

  it("同一用户相同输入 → 命中去重（第二次 ON CONFLICT DO NOTHING）", async () => {
    const k = key("owner:A", "PRJ-1", "solution_architect", "free", "h");
    const first = await tryInsert(k, "T-1", "owner:A");
    const second = await tryInsert(k, "T-2", "owner:A");
    expect(first).toBe("T-1");
    expect(second).toBeNull();   // 命中活动任务去重
  });

  it("不同项目不能共享任务", async () => {
    const a = await tryInsert(key("owner:A", "PRJ-1", "solution_architect", "free", "h"), "T-P1", "owner:A");
    const b = await tryInsert(key("owner:A", "PRJ-2", "solution_architect", "free", "h"), "T-P2", "owner:A");
    expect(a).toBe("T-P1");
    expect(b).toBe("T-P2");
  });

  it("不同 Tier 不能共享任务", async () => {
    const a = await tryInsert(key("owner:A", "PRJ-1", "solution_architect", "free", "h"), "T-free", "owner:A");
    const b = await tryInsert(key("owner:A", "PRJ-1", "solution_architect", "paid", "h"), "T-paid", "owner:A");
    expect(a).toBe("T-free");
    expect(b).toBe("T-paid");
  });

  it("任务终态后同输入可再次入队（活动去重只锁 queued/running）", async () => {
    const k = key("owner:A", "PRJ-1", "solution_architect", "free", "h");
    await tryInsert(k, "T-1", "owner:A");
    await ctx.raw("UPDATE agent_tasks SET status='ok' WHERE task_id='T-1'");
    const again = await tryInsert(k, "T-2", "owner:A");
    expect(again).toBe("T-2");   // 上一条已终态，不再占用活动去重槽
  });
});

describe("Partial 结果统一落库", () => {
  it("partial 运行 → draft + 需人工确认 + metadata 标记", async () => {
    const { saveArtifact } = await import("@/lib/artifacts");
    const saved = await saveArtifact({
      projectId: "PRJ-1", type: "solution_proposal", content: { solutions: [] },
      createdBy: "solution_architect", status: "reviewed",   // 即便传 reviewed 也必须被降级
      humanReviewRequired: true,
      metadata: { partial_output: true, repair_applied: true, review_hint: "不完整输出，需要人工确认" },
    });
    const rs = await ctx.raw("SELECT status, human_review_required, metadata FROM artifacts WHERE artifact_id=$1", [saved.artifact_id]);
    expect(rs.rows[0].status).toBe("draft");                 // 强制 draft，禁止自动 reviewed
    expect(Number(rs.rows[0].human_review_required)).toBe(1);
    const md = JSON.parse(String(rs.rows[0].metadata));
    expect(md.partial_output).toBe(true);
    expect(md.repair_applied).toBe(true);
  });

  it("完整运行 → reviewed，无 partial 标记", async () => {
    const { saveArtifact } = await import("@/lib/artifacts");
    const saved = await saveArtifact({
      projectId: "PRJ-2", type: "bom", content: { items: [1] },
      createdBy: "bom_agent", status: "reviewed",
    });
    const rs = await ctx.raw("SELECT status, human_review_required, metadata FROM artifacts WHERE artifact_id=$1", [saved.artifact_id]);
    expect(rs.rows[0].status).toBe("reviewed");
    expect(Number(rs.rows[0].human_review_required || 0)).toBe(0);
  });
});
