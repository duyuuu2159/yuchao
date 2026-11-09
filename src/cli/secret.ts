// 在终端里读取 key：输入时不显示，读到的值只留在内存里，不写入文件、环境变量或命令历史。

export function askSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('--ask-key 需要在终端里运行'));
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      err ? reject(err) : resolve(value.trim());
    };
    const onData = (chunk: string) => {
      // 粘贴时一整段会作为一个 chunk 到达，逐字符处理
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('已取消'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
