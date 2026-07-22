"use client";
import { useEffect, useRef, useState } from "react";

export function StaleBanner({ ctx, types, label }: { ctx: any; types: string[]; label: string }) {
  if (!types.some((t) => ctx.staleTypes?.includes(t))) return null;
  return <div className="issue warning" style={{ display: "block", marginBottom: 12 }}>⚠ 主方案已变更，{label}可能已过期 —— 建议重新生成后再使用。</div>;
}

/* ============ 方案框图（SVG 自动布局）============
   输入：solution.blocks / connections。布局：输入类在左列、
   主控在中列、输出/通信在右列、电源在底行；连线按接口预检
   问题着色（阻断红 / 警告琥珀 / 正常蓝）。 */
function roleBucket(b: any): "in" | "core" | "out" | "power" {
  const s = `${b.role || ""} ${b.name || ""} ${b.module_id || ""}`.toLowerCase();
  if (/power|电源|buck|boost|ldo/.test(s)) return "power";
  if (/mcu|dsp|fpga|control|主控|controller/.test(s)) return "core";
  if (/motor|actuator|display|comm|wireless|驱动|执行|显示|通信|dac|输出/.test(s)) return "out";
  return "in";
}
export function BlockDiagram({ solution }: { solution: any }) {
  const blocks: any[] = solution.blocks || [];
  const conns: any[] = solution.connections || [];
  const issues: any[] = solution.integration_precheck?.issues || [];
  const buckets: Record<string, any[]> = { in: [], core: [], out: [], power: [] };
  blocks.forEach((b) => buckets[roleBucket(b)].push(b));
  // 布局参数
  const W = 168, H = 52, GX = 90, GY = 16;
  const colX: Record<string, number> = { in: 10, core: 10 + W + GX, out: 10 + 2 * (W + GX) };
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 1;
  (["in", "core", "out"] as const).forEach((c) => {
    buckets[c].forEach((b, i) => pos.set(b.block_id, { x: colX[c], y: 12 + i * (H + GY) }));
    maxRows = Math.max(maxRows, buckets[c].length);
  });
  const powerY = 12 + maxRows * (H + GY) + 8;
  buckets.power.forEach((b, i) => pos.set(b.block_id, { x: 10 + i * (W + GX), y: powerY }));
  const width = 10 + 3 * W + 2 * GX + 10;
  const height = powerY + (buckets.power.length ? H + 14 : 4);

  // 连线端点匹配："K230.UART1_TX" → 匹配名称/模块 id 含 K230 的方块
  function findBlock(endpoint: string): any | null {
    const token = String(endpoint).split(".")[0].toLowerCase();
    return blocks.find((b) => `${b.name} ${b.module_id} ${b.block_id}`.toLowerCase().includes(token)) || null;
  }
  function connColor(c: any): string {
    const hit = issues.find((is) => is.where && String(is.where).includes(String(c.from)) && String(is.where).includes(String(c.to)));
    if (hit?.severity === "blocker") return "#dc2626";
    if (hit?.severity === "warning") return "#d97706";
    return "#3b82f6";
  }
  const bucketFill: Record<string, string> = { in: "#eef6ff", core: "#dbeafe", out: "#eef2ff", power: "#fef6e7" };
  const bucketStroke: Record<string, string> = { in: "#93c5fd", core: "#2563eb", out: "#a5b4fc", power: "#f0c26a" };

  return (
    <div className="diagram">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`方案 ${solution.name} 框图`}>
        {conns.map((c, i) => {
          const fb = findBlock(c.from), tb = findBlock(c.to);
          if (!fb || !tb) return null;
          const p1 = pos.get(fb.block_id)!, p2 = pos.get(tb.block_id)!;
          const x1 = p1.x + (p2.x >= p1.x ? W : 0), y1 = p1.y + H / 2;
          const x2 = p2.x + (p2.x >= p1.x ? 0 : W), y2 = p2.y + H / 2;
          const mx = (x1 + x2) / 2;
          const col = connColor(c);
          return (
            <g key={i}>
              <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={col} strokeWidth={1.6} />
              <circle cx={x2} cy={y2} r={2.6} fill={col} />
              <text x={mx} y={(y1 + y2) / 2 - 5} textAnchor="middle" fontSize="9.5" fill={col} fontFamily="ui-monospace,monospace">
                {c.protocol}{c.baudrate ? `@${c.baudrate >= 1e6 ? c.baudrate / 1e6 + "M" : c.baudrate / 1e3 + "k"}` : ""}
              </text>
            </g>
          );
        })}
        {blocks.map((b) => {
          const p = pos.get(b.block_id);
          if (!p) return null;
          const bk = roleBucket(b);
          return (
            <g key={b.block_id}>
              <rect x={p.x} y={p.y} width={W} height={H} rx={9} fill={bucketFill[bk]} stroke={bucketStroke[bk]} strokeWidth={bk === "core" ? 2 : 1.2} />
              <text x={p.x + W / 2} y={p.y + 21} textAnchor="middle" fontSize="11.5" fontWeight={700} fill="#1a2333">{b.name}</text>
              <text x={p.x + W / 2} y={p.y + 38} textAnchor="middle" fontSize="9.5" fill="#64748b" fontFamily="ui-monospace,monospace">{b.module_id || b.role}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ============ 方案生成（对话式，参考 ai-hardware-genesis 渐进流程）============ */
export function SolutionPage({ ctx }: { ctx: any }) {
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9 }); }, [ctx.msgs.length]);

  const step = ctx.chosenSolution ? 3 : ctx.solutions ? 2 : ctx.requirements ? 1 : 0;
  const steps = ["① 需求输入", "② 方案生成", "③ 方案评估", "④ 确认进入 BOM"];

  return (
    <>
      <div className="steps">
        {steps.map((s, i) => (
          <span key={s} className={"st" + (i < step ? " done" : i === step ? " on" : "")}>{s}</span>
        ))}
        {ctx.shortlist.length > 0 && <span className="hint" style={{ marginLeft: "auto" }}>已选用 {ctx.shortlist.length} 个模块将被优先考虑</span>}
      </div>

      <div className="solution-wrap">
        {/* 左：AI 助手对话 */}
        <div className="card chatbox">
          <div className="head"><span className="ai">AI</span>设计助手 · 渐进式方案发现</div>
          <div className="chatlog" ref={logRef}>
            {ctx.msgs.map((m: any, i: number) => (
              <div key={i} className={"bubble " + m.who}>{m.text}</div>
            ))}
            {ctx.busy && <div className="bubble agent"><span className="spinner" /> 思考中…</div>}
          </div>
          <div className="quickrow">
            {ctx.requirements && !ctx.solutions && (
              <button className="btn sm" disabled={ctx.busy} onClick={ctx.runSolution}>生成候选方案</button>
            )}
            {ctx.requirements && (
              <button className="btn ghost sm" disabled={ctx.busy} onClick={() => ctx.runInterpret(ctx.problemText)}>重新解析赛题</button>
            )}
            {ctx.chosenSolution && (
              <button className="btn ghost sm" onClick={() => ctx.setPage("wiring")}>去电路连线检查 →</button>
            )}
          </div>
          <div className="chatin">
            <textarea value={text} placeholder="粘贴赛题原文，或描述设计需求 / 向助手提问…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ctx.chat(text); setText(""); } }} />
            <button className="btn" disabled={ctx.busy || !text.trim()} onClick={() => { ctx.chat(text); setText(""); }}>发送</button>
          </div>
        </div>

        {/* 右：需求 → 方案卡片 */}
        <div style={{ display: "grid", gap: 14 }}>
          {ctx.requirements && <RequirementEditor ctx={ctx} />}

          {ctx.solutions?.truncation_note && (
            <div className="issue warning">⚠ {ctx.solutions.truncation_note}</div>
          )}
          {(ctx.solutions?.solutions || ctx.solutions?.candidate_solutions || []).map((sol: any) => {
            const pre = sol.integration_precheck;
            const chosen = ctx.chosenSolution?.solution_id === sol.solution_id;
            return (
              <div key={sol.solution_id} className={"solcard" + (chosen ? " chosen" : "")}>
                <h4>
                  <span className="chip" style={{ fontSize: 12 }}>{sol.solution_id}</span>{sol.name}
                  <span style={{ flex: 1 }} />
                  {pre && (pre.passed
                    ? <span className="chip green">接口预检通过</span>
                    : <span className="chip red">预检 {pre.issues?.filter((i: any) => i.severity === "blocker").length} 阻断</span>)}
                  <span className="chip">{sol.risk_level === "low" ? "低风险" : sol.risk_level === "high" ? "高风险" : "中风险"}</span>
                </h4>
                <p className="hint" style={{ margin: "2px 0 6px" }}>{sol.summary}</p>
                <BlockDiagram solution={sol} />
                <div className="prosub">
                  <div className="p"><b>优势</b><ul>{(sol.advantages || []).map((a: string) => <li key={a}>{a}</li>)}</ul></div>
                  <div className="c"><b>代价 / 风险</b><ul>{(sol.disadvantages || []).map((a: string) => <li key={a}>{a}</li>)}</ul></div>
                </div>
                {sol.uncovered_requirements?.length > 0 && (
                  <div className="issue warning">⚠ 未覆盖需求：{sol.uncovered_requirements.join("、")}</div>
                )}
                <BlockList sol={sol} ctx={ctx} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", marginTop: 8 }}>
                  {ctx.backupSolution?.solution_id === sol.solution_id && <span className="chip violet">备用方案</span>}
                  {!chosen && <button className="btn ghost sm" onClick={() => ctx.markBackup(sol)}>设为备用</button>}
                  {!chosen && <button className="btn sm" disabled={ctx.busy} onClick={() => ctx.approveSolution(sol)}>采用为主方案</button>}
                  {chosen && <span className="chip green">✓ 主方案 —— 可进入 BOM / 代码</span>}
                  {chosen && ctx.backupSolution && <button className="btn ghost sm" onClick={ctx.swapToBackup}>切换到备用 ⇄</button>}
                </div>
              </div>
            );
          })}

          {!ctx.requirements && (
            <div className="card">
              <h3>怎么开始？</h3>
              <p className="hint">1️⃣ 把赛题原文整段粘贴到左侧对话框发送 —— 助手会先解析成可核对的指标清单，并标出题面歧义等待你确认。<br />
                2️⃣ 确认后点「生成候选方案」，得到两套取舍不同的方案（含框图与接口预检）。<br />
                3️⃣ 人工选定一套后，即可继续 BOM、连线检查、代码与报告。<br /><br />
                💡 想让方案优先使用某些手头模块？先去「模块选型」页点「选用」。</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ============ 电路连线与接口检查 ============ */
export function WiringPage({ ctx }: { ctx: any }) {
  const sol = ctx.chosenSolution;
  const rep = ctx.wiringReport || sol?.integration_precheck;
  if (!sol) return <div className="card"><p className="hint">请先在「方案生成」页确认一套方案，这里将展示它的连线表并运行接口 / 电源规则检查。</p></div>;
  return (
    <>
    <StaleBanner ctx={ctx} types={["integration_report"]} label="接口检查结果" />
    <div className="grid cols-2" style={{ alignItems: "start" }}>
      <div style={{ display: "grid", gap: 14 }}>
        <div className="card">
          <h3>方案连线 · {sol.name}</h3>
          <BlockDiagram solution={{ ...sol, integration_precheck: rep }} />
          <table className="data">
            <thead><tr><th>从</th><th>到</th><th>协议</th><th>电平</th><th>速率</th></tr></thead>
            <tbody>
              {(sol.connections || []).map((c: any, i: number) => (
                <tr key={i}>
                  <td>{c.from}</td><td>{c.to}</td><td>{c.protocol}</td>
                  <td>{c.voltage_from}V → {c.voltage_to}V</td>
                  <td>{c.baudrate ? c.baudrate.toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sol.power_tree?.length > 0 && (
          <div className="card">
            <h3>电源树</h3>
            <table className="data">
              <thead><tr><th>电源轨</th><th>电压</th><th>来源</th><th>负载</th><th>预算</th></tr></thead>
              <tbody>
                {sol.power_tree.map((p: any) => (
                  <tr key={p.rail}><td>{p.rail}</td><td>{p.voltage}V</td><td>{p.source}</td><td>{(p.loads || []).join("、")}</td><td>{p.budget_ma}mA</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>规则检查结果
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={ctx.busy} onClick={ctx.runWiringCheck}>
            {ctx.busy ? "检查中…" : "重新运行检查"}
          </button>
        </h3>
        <p className="hint">电平容忍 / 引脚冲突 / 波特率 / 电源预算 / 动力隔离 —— 全部为确定性规则，不经过大模型。存在阻断项时代码生成将被拦截。</p>
        {rep ? (
          <>
            <div className={"issue " + (rep.passed ? "info" : "blocker")} style={{ fontWeight: 700 }}>
              {rep.passed ? `✓ 检查通过（${rep.checked_connections ?? sol.connections?.length ?? 0} 条连线）` : "✗ 存在阻断项，禁止进入代码生成"}
            </div>
            {(rep.issues || []).map((is: any, i: number) => (
              <div key={i} className={"issue " + is.severity}>
                <span className="tag">{is.severity === "blocker" ? "阻断" : is.severity === "warning" ? "警告" : "提示"}·{is.rule}</span>
                <span>{is.message}<br /><span className="hint">{is.where}</span></span>
              </div>
            ))}
          </>
        ) : <p className="hint">点「重新运行检查」执行完整规则检查。</p>}
        <div className="issue info" style={{ marginTop: 12 }}>📐 原理图 / PCB 在线编辑为二期功能；当前阶段以连线级检查保证方案电气正确性。</div>
      </div>
    </div>
    </>
  );
}

/* ============ 代码生成 ============ */
export function CodePage({ ctx }: { ctx: any }) {
  const [target, setTarget] = useState("");
  const [active, setActive] = useState(0);
  const [err, setErr] = useState("");
  const [buildJob, setBuildJob] = useState<any>(null);
  const [building, setBuilding] = useState(false);

  async function submitBuild(buildTarget: string) {
    if (!ctx.codeBundle?.files?.length) return;
    setBuilding(true);
    const r = await fetch("/api/build-jobs", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: ctx.projectId, target: buildTarget, files: ctx.codeBundle.files }) }).then((x) => x.json());
    if (!r.job_id) { setErr(r.error || "提交失败"); setBuilding(false); return; }
    setBuildJob({ job_id: r.job_id, status: "queued" });
    // 轮询直到终态（执行器在 CI / 本地跑）
    const t0 = Date.now();
    while (Date.now() - t0 < 40 * 60_000) {
      await new Promise((rs) => setTimeout(rs, 5000));
      const j = await fetch(`/api/build-jobs/${r.job_id}`).then((x) => x.json()).catch(() => null);
      if (j?.status && !["queued", "running"].includes(j.status)) {
        setBuildJob(j);
        if (["MINIMAL_LINKED", "SOURCE_COMPILED"].includes(j.status)) {
          await ctx.runVerify?.();   // 静态验证在前
          await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "code_verifier", project_id: ctx.projectId,
              input: { files: ctx.codeBundle.files, external_status: j.status,
                external_evidence: `build_job:${j.job_id}${j.flash_bytes != null ? ` flash=${j.flash_bytes}B ram=${j.ram_bytes}B` : ""}` } }) });
        }
        break;
      }
      if (j) setBuildJob(j);
    }
    setBuilding(false);
  }
  const b = ctx.codeBundle;
  const files = b?.files || [];
  const mcu = ctx.chosenSolution?.blocks?.find((bl: any) => /mcu|主控/i.test(`${bl.role} ${bl.name}`));
  return (
    <>
    <StaleBanner ctx={ctx} types={["code_bundle", "code_verification"]} label="生成的代码" />
    <div className="code-wrap">
      <div className="card">
        <h3>工程文件</h3>
        <div className="filetree">
          {files.map((f: any, i: number) => (
            <button key={f.path} className={active === i ? "on" : ""} onClick={() => setActive(i)}>{f.path}</button>
          ))}
          {!files.length && <span className="hint">生成后这里显示分层的固件文件树。</span>}
        </div>
        {b?.plan?.length > 0 && (
          <>
            <h4 style={{ marginBottom: 4 }}>分层结构</h4>
            {b.plan.map((p: any) => <div key={p.layer} className="hint">▸ {p.layer}：{p.files.join("、")}</div>)}
          </>
        )}
      </div>

      <div className="codeview">
        <div className="tab">{files[active]?.path || "main.c"}</div>
        <pre>{files[active]?.content || "// 在右侧选择目标模块并点「生成代码」\n// 生成的代码状态为 GENERATED：\n// 编译通过前不会被标记为可用。"}</pre>
      </div>

      <div className="card">
        <h3>代码配置</h3>
        <p className="hint">开发平台：<b>{mcu ? `${mcu.name}（${mcu.module_id || ""}）` : "未确认方案"}</b></p>
        <label className="hint">目标模块（留空自动选择）</label>
        <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid var(--line)", margin: "4px 0 10px" }}>
          <option value="">— 自动 —</option>
          {(ctx.chosenSolution?.blocks || []).map((bl: any) => (
            <option key={bl.block_id} value={bl.module_id || bl.name}>{bl.name}</option>
          ))}
        </select>
        <button className="btn" style={{ width: "100%" }} disabled={ctx.busy} onClick={async () => {
          setErr("");
          const r = await ctx.runCode(target);
          if (!r.ok) setErr(r.message || "生成失败");
          else setActive(0);
        }}>{ctx.busy ? "生成中…" : "⚡ 生成代码"}</button>
        {err && <div className="issue blocker" style={{ marginTop: 10 }}>{err}</div>}
        {b && (
          <>
            <div className="issue info" style={{ marginTop: 10, display: "block" }}>
              验证状态：<b>{b.verification_status}</b>
              <div style={{ display: "flex", gap: 3, margin: "6px 0" }}>
                {["GENERATED", "SYNTAX_CHECKED", "SOURCE_COMPILED", "MINIMAL_LINKED", "SDK_BUILD_PASSED", "HIL_TESTED"].map((st) => (
                  <span key={st} className={"chip" + (b.verification_status === st ? " green" : "")} style={{ fontSize: 10 }}>{st}</span>
                ))}
              </div>
              MINIMAL_LINKED=最小链接出 ELF，≠厂商工程可烧录构建（那需要 SDK_BUILD_PASSED）。
            </div>
            <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} disabled={ctx.busy} onClick={ctx.runVerify}>🔍 静态验证</button>
            {b.verify_issues?.length > 0 && b.verify_issues.map((is: any, i: number) => (
              <div key={i} className={"issue " + (is.severity === "error" ? "blocker" : "warning")} style={{ marginTop: 6 }}>
                <span className="tag">{is.file}</span><span>{is.message}</span>
              </div>
            ))}
            {b.honest_note && <p className="hint" style={{ marginTop: 6 }}>{b.honest_note}</p>}
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 10 }}>
              <b style={{ fontSize: 13 }}>真实编译（build_jobs）</b>
              <p className="hint">交叉编译由执行器完成（GitHub Actions 每 30 分钟巡队列，或本地 <code>npm run build:runner</code>）。成功后自动晋级 COMPILED 并给出 Flash/RAM。</p>
              <div style={{ display: "flex", gap: 6 }}>
                {["mspm0", "stm32", "esp32"].map((t) => (
                  <button key={t} className="btn ghost sm" disabled={building} onClick={() => submitBuild(t)}>编译 {t.toUpperCase()}</button>
                ))}
              </div>
              {buildJob && (
                <div className="issue info" style={{ marginTop: 8, display: "block" }}>
                  任务 {buildJob.job_id}：<b>{buildJob.status}</b>
                  {building && <span className="spinner" style={{ marginLeft: 6 }} />}
                  {buildJob.flash_bytes != null && <> · Flash {buildJob.flash_bytes}B / RAM {buildJob.ram_bytes}B</>}
                  {buildJob.has_bin && <> · <a href={`/api/build-jobs/${buildJob.job_id}?bin=1`} download>下载 BIN</a></>}
                  {buildJob.log && <details style={{ marginTop: 4 }}><summary>编译日志</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{buildJob.log}</pre></details>}
                </div>
              )}
            </div>
            {b.unsupported_items?.length > 0 && (
              <div className="issue warning">以下内容无法可靠生成（不编造 API）：{b.unsupported_items.join("、")}</div>
            )}
          </>
        )}
      </div>
    </div>
    </>
  );
}

/* ============ 调试助手 ============ */
export function DebugPage({ ctx }: { ctx: any }) {
  const [symptom, setSymptom] = useState("");
  const [logs, setLogs] = useState("");
  const [images, setImages] = useState<{ media_type: string; data_base64: string; name: string }[]>([]);
  const [err, setErr] = useState("");
  const s = ctx.debugSession;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setImages((im) => [...im, { media_type: f.type, data_base64: String(rd.result).split(",")[1], name: f.name }]);
    rd.readAsDataURL(f);
  }

  return (
    <div className="grid cols-2" style={{ alignItems: "start" }}>
      <div className="card">
        <h3>报告故障</h3>
        <label className="hint">现象描述</label>
        <textarea className="area" rows={3} value={symptom} onChange={(e) => setSymptom(e.target.value)}
          placeholder="例：电机一启动 MCU 就复位；示波器看 3.3V 轨跌到 2.6V…" />
        <label className="hint">串口日志 / 测量数据（可选）</label>
        <textarea className="area" rows={4} value={logs} onChange={(e) => setLogs(e.target.value)} placeholder="粘贴串口输出、示波器读数…" />
        <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
          <label className="btn ghost sm" style={{ display: "inline-block" }}>
            📷 上传照片（板卡 / 波形）
            <input type="file" accept="image/*" hidden onChange={onFile} />
          </label>
          {images.map((im, i) => <span key={i} className="chip">{im.name} ✕<button style={{ border: 0, background: "none", cursor: "pointer" }} onClick={() => setImages((a) => a.filter((_, j) => j !== i))} aria-label="移除" /></span>)}
        </div>
        <button className="btn" disabled={ctx.busy || !symptom.trim()} onClick={async () => {
          setErr("");
          const r = await ctx.runDebug(symptom, logs, images.map(({ name, ...rest }) => rest));
          if (!r.ok) setErr(r.message || "分析失败");
        }}>{ctx.busy ? "分析中…" : "开始诊断"}</button>
        {err && <div className="issue blocker" style={{ marginTop: 10 }}>{err}</div>}
        {s && <p className="hint" style={{ marginTop: 10 }}>🔁 这是循环调试：按右侧指引测量后，把新结果继续提交，假设会随证据收敛。</p>}
        <div className="issue info" style={{ marginTop: 10 }}>🧪 示波器 / 串口实时接入为二期「实验平台」功能。</div>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        {s?.safety_warnings?.length > 0 && s.safety_warnings.map((w: string, i: number) => (
          <div key={i} className="issue blocker">⚡ 安全：{w}</div>
        ))}
        <div className="card">
          <h3>故障假设（按置信度）</h3>
          {(s?.hypotheses || []).map((h: any, i: number) => (
            <div key={i} className="hyp">
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
                <span>{h.cause || h.hypothesis || h.text}</span>
                <b>{Math.round((h.confidence ?? 0) * 100)}%</b>
              </div>
              <div className="bar"><i style={{ width: `${(h.confidence ?? 0) * 100}%` }} /></div>
              {h.rationale && <p className="hint" style={{ margin: "3px 0 0" }}>{h.rationale}</p>}
            </div>
          ))}
          {!s && <p className="hint">诊断后这里显示带置信度的故障树。</p>}
        </div>
        {s?.next_measurements?.length > 0 && (
          <div className="card">
            <h3>下一步测量动作</h3>
            <table className="data">
              <thead><tr><th>#</th><th>测什么</th><th>预期 / 判据</th></tr></thead>
              <tbody>
                {s.next_measurements.map((m: any, i: number) => (
                  <tr key={i}><td>{i + 1}</td><td>{m.action || m.measure || m.text}</td><td>{m.expected || m.criteria || "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============ 报告生成 ============ */
const CHAPTERS = ["题目分析与摘要", "方案论证与比较", "系统总体设计", "理论分析与计算", "电路与程序设计", "测试方案与结果", "结论", "附录"];
export function ReportPage({ ctx }: { ctx: any }) {
  const [incBom, setIncBom] = useState(true);
  const [incCode, setIncCode] = useState(true);
  const [incDebug, setIncDebug] = useState(false);
  const [err, setErr] = useState("");
  const r = ctx.report;
  return (
    <div className="grid" style={{ gridTemplateColumns: "300px 1fr", alignItems: "start" }}>
      <div style={{ display: "grid", gap: 14 }}>
        <div className="card">
          <h3>报告章节（按电赛规范）</h3>
          {CHAPTERS.map((c, i) => <div key={c} className="chapter"><span className="n">{i + 1}</span>{c}</div>)}
        </div>
        <div className="card">
          <h3>生成选项</h3>
          <div className="tasklist">
            <label><input type="checkbox" checked={incBom} onChange={() => setIncBom(!incBom)} />包含 BOM 元件清单</label>
            <label><input type="checkbox" checked={incCode} onChange={() => setIncCode(!incCode)} />包含代码文件清单</label>
            <label><input type="checkbox" checked={incDebug} onChange={() => setIncDebug(!incDebug)} />包含调试记录</label>
          </div>
          <button className="btn" style={{ width: "100%", marginTop: 12 }} disabled={ctx.busy} onClick={async () => {
            setErr("");
            const res = await ctx.runReport({ includeBom: incBom, includeCode: incCode, includeDebug: incDebug });
            if (!res.ok) setErr(res.message || "生成失败");
          }}>{ctx.busy ? "撰写中…" : "📄 生成报告"}</button>
          {err && <div className="issue blocker" style={{ marginTop: 10 }}>{err}</div>}
          {r && ctx.projectId && (
            <a className="btn ghost" style={{ display: "block", textAlign: "center", marginTop: 8, textDecoration: "none" }}
              href={`/api/report?project_id=${ctx.projectId}`} download>⬇ 下载 Markdown</a>
          )}
          <p className="hint" style={{ marginTop: 10 }}>缺失的测试数据会以【待补充】占位 —— 不会编造数值；生成后自动做型号一致性检查。</p>
        </div>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        {r?.consistency_issues?.length > 0 && (
          <div className="card">
            <h3>一致性检查（{r.consistency_issues.length} 处需核实）</h3>
            {r.consistency_issues.map((c: any, i: number) => (
              <div key={i} className="issue warning">⚠ {typeof c === "string" ? c : c.message || JSON.stringify(c)}</div>
            ))}
          </div>
        )}
        <div className="report-md">{r?.markdown || r?.content || "生成后这里预览报告全文。\n\n报告将基于已确认的方案、结构化需求与 BOM 撰写，遵循电赛设计报告章节规范。"}</div>
      </div>
    </div>
  );
}


/* ============ 需求编辑器（逐条编辑 / 确认 / 驳回）============ */
const REQ_STATUS_UI: Record<string, [string, string]> = {
  AI_EXTRACTED: ["AI 提取", "chip"], NEEDS_REVIEW: ["待核对", "chip gold"], AMBIGUOUS: ["歧义", "chip gold"],
  CONFIRMED: ["已确认", "chip green"], REJECTED: ["已驳回", "chip red"],
};
function RequirementEditor({ ctx }: { ctx: any }) {
  const list: any[] = ctx.requirements?.requirements || [];
  const [editing, setEditing] = useState<string | null>(null);
  const mand = list.filter((r) => r.priority === "mandatory" && r.status !== "REJECTED");
  const confirmed = mand.filter((r) => r.status === "CONFIRMED").length;
  const allConfirmed = confirmed === mand.length && mand.length > 0;

  return (
    <div className="card">
      <h3>需求清单
        <span className="hint" style={{ fontWeight: 400 }}>基本要求已确认 {confirmed}/{mand.length}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={ctx.addRequirement}>＋ 补充需求</button>
        <button className="btn sm" onClick={ctx.confirmAllExtracted}>全部确认</button>
      </h3>
      <div className="progress"><i style={{ width: `${mand.length ? (confirmed / mand.length) * 100 : 0}%` }} /></div>
      {!allConfirmed && <p className="hint">⚠ 所有基本要求逐条确认后才能生成正式方案 —— 第一步解析错了，后面的方案 / BOM / 代码 / 报告会一路错下去。</p>}

      {list.map((r) => {
        const [label, cls] = REQ_STATUS_UI[r.status || "AI_EXTRACTED"] || ["?", "chip"];
        const isEdit = editing === r.id;
        return (
          <div key={r.id} className="req-item" style={{ flexWrap: "wrap", opacity: r.status === "REJECTED" ? 0.5 : 1 }}>
            <span className="rid">{r.id}</span>
            {isEdit ? (
              <span style={{ flex: 1, display: "grid", gap: 5 }}>
                <input value={r.description} onChange={(e) => ctx.updateRequirement(r.id, { description: e.target.value })}
                  style={{ padding: 5, border: "1px solid var(--line)", borderRadius: 6, width: "100%" }} />
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <input value={r.target ?? ""} placeholder="指标" style={{ width: 76, padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}
                    onChange={(e) => ctx.updateRequirement(r.id, { target: e.target.value })} />
                  <input value={r.unit ?? ""} placeholder="单位" style={{ width: 56, padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}
                    onChange={(e) => ctx.updateRequirement(r.id, { unit: e.target.value })} />
                  <input value={r.tolerance ?? ""} placeholder="误差 ±1%" style={{ width: 80, padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}
                    onChange={(e) => ctx.updateRequirement(r.id, { tolerance: e.target.value })} />
                  <select value={r.priority} onChange={(e) => ctx.updateRequirement(r.id, { priority: e.target.value })}
                    style={{ padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}>
                    <option value="mandatory">基本要求</option><option value="bonus">发挥部分</option>
                  </select>
                  <select value={r.verification_method} onChange={(e) => ctx.updateRequirement(r.id, { verification_method: e.target.value })}
                    style={{ padding: 4, border: "1px solid var(--line)", borderRadius: 6 }}>
                    {["measurement", "demonstration", "inspection", "analysis"].map((v) => <option key={v}>{v}</option>)}
                  </select>
                  <button className="btn sm" onClick={() => setEditing(null)}>完成</button>
                </span>
              </span>
            ) : (
              <span style={{ flex: 1 }}>
                {r.description}
                {r.target != null && <span className="hint">（{r.target}{r.unit || ""}{r.tolerance ? ` ${r.tolerance}` : ""}）</span>}
                {r.source && <><br /><span className="hint">📎 {r.source}</span></>}
              </span>
            )}
            <span style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
              <span className={cls}>{label}</span>
              {r.priority === "mandatory" && <span className="must">基本</span>}
              {!isEdit && <button className="btn ghost sm" onClick={() => setEditing(r.id)}>改</button>}
              {r.status !== "CONFIRMED" && <button className="btn sm ok" onClick={() => ctx.setReqStatus(r.id, "CONFIRMED")}>✓</button>}
              {r.status !== "REJECTED" && <button className="btn ghost sm" onClick={() => ctx.setReqStatus(r.id, "REJECTED")}>✕</button>}
            </span>
          </div>
        );
      })}
      {ctx.requirements.ambiguities?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {ctx.requirements.ambiguities.map((a: any, i: number) => (
            <div key={i} className="issue warning">❓ 题面歧义：{typeof a === "string" ? a : (a.description || a.text || JSON.stringify(a)) + (a.source ? `（出自：${a.source}）` : "")}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============ 方案块清单：替换模块 + 需求覆盖矩阵 ============ */
function BlockList({ sol, ctx }: { sol: any; ctx: any }) {
  const [replacing, setReplacing] = useState<any>(null);   // block
  const [q, setQ] = useState("");
  const [showMatrix, setShowMatrix] = useState(false);
  const reqs = (ctx.requirements?.requirements || []).filter((r: any) => r.status !== "REJECTED");
  const otherSol = (ctx.solutions?.solutions || ctx.solutions?.candidate_solutions || []).find((x: any) => x.solution_id !== sol.solution_id);

  const candidates = replacing ? [
    // 另一套方案中同角色的模块置顶（支持"从两套方案合并"）
    ...(otherSol?.blocks || [])
      .filter((b: any) => b.role === replacing.role && b.module_id && b.module_id !== replacing.module_id)
      .map((b: any) => ({ ...(ctx.modules.find((m: any) => m.id === b.module_id) || { id: b.module_id, name: b.name }), _from: otherSol.solution_id })),
    ...ctx.modules.filter((m: any) =>
      m.id !== replacing.module_id &&
      (!q || `${m.name} ${m.main_chip} ${m.id}`.toLowerCase().includes(q.toLowerCase()))),
  ].filter((m: any, i: number, arr: any[]) => arr.findIndex((x) => x.id === m.id) === i).slice(0, 30) : [];

  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "4px 0" }}>
        {(sol.blocks || []).map((b: any) => (
          <span key={b.block_id} className="chip" style={{ display: "inline-flex", gap: 5, alignItems: "center", padding: "3px 6px 3px 10px" }}>
            {b.name}
            <button style={{ border: 0, background: "#fff", borderRadius: 5, padding: "0 6px", cursor: "pointer", fontSize: 11 }}
              onClick={() => { setReplacing(b); setQ(""); }}>替换</button>
          </span>
        ))}
        <button className="btn ghost sm" onClick={() => setShowMatrix(!showMatrix)}>{showMatrix ? "收起" : "需求覆盖矩阵"}</button>
      </div>

      {showMatrix && (
        <table className="data" style={{ margin: "6px 0" }}>
          <thead><tr><th>需求</th>{(sol.blocks || []).map((b: any) => <th key={b.block_id} style={{ writingMode: undefined }}>{b.name}</th>)}<th>覆盖</th></tr></thead>
          <tbody>
            {reqs.map((r: any) => {
              const hit = (sol.blocks || []).filter((b: any) => (b.covers_requirements || []).includes(r.id));
              return (
                <tr key={r.id} style={!hit.length ? { background: "#fdecec" } : undefined}>
                  <td><b>{r.id}</b> <span className="hint">{r.description.slice(0, 20)}</span></td>
                  {(sol.blocks || []).map((b: any) => (
                    <td key={b.block_id} style={{ textAlign: "center" }}>{(b.covers_requirements || []).includes(r.id) ? "✓" : ""}</td>
                  ))}
                  <td>{hit.length ? <span className="chip green">✓</span> : <span className="chip red">未覆盖</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {replacing && (
        <div className="modal-mask" onClick={() => setReplacing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>替换「{replacing.name}」</h3>
            <p className="hint">选择替换模块后自动重跑接口规则检查。来自另一套方案的同角色模块排在最前（支持两套方案合并取用）。</p>
            <input placeholder="搜索模块 / 芯片…" value={q} onChange={(e) => setQ(e.target.value)}
              style={{ width: "100%", padding: 8, border: "1px solid var(--line)", borderRadius: 8, margin: "8px 0" }} />
            {candidates.map((m: any) => (
              <div key={m.id} className="req-item" style={{ alignItems: "center" }}>
                <span style={{ flex: 1 }}>
                  <b>{m.name}</b> {m._from && <span className="chip violet">来自 {m._from}</span>}
                  <br /><span className="hint">{m.main_chip || m.id}</span>
                </span>
                <button className="btn sm" disabled={ctx.busy}
                  onClick={async () => { setReplacing(null); await ctx.replaceBlock(sol.solution_id, replacing.block_id, m); }}>选用</button>
              </div>
            ))}
            <div style={{ textAlign: "right", marginTop: 10 }}>
              <button className="btn ghost sm" onClick={() => setReplacing(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
