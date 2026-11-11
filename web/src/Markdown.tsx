import { memo, type ReactNode, useMemo } from 'react';
import { type Inline, parseMarkdown } from './markdown.ts';
import { CopyButton } from './ui.tsx';

/** 把命中的关键词包上 <mark> */
export function highlight(text: string, terms: string[]): ReactNode {
  const words = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return text;
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function inline(nodes: Inline[], terms: string[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'code':
        return <code key={i}>{highlight(n.text, terms)}</code>;
      case 'bold':
        return <strong key={i}>{highlight(n.text, terms)}</strong>;
      case 'link':
        // 内容来自 agent，不可信：不生成可点击的链接，地址放在提示里
        return (
          <span key={i} className="md-link" title={n.url}>
            {highlight(n.text, terms)}
          </span>
        );
      default:
        return <span key={i}>{highlight(n.text, terms)}</span>;
    }
  });
}

/** 渲染会话里的 Markdown。只生成 React 节点，不使用 dangerouslySetInnerHTML */
export const Markdown = memo(function Markdown({ text, terms = [] }: { text: string; terms?: string[] }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'code':
            return (
              <div key={i} className="md-code">
                <div className="md-code-head">
                  <span>{b.lang || '代码'}</span>
                  <CopyButton text={b.text} label="复制代码" />
                </div>
                <pre>{highlight(b.text, terms)}</pre>
              </div>
            );
          case 'heading': {
            const Tag = b.level <= 2 ? 'h3' : 'h4';
            return <Tag key={i}>{inline(b.inline, terms)}</Tag>;
          }
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, terms)}</li>
                ))}
              </Tag>
            );
          }
          case 'table':
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>{inline(c, terms)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>{inline(c, terms)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={i}>{inline(b.inline, terms)}</p>;
        }
      })}
    </div>
  );
});
