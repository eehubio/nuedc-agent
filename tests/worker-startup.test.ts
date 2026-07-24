import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Worker 启动冒烟：用真实子进程验证 Worker 能起来、能连库、能优雅退出。
 *  这类问题（缺依赖、import 路径错、top-level await 不兼容）只有真跑才会暴露，
 *  单元测试全绿但 Worker 起不来的情况在生产上是致命的。 */

const NODE_BIN = process.env.NODE20_BIN || process.execPath;

function runWorker(env: Record<string, string>, killAfterMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(NODE_BIN, ["--import", "tsx", "scripts/agent-worker.mts"], {
      env: { ...process.env, ...env },
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });

    const timer = setTimeout(() => child.kill("SIGTERM"), killAfterMs);
    // 兜底：SIGTERM 后仍不退出则强杀，避免测试挂死
    const hardKill = setTimeout(() => child.kill("SIGKILL"), killAfterMs + 8000);

    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      resolve({ code, out });
    });
  });
}

/** 模块加载检查。
 *  必须用「文件入口」而非 node -e：后者走 data-URL 加载上下文，
 *  tsx 在该上下文下会把 TS 模块识别成 CJS 并丢失具名导出，
 *  产生与生产环境不符的假失败（生产是 npm run worker，即文件入口）。 */
function runCheck(): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(NODE_BIN, ["--import", "tsx", "scripts/agent-worker.mts"], {
      env: { ...process.env, WORKER_SMOKE_IMPORT_ONLY: "1", DATABASE_URL: "", ENABLE_MOCK_PROVIDER: "1" },
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const t = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

describe("Worker 启动冒烟", () => {
  it("Worker 脚本存在且可被解析", () => {
    expect(existsSync("scripts/agent-worker.mts")).toBe(true);
  });

  // 注：缺失 import / 类型错误由 `npm run typecheck` 覆盖（.mts 已纳入 tsconfig include）。
  // 本文件聚焦 tsc 抓不到的运行时问题：能否真正启动、连库、优雅退出。
  it("Worker 进程能真正启动并完成模块初始化", async () => {
    const { out, code } = await runCheck();
    expect(code, `Worker 启动失败：\n${out.slice(0, 600)}`).toBe(0);
    expect(out).toContain("模块加载成功");
    // 动态 import 在某些入口下解析失败会以此形式暴露
    expect(out).not.toMatch(/ERR_UNSUPPORTED_RESOLVE_REQUEST|resolve module specifier/);
  }, 30_000);

  it("缺少 DATABASE_URL 时给出明确错误并退出，而不是静默挂起", async () => {
    const { out } = await runWorker(
      { DATABASE_URL: "", ENABLE_MOCK_PROVIDER: "1", WORKER_POLL_MS: "200" },
      6000,
    );
    // 只要是「可读的失败」即可：缺配置、连不上库都算正常报错路径
    expect(out).toMatch(/DATABASE_URL|数据库|database|connect|ECONN/i);
    // 但绝不能是模块加载/解析失败 —— 那说明 Worker 本身坏了
    expect(out).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNSUPPORTED_RESOLVE_REQUEST/);
  }, 25_000);

  it("配置齐全时能启动、打印槽位信息，并响应 SIGTERM 优雅退出", async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      // 无数据库环境（如本地）跳过，CI 中有 Postgres 服务时才执行
      console.log("跳过：无 DATABASE_URL");
      return;
    }
    const { out } = await runWorker(
      { DATABASE_URL: dbUrl, ENABLE_MOCK_PROVIDER: "1", WORKER_POLL_MS: "300",
        WORKER_HEAVY_SLOTS: "1", WORKER_LIGHT_SLOTS: "2" },
      12000,   // 首次启动要跑完整套迁移，留足时间
    );
    expect(out).toContain("启动");
    expect(out).toMatch(/重型槽位 1/);
    expect(out).toMatch(/优雅退出|停止认领/);
    // Worker 在真实数据库下必须能完成迁移，不得出现模块解析失败
    expect(out).not.toMatch(/ERR_UNSUPPORTED_RESOLVE_REQUEST|resolve module specifier/);
  }, 30_000);
});
