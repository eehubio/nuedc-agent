import type { Provider, ProviderRequest, ProviderResponse } from "./base";
import { ProviderError } from "./base";

/** 压测与本地开发用的假 Provider：不产生真实费用。
 *  MOCK_LATENCY_MS 控制延迟，MOCK_FAIL_RATE 控制随机失败率（用于容灾测试）。 */
export const mockProvider: Provider = {
  id: "mock",
  label: "Mock（压测用）",
  capabilities: { vision: true, pdf: true, jsonMode: true, thinkingControl: true },
  pricing: { inputPerMillion: 0, outputPerMillion: 0 },
  isConfigured: () => process.env.ENABLE_MOCK_PROVIDER === "1",
  modelFor: () => "mock-model",

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const latency = Number(process.env.MOCK_LATENCY_MS || 200);
    await new Promise((r) => setTimeout(r, latency));

    const failRate = Number(process.env.MOCK_FAIL_RATE || 0);
    if (failRate > 0 && Math.random() < failRate) {
      throw new ProviderError("Mock 模拟限流", "RATE_LIMIT", true, 500);
    }

    // 依据请求内容生成结构合法的假数据，让 Schema 校验能通过
    const text = req.json ? mockJsonFor(req.system + req.messages.map((m) => m.content).join(" ")) : "mock 回复";
    return {
      text,
      inputTokens: Math.ceil((req.system.length + req.messages.reduce((a, m) => a + m.content.length, 0)) / 4),
      outputTokens: Math.ceil(text.length / 4),
      finishReason: "stop",
      truncated: false,
    };
  },
};

function mockJsonFor(prompt: string): string {
  if (/solution|方案/.test(prompt)) {
    return JSON.stringify({ solution: {
      solution_id: "SOL-MOCK", name: "Mock 方案", summary: "压测用假方案",
      blocks: [
        { block_id: "B1", name: "主控", module_id: "", role: "mcu", covers_requirements: ["REQ-001"] },
        { block_id: "B2", name: "传感", module_id: "", role: "sensor", covers_requirements: ["REQ-002"] },
        { block_id: "B3", name: "电源", module_id: "", role: "power", covers_requirements: [] },
        { block_id: "B4", name: "显示", module_id: "", role: "display", covers_requirements: [] },
      ],
      connections: [{ from: "B2.OUT", to: "B1.ADC0", protocol: "Analog", voltage_from: 3.3, voltage_to: 3.3 }],
      power_tree: [{ rail: "3V3", voltage: 3.3, source: "LDO", loads: ["B1", "B2"], budget_ma: 500 }],
      advantages: ["实现简单"], disadvantages: ["精度一般"],
      risk_level: "low", implementation_hours: 20, uncovered_requirements: [],
    } });
  }
  if (/BOM|物料/.test(prompt)) {
    return JSON.stringify({ items: [
      { line_id: "BOM-001", mpn: "MOCK-001", name: "Mock 器件", category: "other.misc", quantity: 1, source_type: "component", confidence: 0.9 },
    ], unresolved_items: [] });
  }
  if (/requirement|需求|指标/.test(prompt)) {
    return JSON.stringify({
      project_name: "Mock 项目", system_overview: "压测用",
      requirements: [
        { id: "REQ-001", type: "functional", description: "Mock 需求一", priority: "mandatory", source: "mock", verification_method: "measurement", status: "AI_EXTRACTED" },
        { id: "REQ-002", type: "performance", description: "Mock 需求二", target: 2, unit: "V", tolerance: "±1%", priority: "mandatory", source: "mock", verification_method: "measurement", status: "AI_EXTRACTED" },
      ],
      scoring_items: [], ambiguities: [],
    });
  }
  return JSON.stringify({ ok: true, mock: true });
}
