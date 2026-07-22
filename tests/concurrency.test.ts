import { describe, it, expect } from "vitest";
import { withAgentContext, currentAgentContext } from "../lib/agents/base";

/** 并发上下文隔离：模块级变量会串用户，AsyncLocalStorage 不会。
 *  这些用例在旧实现（let _ctx）下必然失败。 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Agent 上下文并发隔离", () => {
  it("50 个并发链路各自读到自己的 owner/project/task", async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withAgentContext(
          { owner: `owner-${i}`, projectId: `proj-${i}`, taskId: `task-${i}`, agent: "solution_architect" },
          async () => {
            // 随机让出执行权，最大化交错的可能
            await sleep(Math.random() * 30);
            const a = currentAgentContext();
            await sleep(Math.random() * 30);
            const b = currentAgentContext();
            // 同一链路内多次读取必须稳定
            expect(b.owner).toBe(a.owner);
            return { i, owner: a.owner, projectId: a.projectId, taskId: a.taskId };
          },
        ),
      ),
    );
    for (const r of results) {
      expect(r.owner).toBe(`owner-${r.i}`);
      expect(r.projectId).toBe(`proj-${r.i}`);
      expect(r.taskId).toBe(`task-${r.i}`);
    }
    expect(new Set(results.map((r) => r.owner)).size).toBe(N);
  });

  it("100 个并发 + 深层异步嵌套仍不串线", async () => {
    const N = 100;
    async function deep(level: number): Promise<string | null | undefined> {
      if (level === 0) { await sleep(Math.random() * 10); return currentAgentContext().owner; }
      await sleep(1);
      return deep(level - 1);
    }
    const out = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withAgentContext({ owner: `u${i}` }, () => deep(5)),
      ),
    );
    out.forEach((owner, i) => expect(owner).toBe(`u${i}`));
  });

  it("嵌套上下文内层覆盖、退出后外层恢复", async () => {
    await withAgentContext({ owner: "outer", projectId: "P-out" }, async () => {
      expect(currentAgentContext().owner).toBe("outer");
      await withAgentContext({ owner: "inner", projectId: "P-in" }, async () => {
        expect(currentAgentContext().owner).toBe("inner");
        expect(currentAgentContext().projectId).toBe("P-in");
      });
      // 内层结束后必须回到外层，而不是残留 inner
      expect(currentAgentContext().owner).toBe("outer");
      expect(currentAgentContext().projectId).toBe("P-out");
    });
  });

  it("上下文外调用返回空对象，不抛异常也不串到别人", () => {
    expect(currentAgentContext()).toEqual({});
  });

  it("一条链路抛异常不影响其他并发链路的上下文", async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        withAgentContext({ owner: `e${i}` }, async () => {
          await sleep(Math.random() * 20);
          if (i % 4 === 0) throw new Error(`boom-${i}`);
          const own = currentAgentContext().owner;
          expect(own).toBe(`e${i}`);
          return own;
        }),
      ),
    );
    settled.forEach((r, i) => {
      if (i % 4 === 0) expect(r.status).toBe("rejected");
      else { expect(r.status).toBe("fulfilled"); expect((r as any).value).toBe(`e${i}`); }
    });
  });

  it("源码中不得残留模块级可变上下文", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/agents/base.ts", "utf8");
    expect(src).toContain("AsyncLocalStorage");
    expect(src).not.toMatch(/^let _ctx/m);
    expect(src).not.toContain("setAgentContext");
  });
});
