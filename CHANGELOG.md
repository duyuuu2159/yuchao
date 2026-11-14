# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- **成绩单**（`yuchao score`、网页「成绩单」页、概览卡片）：每个 agent、每个模型的会话里，多少顺利完成、多少返工后完成、多少没解决，以及平均要说几句、每件顺利的事花多少 token、缓存命中率、接口重试次数。判断只依据会话里实际发生的事，每个结论带原因；能识别「在一个 agent 里没搞定、换到另一个接着做」
- **用量**：概览页标题旁显示本机累计消耗的 token（按 agent 分段、缓存命中率）；新的「用量」一节按天画出每个 agent 的 token，列出最费 token 的会话
- 解析时记录每个会话按模型汇总的 token 用量，四家口径统一
- 解析时记录每次工具调用 agent 自己写下的执行结果（成功 / 失败 / 不知道）

### 修复

- Codex 定时任务注入的 `<heartbeat>` 不再被当成用户写的话（影响搜索和画像）

## [0.2.0] - 2026-11-11

工程化：这一版没有新功能，目标是让项目经得起检查——每次提交都有机器把关，性能有可复现的数字，安全有成文的威胁模型。

### 性能

- 搜索在作者本机真实数据（6.5 万条消息）上 P95 从 264 毫秒降到 17 毫秒，P50 从 71 毫秒降到 15 毫秒
- 首次建索引快约 2.5 倍（10 万条消息从 13.1 秒到约 5 秒）：批量写入后一次性重建全文索引
- 新增 `npm run bench`：按固定种子生成会话，任何人都能复现。过程、数据和没有用的尝试见 [docs/perf.md](docs/perf.md)

### 安全

- 本地网页服务加内容安全策略（禁止内联脚本和外部资源）、禁止被嵌入 iframe、`nosniff`、不发送 Referrer；接口响应不缓存
- 明暗模式脚本移出 `index.html`，CSP 因此可以完全禁止内联脚本
- `.gitignore` 忽略 `.env` 和 Claude Code 的 `.claude/settings.local.json`
- 新增 [SECURITY.md](SECURITY.md)：资产、信任边界、每条威胁对应的措施和测试、明确不防护的范围

### 质量

- 端到端测试：用临时家目录真实启动命令行，跑索引、搜索、扫描、接力、配置回滚；画像生成对着假的大模型接口跑完整流程，验证编造的引用被剔除、发出去的内容已打码
- 测试覆盖率下限：行 90%、分支 80%、函数 85%（当前 95% / 81% / 92%）
- 引入 Biome 做代码规范和格式检查；修复 34 处没写 `type` 的按钮、分段按钮改用 `<fieldset>` 并补上 `aria-pressed`
- CI：Windows 和 Linux 上跑类型检查、代码规范、测试和覆盖率；网页 JS 体积预算（gzip 后 100 KB）；在 Windows 上打包 exe 并试运行
- `yuchao --version`

### 文档

- [docs/architecture.md](docs/architecture.md)：分层、统一模型、关键设计和取舍
- [CONTRIBUTING.md](CONTRIBUTING.md)：开发命令、接入新 agent 的步骤、测试数据的规矩

## [0.1.0] - 2026-11-10

第一个完整版本，开发过程见 [docs/devlog.md](docs/devlog.md)。

### 新增

- **统一会话库**：解析 Claude Code、Codex、WorkBuddy、DeepSeek Harness 的本地会话；SQLite FTS5 trigram 中文全文搜索；增量索引；子 agent 挂在父会话下；分叉会话去重
- **安全扫描**：找出会话里泄露的密码、API key、私钥、服务器凭据，按指纹归组，默认打码，可标记误报
- **Agent 眼中的你**：读取各 agent 写下的记忆；本地统计；用大模型生成画像，每条结论附出处，程序剔除编造的引用；支持 Anthropic 和 OpenAI 兼容接口
- **配置管家**：给 agent 的配置文件记版本，导入散落的旧备份，检查损坏的版本，安全回滚
- **服务器面板**：服务状态、线上版本、磁盘、异常和错误日志；用只能运行只读脚本的专用密钥连接
- **接力**：把会话整理成交接说明（目标、改过的文件、命令、报错、最后进度），换一个 agent 接着做
- **单文件程序** `yuchao.exe`，双击即用
- **网页界面**：概览页、Markdown 渲染、地址路由、明暗模式，视觉和个人网站 duyuuu.com 一致

[0.2.0]: https://github.com/duyuuu2159/yuchao/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/duyuuu2159/yuchao/releases/tag/v0.1.0
