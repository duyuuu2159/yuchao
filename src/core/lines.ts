import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * 逐行读取 JSONL：
 *   .jsonl       普通文本
 *   .jsonl.zst   Codex 的压缩会话，边解压边读。必须流式处理：本机有一个 Codex 会话解压后超过了
 *                V8 单个字符串的上限，一次性读入会直接报错。
 *   .jsonl.zstd  DeepSeek Harness 的会话，由几千个独立的 zstd 帧首尾相接，见 zstdFrames。
 */
export async function* readJsonl(path: string): AsyncGenerator<Record<string, any>> {
  if (path.endsWith('.zstd')) {
    yield* parseLines(zstdFrameLines(path));
    return;
  }
  let input: Readable = createReadStream(path);
  if (path.endsWith('.zst')) input = input.pipe(createZstdDecompress());
  yield* parseLines(createInterface({ input, crlfDelay: Infinity }));
}

async function* parseLines(lines: AsyncIterable<string> | Iterable<string>): AsyncGenerator<Record<string, any>> {
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // 写到一半的最后一行（agent 正在运行）或损坏行，跳过即可
    }
  }
}

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 按 zstd 格式（RFC 8878）读帧头和块头，算出从 pos 开始的这一帧有多长，不解压。
 * 帧 = 魔数 4 字节 + 帧头 + 若干块（每块 3 字节块头 + 内容）+ 可选的 4 字节校验。
 * 返回 null 表示这里不是帧，或者帧还没写完。
 */
export function zstdFrameLength(buf: Buffer, pos: number): number | null {
  if (pos + 6 > buf.length) return null;
  const magic = buf.readUInt32LE(pos);
  // 可跳过帧（0x184D2A50–5F）：魔数后面 4 字节是长度
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    const len = 8 + buf.readUInt32LE(pos + 4);
    return pos + len <= buf.length ? len : null;
  }
  if (magic !== ZSTD_MAGIC) return null;
  const fhd = buf[pos + 4];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictIdSize = [0, 1, 2, 4][fhd & 3];
  const fcsSize = [singleSegment, 2, 4, 8][fcsFlag];
  let p = pos + 5 + (singleSegment ? 0 : 1) + dictIdSize + fcsSize;
  for (;;) {
    if (p + 3 > buf.length) return null;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 3) return null; // 保留类型，说明数据不对
    p += 3 + (type === 1 ? 1 : size); // RLE 块的内容只有 1 个字节
    if (last) break;
  }
  p += checksum ? 4 : 0;
  return p <= buf.length ? p - pos : null;
}

/**
 * 把首尾相接的多个 zstd 帧逐帧解压。
 * DeepSeek Harness 每写一批事件就追加一个新帧，一个会话文件有几千帧。Node 的解压对这种文件靠不住：
 * - zstdDecompressSync 只解第一帧，后面的静默丢掉（4MB 的文件只解出 252 字节）
 * - 流式解压遇到第二帧报 Unknown frame descriptor
 * - 帧被截断时不报错，而是静默返回空内容，所以也不能「先试着解压、失败再说」
 * 因此按格式自己算出每一帧的边界再逐帧解压。最后一帧可能还没写完（agent 正在运行），直接丢弃。
 */
export function* zstdFrames(buf: Buffer): Generator<Buffer> {
  let pos = 0;
  while (pos < buf.length) {
    const len = zstdFrameLength(buf, pos);
    if (len === null) return;
    if (buf.readUInt32LE(pos) === ZSTD_MAGIC) yield zstdDecompressSync(buf.subarray(pos, pos + len));
    pos += len;
  }
}

/** 一行（甚至一个汉字的几个字节）可能跨两个帧，所以按帧拼接后再切行；内存里同时只有压缩文件和当前这一帧 */
function* zstdFrameLines(path: string): Generator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for (const frame of zstdFrames(readFileSync(path))) {
    const lines = (rest + decoder.write(frame)).split('\n');
    rest = lines.pop()!;
    yield* lines;
  }
  rest += decoder.end();
  if (rest) yield rest;
}
