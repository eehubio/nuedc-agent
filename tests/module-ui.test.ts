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

describe("缩略图高度不得塌陷（回归防护）", () => {
  it("thumb 有明确高度，不依赖会与内联样式冲突的 aspect-ratio", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/globals.css", "utf8");
    // 基础高度必须存在
    expect(css).toMatch(/\.mod-card \.thumb \{[\s\S]*?height:\s*74px/);
    // 不能再出现 height:auto + aspect-ratio 的组合（首页卡片曾因此塌成 0 高）
    expect(css).not.toMatch(/\.mod-card \.thumb \{ aspect-ratio: 1 \/ 1; height: auto/);
  });

  it("有图状态用 max-width/max-height 而非强制拉伸", async () => {
    const fs = await import("node:fs");
    const css = fs.readFileSync("app/globals.css", "utf8");
    const block = css.slice(css.indexOf(".thumb.has-img img"));
    expect(block).toContain("max-width: 100%");
    expect(block).toContain("max-height: 100%");
    expect(block).toContain("object-fit: contain");
  });

  it("后台 CMS 提供图片预览与删除", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/AdminClient.tsx", "utf8");
    expect(src).toContain("module-gallery");
    expect(src).toContain("图片无法加载");        // 防盗链时给出可操作提示
  });

  it("种子模块均含 images 字段（避免 undefined 导致渲染分支异常）", async () => {
    const fs = await import("node:fs");
    const mods = JSON.parse(fs.readFileSync("data/seed-modules.json", "utf8"));
    for (const m of mods) expect(Array.isArray(m.images), m.id).toBe(true);
  });
});

describe("依赖与 CI 一致性", () => {
  it("lockfile 与 package.json 依赖完全对应（npm ci 的前提）", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const root = lock.packages?.[""] || {};
    const locked = { ...(root.dependencies || {}), ...(root.devDependencies || {}) };
    const missing = Object.keys(deps).filter((k) => !(k in locked));
    expect(missing, `lockfile 缺少依赖，npm ci 会失败：${missing.join(", ")}`).toHaveLength(0);
  });

  it("package.json 里用到的脚本命令都已定义", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    for (const s of ["lint", "typecheck", "test", "build", "verify:docx", "e2e", "load-test", "worker", "db:init"]) {
      expect(pkg.scripts?.[s], `缺少脚本 ${s}`).toBeTruthy();
    }
  });

  it("CI 覆盖 lint/typecheck/test/build 全流程", async () => {
    const fs = await import("node:fs");
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    for (const step of ["npm run lint", "npm run typecheck", "npm test", "npm run build"]) {
      expect(ci, `CI 缺少 ${step}`).toContain(step);
    }
    // CI 必须强制校验 mock，避免烧真实费用
    expect(ci).toContain("mock_enabled");
  });
});
