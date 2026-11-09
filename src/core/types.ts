// 所有 agent 的会话都被转换成这里的统一模型，后面的索引、搜索、界面只认这一种格式。

export type AgentKind = 'claude' | 'codex';

/**
 * user       用户亲手输入的内容
 * assistant  agent 的回复
 * tool_call  agent 发起的工具调用（命令、读写文件等）
 * tool_result 工具返回的结果
 * context    由客户端自动注入的上下文（环境信息、斜杠命令输出、压缩摘要等），默认不参与搜索
 */
export type Role = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'context';

export interface Message {
  seq: number;
  ts: string | null;
  role: Role;
  toolName: string | null;
  text: string;
}

export interface Session {
  /** `${agent}:${nativeId}`，全局唯一 */
  id: string;
  agent: AgentKind;
  nativeId: string;
  /** 子 agent 会话指向发起它的父会话 */
  parentId: string | null;
  title: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  sourcePath: string;
  messages: Message[];
}

/** 工具结果可能是整页日志或 base64 图片，只保留开头部分用于检索 */
export const MAX_TOOL_TEXT = 2000;

export function clip(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? text.slice(0, max) + `…[截断，原长 ${text.length}]` : text;
}
