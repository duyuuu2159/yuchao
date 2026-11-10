// 一个很小的 Markdown 解析器，只覆盖 agent 回复里常见的写法：代码块、标题、列表、表格、行内代码、粗体、链接。
// 只把文本解析成数据结构，由 Markdown.tsx 渲染成 React 节点。
// 会话内容来自 agent 和工具输出，不可信：这里没有「原始 HTML」这种节点，<script> 之类只会被当成普通文字；
// 链接也只保留文字和地址，渲染时不生成可点击的 <a>。

export type Inline = { type: 'text' | 'code' | 'bold'; text: string } | { type: 'link'; text: string; url: string };

export type Block =
  | { type: 'code'; lang: string; text: string }
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { type: 'para'; inline: Inline[] };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    const t = m[0];
    if (m[1]) out.push({ type: 'code', text: t.slice(1, -1) });
    else if (m[2]) out.push({ type: 'bold', text: t.slice(2, -2) });
    else {
      const split = t.lastIndexOf('](');
      out.push({ type: 'link', text: t.slice(1, split), url: t.slice(split + 2, -1) });
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s{0,8}(?:[-*+]|(\d{1,3})[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    const text = para.join('\n').replace(/^\n+|\n+$/g, '');
    if (text) blocks.push({ type: 'para', inline: parseInline(text) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const body: string[] = [];
      // 没有结束标记（回复被截断）时，剩下的内容都算代码
      for (i++; i < lines.length && !(lines[i].trim().startsWith(fence[1]) && /^[`~\s]+$/.test(lines[i])); i++) body.push(lines[i]);
      blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(line);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    const bullet = line.match(BULLET);
    if (bullet) {
      flush();
      const ordered = bullet[1] !== undefined;
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const b = lines[i].match(BULLET);
        if (b && (b[1] !== undefined) === ordered) items.push(b[2]);
        // 缩进的续行并入上一项
        else if (items.length && /^\s{2,}\S/.test(lines[i]) && !FENCE.test(lines[i])) items[items.length - 1] += '\n' + lines[i].trim();
        else break;
      }
      i--;
      blocks.push({ type: 'list', ordered, items: items.map(parseInline) });
      continue;
    }

    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return blocks;
}
