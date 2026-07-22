/** 端到端冒烟：对部署环境验证 持久化/级联失效/快照恢复/权限隔离/任务幂等/编译护栏。
 *  用法：BASE_URL=https://你的域名 npx tsx scripts/e2e-smoke.mts
 *  不调用 LLM（产物用直存接口写入），全程免费、可重复执行。 */
const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
let cookieA = "", cookieB = "";
let pass = 0, fail = 0;

function jar(which: "A" | "B") { return which === "A" ? cookieA : cookieB; }
async function call(which: "A" | "B", path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", cookie: jar(which), ...(init.headers || {}) } });
  const set = res.headers.get("set-cookie");
  if (set) { const c = set.split(";")[0]; if (which === "A") cookieA = c; else cookieB = c; }
  let data: any = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

console.log(`E2E 冒烟 → ${BASE}\n`);

// 1. 用户 A 建项目
const p = await call("A", "/api/projects", { method: "POST", body: JSON.stringify({ name: "E2E 冒烟项目" }) });
check("创建项目", p.status === 201 && !!p.data?.project_id, `HTTP ${p.status}`);
if (!p.data?.project_id) { console.log("\n创建项目失败，后续无法继续。检查部署与 DATABASE_URL。"); process.exit(1); }
const pid = p.data.project_id;

// 2. 持久化：存需求 → 存方案 → 下游 stale
await call("A", `/api/projects/${pid}/artifacts`, { method: "POST", body: JSON.stringify({ type: "requirements", content: { requirements: [{ id: "REQ-001", description: "e2e", priority: "mandatory", status: "CONFIRMED" }] } }) });
await call("A", `/api/projects/${pid}/artifacts`, { method: "POST", body: JSON.stringify({ type: "bom", content: { items: [{ line_id: "L1", name: "x", mpn: "X", quantity: 1, category: "c", source_type: "module", confidence: 1 }] } }) });
const s1 = await call("A", `/api/projects/${pid}/artifacts`, { method: "POST", body: JSON.stringify({ type: "solution", content: { solution_id: "S-A", name: "v1", blocks: [] } }) });
check("方案存为版本", s1.status === 201 && s1.data.version >= 1);
let d = await call("A", `/api/projects/${pid}`);
const bomLatest = (d.data.latest || []).find((a: any) => a.type === "bom");
check("方案变更 → BOM 被精确失效(stale)", bomLatest?.status === "stale", `got=${bomLatest?.status}`);
const reqLatest = (d.data.latest || []).find((a: any) => a.type === "requirements");
check("需求不在方案下游 → 不受影响", reqLatest?.status !== "stale");

// 3. 内容哈希去重：重复保存相同方案不增版本
const s2 = await call("A", `/api/projects/${pid}/artifacts`, { method: "POST", body: JSON.stringify({ type: "solution", content: { solution_id: "S-A", name: "v1", blocks: [] } }) });
check("相同内容不产生新版本(哈希去重)", s2.data?.version === s1.data?.version, `v1=${s1.data?.version} v2=${s2.data?.version}（不相等且快照也 404 → 线上是旧部署或迁移 007 未应用）`);

// 4. 快照：创建 → 改方案 → 整套恢复
const snap = await call("A", `/api/projects/${pid}/snapshots`, { method: "POST", body: "{}" });
check("创建快照", snap.status === 201 && !!snap.data?.snapshot_id, `HTTP ${snap.status} ${JSON.stringify(snap.data)?.slice(0, 80)}`);
if (snap.data?.snapshot_id) {
  await call("A", `/api/projects/${pid}/artifacts`, { method: "POST", body: JSON.stringify({ type: "solution", content: { solution_id: "S-A", name: "v2-changed", blocks: [] } }) });
  const rest = await call("A", `/api/projects/${pid}/snapshots/${snap.data.snapshot_id}/restore`, { method: "POST" });
  check("快照整套恢复", rest.status === 201 && rest.data?.restored?.solution >= 3, `HTTP ${rest.status}`);
  d = await call("A", `/api/projects/${pid}`);
  const solNow = (d.data.latest || []).find((a: any) => a.type === "solution");
  check("恢复后方案内容回到快照时点", solNow?.content?.name === "v1", `got=${solNow?.content?.name}`);
  check("恢复记录来源(change_reason)", String(solNow?.change_reason || "").startsWith("restore"));
} else {
  fail += 3;
  console.log("  ✗ 快照相关 3 项跳过 —— 快照接口不可用。404 通常意味着线上部署不是最新代码：请先 git push 并等 Vercel 部署完成，再重跑 DATABASE_URL=... npm run db:init 应用迁移 007。");
}

// 5. 权限：用户 B（新匿名身份）不可见/不可读 A 的项目
const listB = await call("B", "/api/projects");
check("B 的项目列表不含 A 的项目", !(listB.data.projects || []).some((x: any) => x.project_id === pid));
const readB = await call("B", `/api/projects/${pid}`);
check("B 直读 A 项目被拒(403)", readB.status === 403, `got=${readB.status}`);

// 6. 任务：并发去重 + 取消
const t1 = await call("A", "/api/agent-tasks", { method: "POST", body: JSON.stringify({ agent: "topic_forecast", project_id: pid, input: { device_list: ["MSPM0"] } }) });
const t2 = await call("A", "/api/agent-tasks", { method: "POST", body: JSON.stringify({ agent: "topic_forecast", project_id: pid, input: { device_list: ["MSPM0"] } }) });
check("同项目同 Agent 活动任务去重", t2.data?.deduped === true && t2.data?.task_id === t1.data?.task_id, `HTTP ${t2.status} ${JSON.stringify(t2.data)?.slice(0, 60)}`);
const c = await call("A", `/api/agent-tasks/${t1.data.task_id}/cancel`, { method: "POST" });
check("排队任务可取消", c.data?.status === "canceled", `HTTP ${c.status}`);

// 7. 编译护栏
const badPath = await call("A", "/api/build-jobs", { method: "POST", body: JSON.stringify({ project_id: pid, target: "mspm0", files: [{ path: "../etc/passwd.c", content: "x" }] }) });
check("路径逃逸被拒", badPath.status === 400);
const badExt = await call("A", "/api/build-jobs", { method: "POST", body: JSON.stringify({ project_id: pid, target: "mspm0", files: [{ path: "a.sh", content: "x" }] }) });
check("非法文件类型被拒", badExt.status === 400);
const okJob = await call("A", "/api/build-jobs", { method: "POST", body: JSON.stringify({ project_id: pid, target: "mspm0", files: [{ path: "main.c", content: "int main(void){return 0;}" }] }) });
check("合法编译任务入队", okJob.status === 202);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
