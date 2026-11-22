// 读懂一次工具调用：执行了哪些命令、改了哪些文件。
// 各家 agent 的工具名和参数格式不同，交接说明、成绩单、言行对账都从这里取，口径一致。

/** 写文件类的工具：各家叫法不同 */
export const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch|.*write_file)$/;
/** 执行命令类的工具 */
export const SHELL_TOOLS = /^(Bash|PowerShell|pwsh|exec_command|shell|.*ssh_exec)$/;

/** 工具参数可能被截断成不完整的 JSON，所以按字段用正则取，再按 JSON 字符串规则还原转义 */
export function field(text: string, names: string[]): string[] {
  const out: string[] = [];
  const re = new RegExp(`"(?:${names.join('|')})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  for (const m of text.matchAll(re)) {
    try {
      out.push(JSON.parse(`"${m[1]}"`));
    } catch {
      out.push(m[1]);
    }
  }
  return out;
}

export function filesTouched(toolName: string | null, text: string): string[] {
  // Write/Edit 只认 file_path：写入的内容里可能恰好有补丁格式的文字，不能当成改了那些文件
  if (toolName && EDIT_TOOLS.test(toolName) && toolName !== 'apply_patch')
    return field(text, ['file_path', 'path', 'notebook_path']).slice(0, 1);
  // apply_patch，以及 Codex 的 exec 工具里内嵌的 apply_patch
  return [...text.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n\\"]+)/g)].map((m) => m[1].trim());
}

/** JS 字符串字面量：双引号、单引号或反引号，里面可以有转义 */
const literal = (q: string) => `${q}(?:[^${q}\\\\]|\\\\.)*${q}`;
/** Codex 的 exec 脚本里调用 exec_command 的地方：tools.exec_command({ cmd: "..." }) */
const INNER_COMMAND = new RegExp(`exec_command\\(\\s*\\{\\s*cmd\\s*:\\s*(${[literal('"'), literal("'"), literal('`')].join('|')})`, 'g');

function unquote(lit: string): string {
  if (lit[0] === '"') {
    try {
      return JSON.parse(lit);
    } catch {
      // 脚本里的字符串不一定是合法 JSON（例如 \x 转义），退回到逐个去掉反斜杠
    }
  }
  return lit.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * 这次调用执行了哪些命令（完整的命令，不截断）。
 * 新版 Codex 的 exec 工具不直接执行命令，而是运行一段脚本，真正的命令写在脚本里的
 * tools.exec_command({ cmd: "..." })；一段脚本里可能有好几条。只调用浏览器、读文件的脚本返回空数组
 */
export function commandsOf(toolName: string | null, text: string): string[] {
  if (!toolName) return [];
  if (toolName === 'exec') return [...text.matchAll(INNER_COMMAND)].map((m) => unquote(m[1]));
  if (!SHELL_TOOLS.test(toolName)) return [];
  const cmd = field(text, ['command', 'cmd'])[0] ?? argvCommand(text);
  return cmd ? [cmd] : [];
}

/** 旧版 Codex 的 shell 工具把命令写成数组：["bash", "-lc", "npm test"]、["curl", "-I", "https://…"] */
function argvCommand(text: string): string | undefined {
  try {
    const c = (JSON.parse(text) as { command?: unknown; cmd?: unknown }).command;
    if (!Array.isArray(c) || !c.every((x) => typeof x === 'string')) return undefined;
    // bash -lc "…"、powershell -Command "…"：真正的命令是最后一项
    const shell = /(^|[/\\])(bash|sh|zsh|pwsh|powershell|cmd)(\.exe)?$/i.test(c[0] ?? '');
    return shell && c.length >= 3 ? c.at(-1) : c.join(' ');
  } catch {
    return undefined;
  }
}

/** 是不是在执行命令：成败才有意义（查文件、读网页失败不算 agent 没做成） */
export function isShellCall(toolName: string | null, text: string): boolean {
  // 名字就是执行命令的工具：参数被截断、取不出命令也算；Codex 的 exec 要看脚本里有没有执行命令
  if (toolName && SHELL_TOOLS.test(toolName)) return true;
  return commandsOf(toolName, text).length > 0;
}

/**
 * 把工具结果和发出它的调用对上。记录里没有调用编号，只能靠顺序：
 * agent 可能一次并行发出几个调用，结果按同样的顺序回来；
 * 某个调用没等到结果（会话被打断）时，下一批调用开始就把它丢掉，免得后面的结果全部错位
 */
export class PendingCalls<T> {
  private queue: T[] = [];
  private lastWasCall = false;

  call(info: T) {
    if (!this.lastWasCall) this.queue = [];
    this.queue.push(info);
    this.lastWasCall = true;
  }

  result(): T | undefined {
    this.lastWasCall = false;
    return this.queue.shift();
  }
}
