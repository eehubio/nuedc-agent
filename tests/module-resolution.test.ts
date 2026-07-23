import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** 防回归：禁止在 lib/ 与 scripts/ 里使用「相对路径的运行时动态 import」。
 *
 *  背景：本项目 package.json 没有 "type" 字段（CJS），而 scripts/*.mts 是 ESM。
 *  tsx 在 ESM 入口下加载 CJS 的 lib 文件时，会把它编译成 data: URL；
 *  data: URL 没有「所在目录」，无法解析 "./x" 这类相对说明符，抛
 *  ERR_UNSUPPORTED_RESOLVE_REQUEST（Node 20 必现，Node 22 不复现）。
 *
 *  这个坑先后炸了两次（db.ts→migrations、llm.ts→model-gateway），
 *  都是线上 Worker 直接崩。改用静态 import 即可；若确有循环依赖，
 *  应像 lib/schema.ts、lib/json-repair.ts 那样把共享部分抽成独立模块来破环。
 *
 *  注意：import("包名") 这类「裸说明符」不受影响（能正常解析），只禁相对路径。 */

const ROOT = resolve(__dirname, "..");
const DIRS = ["lib", "scripts"];
const RELATIVE_DYNAMIC_IMPORT = /await\s+import\(\s*["'`]\.{1,2}\//;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("模块解析防回归", () => {
  it("lib/ 与 scripts/ 中不得出现相对路径的动态 import", () => {
    const offenders: string[] = [];
    for (const d of DIRS) {
      for (const file of walk(join(ROOT, d))) {
        const src = readFileSync(file, "utf8");
        src.split("\n").forEach((line, i) => {
          if (RELATIVE_DYNAMIC_IMPORT.test(line)) {
            offenders.push(`${file.replace(ROOT + "/", "")}:${i + 1}  ${line.trim().slice(0, 90)}`);
          }
        });
      }
    }
    expect(offenders, `发现相对路径动态 import（tsx/Node 20 下会抛 ERR_UNSUPPORTED_RESOLVE_REQUEST）：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("破环用的独立模块存在且无反向依赖", () => {
    const schema = readFileSync(join(ROOT, "lib/schema.ts"), "utf8");
    const jsonRepair = readFileSync(join(ROOT, "lib/json-repair.ts"), "utf8");
    // 这两个模块必须是叶子：不 import 任何本项目模块，否则环又回来了
    expect(schema).not.toMatch(/^import .*from\s+["'`]\./m);
    expect(jsonRepair).not.toMatch(/^import .*from\s+["'`]\./m);
    expect(schema).toContain("SCHEMA_SQL");
    expect(jsonRepair).toContain("repairTruncatedJson");
  });
});
