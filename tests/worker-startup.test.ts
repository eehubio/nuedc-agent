import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Worker 真实启动冒烟测试。
 *
 *  为什么需要它：其余测试都跑在 vitest / Next.js 环境里，没有一条覆盖
 *  「tsx 直接执行 scripts/*.mts」这条真实启动路径。Railway 上就是在这条路径上
 *  挂掉的：ERR_UNSUPPORTED_RESOLVE_REQUEST —— .mts（ESM）入口加载 CJS 的 lib 文件时，
 *  tsx 会把后者编译成 data: URL，而 data: URL 无法解析 "./migrations" 这类相对说明符
 *  （base scheme is not hierarchical）。
 *
 *  这类模块解析错误只有真正起进程才会暴露，语法解析和类型检查都发现不了。
 *
 *  做法：用一个必然连不上的 DATABASE_URL 启动 Worker，只断言它「越过了模块解析阶段」
 *  ——即失败原因必须是数据库连接问题，而不是模块解析问题。这样不需要真实数据库。 */

const REPO = resolve(__dirname, "..");

/** Railway 镜像是 Node 20；本地/CI 可能是 Node 22。
 *  Node 20 对 data: URL 的相对说明符解析更严格 —— 同样的代码 22 能跑、20 报
 *  ERR_UNSUPPORTED_RESOLVE_REQUEST。所以优先用 Node 20 跑，才有意义。
 *  设 NODE20_BIN 指向 Node 20 可执行文件即可；未设置则回退当前 Node（仍能验证
 *  ERR_MODULE_NOT_FOUND 一类问题，但对版本相关的解析差异敏感度较低）。 */
const NODE20 = process.env.NODE20_BIN && existsSync(process.env.NODE20_BIN) ? process.env.NODE20_BIN : null;
const TSX_CLI = resolve(REPO, "node_modules/tsx/dist/cli.mjs");

/** 起进程跑一个入口脚本，收集输出直到退出或超时 */
function runEntry(script: string, env: Record<string, string>, timeoutMs = 60_000): Promise<{ out: string; code: number | null }> {
  return new Promise((resolveP) => {
    // 有 Node 20 就直接用它执行 tsx CLI，否则退回 npx tsx
    const [cmd, args] = NODE20
      ? [NODE20, [TSX_CLI, script]]
      : ["npx", ["tsx", script]];
    const child = spawn(cmd, args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveP({ out, code: null }); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolveP({ out, code }); });
  });
}

// 指向一个不存在的主机：连接必然失败，但模块解析必须已经成功
const UNREACHABLE_DB = "postgresql://u:p@127.0.0.1:1/nodb?sslmode=disable";

describe("Worker 启动路径（真实进程）", () => {
  it("agent-worker.mts 能越过模块解析阶段", async () => {
    const { out } = await runEntry("scripts/agent-worker.mts", {
      DATABASE_URL: UNREACHABLE_DB,
      WORKER_ID: "smoke-worker",
    });

    // 关键断言：不能出现模块解析失败
    expect(out).not.toContain("ERR_UNSUPPORTED_RESOLVE_REQUEST");
    expect(out).not.toContain("Failed to resolve module specifier");
    expect(out).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(out).not.toContain("base scheme is not hierarchical");

    // 应当已经进到运行阶段：要么打印启动横幅，要么因连不上库而报数据库错误
    const reachedRuntime = /启动：重型槽位/.test(out) || /Error connecting to database|ECONNREFUSED|NeonDbError|fetch failed/i.test(out);
    expect(reachedRuntime).toBe(true);
  }, 90_000);

  it("worker-healthcheck.mts 能越过模块解析阶段", async () => {
    const { out } = await runEntry("scripts/worker-healthcheck.mts", {
      DATABASE_URL: UNREACHABLE_DB,
      WORKER_ID: "smoke-worker",
    });
    expect(out).not.toContain("ERR_UNSUPPORTED_RESOLVE_REQUEST");
    expect(out).not.toContain("Failed to resolve module specifier");
    expect(out).not.toContain("base scheme is not hierarchical");
  }, 90_000);

  it("init-db.mts 能越过模块解析阶段", async () => {
    const { out } = await runEntry("scripts/init-db.mts", { DATABASE_URL: UNREACHABLE_DB });
    expect(out).not.toContain("ERR_UNSUPPORTED_RESOLVE_REQUEST");
    expect(out).not.toContain("Failed to resolve module specifier");
    expect(out).not.toContain("base scheme is not hierarchical");
  }, 90_000);
});
