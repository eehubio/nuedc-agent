import type { BomItem } from "../types";

// ============================================================
// 备料数量规则 —— 配置化，不硬编码在 LLM 提示词里（设计文档 Agent 10）
// ============================================================

export interface QuantityRule {
  match: RegExp;          // 匹配类别或名称
  multiplier?: number;    // 需求数量倍数
  min?: number;           // 最少数量
  group: BomItem["group"];
  note: string;
}

export const QUANTITY_RULES: QuantityRule[] = [
  { match: /mcu|主控|开发板|launchpad|mspm0|stm32|k230/i, min: 2, group: "必须具备", note: "主控板每队至少 2 块" },
  { match: /电源|buck|boost|ldo|dcdc|power/i, min: 2, group: "建议备份", note: "高风险电源模块至少备 2 个" },
  { match: /电机驱动|motor.?driver|tb6612|drv8/i, multiplier: 1.5, group: "必须具备", note: "电机驱动按需求 ×1.5" },
  { match: /mos|mosfet|二极管|diode|三极管/i, multiplier: 3, group: "通用耗材", note: "易损功率器件按需求 ×3" },
  { match: /排针|排母|连接器|connector|杜邦|xh|ph2\.0/i, multiplier: 2, group: "通用耗材", note: "连接器按需求 ×2" },
  { match: /pcb|定制板|主板/i, min: 3, group: "必须具备", note: "定制 PCB 主板至少 3 块" },
];

export function applyQuantityRules(items: BomItem[]): BomItem[] {
  return items.map((item) => {
    const hay = `${item.category} ${item.name} ${item.mpn}`;
    for (const rule of QUANTITY_RULES) {
      if (rule.match.test(hay)) {
        let qty = item.quantity;
        if (rule.multiplier) qty = Math.ceil(qty * rule.multiplier);
        if (rule.min) qty = Math.max(qty, rule.min);
        return { ...item, quantity: qty, group: item.group ?? rule.group };
      }
    }
    return { ...item, group: item.group ?? "必须具备" };
  });
}

/** 人工审核条件（设计文档 Agent 4）：置信度低 / 有替代料 / 功率电压风险 */
export function flagForReview(items: BomItem[]): BomItem[] {
  return items.map((it) => ({
    ...it,
    needs_review:
      it.confidence < 0.8 ||
      (it.substitutes && it.substitutes.length > 1) ||
      /高压|220v|功率|igbt/i.test(it.name),
  }));
}
