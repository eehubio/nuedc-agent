/** 产物类型级依赖图（DAG）。精确失效：类型 T 更新时，只有 T 的传递下游被标 stale。
 *  比固定数组更细：需求变→全链失效；接口检查变→只影响代码及之后；代码变→只影响验证/测试/报告。
 *  实例级溯源（哪份报告用了哪版 BOM）记录在 artifact_dependencies 表。 */

export const TYPE_DAG: Record<string, string[]> = {
  // 上游类型 → 直接下游类型
  requirements:       ["solution_proposal", "solution", "test_plan"],
  solution_proposal:  ["solution"],
  solution:           ["integration_report", "bom", "code_bundle"],
  integration_report: ["code_bundle"],
  bom:                ["procurement_plan", "report"],
  code_bundle:        ["code_verification", "test_record", "report"],
  code_verification:  ["report"],
  test_plan:          ["test_record"],
  test_record:        ["score", "test_report"],
  score:              ["report"],
  test_report:        ["report"],
};

/** 类型 T 的全部传递下游（不含 T 自身） */
export function downstreamOf(type: string): string[] {
  const out = new Set<string>();
  const walk = (t: string) => {
    for (const d of TYPE_DAG[t] || []) {
      if (!out.has(d)) { out.add(d); walk(d); }
    }
  };
  walk(type);
  return [...out];
}

/** 各 Agent 消费的上游产物类型（自动记录实例级 source chain 用） */
export const AGENT_CONSUMES: Record<string, string[]> = {
  solution_architect:  ["requirements"],
  integration_checker: ["solution"],
  bom_agent:           ["solution"],
  procurement_planner: ["bom", "solution"],
  code_generator:      ["solution", "integration_report"],
  code_verifier:       ["code_bundle"],
  test_scoring:        ["requirements", "test_plan"],
  report_composer:     ["requirements", "solution", "bom", "code_bundle", "score"],
};
