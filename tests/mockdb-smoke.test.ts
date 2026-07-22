import { describe, it, expect, afterAll } from "vitest";
import { setupMockDb, teardownMockDb } from "./helpers/mock-db";

describe("mock DB 底座", () => {
  afterAll(teardownMockDb);

  it("全部迁移能在 pglite 上跑通", async () => {
    const ctx = await setupMockDb();
    const rs = await ctx.raw("SELECT id FROM schema_migrations ORDER BY id");
    const ids = rs.rows.map((r: any) => Number(r.id));
    expect(ids).toContain(1);
    expect(ids).toContain(16);
    expect(ids).toContain(17);
  });

  it("agent_tasks 关键列存在", async () => {
    const ctx = await setupMockDb();
    const rs = await ctx.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name='agent_tasks'`,
    );
    const cols = rs.rows.map((r: any) => String(r.column_name));
    for (const c of ["dedup_key", "retryable", "provider_error_code", "cost_class", "quota_ref"]) {
      expect(cols).toContain(c);
    }
  });
});
