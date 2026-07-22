import { describe, it, expect } from "vitest";
import { pdfSha256, similarity, matchRequirements, diffExtractions } from "../lib/problem-center";
import { searchModules, buildModuleContext, visibleTo, extractTags } from "../lib/module-search";

describe("PDF 哈希（完整二进制）", () => {
  it("前 600KB 相同、尾部不同的两份文件哈希不同", () => {
    const prefix = "P".repeat(600_000);
    const a = Buffer.from(prefix + "END-A").toString("base64");
    const b = Buffer.from(prefix + "END-B").toString("base64");
    expect(pdfSha256(a)).not.toBe(pdfSha256(b));
    expect(pdfSha256(a)).toHaveLength(64);
  });
});

describe("双模差异配对（多策略，非下标对齐）", () => {
  it("一方多提取一条时不产生连锁错位", () => {
    const A = [
      { id: "REQ-001", description: "输出电压可调", target: 10, unit: "V" },
      { id: "REQ-002", description: "效率不低于 90%", target: 90, unit: "%" },
      { id: "REQ-003", description: "具备过流保护" },
    ];
    // B 在开头多提取了一条 —— 若按下标对齐，后面三条全部错位
    const B = [
      { id: "REQ-000", description: "系统总体要求" },
      { id: "REQ-001", description: "输出电压可调", target: 10, unit: "V" },
      { id: "REQ-002", description: "效率不低于 90%", target: 90, unit: "%" },
      { id: "REQ-003", description: "具备过流保护" },
    ];
    const diffs = diffExtractions({ requirements: A, scoring_items: [] }, { requirements: B, scoring_items: [] });
    // 只应有 1 处「B 多出一条」，不应产生 3 条错位差异
    expect(diffs).toHaveLength(1);
    expect(diffs[0].value_a).toContain("未提取到");
    expect(diffs[0].value_b).toContain("系统总体");
  });

  it("编号缺失时按页码 + 描述相似度配对", () => {
    const A = [{ description: "输出电压可调至 10V", source_page: 2, target: 10, unit: "V" }];
    const B = [{ description: "输出电压可调到 10V", source_page: 2, target: 12, unit: "V" }];
    const pairs = matchRequirements(A, B);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].method).toBe("source_page");
    expect(pairs[0].b).toBeTruthy();
    // 指标不一致必须是 critical
    const diffs = diffExtractions({ requirements: A, scoring_items: [] }, { requirements: B, scoring_items: [] });
    expect(diffs.some((d) => d.severity === "critical" && d.field_path.includes("target"))).toBe(true);
  });

  it("完全一致的提取不产生任何差异", () => {
    const x = {
      requirements: [{ id: "R1", description: "同样描述", target: 5, unit: "V", priority: "mandatory" }],
      scoring_items: [{ item: "测量", points: 10 }],
    };
    expect(diffExtractions(x, JSON.parse(JSON.stringify(x)))).toHaveLength(0);
  });

  it("措辞差异标 info，指标差异标 critical", () => {
    const A = { requirements: [{ id: "R1", description: "输出电压应当可以调节", target: 5, unit: "V" }], scoring_items: [] };
    const B = { requirements: [{ id: "R1", description: "输出电压应该可以调节", target: 5, unit: "V" }], scoring_items: [] };
    const d = diffExtractions(A, B);
    expect(d.every((x) => x.severity !== "critical")).toBe(true);
  });

  it("相似度函数：相同为 1，无关为低值", () => {
    expect(similarity("输出电压可调", "输出电压可调")).toBe(1);
    expect(similarity("输出电压可调", "无线传输信号")).toBeLessThan(0.3);
    expect(similarity("输出电压可调至10V", "输出电压可调到10V")).toBeGreaterThan(0.6);
  });
});

describe("模块 Top-K 检索", () => {
  const mods = [
    { id: "pub1", name: "公共模块", scope: "PUBLIC", category: "mcu.arm", certification_status: "COMPETITION_READY", interfaces: [{ interface_type: "UART" }], power: { input_voltage_range: [3, 5] }, inventory_qty: 3 },
    { id: "mine", name: "我的私有模块", scope: "PERSONAL", owner_ref: "u1", category: "mcu.arm", certification_status: "DRAFT", interfaces: [], power: {} },
    { id: "other", name: "别人的私有模块", scope: "PERSONAL", owner_ref: "u2", category: "mcu.arm", certification_status: "COMPETITION_READY", interfaces: [], power: {} },
    { id: "org1", name: "组织模块", scope: "ORGANIZATION", org_ref: "org-A", category: "sensor.imu", certification_status: "BENCHMARKED", interfaces: [], power: {} },
    { id: "dep", name: "已弃用", scope: "PUBLIC", category: "mcu.arm", certification_status: "DEPRECATED", interfaces: [], power: {} },
  ];

  it("scope 过滤：看不到别人的私有模块", () => {
    expect(visibleTo(mods[0], {})).toBe(true);
    expect(visibleTo(mods[1], { viewerRef: "u1" })).toBe(true);
    expect(visibleTo(mods[2], { viewerRef: "u1" })).toBe(false);
    expect(visibleTo(mods[3], { orgRef: "org-A" })).toBe(true);
    expect(visibleTo(mods[3], { orgRef: "org-B" })).toBe(false);
  });

  it("弃用模块被排除", () => {
    const { picked } = searchModules(mods, { viewerRef: "u1" });
    expect(picked.map((p) => p.module.id)).not.toContain("dep");
  });

  it("类别与接口过滤生效", () => {
    const { picked } = searchModules(mods, { categories: ["mcu"], interfaces: ["UART"] });
    expect(picked.map((p) => p.module.id)).toEqual(["pub1"]);
  });

  it("电压不兼容的模块被过滤", () => {
    const { picked } = searchModules(mods, { categories: ["mcu"], voltage: 12 });
    expect(picked.map((p) => p.module.id)).not.toContain("pub1");   // 只支持 3~5V
  });

  it("每个入选模块附带可解释的选中理由", () => {
    const { picked } = searchModules(mods, { viewerRef: "u1", preferred: ["mine"] });
    const mine = picked.find((p) => p.module.id === "mine");
    expect(mine?.reasons).toContain("用户已选用");
    const pub = picked.find((p) => p.module.id === "pub1");
    expect(pub?.reasons.some((r) => r.includes("有货"))).toBe(true);
  });

  it("topK 截断并在 manifest 中报告省略数量", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`, name: `模块${i}`, scope: "PUBLIC", category: "other.misc",
      certification_status: "DOCUMENTED", interfaces: [], power: {},
    }));
    const { manifest } = buildModuleContext(many, { topK: 20 });
    expect(manifest.includedModuleIds).toHaveLength(20);
    expect(manifest.omittedModuleCount).toBe(80);
    expect(Object.keys(manifest.selectionReasons)).toHaveLength(20);
    expect(manifest.estimatedTokens).toBeGreaterThan(0);
  });

  it("需求关键词参与排序", () => {
    const list = [
      { id: "a", name: "普通电阻", scope: "PUBLIC", category: "passive", certification_status: "DOCUMENTED", interfaces: [], power: {} },
      { id: "b", name: "DDS 信号发生模块", scope: "PUBLIC", category: "signal", certification_status: "DOCUMENTED", interfaces: [], power: {} },
    ];
    const tags = extractTags([{ description: "使用 DDS 产生正弦信号" }]);
    const { picked } = searchModules(list, { requirementTags: tags });
    expect(picked[0].module.id).toBe("b");
  });
});
