import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** 防回归：压测脚本里出现的 agent 名必须是真实注册过的。
 *  第 10 次 CI 就栽在这里：脚本用了不存在的 requirement_analyst，
 *  服务端白名单校验返回 400，15 个请求全挂。 */
describe("压测脚本的 agent 名有效性", () => {
  it("脚本里的 agent 名都在 AGENT_TASK_TYPE 映射中", async () => {
    const { AGENT_TASK_TYPE } = await import("@/lib/model-gateway/task-policy");
    const src = readFileSync("scripts/load-test.mts", "utf8");
    // 抓取形如 "xxx_yyy" 且出现在 agent 选择语句里的名字
    const line = src.split("\n").find((l) => l.includes("const agent ="));
    expect(line, "未找到 agent 选择语句").toBeTruthy();
    const names = [...line!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(AGENT_TASK_TYPE[n], `agent "${n}" 未注册（会被服务端 400 拒绝）`).toBeTruthy();
    }
  });
});
