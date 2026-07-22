import type { SolutionProposal } from "../types";

// ============================================================
// 接口与集成检查 —— 设计文档 Agent 9 的"硬规则"部分。
// 这些检查用程序实现而不是 LLM：结果必须确定、可复现。
// 发现 blocker 时，方案禁止进入代码生成阶段。
// ============================================================

export interface IntegrationIssue {
  severity: "blocker" | "warning" | "info";
  rule: string;
  message: string;
  where: string;
}

export interface IntegrationReport {
  passed: boolean;
  issues: IntegrationIssue[];
  checked_connections: number;
}

export function checkIntegration(
  solution: SolutionProposal,
  moduleIndex: Record<string, any> // module_id -> 模块完整数据（含 interfaces/power）
): IntegrationReport {
  const issues: IntegrationIssue[] = [];

  // ---- 1. 连接级检查：电平兼容 ----
  for (const conn of solution.connections || []) {
    const where = `${conn.from} → ${conn.to}`;
    const vf = conn.voltage_from;
    const vt = conn.voltage_to;
    if (vf != null && vt != null) {
      // 5V 输出直接进 3.3V 非容忍输入
      if (vf > vt + 0.3) {
        const toIface = findInterface(moduleIndex, conn.to);
        const tolerant = toIface?.five_v_tolerant === true;
        if (vf >= 4.5 && vt <= 3.6 && !tolerant) {
          issues.push({
            severity: "blocker",
            rule: "LEVEL_5V_INTO_3V3",
            message: `${vf}V 电平直接驱动 ${vt}V 非 5V 容忍输入，需加电平转换`,
            where,
          });
        } else {
          issues.push({
            severity: "warning",
            rule: "LEVEL_MISMATCH",
            message: `发送端电平 ${vf}V 高于接收端 ${vt}V，请确认容忍性或加分压/电平转换`,
            where,
          });
        }
      }
      // 3.3V 驱动 5V 输入：多数可行但阈值需确认
      if (vt - vf >= 1.5) {
        issues.push({
          severity: "warning",
          rule: "LEVEL_LOW_DRIVE_HIGH",
          message: `${vf}V 驱动 ${vt}V 输入，VIH 阈值可能不满足，请核对接收端数据手册`,
          where,
        });
      }
    }
    // UART 波特率超出能力
    if (conn.protocol?.toUpperCase() === "UART") {
      const fromIface = findInterface(moduleIndex, conn.from);
      const toIface = findInterface(moduleIndex, conn.to);
      const baud = (conn as any).baudrate;
      for (const [iface, side] of [[fromIface, conn.from], [toIface, conn.to]] as const) {
        if (baud && iface?.max_baudrate && baud > iface.max_baudrate) {
          issues.push({
            severity: "blocker",
            rule: "BAUDRATE_EXCEEDED",
            message: `波特率 ${baud} 超过 ${side} 的上限 ${iface.max_baudrate}`,
            where,
          });
        }
      }
    }
  }

  // ---- 2. 引脚冲突：区分「驱动扇出」与「多源冲突」 ----
  // 一个输出驱动多个输入（同一 from 出现多次）= 扇出，电路上通常合法 → 警告核对驱动能力
  // 多个连接汇入同一输入（同一 to 出现多次）= 多个源抢一个引脚 → 阻断
  // I2C/CAN/RS485 总线端点豁免
  const asDriver = new Map<string, string[]>();
  const asReceiver = new Map<string, string[]>();
  for (const conn of solution.connections || []) {
    const label = `${conn.from}→${conn.to}`;
    asDriver.set(conn.from.trim(), [...(asDriver.get(conn.from.trim()) || []), label]);
    asReceiver.set(conn.to.trim(), [...(asReceiver.get(conn.to.trim()) || []), label]);
  }
  const isBus = (pin: string) => /SDA|SCL|CAN|RS485/i.test(pin);
  for (const [pin, uses] of asReceiver) {
    if (uses.length > 1 && !isBus(pin)) {
      issues.push({
        severity: "blocker",
        rule: "PIN_CONFLICT",
        message: `输入端 ${pin} 被 ${uses.length} 个信号源同时驱动：${uses.join("；")} —— 多源冲突会导致信号打架，需加选择开关/多路复用或改用不同引脚`,
        where: pin,
      });
    }
  }
  for (const [pin, uses] of asDriver) {
    if (uses.length > 1 && !isBus(pin)) {
      issues.push({
        severity: "warning",
        rule: "PIN_FANOUT",
        message: `输出端 ${pin} 扇出驱动 ${uses.length} 路：${uses.join("；")} —— 电路上通常合法，请核对驱动能力与负载阻抗`,
        where: pin,
      });
    }
  }

  // ---- 3. 电源树：电流预算 ----
  for (const rail of solution.power_tree || []) {
    if (!rail.budget_ma) continue;
    let demand = 0;
    const detail: string[] = [];
    for (const load of rail.loads || []) {
      const block = (solution.blocks || []).find((b) => b.block_id === load || b.name === load);
      const mod = block?.module_id ? moduleIndex[block.module_id] : null;
      const ma = mod?.power?.peak_current_ma ?? mod?.power?.typical_current_ma ?? 0;
      demand += ma;
      if (ma) detail.push(`${block?.name}:${ma}mA`);
    }
    if (demand > rail.budget_ma) {
      issues.push({
        severity: "blocker",
        rule: "POWER_BUDGET_EXCEEDED",
        message: `电源轨 ${rail.rail} 需求约 ${demand}mA（${detail.join("，")}）超过预算 ${rail.budget_ma}mA`,
        where: rail.rail,
      });
    } else if (demand > rail.budget_ma * 0.8) {
      issues.push({
        severity: "warning",
        rule: "POWER_BUDGET_TIGHT",
        message: `电源轨 ${rail.rail} 需求 ${demand}mA 已达预算 ${rail.budget_ma}mA 的 80%，建议留裕量`,
        where: rail.rail,
      });
    }
  }

  // ---- 4. 电机/逻辑电源隔离提示 ----
  const hasMotor = (solution.blocks || []).some((b) => /电机|motor|舵机|servo/i.test(b.name + (b.role || "")));
  const rails = solution.power_tree || [];
  if (hasMotor && rails.length > 0) {
    const motorRailSeparate = rails.some((r) => /motor|电机|VM|vbat/i.test(r.rail));
    if (!motorRailSeparate) {
      issues.push({
        severity: "warning",
        rule: "MOTOR_LOGIC_ISOLATION",
        message: "系统含电机/舵机但电源树未见独立动力电源轨；电机启动电流可能导致逻辑电源跌落复位，建议分轨并加大电容/磁珠隔离",
        where: "power_tree",
      });
    }
  }

  const passed = !issues.some((i) => i.severity === "blocker");
  return { passed, issues, checked_connections: (solution.connections || []).length };
}

function findInterface(moduleIndex: Record<string, any>, endpoint: string) {
  // endpoint 形如 "MSPM0.UART0_RX" —— 前缀匹配模块，后缀匹配接口名
  const [modKey, ...rest] = endpoint.split(".");
  const sig = rest.join(".");
  for (const [id, mod] of Object.entries(moduleIndex)) {
    if (id.includes(modKey.toLowerCase()) || (mod as any).name?.includes(modKey)) {
      for (const iface of (mod as any).interfaces || []) {
        if (sig.toUpperCase().includes(String(iface.name).toUpperCase())) return iface;
      }
    }
  }
  return null;
}
