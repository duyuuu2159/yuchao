import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown } from '../web/src/markdown.ts';

const F = '`'.repeat(3);

test('代码块：内容原样保留，里面的 Markdown 记号和 HTML 不解析', () => {
  const blocks = parseMarkdown(`先看配置：\n\n${F}bash\n# 不是标题\nnpm run **build** <script>\n${F}\n\n完成。`);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['para', 'code', 'para'],
  );
  assert.deepEqual(blocks[1], { type: 'code', lang: 'bash', text: '# 不是标题\nnpm run **build** <script>' });
});

test('没有结束标记的代码块（回复被截断）一直算到结尾', () => {
  const blocks = parseMarkdown(`${F}ts\nconst a = 1;\n## 仍然是代码`);
  assert.deepEqual(blocks, [{ type: 'code', lang: 'ts', text: 'const a = 1;\n## 仍然是代码' }]);
});

test('标题、有序和无序列表、段落里的换行', () => {
  const blocks = parseMarkdown('## 结果\n\n- 第一项\n- 第二项\n  续行\n\n1. 甲\n2. 乙\n\n第一行\n第二行');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'list', 'list', 'para'],
  );
  assert.equal((blocks[0] as any).level, 2);
  const [ul, ol] = [blocks[1], blocks[2]] as any[];
  assert.equal(ul.ordered, false);
  assert.deepEqual(
    ul.items.map((i: any) => i[0].text),
    ['第一项', '第二项\n续行'],
  );
  assert.equal(ol.ordered, true);
  assert.equal((blocks[3] as any).inline[0].text, '第一行\n第二行');
});

test('表格：分隔行不算数据', () => {
  const [t] = parseMarkdown('| 名称 | 状态 |\n|---|:--:|\n| nginx | `ok` |\n| app | 挂了 |') as any[];
  assert.equal(t.type, 'table');
  assert.deepEqual(
    t.head.map((c: any) => c[0].text),
    ['名称', '状态'],
  );
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0][1], [{ type: 'code', text: 'ok' }]);
});

test('行内：代码、粗体、链接', () => {
  assert.deepEqual(parseInline('运行 `npm test`，**全部通过**，见 [文档](https://example.com/a)。'), [
    { type: 'text', text: '运行 ' },
    { type: 'code', text: 'npm test' },
    { type: 'text', text: '，' },
    { type: 'bold', text: '全部通过' },
    { type: 'text', text: '，见 ' },
    { type: 'link', text: '文档', url: 'https://example.com/a' },
    { type: 'text', text: '。' },
  ]);
  assert.deepEqual(parseInline('`**不加粗**`'), [{ type: 'code', text: '**不加粗**' }]);
});

test('不可信内容：HTML 只是文字，没有任何「原始 HTML」节点；危险链接只作为数据保留', () => {
  const src = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[点我](javascript:alert(1))';
  const blocks = parseMarkdown(src);
  const types = new Set<string>();
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      if (typeof v.type === 'string') types.add(v.type);
      Object.values(v).forEach(walk);
    }
  };
  walk(blocks);
  assert.deepEqual([...types].sort(), ['link', 'para', 'text']);
  const para = blocks[0] as any;
  assert.ok(para.inline[0].text.includes('<script>alert(1)</script>'));
  assert.ok(para.inline.find((x: any) => x.type === 'link').url.startsWith('javascript:'), '地址只是数据，渲染时不生成 <a>');
});

test('普通聊天内容不被误伤：空文本、只有一行、带星号的算式', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('继续'), [{ type: 'para', inline: [{ type: 'text', text: '继续' }] }]);
  assert.equal((parseMarkdown('2 * 3 * 4 = 24')[0] as any).inline.length, 1);
});
