# Super Pi 与 Pi 1.5.0 差异评估

核对日期：2026-11-03（Asia/Tokyo）。结论：优先借鉴安全、持久化和命令执行正确性修复，再处理流式解析、摘要和检索体验；不建议整体覆盖上游代码。本次只修改许可证、包分发元数据和文档，下列运行时缺口尚未修复。

后续设计见[逐项实施方案](upstream-pi-1.5.0-implementation-plan.md)：固定任务顺序、完整调用链审计要求、性能硬门禁、最小必要校验和验收条件。方案落盘不表示已经实施。

## 基线与范围

| 项目 | 固定基线 |
| --- | --- |
| 本地 Super Pi | `b81db72154ff703d2378d58362f03cb83e14adc1`，核心包版本 `1.0.0` |
| 上游最新稳定版 | [Pi v1.5.0](https://github.com/earendil-works/pi/releases/tag/v1.5.0)，提交 `f9a26365568127461c47a07a37dcb42c140a3ac5` |
| 发布时间 | 2026-11-02 11:05:31 UTC，即日本时间 20:05:31 |
| 上一轮 | [Pi 1.1.0 对照与实施记录](upstream-pi-1.1.0-task-plan.md)，不能再用 README 中原先的 0.87.0 说明代表现状 |
| 本次方法 | 阅读 v1.2.0–v1.5.0 coding-agent 发布记录及 AI changelog；针对高价值项核对当前源码，并对命令输出、启动失败和会话追加失败运行离线探针；执行生产依赖审计 |

本项目版本号独立，不应把 `1.0.0 → 1.5.0` 当作需要直接升级的依赖关系。本次不是全仓语义差异审计，也未把上游 main 未发布内容计入稳定版结论。R 表示本地探针观察；S 表示源码确认；V 表示仍需复现；E 表示当前已有对应能力；F 表示产品选择。

## 建议优先处理

### P0：依赖、安全边界和会话完整性

| 项目 | 当前证据 | 建议与验收 |
| --- | --- | --- |
| 生产依赖公告（S） | `npm.cmd audit --omit=dev --json` 报告 **16 个受影响包：8 high、8 moderate、0 critical**。当前 `undici=8.11.2`、`minimatch=10.2.5`；上游 1.5.0 已更新 Undici 并处理 glob 放大问题。 | 单独升级直接依赖及必要传递依赖，再核对兼容性、公告范围和可达调用链。不要运行不加审查的 `audit fix --force`。历史“0 公告”已失效；数量含传递影响，不是 16 个已验证可利用漏洞。[minimatch 公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)、[Undici TLS 公告](https://github.com/advisories/GHSA-2m5v-pch6-74hx) |
| 保存的“不信任”被跳过（S） | [project-trust.ts](../packages/coding-agent/src/core/project-trust.ts) 的 `resolveProjectTrusted()` 在没有需信任资源时直接返回 `true`，早于 `trustStore.get()`。上游同分支已改为尊重保存的决定。 | 先复现仅含 `AGENTS.md` 的目录、保存拒绝、继承拒绝和显式覆盖，再统一 TUI/SDK/package 命令行为。此处确认的是信任状态错误，不等于证明已突破 Windows Sandbox。[上游问题](https://github.com/earendil-works/pi/issues/10947)、[修复源码](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/project-trust.ts) |
| 会话写盘失败后保留错误父节点（R） | [session-manager.ts](../packages/coding-agent/src/core/session-manager.ts) 的 `_appendEntry()` 先更新 `fileEntries`、`entryCount`、`byId`、`leafId`，再持久化。注入 `_persist()` 失败后，条目数仍由 0 变为 1，leaf 也改变。上游已回退内存状态。 | 保留本地原子写、操作存储及缓存设计；覆盖首次写入、普通追加、分支、失败重试和恢复后的 parent 链。本地还需回退 `entryCount`，不能照搬少一个字段的上游补丁。部分磁盘写入的恢复应单独设计。[上游问题](https://github.com/earendil-works/pi/issues/11460)、[修复源码](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/session-manager.ts) |
| 登录 URL 与终端控制字符（S） | [login-dialog.ts](../packages/coding-agent/src/modes/interactive/components/login-dialog.ts) 的认证、device-code、info 链接直接拼接 OSC 8；[open-browser.ts](../packages/coding-agent/src/utils/open-browser.ts) 接受任意 target。不经过 shell 已解决一类注入，但不是 URL 协议和终端字符校验。 | 在登录入口只接受合适的 Web URL，拒绝/清理控制字符，并保留正常复制流程；通用打开文件功能与登录 URL 校验分开。尚未发起真实恶意登录或打开非 Web 地址。上游 1.5.0 已有对应修复。 |

### P1：命令可靠性、性能与摘要

| 项目 | 当前证据 | 建议与验收 |
| --- | --- | --- |
| 扩展 `exec()` 有界输出及关闭（S/R） | [core/exec.ts](../packages/coding-agent/src/core/exec.ts) 累加无上限字符串，没有 `maxBuffer`/`truncated`；强杀检查使用 `proc.killed`，它仅表示已发出信号。逐块 `toString()` 导致跨块 UTF-8 损坏；启动错误被吞成空 stderr，后两项已实测。 | 为扩展入口增加合并输出字节上限、跨块解码、明确截断状态、启动错误和可靠终止/定时器清理。不要误认为已有 Bash/PowerShell 后台任务限制自动覆盖此入口。未运行海量输出崩溃或忽略 SIGTERM 的危险探针。[上游 exec 源码](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/exec.ts) |
| 工具参数流式增量解析（S） | [anthropic-messages.ts](../packages/ai/src/api/anthropic-messages.ts) 仍执行 `partialJson += delta` 后对累计内容 `parseStreamingJson()`；Bedrock 和 OpenAI Chat Completions 也有累计重解析路径。上游 1.5.0 已引入增量解析。 | 先固定大 JSON/grammar 工具输入，再测每个 delta 的扫描、复制和分配量。保留最终语义校验与取消清理；不能因为 TUI 已缓存就忽略 provider 层成本。尚未测量本次候选的性能收益。[上游发布记录](https://github.com/earendil-works/pi/releases/tag/v1.5.0) |
| 分支摘要输出上限、推理和认证（S/V） | [branch-summarization.ts](../packages/coding-agent/src/core/compaction/branch-summarization.ts) 固定 `maxTokens: 2048`；[agent-session.ts](../packages/coding-agent/src/core/agent-session.ts) 的 branch summary 调用未传 thinking level。摘要认证仍将解析出的 `apiKey` 传给摘要流，但本地有专用 stream/auth 边界，是否重现上游 OAuth 问题需测试。 | 先补 reasoning model 的摘要夹具，按模型上限及产品成本策略决定输出限额；认证必须保持 OAuth 与显式 key 的来源语义。不要为模仿上游而默认扩大费用。[1.4.0 发布记录](https://github.com/earendil-works/pi/releases/tag/v1.4.0)、[1.5.0 发布记录](https://github.com/earendil-works/pi/releases/tag/v1.5.0) |
| 图片编码选择（S） | [image-resize-core.ts](../packages/coding-agent/src/utils/image-resize-core.ts) 先生成 PNG 和多档 JPEG，再返回首个符合上限的候选；PNG 达标就不会选更小 JPEG。 | 用照片、透明图和代码截图比较编码尺寸、质量及内存；按内容/透明度选择编码，避免默认牺牲文字清晰度。上游 1.5.0 的“优先较小编码”值得借鉴，尚无本地体积改善测量。 |

### P2：搜索、兼容性与可选功能

| 项目 | 当前状态 | 建议 |
| --- | --- | --- |
| 中文工具搜索与排序（E/S） | [tool-classification](../packages/tool-classification/src/index.ts) 已使用 Unicode 字母/数字，并给完全匹配的工具名高分，不能说“完全不支持中文”。但没有 Unicode normalization 或无空格分词；名称与描述的普通词匹配共用加分。 | 借鉴 1.5.0 的多词覆盖、名称权重、规范等价文本与中日文分词；先添加检索样例，再决定分词成本。保持现有 browser/browser_debug 路由及权限过滤。 |
| Windows 路径等价性（V） | [paths.ts](../packages/coding-agent/src/utils/paths.ts) 的 `canonicalizePath()` 成功时取 realpath，失败时返回原字符串；这不能直接证明所有路径比较都正确或错误。 | 用盘符大小写、缺失路径、symlink、自定义 session 根目录、Skills 去重和 package remove 做矩阵复现；不要笼统对所有路径小写。上游 1.5.0 有跨入口修复。 |
| JSON Schema 验证迁移（F） | 上游 1.5.0 用 `pi-schema`，工具参数 coercion 和 TypeBox 专有特性行为发生变化。 | 不作为普通依赖升级移植。先盘点本地 extension、MCP、Codemode schema、验证与授权先后关系；特别避免授权和执行看到不同的参数。 |
| 配置文档、更新说明与计费来源（F/E） | 上游 1.2–1.5 提供 schema 生成的模型配置参考、扩展更新说明、provider 实际费用来源标记。Super Pi 已有 settings/keybindings schema 和模型能力文档。 | 可优先借鉴自动生成文档以降低漂移；更新说明默认有界；实际账单与目录估算明确区分。已有 `responseModel` 字段，不把它重复列为缺失。 |
| OpenRouter 账户模型目录（V/F） | 上游 1.2.0 引入按 key 返回的可用模型、上下文与价格；本次没有完整审计本地目录链，也未使用真实账户请求。 | 若经常使用 OpenRouter，单独核对目录来源、区域 endpoint、缓存身份和退出登录后的失效；不能以静态目录存在代替账户权限。 |

## 应保留的本地能力与不直接搬运的改动

- **执行边界。** Super Pi 已有三档权限、Windows Sandbox 执行/写回和原生授权。上游 1.5.0 删除其原生 sandbox 示例并不构成本地回退理由。见[执行环境](execution-environments.md)。
- **Codemode 与生命周期。** 本地已有 Worker 复用、容量控制、取消、工具权限和读取证据边界。上游 1.4 的空闲 worker 等待策略可以作为背压设计参考，不能借此绕过本地 owner、容量和释放契约。
- **MCP。** 本地已经有 `secureUrl()`、discovery/issuer 检查、凭据轮换保护、CIMD 与项目配置管理；不能把上游的“拒绝非 HTTP OAuth URL”笼统列成本地 MCP 完全缺失。MCP 检查也不能替代通用 provider 登录 UI 的防护。见 [oauth.js](../packages/mcp-bridge/src/oauth.js)。
- **长任务和上下文。** Plan、Goal、Project Context、Memory、后台任务及不跨重启自动重放是现有产品选择。上游 `durable`、`chord`、classifier、Radius 等需要各自的需求与兼容性评估。
- **TUI 性能。** 已有帧背压、缓存与大量 source invariants，不重复移植整套渲染。逐项确认未覆盖的 provider 参数解析、局部高亮缓存和新终端兼容即可。

建议实施顺序：依赖公告与信任/登录边界 → 会话追加一致性 → 扩展 exec → provider 增量解析 → 摘要 → 图片与搜索 → 可选产品功能。每类问题单独验证，避免用一次“大版本同步”混合独立风险。

任何后续热路径修改都必须先阅读 [hot-path allocation contract](performance/hot-path-allocation-contract.md)，审计完整生产调用链，再提供相关 AST/source invariants、allocation benchmark、确定性计数与生命周期/引用释放证据。本次没有修改生产执行代码，不能将上述建议写成已通过性能门禁。

## 实际验证与边界

Windows，Node.js `v26.13.0`，npm `11.20.0`。生产函数离线探针结果：

| 探针 | 输入/故障注入 | 观察结果 |
| --- | --- | --- |
| 命令启动失败 | 调用不存在的命令名 | `code=1`、`stderr=""`，丢失启动错误 |
| UTF-8 分块 | 子进程先输出字节 `E4`，100ms 后输出 `B8 AD` | 期望“中”，得到三个替换字符 `���`，退出码仍为 0 |
| 会话写入失败 | `SessionManager.inMemory()` 上将 `_persist()` 替换为抛出错误，再调用 `appendMessage()` | 调用抛错，但 entries/count 从 0 变 1，leaf 从 null 变为新 ID |

第三项是生产追加方法的故障注入，未操作真实用户会话，也不是磁盘写满/断电测试。没有运行真实 provider 请求、恶意 URL 打开、完整终端交互或内存耗尽测试。

可移植的审计摘要、上游固定版本和探针结果见 [JSON 证据](evidence/upstream-pi-1.5.0-review.json)。本地下载与打包清单保存在 `.git/superpi-license-upstream-20261103/`，不随仓库分发；本报告关键事实和结果不依赖访问该目录。复核生产依赖可运行 `npm.cmd audit --omit=dev --json`，结果会随公告更新。

许可证验证覆盖根包及全部 34 个 workspace 的 SPDX 值、锁文件元数据、原 MIT 文本逐字节保留，以及 `npm.cmd pack --workspaces --dry-run --ignore-scripts --json` 的法律文件清单。依赖版本和运行时代码未随本次文档任务升级。
