/** JSON 截断修复（纯函数，无外部依赖）。
 *
 *  单独成文件是为了打破 llm.ts ⇄ model-gateway/index.ts 的循环依赖：
 *  model-gateway 只需要这一个纯函数，而 llm.ts 又要调用 model-gateway。
 *  过去用动态 import 绕开循环，但那在 tsx 下会失败 —— .mts（ESM）入口加载
 *  CJS 的 lib 文件时，tsx 把后者编译成 data: URL，data: URL 无法解析相对说明符
 *  （ERR_UNSUPPORTED_RESOLVE_REQUEST，Node 20 上必现）。 */

/** 请求模型只输出 JSON，并做防御性解析（剥离 ```json 围栏、截取首尾大括号）。 */
/** 修复被 token 上限截断的 JSON：回退到最后一个完整的元素边界，再补齐闭合符。
 *  截断是长输出的常见失败模式，直接报错会让整次调用（和费用）白白浪费。 */
export function repairTruncatedJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  // 单遍扫描：记录每个「完整元素结束」的位置及其时刻的容器栈深度
  type Mark = { pos: number; depth: number };
  const marks: Mark[] = [];
  const stack: string[] = [];
  let inStr = false, esc = false, sawValue = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') {
      inStr = !inStr;
      if (!inStr) { sawValue = true; marks.push({ pos: i, depth: stack.length }); }
      continue;
    }
    if (inStr) continue;
    if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); sawValue = false; }
    else if (c === "}" || c === "]") { stack.pop(); sawValue = true; marks.push({ pos: i, depth: stack.length }); }
    else if (c === "," ) { sawValue = false; }
    else if (/[0-9truefalsn.eE+-]/.test(c)) {
      // 数字/布尔/null 的结束以下一个分隔符判定
      const next = text[i + 1];
      if (next === undefined || /[\s,}\]]/.test(next)) { sawValue = true; marks.push({ pos: i, depth: stack.length }); }
    }
  }

  if (!stack.length) {
    const end = text.lastIndexOf("}");
    return end > start ? text.slice(start, end + 1) : null;
  }

  // 截断：从后往前找一个「值刚结束」的位置，且它不是某个键名（键名后面跟冒号）
  for (let k = marks.length - 1; k >= 0; k--) {
    const m = marks[k];
    const after = text.slice(m.pos + 1, m.pos + 40);
    if (/^\s*:/.test(after)) continue;          // 这是键名，不是值 → 不能在此截断
    let body = text.slice(start, m.pos + 1);
    // 补齐该位置所需的闭合符（栈的前 depth 层）
    const need = stack.slice(0, m.depth).reverse();
    body += need.join("");
    try { JSON.parse(body); return body; } catch { /* 继续往前找 */ }
  }
  return null;
}
