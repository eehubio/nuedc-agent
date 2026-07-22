import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, BorderStyle,
} from "docx";

/** Markdown → DOCX。覆盖电赛报告实际用到的语法：
 *  #~###### 标题、段落、无序/有序列表、表格、代码块、粗体、行内代码、分隔线。 */

interface Block {
  type: "heading" | "para" | "list" | "table" | "code" | "hr";
  level?: number;
  text?: string;
  items?: { text: string; ordered: boolean }[];
  rows?: string[][];
  lang?: string;
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) { blocks.push({ type: "para", text: para.join(" ") }); para = []; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line)) {
      flushPara();
      const lang = line.replace(/^```/, "").trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      blocks.push({ type: "code", text: body.join("\n"), lang });
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      blocks.push({ type: "heading", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // 表格（| a | b | 后跟分隔行）
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const rows: string[][] = [];
      const parseRow = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      rows.push(parseRow(line));
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      blocks.push({ type: "table", rows });
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const items: { text: string; ordered: boolean }[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const ordered = /^\s*\d+\./.test(lines[i]);
        items.push({ text: lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""), ordered });
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // 空行 → 段落结束
    if (!line.trim()) { flushPara(); i++; continue; }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

/** 行内格式：**粗体**、`代码`、*斜体* */
function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index) }));
    const tok = m[0];
    if (tok.startsWith("**")) runs.push(new TextRun({ text: tok.slice(2, -2), bold: true }));
    else if (tok.startsWith("`")) runs.push(new TextRun({ text: tok.slice(1, -1), font: "Consolas" }));
    else runs.push(new TextRun({ text: tok.slice(1, -1), italics: true }));
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }));
  return runs.length ? runs : [new TextRun({ text })];
}

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

export async function markdownToDocxBuffer(md: string, title: string): Promise<Buffer> {
  const blocks = parseMarkdown(md);
  const children: (Paragraph | Table)[] = [];

  for (const b of blocks) {
    if (b.type === "heading") {
      children.push(new Paragraph({
        heading: HEADINGS[Math.min((b.level || 1) - 1, 5)],
        children: inlineRuns(b.text || ""),
        spacing: { before: 240, after: 120 },
      }));
    } else if (b.type === "para") {
      children.push(new Paragraph({ children: inlineRuns(b.text || ""), spacing: { after: 120 }, alignment: AlignmentType.JUSTIFIED }));
    } else if (b.type === "list") {
      for (const it of b.items || []) {
        children.push(new Paragraph({
          children: inlineRuns(it.text),
          bullet: it.ordered ? undefined : { level: 0 },
          numbering: undefined,
          indent: { left: 480 },
          spacing: { after: 60 },
        }));
      }
    } else if (b.type === "code") {
      for (const line of (b.text || "").split("\n")) {
        children.push(new Paragraph({
          children: [new TextRun({ text: line || " ", font: "Consolas", size: 18 })],
          shading: { type: ShadingType.CLEAR, fill: "F5F7FA" },
          spacing: { after: 0 },
        }));
      }
      children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
    } else if (b.type === "table" && b.rows?.length) {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const colWidth = Math.floor(9360 / cols);
      children.push(new Table({
        columnWidths: Array(cols).fill(colWidth),
        rows: b.rows.map((row, ri) => new TableRow({
          children: Array.from({ length: cols }, (_, ci) => new TableCell({
            width: { size: colWidth, type: WidthType.DXA },
            shading: ri === 0 ? { type: ShadingType.CLEAR, fill: "EEF2FF" } : undefined,
            children: [new Paragraph({ children: inlineRuns(row[ci] ?? "") })],
          })),
        })),
      }));
      children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
    } else if (b.type === "hr") {
      children.push(new Paragraph({
        text: "",
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC" } },
        spacing: { after: 120 },
      }));
    }
  }

  const doc = new Document({
    creator: "电赛智能体 NUEDC Agent",
    title,
    styles: {
      default: {
        document: { run: { font: "Microsoft YaHei", size: 22 }, paragraph: { spacing: { line: 320 } } },
      },
    },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}
