import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/** DB_DRIVER 显式配置与 CI 隔离的防回归测试。 */

const saved = { ...process.env };
beforeEach(() => { for (const k of ["DB_DRIVER", "DATABASE_URL", "PGLITE_TEST"]) delete process.env[k]; });
afterEach(() => { Object.assign(process.env, saved); });

describe("一、pg 在生产依赖中", () => {
  it("pg 在 dependencies，@types/pg 在 devDependencies", () => {
    const p = JSON.parse(readFileSync("package.json", "utf8"));
    expect(p.dependencies?.pg, "pg 必须在 dependencies（运行时 require）").toBeTruthy();
    expect(p.devDependencies?.pg, "pg 不应重复出现在 devDependencies").toBeFalsy();
    expect(p.devDependencies?.["@types/pg"], "@types/pg 应在 devDependencies").toBeTruthy();
  });
});

describe("二、DB_DRIVER 显式优先", () => {
  it("显式值覆盖 URL 自动判断", async () => {
    const { resolveDbDriver } = await import("@/lib/db");
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/x";
    process.env.DB_DRIVER = "neon_http";
    expect(resolveDbDriver()).toBe("neon_http");
    process.env.DB_DRIVER = "postgres_pool";
    expect(resolveDbDriver()).toBe("postgres_pool");
    process.env.DB_DRIVER = "pglite";
    expect(resolveDbDriver()).toBe("pglite");
  });

  it("未配置时按 DATABASE_URL 自动判断", async () => {
    const { resolveDbDriver } = await import("@/lib/db");
    process.env.DATABASE_URL = "postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db";
    expect(resolveDbDriver()).toBe("neon_http");
    process.env.DATABASE_URL = "postgresql://ci:ci@127.0.0.1:5432/nuedc_ci";
    expect(resolveDbDriver()).toBe("postgres_pool");
  });

  it("非法值必须抛错，不得静默回退", async () => {
    const { resolveDbDriver } = await import("@/lib/db");
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/x";
    process.env.DB_DRIVER = "mysql";
    expect(() => resolveDbDriver()).toThrow(/DB_DRIVER/);
  });

  it("查询与事务使用同一驱动解析（源码约束）", () => {
    const src = readFileSync("lib/db.ts", "utf8");
    // conn() 与 txPool() 都必须调用 resolveDbDriver
    const conn = src.slice(src.indexOf("function conn()"), src.indexOf("function toPgPlaceholders"));
    expect(conn).toMatch(/resolveDbDriver\(\)/);
    const tx = src.slice(src.indexOf("export function txPool()"));
    expect(tx.slice(0, 600)).toMatch(/resolveDbDriver\(\)/);
    // 不得再出现各自为政的 isNeonHost 直接判断
    expect(tx.slice(0, 600)).not.toMatch(/isNeonHost\(url\) \?/);
  });

  it("readiness 返回 db_driver", () => {
    const src = readFileSync("app/api/admin/readiness/route.ts", "utf8");
    expect(src).toMatch(/db_driver/);
    expect(src).toMatch(/resolveDbDriver/);
  });
});

describe("三、日常 CI 只 build 一次", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  it("整个 workflow 只有一处 build", () => {
    const builds = (ci.match(/next build|npm run build/g) || []).length;
    expect(builds, "应只保留一处 build").toBe(1);
  });
  it("步骤顺序符合要求", () => {
    const order = ["Install", "Lint", "Typecheck", "Test", "Worker startup smoke",
                   "- name: Build", "Queue smoke", "Stop server", "Upload test reports"];
    let pos = -1;
    for (const step of order) {
      const at = ci.indexOf(step);
      expect(at, `缺少步骤：${step}`).toBeGreaterThan(-1);
      expect(at, `顺序错误：${step}`).toBeGreaterThan(pos);
      pos = at;
    }
  });
  it("CI 显式声明 DB_DRIVER", () => {
    expect(ci).toMatch(/DB_DRIVER: postgres_pool/);
    expect(ci).toMatch(/DB_DRIVER: pglite/);
  });
});

describe("四、重型压测两 Job 隔离", () => {
  const lt = readFileSync(".github/workflows/load-test.yml", "utf8");
  it("两个独立 Job，各自独立数据库", () => {
    expect(lt).toMatch(/^ {2}queue-only:/m);
    expect(lt).toMatch(/^ {2}mock-provider:/m);
    expect(lt).toMatch(/nuedc_queue/);
    expect(lt).toMatch(/nuedc_mock/);
  });
  it("queue-only Job 不启动 Worker", () => {
    const j = lt.slice(lt.indexOf("  queue-only:"), lt.indexOf("  mock-provider:"));
    expect(j).not.toMatch(/agent-worker\.mts/);
    expect(j).toMatch(/--mode=queue-only/);
  });
  it("mock-provider Job 启动 Worker 且要求 Live Worker", () => {
    const j = lt.slice(lt.indexOf("  mock-provider:"));
    expect(j).toMatch(/agent-worker\.mts/);
    expect(j).toMatch(/--mode=mock-provider/);
  });
  it("两个 Job 分别上传 Artifact", () => {
    expect(lt).toMatch(/name: heavy-queue-only/);
    expect(lt).toMatch(/name: heavy-mock-provider/);
  });

  it("DB stats 不依赖 psql（Runner 未必预装 postgresql-client）", () => {
    expect(lt).not.toMatch(/psql/);
    expect(lt).toMatch(/collect-db-stats\.mjs --mode=queue-only/);
    expect(lt).toMatch(/collect-db-stats\.mjs --mode=mock-provider/);
  });

  it("Worker 启动用轮询而非固定 sleep", () => {
    const j = lt.slice(lt.indexOf("  mock-provider:"));
    const step = j.slice(j.indexOf("- name: Start worker"), j.indexOf("- name: Preflight"));
    expect(step).not.toMatch(/^\s+sleep 8$/m);
    expect(step).toMatch(/for i in \$\(seq 1 30\)/);
    expect(step).toMatch(/exit 1/);
  });
});

describe("六、Vercel 侧显式声明 DB_DRIVER", () => {
  it(".env.example 与 README 均说明 neon_http", () => {
    const env = readFileSync(".env.example", "utf8");
    const readme = readFileSync("README.md", "utf8");
    expect(env).toMatch(/DB_DRIVER=neon_http/);
    expect(env).toMatch(/postgres_pool/);
    expect(env).toMatch(/pglite/);
    // .env.example 不应再残留已废弃的 Turso 配置
    expect(env).not.toMatch(/TURSO_/);
    expect(readme).toMatch(/DB_DRIVER=neon_http/);
  });
});

describe("五、readiness 前置检查脚本", () => {
  const src = readFileSync("scripts/assert-readiness.mjs", "utf8");
  it("支持三种模式且 queue-only 不要求 Worker", () => {
    expect(src).toMatch(/queue-only/);
    expect(src).toMatch(/mock-provider/);
    expect(src).toMatch(/report-only/);
    // 只有 mock-provider 检查 Live Worker
    const workerCheck = src.slice(src.indexOf('MODE === "mock-provider"'));
    expect(workerCheck.slice(0, 300)).toMatch(/workers\?\.live/);
  });
  it("断言 HTTP 200 / ready / DB 可达", () => {
    expect(src).toMatch(/res\.status !== 200/);
    expect(src).toMatch(/database\?\.ok !== true/);
    expect(src).toMatch(/body\?\.ready !== true/);
  });
  it("不静默吞错：失败写入详情并非零退出", () => {
    expect(src).toMatch(/readiness 请求失败/);
    expect(src).toMatch(/process\.exit\(reportOnly \? 0 : 1\)/);
  });
});
