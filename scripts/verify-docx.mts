/** DOCX 导出验证：生成后解压检查 OOXML 结构完整性与中文内容。
 *  CI 中运行，防止导出功能悄悄坏掉。 */
import { markdownToDocxBuffer } from "../lib/report-export";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const md = `# 电赛设计报告

## 摘要
本系统采用 **DDS** 方案实现信号发生，误差 \`≤1%\`。

## 1 方案论证
* 方案一：FPGA 数字合成
* 方案二：专用 DDS 芯片

| 指标 | 要求 | 实测 |
| --- | --- | --- |
| 幅度 | 2Vpp | 2.01Vpp |
| 相位差 | ±1° | 0.6° |

\`\`\`c
int main(void) { return 0; }
\`\`\`

---

## 结论
全部基本要求通过。`;

const buf = await markdownToDocxBuffer(md, "CI 验证报告");
const path = "/tmp/ci-verify.docx";
writeFileSync(path, buf);

const checks: [string, boolean][] = [];
checks.push(["ZIP 魔数正确", buf.slice(0, 2).toString() === "PK"]);
checks.push(["体积合理(>3KB)", buf.length > 3000]);

// 解压核对 OOXML 必备条目与内容
const list = execFileSync("unzip", ["-l", path]).toString();
checks.push(["含 word/document.xml", list.includes("word/document.xml")]);
checks.push(["含 [Content_Types].xml", list.includes("[Content_Types].xml")]);
checks.push(["含 word/styles.xml", list.includes("word/styles.xml")]);

const xml = execFileSync("unzip", ["-p", path, "word/document.xml"]).toString();
checks.push(["中文正文保留", xml.includes("电赛设计报告")]);
checks.push(["标题使用内置样式", /Heading/i.test(xml)]);
checks.push(["表格已生成", xml.includes("<w:tbl>")]);
checks.push(["粗体已生成", xml.includes("<w:b/>")]);
checks.push(["表格数据保留", xml.includes("2.01Vpp")]);

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} 项通过`);
process.exit(failed ? 1 : 0);
