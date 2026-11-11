import { createHash } from 'node:crypto';

// 敏感信息扫描：在一段文本里找出密码、密钥、令牌等，只返回打码后的内容和不可逆的指纹。

export type Severity = 'high' | 'medium';

export interface Rule {
  id: string;
  name: string;
  severity: Severity;
  /** 必须带 g 标志；第 1 个捕获组是敏感值本身，没有捕获组则整个匹配都算 */
  pattern: RegExp;
  /** 额外的过滤，返回 false 表示误报 */
  accept?: (value: string) => boolean;
}

export interface Match {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  /** 打码后的值，例如 Al********2e */
  masked: string;
  /** 原值的 SHA-256 前 16 位，用于把同一个秘密的多次出现归为一组 */
  fingerprint: string;
  /** 命中位置前后的文字，敏感值已打码 */
  context: string;
}

/** 香农信息熵（每个字符的比特数）。随机生成的密码通常 > 3，英文单词通常 < 3 */
export function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  const n = [...s].length;
  let h = 0;
  for (const k of freq.values()) {
    const p = k / n;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDERS =
  /^(?:x+|\*+|\.+|-+|_+|null|none|nil|undefined|true|false|string|str|number|bool(?:ean)?|required|optional|password\d*|passwd|pwd|secret|token|your[_-]?\w*|my[_-]?\w*|example\w*|changeme|test[\w-]*|demo[\w-]*|placeholder|redacted|hidden|todo|xxx\w*|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%\w+%?)$/i;

/**
 * 看起来像真实密码的值：
 * - 不是占位符、变量引用、类型名
 * - 同时有字母和数字，或者熵足够高
 */
export function looksLikeSecret(v: string): boolean {
  if (v.length < 6 || v.length > 128) return false;
  if (PLACEHOLDERS.test(v)) return false;
  if (v.includes('…')) return false; // 被日志截断的片段
  if (/^[$%{<(]|^process\.env|^os\.|^getenv|^env\./i.test(v)) return false;
  // 正则、代码片段和转义序列，例如 token|secret|password、String(req.body、\n$env:KEY
  if (/[|\\()[\]{}^]/.test(v)) return false;
  if (/^(.)\1+$/.test(v)) return false;
  if (/^[a-z_]+\(|\)$/.test(v)) return false; // 函数调用，例如 input()
  if (/[\u4e00-\u9fff]/.test(v)) return false; // 含中文的是说明文字，不是密码
  // 含全角标点等非 ASCII 字符的也是说明文字，例如「（base64url 字符」
  if ([...v].some((c) => c.charCodeAt(0) > 126)) return false;
  if (v.startsWith('@')) return false; // user:password@host 这类模板里截到的是主机名
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return false; // 常量名，例如 GITHUB_CLIENT_SECRET
  if (/^[a-z._-]+$/.test(v)) return false; // 全小写的单词或句子片段，例如 non-interactively.
  if (/^(?:[a-z]+[._-])*[a-z]+$/i.test(v) && entropy(v) < 3.2) return false; // 普通单词或变量名
  const mixed = /[a-z]/i.test(v) && /\d/.test(v);
  return mixed || entropy(v) >= 3.5;
}

// 前面是 $、%、/ 时不算：$PWD 是 PowerShell 的当前目录，/etc/passwd 是系统文件
const PASSWORD_WORD = String.raw`(?:(?<![$%/\w.-])(?:password|passwd|pwd)\b|密码|口令)`;

export const RULES: Rule[] = [
  {
    id: 'private_key',
    name: '私钥',
    severity: 'high',
    // 只有标记行没有内容的（例如代码里的字符串常量）不算；整段正文都算作秘密，一行也不能漏打码
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?:\\[rn]|\s)*([A-Za-z0-9+/=]{40,}(?:(?:\\[rn]|\s)+[A-Za-z0-9+/=]{4,})*)/g,
  },
  {
    id: 'anthropic_key',
    name: 'Anthropic API key',
    severity: 'high',
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})/g,
  },
  {
    id: 'openai_key',
    name: 'OpenAI 风格 API key',
    severity: 'high',
    pattern: /\b(sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,})/g,
    accept: (v) => /\d/.test(v) && /[a-z]/i.test(v.slice(3)),
  },
  {
    id: 'github_token',
    name: 'GitHub 令牌',
    severity: 'high',
    pattern: /\b((?:gh[pousr]_[A-Za-z0-9]{36,})|(?:github_pat_[A-Za-z0-9_]{50,}))/g,
  },
  {
    id: 'aws_key',
    name: 'AWS Access Key',
    severity: 'high',
    pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
  },
  {
    id: 'google_key',
    name: 'Google API key',
    severity: 'high',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})/g,
  },
  {
    id: 'sshpass',
    name: 'sshpass 命令里的密码',
    severity: 'high',
    pattern: /\bsshpass\s+-p\s*(?:'([^']+)'|"([^"]+)"|(\S+))/g,
    accept: (v) => v.length >= 4 && !/^[\\$]|[\u4e00-\u9fff]/.test(v),
  },
  {
    id: 'url_credential',
    name: '链接里的账号密码',
    severity: 'high',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]+)@[^\s'"]+/gi,
    accept: looksLikeSecret,
  },
  {
    // 代码里成组写出的地址、用户名、密码，例如 ssh.connect('203.0.113.7', 'root', 'Tq8v...')
    id: 'server_credential',
    name: '服务器登录凭据',
    severity: 'high',
    pattern: /['"]\d{1,3}(?:\.\d{1,3}){3}['"]\s*,\s*['"][\w.-]{1,32}['"]\s*,\s*['"]([^'"\s]{6,64})['"]/g,
    accept: looksLikeSecret,
  },
  {
    id: 'password',
    name: '明文密码',
    severity: 'medium',
    pattern: new RegExp(PASSWORD_WORD + String.raw`\s*(?:是|为|[:=：])?\s*["'\x60]?([^\s"'\x60,，;；。)）\]}]{6,64})`, 'gi'),
    accept: looksLikeSecret,
  },
  {
    id: 'generic_secret',
    name: '疑似密钥或令牌',
    severity: 'medium',
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=.]{20,})/gi,
    accept: (v) => entropy(v) >= 3.5 && looksLikeSecret(v),
  },
];

/** IPv4 地址，排除 0.0.0.0、127.x、版本号这类 */
export const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;

function hasServerAddressNear(text: string, at: number, radius = 120): boolean {
  const near = text.slice(Math.max(0, at - radius), at + radius);
  for (const m of near.matchAll(IPV4)) {
    if (!/^(?:0\.|127\.|255\.)/.test(m[0])) return true;
  }
  return /\broot@|用户名|\busername\b|\bssh\b/i.test(near);
}

export function mask(v: string): string {
  const chars = [...v];
  if (chars.length <= 6) return chars[0] + '*'.repeat(chars.length - 1);
  return chars.slice(0, 2).join('') + '*'.repeat(Math.min(chars.length - 4, 12)) + chars.slice(-2).join('');
}

export function fingerprint(v: string): string {
  return createHash('sha256').update(v).digest('hex').slice(0, 16);
}

type Found = Omit<Match, 'context'> & { value: string; at: number };

/** 找出文本里的所有秘密，同一个秘密只保留一条，以严重程度最高的规则为准 */
function collect(text: string): Found[] {
  const found = new Map<string, Found>();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      const value = m.slice(1).find((g) => g !== undefined) ?? m[0];
      if (rule.accept && !rule.accept(value)) continue;
      const at = (m.index ?? 0) + m[0].indexOf(value);

      let { id, name, severity } = rule;
      // 密码旁边就是服务器地址或用户名，说明是一整套可以直接登录的凭据
      if (id === 'password' && hasServerAddressNear(text, at)) {
        id = 'server_credential';
        name = '服务器登录凭据';
        severity = 'high';
      }

      const fp = fingerprint(value);
      const prev = found.get(fp);
      if (prev && (prev.severity === 'high' || severity === 'medium')) continue;
      found.set(fp, { ruleId: id, ruleName: name, severity, masked: mask(value), fingerprint: fp, value, at });
    }
  }
  return [...found.values()];
}

/** 先替换长的值，避免短值是长值一部分时只替换了一半 */
function redactWith(text: string, found: Found[]): string {
  return [...found].sort((a, b) => b.value.length - a.value.length).reduce((acc, f) => acc.split(f.value).join(f.masked), text);
}

/** 把文本里所有能识别出的秘密替换成打码后的样子 */
export function redact(text: string): string {
  return redactWith(text, collect(text));
}

/** 扫描一段文本，返回每个秘密的打码值、指纹和打码后的上下文 */
export function scanText(text: string, radius = 50): Match[] {
  const found = collect(text);
  if (!found.length) return [];

  const spans: [number, number][] = [];
  for (const f of found) {
    for (let i = text.indexOf(f.value); i !== -1; i = text.indexOf(f.value, i + 1)) spans.push([i, i + f.value.length]);
  }
  return found.map(({ value, at, ...rest }) => {
    let start = Math.max(0, at - radius);
    let end = Math.min(text.length, at + value.length + radius);
    // 截取边界不能落在某个秘密的中间，否则那一半不会被打码
    for (const [a, b] of spans) {
      if (a < start && b > start) start = a;
      if (a < end && b > end) end = b;
    }
    // 上下文里可能还有别的秘密，全部打码后再输出，原文不会出现在结果里
    const context =
      (start > 0 ? '…' : '') + redactWith(text.slice(start, end), found).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
    return { ...rest, context };
  });
}
