# Super Pi 文档导航

这里按读者要完成的任务组织 Super Pi 文档。根目录的 [README](../README.md) 是当前源码运行方式、能力状态和限制的入口；[English README](../README.md) 与 [中文 README](../README.zh-CN.md) 共享同一组事实。

## 开始使用

- [项目首页（English）](../README.md)：定位、快速开始、认证、模型选择、目标项目启动方式和边界。
- [项目首页（简体中文）](../README.zh-CN.md)：中文对等版本。
- [Coding-agent 说明](../packages/coding-agent/README.md)：全屏退出、Windows PowerShell、扩展观察者和运行时细节。
- [模型能力参考](model-capabilities.md)：模型输入模态、工具调用、推理、上下文、缓存和 provider 能力。

源码交付的最短路径是：在仓库根目录运行 `npm.cmd ci`、`npm.cmd run build:offline`，再通过 `npm.cmd run superpi` 启动。包内 README 如果保留面向独立 npm 包或上游 Pi 的安装片段，应视为包级参考；源码 checkout 的正式入口以根 README 和 `scripts/superpi.mjs` 为准。

## 模型、认证和 provider

- [AI/provider API](../packages/ai/README.md)：provider 集合、模型目录、认证解析、工具调用、图片输入和自定义 provider。
- [模型能力参考](model-capabilities.md)：能力字段和模型目录说明。
- [CLI 帮助源码](../packages/coding-agent/src/cli/args.ts)：CLI 参数、`--list-models`、`--mode`、工具范围和环境变量清单。
- [认证命令源码](../packages/coding-agent/src/cli/auth-command.ts)：`auth check`、`auth print-api-key` 和 `auth print-bearer-token` 的职责与参数。
- [Super Pi 配置资源](../.sp/config/README.md)：仓库随源码加载的 package 列表与个人配置边界。

`/login` 用于交互式 provider 认证，`/model` 用于选择模型；`auth print` 命令会输出凭据，适合明确的外部集成，不应作为首次配置教程中的普通步骤。

## 工具、权限和项目上下文

- [Project Context 和 CodeGraph](../packages/project-context/README.md)：项目身份、规则、轻量索引和显式 CodeGraph 操作。
- [LSP](../packages/lsp/README.md)：诊断、source fix 和符号导航的配置与边界。
- [Tool classification](../packages/tool-classification/README.md)：初始工具面、延迟工具搜索和按需激活。
- [Dynamic instructions](../packages/dynamic-instructions/README.md)：工作区规则和 Skills catalog 的增量更新。
- [Goal mode](../packages/goal/README.md)：持续目标、预算、暂停/恢复和实验队列。
- [Plan mode](../packages/plan-mode/README.md)：只读探索、结构化提问、计划确认和实现交接。
- [MCP bridge](../packages/mcp-bridge/README.md)：stdio、Streamable HTTP、SSE、配置和可信 server 边界。
- [Memory](../packages/memory/README.md)：项目/全局记忆、会话搜索、Skills 和人工审阅的记忆提取流程；普通工具操作的确认方式取决于入口。

这些包的加载和可用性由 `.sp/config/settings.json`、全局/项目配置、项目可信度和 CLI 选项共同决定；源码中存在不等于每次运行都启用。

## 图片、终端和嵌入

- [图片输入和交互控制](interactive-control-image-input.md)：图片草稿、提交、取消和终端输入边界。
- [Auxiliary Vision](../packages/extensions/auxiliary-vision/README.md)：文本模型的可选图像描述、配置和文件范围。
- [TUI](../packages/tui/README.md)：终端组件和布局包参考。
- [RPC protocol](../packages/protocol/README.md)：运行时协议、帧边界和验证。
- [RPC client](../packages/client/README.md)：远程 session client、lease 和 transport。
- [RPC server](../packages/server/README.md)：实验性 server core；不提供独立 coding-agent 服务。
- [SDK 源码入口](../packages/coding-agent/src/core/sdk.ts)：嵌入式 session 创建和扩展绑定的类型入口。

## 开发和性能契约

- [性能文档索引](performance/README.md)：性能设计、验证和历史候选。
- [Hot-path allocation contract](performance/hot-path-allocation-contract.md)：provider、工具、交互、渲染和大结果路径的修改要求。
- [Tool-result presentation](performance/phase5b-budgeted-model-view.md)：显式启用的结果展示流程；模型 Token 预算投影还需配置正整数 `budgetTokens`，没有生产默认预算。
- [Token estimator](performance/phase5a-token-estimator.md)：估算口径与限制。
- [TUI responsiveness](performance/tool-progress-tui-responsiveness.md)：进度、背压和取消的设计记录。
- [源码贡献检查](../package.json)：check、build:offline、test:hot 和完整 test 脚本。

生产代码贡献应先读取适用的 `AGENTS.md` 和性能契约。性能文档中的 benchmark 数字属于特定版本、环境和 fixture 的验证记录，不能直接当作产品承诺。

## 历史、来源和评估

- [Pi 0.84.1 → 0.86.1 定向评估](policy-diagnostics-pi-0.84.1-0.86.1-assessment.md)：当前 Super Pi 与固定上游 tag 的差异记录，不是整体升级。
- [独立化状态记录](../MIGRATION.md)：历史迁移收尾和当前数据边界。
- [来源与许可证](../NOTICE.md)：Pi 和其他保留来源的归属。
- [性能/修复记录](repairs/session-clean-timeout-boundaries.md)：历史验证材料，不是新用户安装指南。

历史记录中的旧 worktree 路径、临时命令、候选分支和验收环境只用于理解当时实现，不应复制到新项目执行。无法从当前入口和源码确认的能力，不作为当前承诺。

## 贡献文档

文档修改应保持：

- 示例目录、凭据和 session 内容使用虚构或脱敏值。
- 命令与当前 `package.json`、CLI parser 和正式 launcher 一致。
- 英文和中文首页共享同一章节结构、命令、启用状态和限制。
- 仓库内链接使用相对路径，并在提交前检查大小写和锚点。

欢迎从 README、包说明和性能契约开始，再按实际影响选择 `npm.cmd run check`、构建和测试范围。来源和 MIT 许可证见 [NOTICE.md](../NOTICE.md) 与仓库 [LICENSE](../LICENSE)。
