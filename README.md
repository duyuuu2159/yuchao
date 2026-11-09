# 鱼巢 AgentNest

把 Claude Code、Codex 等多个 AI agent 的本地会话管在一起：一个搜索框搜遍所有 agent 的历史。

- **本地优先**：只读取本机的会话文件，不修改、不上传
- **中文全文搜索**：基于 SQLite FTS5 trigram，不需要分词词典
- **增量索引**：只重新解析有变化的文件，日常更新只要几秒
- **认得清来源**：区分你亲手写的话、agent 的回复、工具调用和客户端自动注入的上下文；子 agent 会话挂在父会话下面；分叉会话复制的历史在搜索结果里只出现一次

## 支持的 agent

| agent | 会话位置 | 备注 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 包括子 agent（`subagents/`） |
| Codex | `~/.codex/sessions/`、`~/.codex/archived_sessions/` | 支持 `.jsonl.zst` 压缩文件；标题读自 `session_index.jsonl` |

## 使用

需要 Node.js 24 或更新版本（用到了内置的 `node:sqlite`、zstd 解压和 TypeScript 类型擦除）。

```bash
npm install
```

```bash
npm run web:build
```

```bash
node src/cli/main.ts index
```

```bash
node src/cli/main.ts search nginx 回滚
```

```bash
node src/cli/main.ts serve
```

然后打开 <http://127.0.0.1:4317>。

### 命令

| 命令 | 作用 |
|---|---|
| `index` | 扫描并增量索引会话 |
| `search <词...>` | 搜索对话，多个词需同时出现；`--agent claude\|codex`、`--tools` 同时搜工具调用 |
| `sessions` | 按最近活动列出会话；`--all` 包含子 agent |
| `show <id>` | 查看完整对话；`--tools` 显示工具调用 |
| `stats` | 索引统计 |
| `serve` | 启动本地网页界面，只监听 127.0.0.1 |

索引存放在 `~/.yuchao/index.db`，可用环境变量 `YUCHAO_DB` 修改。

## 开发

```bash
npm test
```

```bash
npm run typecheck
```

前端开发时先运行 `node src/cli/main.ts serve`，再运行 `npm run web:dev`，Vite 会把 `/api` 转发给本地服务。

### 目录结构

```
src/core/      解析器、索引、搜索（不依赖界面）
  parsers/     每种 agent 一个解析器，输出统一的 Session 模型
src/cli/       命令行入口
src/server/    本地 HTTP API 和静态文件服务
web/           React 界面
test/          测试；fixtures/ 里是手写的假会话，不含任何真实数据
docs/          计划和开发日志
```

## 路线图

见 [docs/PLAN.md](docs/PLAN.md)。当前完成 M1（统一会话库）。

## 许可

MIT
