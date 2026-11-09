import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * 逐行读取 JSONL，`.zst` 文件边解压边读。
 * 必须流式处理：本机有一个 Codex 会话解压后超过了 V8 单个字符串的上限，一次性读入会直接报错。
 */
export async function* readJsonl(path: string): AsyncGenerator<Record<string, any>> {
  let input: Readable = createReadStream(path);
  if (path.endsWith('.zst')) input = input.pipe(createZstdDecompress());
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // 写到一半的最后一行（agent 正在运行）或损坏行，跳过即可
    }
  }
}
