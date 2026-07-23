import { describe, it, expect } from "vitest";

/** 取消延迟的行为验证（非源码字符串断言）。
 *
 *  Worker 里心跳 30s、取消轮询 3s 是两个独立定时器。这里用同样的结构跑一遍缩放后的
 *  时间，验证「取消能在远小于心跳周期内生效」这一实际行为 —— 合并成一个定时器时，
 *  取消最坏要等满一个心跳周期，Provider 那段时间还在烧 token。 */

/** 复刻 Worker 的双定时器结构：心跳只续租，取消轮询负责 abort */
function runWithPolling(opts: {
  heartbeatMs: number; cancelPollMs: number;
  cancelRequestedAt: number;      // 多久后数据库里被置上取消标记
  totalMs: number;
}): Promise<{ abortedAt: number | null; heartbeats: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const abort = new AbortController();
    let cancelRequested = false;
    let abortedAt: number | null = null;
    let heartbeats = 0;

    setTimeout(() => { cancelRequested = true; }, opts.cancelRequestedAt);

    const hb = setInterval(() => { heartbeats++; }, opts.heartbeatMs);
    const poll = setInterval(() => {
      if (cancelRequested && !abort.signal.aborted) {
        abort.abort();
        abortedAt = Date.now() - t0;
      }
    }, opts.cancelPollMs);

    setTimeout(() => {
      clearInterval(hb); clearInterval(poll);
      resolve({ abortedAt, heartbeats });
    }, opts.totalMs);
  });
}

describe("取消延迟（行为验证）", () => {
  it("独立取消轮询：取消在一个心跳周期内就生效", async () => {
    // 按 10:1 缩放真实配置（心跳 300ms ≈ 30s，取消轮询 30ms ≈ 3s）
    const r = await runWithPolling({
      heartbeatMs: 300, cancelPollMs: 30,
      cancelRequestedAt: 50, totalMs: 400,
    });
    expect(r.abortedAt).not.toBeNull();
    // 取消发出后应在 ~1 个轮询周期内 abort，远早于下一次心跳
    expect(r.abortedAt!).toBeLessThan(150);
    expect(r.abortedAt!).toBeLessThan(300);   // 严格早于心跳周期
  });

  it("对照：若取消检查搭在心跳上，延迟会拖到整个心跳周期", async () => {
    // 取消轮询间隔 == 心跳间隔（即旧实现的合并写法）
    const r = await runWithPolling({
      heartbeatMs: 300, cancelPollMs: 300,
      cancelRequestedAt: 50, totalMs: 700,
    });
    expect(r.abortedAt).not.toBeNull();
    // 必须等到下一次 300ms 的 tick 才生效
    expect(r.abortedAt!).toBeGreaterThanOrEqual(280);
  });

  it("abort 后 Provider 调用立即中断（mock provider 真实计时）", async () => {
    process.env.ENABLE_MOCK_PROVIDER = "1";
    process.env.MOCK_LATENCY_MS = "5000";
    const { mockProvider } = await import("@/lib/model-gateway/providers/mock");
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = mockProvider.complete({
      system: "s", messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100, temperature: 0.3, json: true, timeoutMs: 9000, signal: ctl.signal,
    } as any, "mock-model");
    setTimeout(() => ctl.abort(), 80);
    await expect(p).rejects.toMatchObject({ code: "CANCELED" });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);   // 远小于 5000ms 的模拟时延
  });
});
