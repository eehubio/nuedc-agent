import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // 与 tsconfig 的 paths 保持一致，使 app/ 下的路由文件可被测试直接导入
  resolve: { alias: { "@": resolve(__dirname, ".") } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
