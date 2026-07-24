import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fitWithin, dataUrlBytes, MODULE_IMAGE } from "@/lib/module-image";

describe("模块图片缩放", () => {
  it("等比缩放到最长边不超过上限", () => {
    expect(fitWithin(1920, 1080, 480)).toEqual({ width: 480, height: 270 });
    expect(fitWithin(1000, 2000, 480)).toEqual({ width: 240, height: 480 });
  });

  it("小图不放大（避免糊图）", () => {
    expect(fitWithin(300, 200, 480)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(480, 480, 480)).toEqual({ width: 480, height: 480 });
  });

  it("字节估算正确（含 padding）", () => {
    const b64 = Buffer.from("x".repeat(3000)).toString("base64");
    expect(dataUrlBytes(`data:image/webp;base64,${b64}`)).toBe(3000);
    expect(dataUrlBytes("非法输入")).toBe(0);
  });
});

describe("服务端图片校验", () => {
  const src = readFileSync("app/api/modules/[id]/image/route.ts", "utf8");

  it("只接受位图格式，拒绝 SVG", () => {
    // SVG 可内嵌脚本，绝不能进白名单
    expect(src).toMatch(/ALLOWED_MIME\s*=\s*\["image\/webp",\s*"image\/jpeg",\s*"image\/png"\]/);
    expect(src).not.toMatch(/image\/svg/);
  });

  it("有大小上限且独立于客户端", () => {
    expect(src).toMatch(/MAX_BYTES/);
    expect(src).toMatch(/status: 413/);
  });

  it("写操作限工作人员", () => {
    const put = src.slice(src.indexOf("export async function PUT"));
    expect(put).toMatch(/\["admin", "lab"\]\.includes\(tier\)/);
    const del = src.slice(src.indexOf("export async function DELETE"));
    expect(del).toMatch(/\["admin", "lab"\]\.includes\(tier\)/);
  });

  it("GET 带 ETag 缓存", () => {
    expect(src).toMatch(/ETag/);
    expect(src).toMatch(/if-none-match/);
    expect(src).toMatch(/status: 304/);
  });
});

describe("列表不下发图片本体", () => {
  it("查询只取 has_image 布尔值", () => {
    const q = readFileSync("lib/module-query.ts", "utf8");
    expect(q).toMatch(/\(image IS NOT NULL\) AS has_image/);
    // 绝不能在列表里 SELECT image 本体
    expect(q).not.toMatch(/SELECT[^"]*\bimage\b(?![_)\s]*IS NOT NULL)[^"]*FROM modules/);
  });

  it("迁移 21 建立 image 列", () => {
    const m = readFileSync("lib/migrations.ts", "utf8");
    expect(m).toMatch(/id: 21/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS image TEXT/);
  });
});
