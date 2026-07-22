import { describe, it, expect } from "vitest";

/** Worker 与配额一致性。数据库相关逻辑用契约检查 + 纯逻辑验证。 */

describe("任务队列：原子认领与租约", () => {
  it("认领 SQL 使用 FOR UPDATE SKIP LOCKED，多 Worker 不会抢到同一条", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    expect(src).toContain("FOR UPDATE SKIP LOCKED");
    expect(src).toContain("ORDER BY priority ASC");     // 按优先级
    expect(src).toContain("scheduled_at IS NULL OR scheduled_at <= now()");  // 尊重延迟调度
  });

  it("认领即设置租约与心跳时间", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    expect(src).toContain("lease_expires_at = now() + interval");
    expect(src).toContain("heartbeat_at = now()");
  });

  it("回收循环把过期租约任务重新入队，超限进死信", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function reclaimExpired"), src.indexOf("export async function completeTask"));
    expect(fn).toContain("status='queued'");            // 重新入队
    expect(fn).toContain("attempts < max_attempts");
    expect(fn).toContain("status='dead'");              // 死信
    expect(fn).toContain("refundQuota");                // 死信必须退款
  });

  it("心跳失效后 Worker 不再写结果（防止已回收任务被覆盖）", async () => {
    const fs = await import("node:fs");
    const q = fs.readFileSync("lib/task-queue.ts", "utf8");
    // completeTask 带 worker_id 与 status='running' 条件，被回收后更新影响 0 行
    const fn = q.slice(q.indexOf("export async function completeTask"));
    expect(fn).toContain("AND status='running' AND worker_id=?");
    expect(fn).toContain("if (!claimed.rows.length) return;");
  });
});

describe("配额一致性", () => {
  it("任务成功才 commit，失败/取消一律 refund", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/task-queue.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function completeTask"), src.indexOf("export async function failTask"));
    expect(fn).toContain("if (opts.ok && !opts.canceled) await commitQuota");
    expect(fn).toContain("else await refundQuota");
  });

  it("预占在建任务时完成并绑定 quota_ref", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/agent-tasks/route.ts", "utf8");
    expect(src).toContain("reserveQuota");
    expect(src).toContain("quota_ref");
    expect(src).toContain("quota_kind");
  });

  it("commitQuota 只对 reserved 状态生效（重复调用幂等）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/usage.ts", "utf8");
    expect(src).toContain("WHERE ref=? AND status='reserved'");
  });

  it("重型任务有每日配额，防止单用户刷爆预算", async () => {
    const { quotaFor } = await import("../lib/usage");
    expect(quotaFor("heavy_task", "free")).toBeGreaterThan(0);
    expect(quotaFor("heavy_task", "paid")).toBeGreaterThan(quotaFor("heavy_task", "free"));
    expect(quotaFor("heavy_task", "admin")).toBe(-1);
  });
});

describe("Worker 部署形态", () => {
  it("提供常驻 Worker 脚本，支持并发槽位与优雅退出", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/agent-worker.mts", "utf8");
    expect(src).toContain("SIGTERM");
    expect(src).toContain("WORKER_HEAVY_SLOTS");
    expect(src).toContain("WORKER_LIGHT_SLOTS");
    expect(src).toContain("reclaimLoop");
    expect(src).toContain("heartbeat");
    // 退出时释放租约，让其他 Worker 立即接管
    expect(src).toContain("status='queued', worker_id=NULL");
  });

  it("execute 路由默认生产关闭，仅 admin/debug 或显式开关可用", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/agent-tasks/[id]/execute/route.ts", "utf8");
    expect(src).toContain("ALLOW_INLINE_EXECUTE");
    expect(src).toContain('resolveTier(req) !== "admin"');
    expect(src).toContain("worker_mode: true");
  });

  it("前端在 Worker 模式下只轮询不点火", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/api.ts", "utf8");
    expect(src).toContain("if (d?.worker_mode) return;");
    expect(src).toContain('st.status === "dead"');      // 死信状态有明确提示
  });
});
