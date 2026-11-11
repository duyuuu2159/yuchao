# 参与开发

## 准备

需要 Node.js 24 或更新版本。

```bash
npm install
```

```bash
npm run check
```

`check` 依次运行类型检查、代码规范（Biome）和全部测试（含覆盖率下限）。CI 跑的是同样的内容，本地通过了 CI 一般也会通过。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 运行全部测试 |
| `npm run test:coverage` | 测试并检查覆盖率：行 90%、分支 80%、函数 85% |
| `npm run lint` | 代码规范和格式检查 |
| `npm run format` | 自动修复格式和 import 顺序 |
| `npm run typecheck` | 类型检查（后端和网页） |
| `npm run bench` | 性能基准，见 [docs/perf.md](docs/perf.md) |
| `npm run web:dev` | 网页开发模式（先另开一个终端运行 `node src/cli/main.ts serve`） |
| `npm run build:exe` | 打包成单文件 `dist/yuchao.exe` |

## 接入一个新的 agent

1. 在 `src/core/types.ts` 的 `AgentKind` 里加一个名字
2. 在 `src/core/parsers/` 写一个解析器：输入会话文件路径，输出 `Session`
3. 在 `src/core/agents.ts` 的 `AGENTS` 里注册：数据目录、怎么找会话文件、配置文件
4. 在 `test/fixtures/<agent>/` 放**手写的**样例会话，在 `test/parsers.test.ts` 加测试

**样例会话不能来自真实数据。** 真实会话里常常有密码、服务器地址和私人对话，哪怕「看过了没问题」也不要复制。照着真实格式手写几条就够了。

不要根据猜测的格式写解析器：没有真实数据可以对照，就先不接。

## 改动解析规则时

提升 `src/core/store.ts` 里的 `PARSER_VERSION`。用户打开新版本时索引会自动清空重建，否则按旧规则解析的结果会一直留在库里。

## 测试里的假密钥

在运行时拼接，不要在源码里写出完整的令牌格式：

```ts
const FAKE_GH = 'gh' + 'p_' + 'test0123456789abcdefABCDEF0123456789';
```

否则 GitHub 的推送保护会拦下这次推送，代码扫描工具也会报警。

## 提交

- 一个提交做一件事，说明写清楚**为什么**，而不只是改了什么
- 只改排版的提交（格式化、整理 import）把提交号加进 `.git-blame-ignore-revs`
- 推送前确认没有带上 `.env`、key 文件、真实会话或截图里的敏感信息

## 安全问题

请看 [SECURITY.md](SECURITY.md)，不要开公开 issue。
