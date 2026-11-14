// 工具执行有没有失败：用 agent 自己记录的执行结果，而不是在输出文字里找 error 这类词。
//
// 在输出里找关键词会大量误判：输出里显示的代码（`except Exception as e:`）、成功的汇总（`0 failed`）、
// 「无控制台错误」都会被当成报错。四家 agent 其实都记录了执行结果，只是写法不同：
//
//   Claude Code       tool_result 上的 is_error（缺省表示成功）
//   Codex             输出第一行：Script completed / Script failed / Exit code: N / Process exited with code N
//   WorkBuddy         输出里的 exit code N；status 为 incomplete 表示没跑完
//   DeepSeek Harness  tool/result 上的 isError
//
// 返回 true 失败、false 成功、null 不知道（例如还在运行、等待超时、被用户取消）。

/** 用户自己中断或拒绝了这次调用：这是用户叫停，不是 agent 失败 */
const USER_STOPPED =
  /user (?:cancelled|canceled|doesn't want to proceed|rejected|denied)|tool (?:call|use) (?:was )?(?:aborted|interrupted|rejected)|was interrupted|request interrupted by user/i;

export function stoppedByUser(output: string): boolean {
  return USER_STOPPED.test(output.slice(0, 500));
}

export function claudeFailed(block: { is_error?: unknown }, output: string): boolean | null {
  if (block.is_error !== true) return false;
  return stoppedByUser(output) ? null : true;
}

export function codexFailed(output: string): boolean | null {
  const head = output.trimStart().slice(0, 300);
  if (/^Script failed/.test(head)) return true;
  if (/^Script completed/.test(head)) {
    // 脚本跑完了，但里面的命令可能以非零退出
    const code = /\bExit code:\s*(-?\d+)/.exec(output.slice(0, 2000));
    return code ? code[1] !== '0' : false;
  }
  const code = /^(?:Exit code:|Process exited with code)\s*(-?\d+)/m.exec(head);
  if (code) return code[1] !== '0';
  const meta = /"exit_code"\s*:\s*(-?\d+)/.exec(head);
  if (meta) return meta[1] !== '0';
  return null; // Script running、Wait timed out、子 agent 状态等，不是成败
}

export function workbuddyFailed(status: unknown, output: string): boolean | null {
  if (status === 'cancelled') return null; // 被用户中断，不算 agent 失败
  if (status === 'incomplete') return true;
  const code = /\bexit code\s*(-?\d+)/i.exec(output.slice(0, 2000));
  if (code) return code[1] !== '0';
  return status === 'completed' ? false : null;
}

export function dshFailed(data: { isError?: unknown; error?: unknown }, output: string): boolean | null {
  if (stoppedByUser(output)) return null;
  if (data.isError === true || (data.error && data.isError !== false)) return true;
  if (data.isError === false) return false;
  return null;
}
