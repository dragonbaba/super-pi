# 固定工具入口与按需契约

历史覆盖边界：本记录只在 Codex 发送体上验证了前缀，且“本地替换”夹具受到 SDK 同名覆盖影响。后续[跨 provider 验证](provider-prefix-matrix-2026-11-16.md)修正夹具并核对最终注册定义，扩展至全部十类 API，也替代下文的活动工具顺序及激活时规则注入行为。

## 结论与根因

PR #317 修正了误激活和缓存诊断；当时本地工具仍由 `CodemodeController.setTools` 拼接声明。激活、重排、替换说明或 Schema 都可能改变 provider 的 CodeMode 定义。这是客户端前缀变化的证据，不能单独解释历史服务端 cache-read 为零的原因。

本次删除该内联声明路径。本地和 MCP 契约统一按需读取，CodeMode 入口保持固定；活动工具、当前 Schema、权限检查和文档版本检查继续由原所有者维护。真实顶层控制工具及扩展显式 `promptGuidelines` 仍发送到模型，不为缓存隐藏规则。新增入口指引只说明固定调用协议，不嵌入动态目录。

另一个可复现问题是准确搜索已激活工具时，该工具先被排除，其他工具的描述却可能匹配并被激活。现在准确活动名称优先返回原名、不激活其他项；类别无新工具时报告已激活项。MCP 搜索返回 `activated`、`alreadyActive`、`rejected` 及 `matched` / `rejected` / `no_matches` 状态，保留原有 `unconfigured` 契约。搜索不执行目标工具，不授权，也不自动重试成功操作。

`ALL_TOOLS.name` 是可调用的 JavaScript 属性，规范化或名称碰撞时并非注册名。保留该字段兼容旧脚本，新增 `toolName` 供 `describeTools` / `callTool` 使用。完整文档也给出准确注册名调用方式，工具策略仍在真正执行前检查。新激活工具通过 `callTool` 在同一脚本使用；目录和 `tools` 属性在下一脚本刷新。

## 其他 agent 的做法

核对 2026-11-16 的公开主分支，并固定源码版本便于复查；Claude 部分依据官方文档，不声称检查闭源实现。

| 来源 | 可借鉴行为与本次边界 |
| --- | --- |
| [Codex 工具搜索](https://github.com/openai/codex/blob/95946faafcd8f068e28610e8ae6a4c03060c1448/codex-rs/core/src/tools/handlers/tool_search.rs) | 搜索结果在曝光前核对当前工具路由和策略；按需返回当前定义。Pi 保留原执行和文档校验，不把旧目录视为授权。 |
| [Claude 缓存与工具搜索](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) | 延迟定义随工具引用进入后部对话，保留之前的缓存前缀。Pi 固定已有 CodeMode 入口，不伪造原生工具引用协议。 |
| [OpenCode MCP](https://github.com/anomalyco/opencode/blob/8bb7fab26e593d3fdb69226f667221e666c4d006/packages/opencode/src/mcp/index.ts) | MCP 工具和服务说明稳定排序，并根据当前连接状态读取。本次 Pi 改为固定入口与准确注册名，不把远端文本提升为权限或系统规则。 |

[OpenAI 原生 Tool Search](https://developers.openai.com/api/docs/guides/tools-tool-search)也将延迟定义追加到上下文后部。公开 Responses API 能力不等于 Codex OAuth 专用端点支持；本次没有向该端点添加未经验证的协议选项。

## 前缀边界

- 普通嵌套工具激活、顺序、说明、Schema 和真实 MCP 注册刷新不改变固定 CodeMode 定义。
- 直接模型工具及其顺序、明确的系统规则、项目/Skills 指令更新、模型与 reasoning 配置、历史改写/压缩、分支和会话切换仍需要按真实内容核对。
- `prompt_cache_key`、缓存保留配置、provider/账号/路由和 HTTP/WS 续接属于不同边界；客户端稳定定义不能保证服务端命中，也不能证明历史未命中原因。
- 先检查当前 `ALL_TOOLS`，需要时才发现工具；读完整说明和精确 Schema。搜索为空、无 MCP 配置、策略拒绝、已激活和顶层控制工具不是同一种状态。服务级 MCP instructions 的独立分组机制不在本次实现范围，现有逐工具完整说明继续保留。

## 验证与分配边界

先复现固定入口、准确活动名称与缺失 MCP 状态的问题，再通过 253 项相关回归：真实 SDK/QuickJS、Codex SSE 发送边界、真实 MCP 注册适配器、当前 Schema 拒绝旧参数、长说明、文档分页/版本、别名碰撞、工具策略、浏览器路由及 AST 分配约束。

Codex 离线夹具在实际 `fetch` 边界读取已编码的 zstd 请求体，再解压检查真实 `tools`、`instructions`、`prompt_cache_key`：9 次请求中，前 7 次激活/重排/本地替换/MCP 刷新保持三者相同；后 2 次控制工具和系统规则改变产生应有差异。固定 tools JSON 为 9,924 UTF-8 bytes；首请求原始体 11,241 bytes、压缩体 5,089 bytes。后续历史正常增长，不能将整包大小相等当成验收条件。这是离线传输回归，不是实际服务端缓存或 token 测量。

生产链审计：`setActiveToolsByName → CodemodeController.setTools → Agent.modelTools → Codex 工具转换/编码`；`search → 当前活动目录 → describeTools → 当前 Schema/权限 → callTool`；运行时目录由 sandbox 建立、下一脚本刷新并在关闭释放。变化属于工具选择、显式发现/文档请求和 VM 初始化边界，未修改每 delta、进度或渲染热路径，因此不跑无关帧基准。新增目录身份复用现有对象，只加字符串引用；发现结果数组受原 limit / MCP 8 项边界约束，没有新池或任意额度。

补充运行现有 catalog/documentation 分配与生命周期夹具：8/512 项目录的激活 Schema 读取均为 0，入口均为 9,668 字符；按需读取仍覆盖所选契约。16 项大 JSON 文档只序列化各 Schema 一次，续页复用当前快照。三个场景 Worker 启动/关闭各 1，关闭后名称映射、文档快照均为 0；24 + 12 个跟踪引用在受控 GC 后全部释放。宿主采样分配分别约 23.0 MB / 10.1 MB，主要来自目录基准遍历、标识符转换和按需 JSON 序列化；未测 Worker heap，也未进行同负载基线对比，不据此宣称 CPU、峰值内存或吞吐改进。

`npm run check`、`npm run build:offline` 已通过。完整套件及最终 head 的审查/CI 结果以关联 PR 为准；这里不预写未观察到的结果。
