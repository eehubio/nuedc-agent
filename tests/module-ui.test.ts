import { describe, it, expect } from "vitest";

/** 模块图片渲染与 UI 契约。 */

describe("模块图片渲染", () => {
  it("schema 定义了 images 字段", async () => {
    const { moduleInputSchema } = await import("../lib/module-schema");
    const parsed = moduleInputSchema.parse({
      id: "m1", name: "测试模块", category: "mcu.arm",
      images: ["https://example.com/a.jpg"],
    } as any);
    expect(parsed.images).toEqual(["https://example.com/a.jpg"]);
  });

  it("未提供 images 时默认为空数组（回退到分类图标）", async () => {
    const { moduleInputSchema } = await import("../lib/module-schema");
    const parsed = moduleInputSchema.parse({ id: "m1", name: "x", category: "mcu.arm" } as any);
    expect(parsed.images).toEqual([]);
  });

  it("三处 UI 都渲染 images：首页卡片、模块详情弹窗、框图功能块弹窧", async () => {
    const fs = await import("node:fs");
    const core = fs.readFileSync("components/pages-core.tsx", "utf8");
    const build = fs.readFileSync("components/pages-build.tsx", "utf8");
    // 统一缩略图组件，有图用图、无图回退图标
    expect(core).toContain("export function ModuleThumb");
    expect(core).toContain("const src = (m?.images || [])[0]");
    // 卡片与列表都改用该组件，不再直接写死图标
    expect(core).not.toContain('<div className="thumb">{modIcon(m.category)}</div>');
    // 详情弹窗与框图弹窗都有图片区
    expect(core).toContain("module-gallery");
    expect(build).toContain("module-gallery");
  });

  it("图片加载失败时隐藏而不是显示裂图", async () => {
    const fs = await import("node:fs");
    const core = fs.readFileSync("components/pages-core.tsx", "utf8");
    expect(core).toContain("onError");
    expect(core).toContain('style.display = "none"');
  });

  it("缩略图为正方形容器且图片完整显示不裁切", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/globals.css", "utf8");
    expect(css).toContain("aspect-ratio: 1 / 1");
    expect(css).toContain("object-fit: contain");   // contain 而非 cover：不裁切
  });
});

describe("导航与流程", () => {
  it("二期占位导航（仿真验证/实验平台）已移除", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/Platform.tsx", "utf8");
    expect(src).not.toContain("NAV_SOON");
    expect(src).not.toContain("仿真验证");
    expect(src).not.toContain("实验平台");
  });

  it("模块选型的 shortlist 确实传给方案生成", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/Platform.tsx", "utf8");
    expect(src).toContain("preferred_modules: shortlist.length ? shortlist : undefined");
  });

  it("模块选型页说明其为可选步骤，并提供返回方案生成的入口", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-core.tsx", "utf8");
    expect(src).toContain("可选步骤");
    expect(src).toContain('ctx.setPage("solution")');
  });

  it("方案生成页显示当前优先模块清单", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    expect(src).toContain("已从「模块选型」选用");
  });
});
