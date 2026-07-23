import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** 防回归：顶部「工作流程」标签必须只包含流程步骤。
 *  管理类入口（首页、我的项目）插在中间会打断
 *  方案→模块→连线→BOM→代码→调试→测试→报告 的操作节奏。 */

const src = readFileSync("components/Platform.tsx", "utf8");

function navKeys(): string[] {
  const start = src.indexOf("const NAV = [");
  const block = src.slice(start, src.indexOf("] as const;", start));
  return [...block.matchAll(/key:\s*"(\w+)"/g)].map((m) => m[1]);
}

describe("工作流程导航", () => {
  it("流程标签按正确顺序排列且不被管理入口打断", () => {
    const nonWorkflow = ["home", "projects"];
    const flow = navKeys().filter((k) => !nonWorkflow.includes(k));
    expect(flow).toEqual([
      "solution", "modules", "wiring", "bom", "code", "debug", "testing", "report",
    ]);
  });

  it("worktabs 显式过滤掉非流程入口", () => {
    const nav = src.slice(src.indexOf('aria-label="工作流程"'), src.indexOf('aria-label="工作流程"') + 400);
    expect(nav).toMatch(/NON_WORKFLOW/);
    expect(src).toMatch(/const NON_WORKFLOW = \["home", "projects"\] as const/);
  });

  it("我的项目入口放在顶部工具栏，与项目选择器同区", () => {
    const topbar = src.slice(src.indexOf('<header className="topbar">'), src.indexOf("</header>"));
    expect(topbar).toMatch(/我的项目/);
    expect(topbar).toMatch(/setPage\("projects"\)/);
    // 且仍与项目选择器、新建项目在一起
    expect(topbar).toMatch(/选择项目/);
    expect(topbar).toMatch(/新建项目/);
  });
});
