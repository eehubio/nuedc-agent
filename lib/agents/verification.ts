// 验证类 Agent：测试评分（test_scoring）与代码静态验证（code_verifier）
import { llmJson } from "../llm";
import { registerAgent } from "./base";
import { computeScore, type TestRecord } from "../rules/test-scoring";
import type { Requirement } from "../types";

// ============ test_scoring：测试计划（LLM）+ 判定与得分（纯规则）============
registerAgent("test_scoring", async (input) => {
  const requirements: Requirement[] = input.requirements?.requirements || input.requirements || [];
  if (!requirements.length) return { ok: false, output: null, message: "缺少已确认的需求清单" };
  const records: TestRecord[] = input.records || [];

  // 判定与得分永远走规则，不管有没有 LLM
  const { verdicts, summary } = computeScore(requirements, records);

  // 测试计划：每条需求 → 仪器/测点/步骤/判据（只在首次或明确要求时生成）
  let plan: any = input.existing_plan || null;
  if (!plan && input.generate_plan !== false) {
    try {
      plan = await llmJson<{ test_cases: {
        requirement_id: string; test_case_id: string; instrument: string;
        measure_points: string[]; steps: string[]; threshold: string; pitfalls?: string;
      }[] }>({
        system: `你是电赛测试指导教师。为每条需求设计可执行的测试用例。
规则：
1. instrument 只用常见仪器：示波器/万用表/信号源/频谱仪/电子负载/卷尺秒表等
2. measure_points 写明具体测点（网络名/引脚/接口）
3. steps 3~6 步，动作明确可复现
4. threshold 引用需求的 target/tolerance 原值，不要改数
5. 有测量陷阱（探头档位、共地、量程）写入 pitfalls
6. requirement_id 必须使用输入中的真实 id，禁止编造`,
        messages: [{ role: "user", content: `需求清单：\n${JSON.stringify(requirements.map(({ id, description, target, unit, tolerance, verification_method, priority }) => ({ id, description, target, unit, tolerance, verification_method, priority }))).slice(0, 7000)}` }],
        maxTokens: 4096,
      });
      // 防幻觉：丢弃引用了不存在需求 id 的用例
      const validIds = new Set(requirements.map((r) => r.id));
      plan.test_cases = (plan.test_cases || []).filter((t: any) => validIds.has(t.requirement_id));
    } catch { plan = { test_cases: [], note: "测试计划生成失败，判定与得分不受影响" }; }
  }

  return {
    ok: true,
    artifact_type: "test_report",
    output: { plan, records, verdicts, summary },
    human_review_required: false,
    message: `基本要求 ${summary.mandatory_passed}/${summary.mandatory_total} 通过，预计得分 ${summary.score_low}~${summary.score_high}`,
  };
});

// ============ code_verifier：静态校验（诚实边界：真实编译需工具链，由 CI 回写状态）============
interface FileIssue { file: string; severity: "error" | "warning"; message: string }

function staticCheckC(path: string, content: string): FileIssue[] {
  const issues: FileIssue[] = [];
  const push = (severity: FileIssue["severity"], message: string) => issues.push({ file: path, severity, message });

  // 括号配平（忽略字符串与注释的粗粒度实现）
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const [open, close, name] of [["{", "}", "花括号"], ["(", ")", "圆括号"], ["[", "]", "方括号"]] as const) {
    const a = (stripped.match(new RegExp(`\\${open}`, "g")) || []).length;
    const b = (stripped.match(new RegExp(`\\${close}`, "g")) || []).length;
    if (a !== b) push("error", `${name}不配平（${open}×${a} vs ${close}×${b}），文件可能被截断`);
  }
  // 条件编译配平
  const ifs = (stripped.match(/^\s*#\s*if/gm) || []).length;
  const endifs = (stripped.match(/^\s*#\s*endif/gm) || []).length;
  if (ifs !== endifs) push("error", `#if(${ifs}) 与 #endif(${endifs}) 不配平`);
  // 生成残留占位
  for (const marker of ["【待补充】", "...", "TODO:", "FIXME", "省略"]) {
    if (content.includes(marker)) push("warning", `含占位/未完成标记 "${marker}"，烧录前必须补全`);
  }
  // 明显截断：末尾非闭合
  const tail = content.trimEnd().slice(-1);
  if (content.length > 200 && !["}", ";", ">", "\n", "/"].includes(tail)) {
    push("warning", `文件末尾以 "${tail}" 结束，疑似生成中断`);
  }
  return issues;
}

registerAgent("code_verifier", async (input) => {
  const files: { path: string; content: string }[] = input.files || input.bundle?.files || [];
  if (!files.length) return { ok: false, output: null, message: "缺少 files（先运行代码生成）" };

  const all: FileIssue[] = [];
  for (const f of files) {
    if (/\.(c|h|cpp|hpp|ino)$/i.test(f.path)) all.push(...staticCheckC(f.path, f.content));
  }
  const hasMain = files.some((f) => /\bmain\s*\(/.test(f.content));
  if (!hasMain) all.push({ file: "(工程)", severity: "warning", message: "未找到 main() 入口，确认工程结构" });

  const errors = all.filter((i) => i.severity === "error");
  const status = errors.length ? "GENERATED" : "SYNTAX_CHECKED";

  return {
    ok: true,
    artifact_type: "code_verification",
    output: {
      verification_status: status,
      issues: all,
      files_checked: files.length,
      honest_note: "SYNTAX_CHECKED 仅代表通过静态结构校验。COMPILED 及以上状态需真实工具链：本地或 CI 中运行编译后，调用本接口带 external_status 回写（如 GitHub Actions 使用 arm-none-eabi-gcc / TI CCS CLI）。未达 COMPILED 的代码一律不得视为可用。",
      ...(input.external_status && ["COMPILED", "UNIT_TESTED", "HIL_TESTED", "FIELD_VERIFIED"].includes(input.external_status)
        ? { verification_status: errors.length ? status : input.external_status, external_evidence: input.external_evidence || null }
        : {}),
    },
    human_review_required: false,
    message: errors.length
      ? `静态校验发现 ${errors.length} 个结构错误，维持 GENERATED`
      : `静态校验通过 → SYNTAX_CHECKED（${files.length} 个文件）`,
  };
});
