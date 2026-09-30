# Super Pi 对照 Pi v0.99.1：差异审查与有界实施计划

原审查日期：2026-09-30  
修订：v1.1 · 2026-09-30（API-first / 既有 Codex 兼容 / 性能归属 / 验证去重）

> 本次交付是对原评估的修订，不是源码修复或测试完成报告。保留 A1–D3 编号及原始对照材料，新增 A5 与执行边界。原审查事实、补充静态核验和本次实施要求分开标明；尚未复现的风险、性能收益、账号在线有效性均不得写成已验证结论。
>
> 实施状态（2026-09-30）：本计划已在分支 `feat/upstream-0991-absorb` 上按 §6.1 实施，逐项结论与证据见 §9；§1–§8 的计划正文保持修订稿原样，不按实施结果回改。

## 1. 基线与方法

| 项 | 值 |
| --- | --- |
| Super Pi | `D:\RMProjects\Pi`，HEAD `ef8ac684d`（PR #52 合并后），包版本仍标 `0.84.1` |
| 上游 Pi | `D:\RMProjects\TempPi\pi`，全部包 `0.99.1`（2026-09-29 发布） |
| 已有评估 | `docs/policy-diagnostics-pi-0.84.1-0.86.1-assessment.md`（0.84.1→0.86.1）、`SUPER_PI_V087_BOUNDED_OPTIMIZATION_PLAN.md` + `docs/performance/pi-087-bounded-optimization.md`（0.87.0，S1–S6/R1–R3 已落地） |
| 本文范围 | 0.84.1→0.99.1 全量 changelog（coding-agent / ai / agent / tui 及新包），重点是 0.87.1、0.99.0、0.99.1 与此前"推迟"的条目 |

原审查方法（沿用原作者记录）：逐条阅读上游 changelog，在两侧源码中定位实现；原文的 `文件:行号` 是该基线的定位线索，不是实施时的实时行号。原审查未运行构建、测试或基准。

本次补充静态核验：读取同一基线 `ef8ac684de2ee46441b2a3deca4a67e4239e1c28` 的 `AGENTS.md`、热路径契约、根 `package.json`、`scripts/test.mjs` 和 `.github/workflows/ci.yml`，并采用前一轮已读取的 Codex 认证代码与压缩包 README 作为 A5 的排查线索。没有重做全量源码对照、运行在线认证或执行性能测试。

实施前先确认实际 `origin/main`、工作区和适用的局部 `AGENTS.md`。不回退到本文快照，不因版本号较旧重复实施已等价功能。每项先确认当前机制/复现，再做最小修改；与当前源码不符时更新本项结论并留下原因。

上游版本号从 0.87.1 直接跳到 0.99.0，0.99.0 是一次大版本（codemode/MCP/虚拟模型/分类器/system 主题/TS 7 工具链）。

## 2. 总体差异

### 2.1 包结构

| 上游独有 | 说明 | 建议 |
| --- | --- | --- |
| `codemode` | QuickJS/WASM 沙箱，模型写 JS 调用工具 | **重点评估**（见 D1） |
| `mcp` | 独立 MCP 客户端（stdio / Streamable HTTP / OAuth） | Super Pi 已有 `mcp-bridge`，只借鉴 OAuth 与 exposure 模型 |
| `durable` / `chord` | 事务化 Session、复制状态框架、任务运行时 | 不吸收（架构替换级，且与 Super Pi session 契约冲突） |
| `evals` | 评测框架 | 不吸收 |

| Super Pi 独有 | 说明 |
| --- | --- |
| `memory`、`goal`、`plan-mode`、`lsp`、`project-context`、`statusline`、`tui-kit`、`chrome-devtools`、`mcp-bridge`、`openai-server-compaction`、`provider-aware-compaction`、`openai-fast-mode`、`dynamic-instructions`、`tool-classification`、`extensions/*`（资源生命周期守卫、mutation guard、false-success guard、subagent 等） | 这些是 Super Pi 的差异化核心，上游没有对应物 |

代码规模：上游 `agent` 33.6k 行（Super Pi 12.5k）、`coding-agent` 83.3k 行（Super Pi 76.7k）。上游 agent 包的膨胀主要来自 harness/durable 相关实现，不是 Super Pi 需要的。

### 2.2 上游的破坏性架构变更（不整体跟进）

| 版本 | 变更 | 为什么不跟 |
| --- | --- | --- |
| 0.86.0 | provider 输入从 `Context` 改为 `TranscriptContext`，system prompt 和 tools 移入 transcript 系统消息 | 需要重写全部 provider adapter；Super Pi 的 `pi-messages` 请求契约、strict 能力、缓存前缀 manifest 都建立在 `Context` 上 |
| 0.87.0 | `SessionManager` 成为 provider 上下文的唯一来源；`ContextEditEntry`；`finishTurn` 取代 `shouldStopAfterTurn` | R1（放弃尝试不再进入上下文）已在 Super Pi 用现有 checkpoint 机制最小修复，不需要这套 |
| 0.99.0 | 模型类型统一（chat/image/classifier），catalog schema v6 | 只有做图像生成/分类器才需要 |

结论：继续沿用“有界切片”策略；不对上游 Pi 整体 rebase 或合并，不重写 Super Pi 的核心会话与 provider 契约。

### 2.3 本次确定的产品与维护边界（新增要求）

**GPT / Claude 优先维护正式 API 接入；既有 `openai-codex` 做有界兼容维护，不追平 ChatGPT 的整套订阅产品。** API-first 不等于删除现有 Codex，也不等于把原生 Responses、缓存和压缩能力降到最低公共接口。

- 不整体引入新增的 ChatGPT 账户、权益、订阅管理及云端工作流；不重新启用已禁用的 Anthropic 自管订阅 OAuth。
- 保留现有 Codex 登录、刷新与请求链；只修兼容性、安全性和明确的故障。凭据存在、刷新成功、普通请求成功、远程压缩成功是不同状态，不用一个“已登录”标志代替。
- API 与订阅认证、端点和计费来源保持显式归属。认证或配额失败后不得静默切到另一账户、API key、provider 或计费来源；不复制、迁移或清理用户凭据作为默认修复手段。
- 远程压缩按实际入口的协议契约维护；保留 GPT 的既有 failed-closed 边界、可移植摘要及本地会话权威性。不新造账户健康框架、后台探测器或第二套凭据存储。
- 其余 provider 的正常 API 行为不应因 GPT/Codex 的特殊路径发生变化。

## 3. 已吸收或已等价（不要重复做）

| 上游条目 | Super Pi 现状 |
| --- | --- |
| EventStream 双栈 FIFO（0.86.0，#9055） | S4 已落地 |
| 无 body 400/413 只限 Cerebras、z.ai `Prompt too long`（0.86.0/0.86.1） | S1 已落地 |
| 未知 Chat 端点默认不发 strict（0.87.0，#9816） | S2 已落地 |
| GIF 文件头完整签名（0.87.0，#9755） | S3 已落地 |
| 扩展虚拟模块载荷按需加载（0.86.0，#9540） | S5 已落地 |
| fuzzy `indexOf` 推进（0.86.0，#9267） | S6 已落地 |
| 放弃的尝试不再进入上下文（0.87.0） | R1 已用现有机制修复 |
| `sanitizeBinaryOutput` 不再逐字符建数组（0.99.0） | `coding-agent/src/utils/shell.ts:328` 已是单遍扫描，且额外剔除孤立代理项，比上游更严格 |
| JSONL 缺尾换行导致下一条损坏（0.84.4，#8345） | `session-manager.ts:1042` `_appendNeedsSeparator` |
| 被信号终止的命令报成功（0.86.0，#9577） | `tools/bash.ts:1093` `[SHELL_INTERRUPTED]` |
| 截断的压缩摘要不落盘（0.84.3，#7048） | `compaction.ts:696` |
| 语法高亮语言懒加载（0.84.3） | `utils/syntax-highlight.ts:53` eager registry |
| GPT-5.6+ `prompt_cache_options.ttl`（0.85.1） | 已存在 |
| Anthropic `defer_loading` / `tool_reference` 延迟工具 | `ai/src/api/anthropic-messages.ts:1121,1350` |
| MCP 工具延迟暴露 | `mcp-bridge` 的 `mcp_search_tools`（默认 deferred） |
| `session_compact_failed` 事件、`--mode` 非法值报错、BOM 处理 | 均已存在 |

## 4. 推荐吸收清单

优先级定义：
- **P0**：原评估认为可能导致错误执行、无效请求或丢数据的正确性问题，或值得优先验证的小范围热路径优化。优先级不代表已复现；性能收益仍须测量。
- **P1**：有明确收益但需要测量或设计。
- **P2**：只做设计评审，有复现再立项。

### P0-A：正确性 / 安全（直接关联无效请求与错误执行）

#### A1. Responses 流以"未完成的工具调用"结束时必须报错（上游 0.99.0，#9974）

- **问题**：某些服务端不发 `output_index`（例如 llama.cpp），或者流被截断时，工具调用的 `output_item.done` 永远不会到达。这类调用的参数可能被截断或串到别的调用里。agent 会执行最终消息中的**所有**工具调用，于是可能执行一条混杂拼接出来的 bash 命令。
- **Super Pi 现状**：`ai/src/api/openai-responses-shared.ts:760` 只检查了 `sawTerminalResponseEvent`，没有检查未完成的工具调用。
- **上游实现**（在 terminal event 检查之后，约 10 行）：

```ts
if (output.stopReason === "toolUse") {
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		const toolCall = block as StreamingToolCall;
		if (toolCall.partialJson !== undefined || toolCall.customInput !== undefined) {
			throw new Error(`OpenAI Responses stream completed with an unfinished tool call: ${toolCall.name} (${toolCall.id})`);
		}
	}
}
```

- **适配要点**：Super Pi 的 `StreamingToolCall` scratch 字段名要以本地实现为准（确认完成的调用会清理 `partialJson`）。Codex 路径共享同一个 `processResponsesStream`，这一处修改就能同时覆盖两者。
- **验收**：借鉴上游 `ai/test/openai-responses-terminal-event.test.ts` 的两个用例（缺 `output_item.done`、缺 `output_index` 导致串参），通过本仓已有根 `tests` 入口接入 CI；正常完成的调用不受影响，失败消息里的工具不得被执行。不要只校验抛错文本，还要验证 agent 执行次数为 0。缺 `output_index` 的事件关联规则按当前实现验证，不以伪造完成事件掩盖串参。

#### A2. 流式期间 `triggerTurn: false` 的自定义消息必须延后到本轮工具结果之后（上游 0.84.4，#8537）

- **问题**：agent 正在执行工具时，扩展调用 `sendMessage(..., { triggerTurn: false })`，消息会被直接 push 进 `agent.state.messages` 并写入 session，位置落在 assistant 的 `tool_use` 和它的 `tool_result` 之间。Anthropic 等会校验顺序的 provider 在重放时拒绝整个请求，结果是一次失败请求、一次重试，严重时整个会话卡死。
- **Super Pi 现状**：`coding-agent/src/core/agent-session.ts:2945-2955`，`else` 分支无条件立即追加。
- **触发面**：Super Pi 自己的 `plan-mode/src/plan-mode.ts:533` 和 `plan-mode/src/presentation.ts:80` 就在使用 `triggerTurn: false`。
- **上游实现**：新增 `_pendingCustomMessages`；`isStreaming` 时先入队，不发事件；工具结果写入 state/session 后用 `_flushPendingCustomMessages()` 统一追加并发 `message_start/end`。
- **适配要点**：挂到 Super Pi 自己的 turn 边界（相关工具结果入 state/session 之后、下一次 provider 请求之前），保留多个自定义消息的 FIFO、恰好一次事件与持久化语义。队列由当前 session/turn 所有；abort、错误时只在保持调用/结果配对的安全位置 flush，dispose 或会话替换时按明确语义释放，不能跨会话泄漏。不要为 flush 新建每事件闭包或并行状态机。`getQueuedMessages` 的 UI 预览包含 pending 项，但返回值不得暴露可变队列本体。
- **验收**：离线 faux provider 夹具。assistant 发出 tool_call，工具执行期间扩展发 `triggerTurn: false` 消息，检查下一次 provider wire 中 `tool_use` 紧跟 `tool_result`，自定义消息排在之后；abort 后 pending 被释放。

#### A3. Codex SSE：EOF 时处理残余帧（上游 0.85.0，#9047）

- **问题**：服务端最后一个事件（常见是 `response.completed`）后面如果没有空行，Super Pi 在 `done` 时直接 `break`，丢掉 buffer 里的终止事件。随后抛出 "stream ended before a terminal response event"，整个回合作废并重试，已经产出的 token 白花。
- **Super Pi 现状**：`ai/src/api/openai-codex-responses.ts:826` `parseSSE` 中 `if (done) break;` 位于解析之前。
- **修复**（上游写法）：

```ts
buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
if (done && buffer.trim()) buffer += "\n\n"; // EOF 终止残余帧
// ...原有 while (idx !== -1) 解析...
if (done) break;
```

- **修订**：上例只是 EOF 修复机制，不是要求逐字照搬。保留解码尾字节、残余帧恰好处理一次、空尾部不产出事件等语义；CRLF 与跨 chunk 情况同 C7 使用一组参数化夹具。仅整理触及区段的格式，不把整文件格式化混入正确性 commit。

#### A4. 首条用户消息即落盘（上游 0.99.0，#10000）

- **问题**：新会话要等到第一条 assistant 回复才写文件。用户发出一个长 prompt 后，在首个回复完成前退出、崩溃或断网，这个 prompt 就彻底丢了。
- **Super Pi 现状**：`coding-agent/src/core/session-manager.ts:1047-1055`，`hasAssistant` 为假时只把 `flushed` 置为 false 然后返回。
- **上游实现**：条件改为"存在 user 或 assistant 消息"，并且只在 `!flushed` 时检查；首次写入用 `openSync(path, "wx")`，防止覆盖同名文件。
- **适配要点**：Super Pi 首次写入使用 `writeSessionEntriesAtomically`，保留这一点，只改判定条件。同时把 `.some()` 检查移到 `!flushed` 分支里：现在每次 append 都会跑一遍，虽然会在第一条 assistant 处短路，但没有必要。
- **验收**：复用已有隔离进程夹具验证：user 消息写入完成、assistant 尚未回复时退出，再打开能恢复该消息；空会话不留文件，原子写入与追加分隔符契约不变。不要求逐条消息做同步全盘扫描，也不把一次成功写入夸大为断电持久性保证。

#### A5. 既有 Codex 认证与远程压缩可靠性（本次新增，有界兼容）

**范围**：维护已经存在的能力，不引入新的订阅体系，也不预先假定所有排查项都需要改代码。普通 API 与 Codex 两条路径分别验收。

**补充静态线索**：`ai/src/auth/oauth/openai-codex.ts` 保留浏览器/设备码登录与刷新；`ai/src/auth/resolve.ts` 已有临近过期刷新、`CredentialStore.modify()` 下重新检查及刷新超时，禁止失败后静默改用环境 API key。实施时核对真实 store 的锁与写回语义，不再并列造一套锁。`openai-server-compaction/README.md` 声明了 GPT failed-closed、窄协议回退和 `/provider-refresh` 只重置传输的契约，须沿运行时代码验证，不能只依据 README 宣布通过。

**A5-a · 认证与诊断**

- 复用当前认证解析入口，让普通请求和压缩各自在请求边界获取有效认证；不要长期捕获旧 token，也不要在每个 delta 中读取或刷新凭据。检验并发刷新、写回失败、临时网络失败与终止性认证失败的既有处理，不无故清除凭据或增加自动重试层。
- `readTokenResponse()` 当前会把缺字段的成功响应 `JSON.stringify(json)` 拼入错误；当响应部分字段已含 token 时存在泄露风险。改成有界的缺字段/状态诊断，不回显原始响应、token、认证 URL 参数或 headers；错误 cause、日志和持久化遥测也不得重新引入这些值。用合成哨兵秘密验证，不读出真实凭据。
- 401、权限/权益拒绝、配额耗尽、网络失败和压缩协议不支持按已有结构化信息区分；不要把它们全部解释成“重新登录”。在认证解析/协议边界做校验，不用宽泛字符串正则驱动跨 provider 回退。

**A5-b · 压缩的一致性与失败边界**

- 明确区分普通 API Responses、Codex backend、v2 流式压缩和 unary compact 入口；沿实际请求与返回 schema 验证历史重建，不混用不同入口的返回窗口，也不盲目只取单个 opaque item。必要的协议核实单独记录，不把推断写成已证实的现有 bug。
- 保留现有回退条件：仅输出前明确表示 `compaction_trigger` / `remote_compaction_v2` 不支持的 400/404，才允许现有的一次 unary 回退。通用 400/404、401/403、配额/限流、网络超时、取消、输出后的失败或畸形成功流，不能因此再次提交完整上下文。
- 远程结果与必需可移植摘要均满足既有成功条件后，才提交新的 compaction entry 和工作上下文；失败不提交成功压缩状态、不丢弃原会话，不绕过 GPT 的 `{ cancel: true }` / failed-closed 边界。既有失败遥测可以保留，但必须有界、脱敏；普通非 GPT fallback 语义不因此扩张或收紧。
- 继续使用既有 session 资源生命周期与失效点；会话切换、fork/resume、模型/端点/认证身份变化后不得错误复用不兼容的 continuation 或 opaque 状态。`/provider-refresh` 不是重新登录，也不是删除本地压缩记录。先确认已有机制，不默认增加全局 capability cache、新开关或第二套状态机。
- 摘要 `toolChoice: "none"` 与提示词两项仍按 P2 的复现条件处理；修摘要兼容不等于已验证原生远程压缩。

**最小验收**：合并到已有认证/压缩 contract 夹具：近过期刷新及请求取新认证、合成 token 不进入诊断、仅允许的回退发生一次、一般失败/abort 不重复发送且不提交成功状态、成功压缩后能续接，另含普通 API 与非 GPT 的不受影响用例。根 `tests` 入口实际发现这些回归。

**在线状态**：默认离线；不把真实账号 smoke 放入 CI，不上传真实会话或凭据。只有已有明确授权的本机诊断允许时，才用合成短会话做最少的普通请求、压缩与续接；否则交付标“在线有效性未实测”，不能把离线通过写成账号有效。

### P0-B：TUI 热路径（有界优化，收益须验证）

这 4 项都命中 Super Pi `hot-path-allocation-contract.md` 定义的渲染/布局热路径，必须按契约补结构计数与生命周期证据。

#### B1. `visibleWidth()` 增加"ASCII + ANSI"快速路径（上游 0.99.0）

- **问题**：TUI 里绝大多数行是带 ANSI 样式的 ASCII 文本。Super Pi 的快速路径 `isPrintableAscii` 遇到 `\x1b` 就失败，于是每一行都要走完整流程：查 512 项 Map、剥离 ANSI（逐字符 `stripped += clean[i]`，每个转义序列还通过 `extractAnsiCode` 分配 `{code, length}` 对象和子串）、`Intl.Segmenter` 分段、写回缓存。512 项缓存对于一屏 40 行乘以多次 resize/主题切换来说会持续抖动。
- **Super Pi 现状**：`tui/src/utils.ts:260-313`；`isPrintableAscii` 在 `:60`；非分配的 `findTerminalSequenceEnd` 已经存在于 `:469`，但 `visibleWidth` 没用它。
- **修复**：
  1. 在缓存查找之前加 `asciiVisibleWidth()`：逐 code unit 扫描，`0x20–0x7e` 计 1，`\t` 计 3，`\x1b` 用 `findTerminalSequenceEnd` 跳过，遇到其他字符返回 -1 回落到慢路径。零分配。
  2. 慢路径的剥离循环改成 `indexOf("\x1b")` 分段拼接，用 `findTerminalSequenceEnd` 替代 `extractAnsiCode`。
- **注意语义差异**：上游 `ansiCodeLength` 只认 CSI 终止符 `m/G/K/H/J`；Super Pi 用的是 `ANSI_SEQUENCE_FINAL_PATTERN`。快速路径必须复用 Super Pi 自己的判定，否则宽度结果会和慢路径不一致。
- **验收**：对现有宽度语料做新旧两条路径的逐行结果比对（CJK、emoji、OSC 8 链接、APC 光标标记、tab）；`bench:tui-frame-allocations` 的 sampled bytes/frame 下降；`Intl.Segmenter` 调用计数在纯样式 ASCII 夹具中为 0。

#### B2. `Box` 以未填充的子行做缓存比较（上游 0.99.0）

- **原评估定位**：渲染子组件时，每帧先执行 `childLines.push(leftPad + line)`，即使缓存命中也先做 padding 字符串构造；`applyBg` 还可能重复测宽。**修订**：不把 JS 字符串比较必然退化为逐字扫描、或复用字符串必然变成指针比较作为收益依据；应测量实际字符串物化与测宽次数。
- **Super Pi 现状**：`tui/src/components/box.ts:97-103`（加 padding）、`:143-152`（`applyBg`）。
- **候选修复**：缓存比较使用原始子行；仅在 miss、真正生成输出时构造 `leftPad + line`。只有确认 `applyBackgroundToLine` 没有额外 reset/重新着色等语义时，才省去重复测宽。缓存键必须覆盖 padding、width、背景/主题及相关子内容变化，不依赖未证明的字符串身份。
- **验收**：快照/视觉语义不变，缓存命中时本项新增的 padding/背景重建计数为 0；miss 与 invalidation 仍正确。按真实调用链报告剩余分配，不把“本项消除重复构造”写成整个 Box 无条件零分配。

#### B3. Footer 缓存会话 usage 统计（上游 0.99.0）

- **问题**：footer **每帧**都执行 `this.session.sessionManager.getEntries()`，而 Super Pi 的 `getEntries()` 是 `this.fileEntries.filter(...)`（`session-manager.ts:1326`），也就是**每帧复制一次整个会话数组**并全量遍历累加 usage，外加一次 `getContextUsage()`。流式输出时帧率高、会话长，这是随会话长度线性增长的每帧 CPU 和内存分配。
- **Super Pi 现状**：`coding-agent/src/modes/interactive/components/footer.ts:92-121`。
- **上游实现**：`getSessionStats()` 以 `(session, sessionId, leafId, entryCount, limitsModel)` 为键缓存结果。entries 是 append-only 的，每次 append 都会移动 leaf，所以这组键足以判定是否变化。
- **适配要点**：
  1. Super Pi 需要新增 `SessionManager.getEntryCount()`（返回 `fileEntries.length - headerCount`，O(1)，不复制）。
  2. Super Pi 的遍历还顺带计算了 `sessionName`（最新的 `session_info`），也要纳入缓存。
  3. `limitsModel` 在 Super Pi 里对应当前模型，以及 provider-aware 路由后的实际模型。
  4. 持久历史聚合与流式实时 usage 分开处理；后者若依赖 delta，不可仅用 entry/leaf 键缓存。模型/路由变化、rename、branch、reload、compaction 的失效基于实际可变来源验证，不先引入通用 revision bus。
- **调用链检查**：定位 footer 与 statusline 的实际生产统计调用；只处理同根因的已确认重复扫描。计数 API 必须与 `getEntries()` 的真实过滤语义相同，不能未经核对就用 `fileEntries.length - 1`；已有廉价计数可直接复用。不扩张为全仓统计框架重构。
- **验收**：5,000/50,000 条目会话下，footer 每帧的数组分配为 0；usage 数值在 append、compaction、branch 导航、切换会话后正确刷新。

#### B4. Markdown 解析结果跨宽度/主题失效复用（上游 0.99.0）

- **问题**：Super Pi 的 `invalidate()` 和 `clearRenderCache()`（`tui/src/components/markdown.ts:436-470`）会清掉全部状态，下一次 `render` 再调用 `lexMarkdown(normalizedText)`（`:513`）重新解析整段 Markdown。token 只取决于源文本，resize 和主题切换并不需要重新解析。长会话里 resize 一次，所有可见或需重排的 Markdown 都要重新 lex。
- **上游实现**：`cachedTokens?: { source, tokens }`，只要源文本不变就复用，跨 invalidate 保留。
- **适配要点（重要）**：Super Pi 在 `lexMarkdown` 里专门修复过 marked 共享 tokenizer 持有最后一棵 token 树的问题（`:251-261` 注释），说明团队很在意 token 树的滞留。所以这里的方案应该是：
  - `invalidate()`（宽度/主题变化）保留 tokens；
  - `[RELEASE_COMPONENT_RENDER_CACHE]` 和 retained transcript 的离屏释放**必须**同时释放 tokens；
  - 和现有 incremental 路径协调：流式追加时 incremental 已经在做部分重解析，缓存键要用 normalizedText，避免误用过期 tokens。
- **验收**：`bench:tui-markdown-incremental-wrap` 和 resize 夹具中 `sourceCharactersReparsed` 在纯宽度变化时为 0；lifecycle 夹具在 release 后 token 引用为 0（与现有 heap slope 断言同一套）。

### P1：启动 / 会话 / 计费 / token

#### C1. `--session <id>` 只读会话头（上游 0.86.0，#9601）

- **Super Pi 现状**：`coding-agent/src/main.ts:268-292` 的 `resolveSessionPath` 和 `findLocalSessionByExactId` 调用 `SessionManager.list()`/`listAll()`，这会加载**全部会话的完整 transcript**，只为比较 id。
- **上游**：`SessionManager.findById()` 只读每个 `.jsonl` 的首行 header。前缀匹配仍然可以回落到 list（或者改成同样只读 header 的前缀扫描）。
- **收益**：会话目录越大收益越高，属于 I/O 和解析量的数量级差异。

#### C2. `--continue` 先按 mtime 排序，找到第一个匹配即停（上游 0.86.0）

- **Super Pi 现状**：`session-manager.ts:653-667` 先对所有文件读 header，再 stat、再排序。
- **上游**：先 stat 排序，然后按顺序读 header，命中 cwd 即返回。通常只需要读 1 个文件头。

#### C3. `--resume` 列表渐进加载与取消（上游 0.86.0）

- 上游 `list/listAll` 接受 `AbortSignal`，选中会话后取消剩余的 transcript 读取，并按 mtime 优先加载。Super Pi 的 `list/listAll`（`session-manager.ts:1671,1686`）没有 signal 参数。
- 和 C1、C2 一起做，是一组"会话 I/O"切片。

#### C4. OpenAI `service_tier: "fast"` 计价（上游 0.99.0，#10034）

- **原评估线索**：`getServiceTierCostMultiplier`（`ai/src/api/openai-responses.ts:386-398`）缺少 `"fast"` 分支，并认为会低估成本。
- **修订门槛**：响应 tier、适用模型与价格来源均需实施时核实；本稿未重新核验实时价格，不能继续把“约低估一半”当成已证实结论。只有证明当前计价规则里 `fast` 与 `priority` 的语义确实相同，才合并分支；否则使用现有模型价格数据或明确未知，不能硬编码猜测的倍数。
- **验收**：请求 tier 与响应实际 tier 的优先级、普通 API 的成本计算、订阅通道的费用展示语义分别覆盖。不要把订阅 token 的 API 等价估价写成实际扣款；无可核验依据时将 C4 标为待证实，不阻塞其他无关项。

#### C5. 按模型配置图片编码参数（上游 0.87.0，`inputLimits.images.resize`，#9631）

- **Super Pi 现状**：`coding-agent/src/utils/image-resize-core.ts:25-28` 对所有模型固定使用 2000×2000 / 4.5 MiB / JPEG 80。
- **收益**：
  - 带宽和延迟：2000px 的图对多数模型都会在服务端再次缩放（例如 Claude 长边上限约 1568），多传的字节和 base64 编码时间都是浪费；
  - token：对按像素计费或分块计费的模型，客户端先缩到模型的原生上限可以避免"服务端缩放规则与预期不一致"带来的计费偏差；
  - 缓存安全：图片**只编码一次**，切换模型不会重写历史图片，保证前缀缓存不因为图片字节变化而失效。
- **适配要点**：接入 `models.json` 的 `modelOverrides[*].inputLimits`（Super Pi 的 `model-config.ts:244` 已有 `modelOverrides` schema，扩展字段即可），在附件、`read` 和工具结果图片三个入口生效；辅助视觉（Auxiliary Vision）路径使用视觉模型自己的 profile。
- **验收**：同一张图在不同 profile 下的输出尺寸和字节数；切换模型后历史图片字节不变（前缀 hash 不漂移，复用 `bench:prefix`）。

#### C6. CLI 打包 + Node compile cache（上游 0.84.3 / 0.86.0）

- **Super Pi 现状**：`coding-agent` 构建为 `tsgo` 非打包输出（`package.json:35`），`dist/cli.js` 启动时会解析大量模块文件；没有 `module.enableCompileCache()`。S5 记录中无扩展 `--help` 约 532 ms，默认资源约 1477 ms。
- **上游**：`scripts/build-coding-agent-bundle.mjs`（esbuild，ESM，`splitting: true`，只保留少数 external），在打包入口里调用 `enableCompileCache()`。
- **建议**：分两步测量。先只加 compile cache（改动小，风险在缓存目录不可写和只读环境，需要 try/catch 并允许 `NODE_DISABLE_COMPILE_CACHE`），测冷启动和热启动；再评估打包（风险在扩展别名、`@super-pi/*` 身份一致性、jiti 路径和 SEA，S5 已经为 built Node 做过别名处理，可以复用）。旧评估里 compile cache 被标为 P1 待测，这里维持该判断，但建议先用本机 10 样本的冷/热启动数据决定。

#### C7. Codex / SSE 解析的分配优化（Super Pi 可以超越上游）

- 原评估指出：每个事件都执行 `buffer = buffer.slice(idx + 2)`，并用 `split("\n").filter().map()` 处理帧，还缺少 `\r\n\r\n` 分隔处理。实施时统计实际 slice/字符串物化与数组分配，不把每次 slice 都直接等同于底层完整复制。
- 这是 provider delta 热路径。候选方案为 `readOffset` 游标扫描、每个 chunk 至多整理一次已消费前缀、`data:` 行直接扫描；游标/decoder/buffer 由单次 stream 所有，不提升为跨请求可变全局。LF/CRLF、分隔符与 UTF-8 跨 chunk、多个 `data:` 行、注释/空帧、EOF 残余和取消在同组夹具参数化。A3 正确性与 C7 优化分 commit，但不复制两套 parser 或测试矩阵。先确认 `bench:stream` 确实覆盖生产 `parseSSE`；未覆盖则最小扩展已有夹具，不拿仅事件分发数据证明解析器优化。

#### C8. RpcClient 监听器变更期间的派发语义（上游 0.99.0，#9990）

- **原评估线索**：`coding-agent/src/modes/rpc/rpc-client.ts:521` 直接遍历 `eventListeners`；上游用快照处理回调中的订阅变更。
- **修订门槛**：先核对实际容器及契约，并用自注销、注销其他监听器、派发期间新增、重入和异常用例判断是否真有漏发/重复发。不能仅凭“迭代期间删除”就宣称当前实现一定跳过下一项。
- **候选方案**：若确认需要派发快照，优先采用订阅/取消订阅这一低频边界的 copy-on-write 或按版本失效的稳定快照，常规派发只读稳定引用。每事件 `[...listeners]`、多层墓碑/压缩状态机都不是默认答案；新增复杂机制必须有重入语义或测量证据支持。
- **验收**：按既有事件契约定义本轮与下轮谁收到事件；原监听顺序、异常投影和清理不变，普通派发新增数组/闭包分配为 0。已等价则只补缺失回归与结论，不强行改实现。

#### C9. `--` 作为选项结束符（上游 0.84.3，#7269）

- `coding-agent/src/cli/args.ts:204` 附近没有 `arg === "--"` 分支。以 `-` 开头的 prompt（例如 `superpi -- "-x 是什么"`）会被当作选项解析。改动很小。

### P1：token 大杠杆（需要设计）

#### D1. Codemode：让模型写脚本批量调用工具（上游 0.99.0）

这是本次上游最大的 **token 杠杆**，也是 Super Pi"低 token 消耗"定位最值得研究的一项。

**机制**：新增一个 `codemode` 工具。模型提交一段 JS，在 QuickJS（WASM，worker 线程）沙箱中运行；沙箱内只能通过 `tools.<name>(args)` 调用其他工具，可以用 `Promise.allSettled` 并行。**只有脚本的输出进入上下文**，中间结果不进入。

**token 为什么省**（机制推断，未测量）：
1. 回合数：例如"读 8 个文件、各 grep 一次、汇总"，普通模式需要多轮往返，每轮都要重发整个上下文（即使有缓存，cache read 也计费，而且会增加延迟）；codemode 一轮完成。
2. 中间结果：脚本可以在沙箱里过滤大输出（例如 bash 返回 1 MiB 的结构化 `output`，脚本只 `text()` 出匹配的 20 行），大结果不进入模型上下文。
3. 工具声明：`codemode.mode: "only"` 时其他工具不向模型声明，只在 codemode 描述里以 TS 声明列出，并受 `codemode.inlineBudget`（默认 3000 估算 token）约束；超出部分由脚本用 `searchTools()`（BM25）或 `describeTool()` 按需查找。工具很多（MCP）时，这比逐个声明 schema 省得多。

**与 Super Pi 的契合点和风险**：

| 关注点 | 上游做法 | Super Pi 需要确认 |
| --- | --- | --- |
| 权限 | 嵌套调用走 `runToolCall(..., beforeToolCall: this._beforeToolCall(ctx, parentId))`（`agent-session.ts:686-720`），**会经过 session hooks** | 资源生命周期守卫、mutation guard、false-success guard、project trust、ask_user 都要能识别 `parentToolCallId`，并在嵌套调用里给出正确的拒绝投影 |
| 审计与 UI | 嵌套调用发出带 `parentToolCallId` 的 `tool_execution_*` 事件；结果消息上记录有界的 `nestedCalls`（最多 256 次、每次参数 8 KiB、总计 32 KiB） | Super Pi 的 tool-execution 渲染、写入完成卡片、Operation Journal、Evidence Ledger 要能挂接子调用 |
| 输出上限 | `max_output_tokens` 默认 10000，超出时保留首尾并写入临时文件 | 与 Super Pi 的 `toolResultPresentation`/`budgetTokens` 和 continuation artifact 统一，不要再造一套截断 |
| 成本 | 嵌套调用的 usage 合并到父结果（0.99.0 修复） | 纳入 session cost 和 `bench:*` 的任务级成本口径 |
| 持久状态 | `store/load` 写入 `codemode-store` 自定义条目，按分支可见 | 可以先不做 |
| 并发 | 顺序执行模式下嵌套调用也串行 | Super Pi 的 MCP 工具强制 sequential，要继承 |
| 依赖 | 新增 QuickJS WASM 依赖 | 走依赖审查；WASM 在 SEA/Bun 下的加载路径要验证 |

**建议分期**：
1. 设计评审：先写一份"嵌套调用经过 Super Pi 策略链"的调用链图，列出每个守卫需要的改动。
2. 最小可用版本：`mode: "on"`（不隐藏已声明的工具），只允许只读工具（`read/grep/find/ls` 和只读 bash），`inlineBudget` 默认值，不做 `store`、分类器和模型调用。
3. 用 `tests/next-phase-cost.test.ts` 这类任务级夹具，对比同一任务在普通模式和 codemode 下的请求数、输入/缓存/输出 token；**有实测收益再扩大到写工具**。

#### D2. 统一工具暴露模型（上游 0.99.0 `exposure`）

- 上游给工具增加了 `exposure: direct | model-only | codemode | deferred | hidden`，外加 `namespace`、`annotations`、`outputSchema/structuredContent`、`prepareLoadout()`、`tool_search`。
- Super Pi 现在有三套相近的机制：`tool-classification` 里的 `tool_search`、`mcp-bridge` 的 `mcp_search_tools`（默认 deferred，每次最多激活 8 个）、Anthropic/OpenAI 的原生 `defer_loading`。
- **建议**：借鉴 `exposure` 枚举作为统一的内部模型，把现有两个搜索工具收敛成一个，并为 D1 铺路。这是内部 API 整理，会影响扩展兼容性，需要单独立项。

#### D3. 工具追加不破坏缓存前缀（上游 0.84.2 / 0.86.0）

- 上游在 OpenAI Responses 上优先使用**消息锚定的 `additional_tools`**：中途激活的工具作为一条 developer 消息追加在对话尾部，而不是改动顶层 `tools`。顶层工具列表不变，前缀缓存就不失效。不支持时退回 `tool_search_call/output` 伪调用。
- Super Pi 的 `mcp_search_tools` 和 `tool_search` 激活工具时，如果改的是顶层 tools（需要确认各 provider 的具体行为），每次激活都会让后续请求的缓存前缀失效。
- **建议**：先用 `bench:prefix` / PrefixManifestRecorder 实测"激活一个 deferred 工具后下一次请求的前缀 hash 是否变化"。如果变化，再评估只在 OpenAI Responses 上引入 `additional_tools`（`ai/src/api/openai-responses-shared.ts` 中上游约 40 行，不依赖 TranscriptContext 也能实现）。

### P2：设计评审或小修（有复现再做）

| 项 | 上游 | Super Pi 现状 | 说明 |
| --- | --- | --- | --- |
| 摘要请求不强制 `toolChoice: "none"` | 0.84.4（#8649、#8638） | `compaction.ts:740` 仍然强制 | 部分 provider 在没有 tools 时拒绝 `tool_choice`，导致压缩失败；需要用 Super Pi 的 provider 矩阵验证后再改 |
| 拆分回合摘要被 Fable 5.1 拒绝 | 0.87.1（#9908） | `compaction.ts:985,1140` 使用旧提示词（"This is the PREFIX of a turn..."） | 上游改为 `# Conversation` / `# Instructions` 分隔加续写导向提示词。如果使用 Fable 5.1 做压缩，这是 P1 |
| agent 级重试退避上限 | 0.86.0 `retry.maxAgentDelayMs`（默认 60s） | `agent-session.ts:4761` `baseDelayMs * 2 ** n` 无上限 | 默认 maxRetries=3 时不会触发；用户调高重试次数时有用 |
| Cloudflare 520 视为可重试 | 0.86.0（#9627） | `ai/src/utils/retry.ts` 没有 `"520"` | 一行 |
| 非 bash 工具遵循 `ctx.cwd` | 0.85.0（#8627） | 只有 `tools/bash.ts:926` 使用 `ctx?.cwd` | 对 subagent/SDK 多 cwd 场景重要；Super Pi 已有 native batch cwd，需要对齐语义 |
| OpenCode 会话头覆盖所有 adapter | 0.86.0（#9326） | 只在部分 adapter 中存在 | 影响 OpenCode 的缓存路由命中率 |
| `provider_stream_event` 观察原始事件 | 0.99.0 | 无 | 调试用，可选 |
| 每条 assistant 记录 `thinkingLevel` | 0.99.0 | 已有同名字段（26 处） | 确认语义一致即可 |
| 虚拟模型 / 分类器路由 | 0.99.0（实验性） | 无 | 按请求路由到便宜或昂贵的模型，是**成本**杠杆，但依赖 Jev 分类器服务，实验阶段，先观望 |
| 全屏 transcript 搜索 | 0.84.2 / 0.85.0 | Super Pi TUI 中不存在（`tui-alt-screen.ts` 没有 search） | 功能项，不是性能项；如果要做，参考上游 `alt-screen-search.ts` 的 ASCII 索引和仅对可见区域高亮 |
| `sanitizeBinaryOutput` 单正则 | 0.99.0 | 单遍 `codePointAt` 循环 | 语义不同（Super Pi 会剔除孤立代理项）；只做微基准比较，不必迁移 |
| 新模型元数据 | 0.87.1 / 0.99.x：Claude Opus 5.5、Sonnet 5.5（1M，自适应思考）、GPT-6 Sol/Luna、GPT-6.1 Sol、Grok 4.7 | 两侧本地源码中都搜不到这些 ID（catalog 数据由 `hydrate:model-data` 拉取，本地都未水化），需要实施时核实 | 走 `generate:models`，不要手改生成文件 |
| TS 7.0 / ES2024 / Node 类型剥离替代 tsx | 0.99.0 | TS 5.9.3 + `@typescript/native-preview` dev 版，ES2022 | 工具链升级，与性能无直接关系；native-preview dev 版有漂移风险，建议择机对齐稳定的 TS 7 |

## 5. 明确不建议吸收

| 上游条目 | 理由 |
| --- | --- |
| Prompt cache 预热（0.86.0） | 后台产生额外付费请求，与"低消耗"目标冲突；旧评估已经明确推迟，这里维持 |
| `/bug` 上报、Radius 上传、崩溃上报（0.86.0） | 远程诊断，Super Pi 不接入 |
| 上游新增的 ChatGPT 全套订阅、账户和云端工作流 | 不整体吸收。GPT/Claude 以正式 API 为主要维护路线；既有 `openai-codex` 保留登录、刷新、请求及远程压缩的有界兼容与安全维护，见 A5。不承诺官方客户端功能对齐，不静默切换计费来源；Anthropic 已禁用的自管订阅 OAuth 不重新启用 |
| `durable` / `chord` / 事务化 Session | 架构替换级 |
| TranscriptContext、canonical SessionManager、ContextEditEntry、`finishTurn` | 见 2.2；R1 已经本地解决 |
| system 主题 / OKLCH 颜色系统 | 纯 UI，而且查询终端调色板会增加启动时的终端往返 |
| 图像生成、llama.cpp 分类器、Meta Muse、Radius 目录 | 与编码助手的核心工作流无关 |

## 6. 本轮范围与实施顺序（修订）

### 6.1 一个新分支、一个新集成 PR，按机制分 commit

| 本轮归属 | 条目 | 执行规则 |
| --- | --- | --- |
| 正确性与已有兼容 | A1–A5、C9 | 逐项核验当前实现；修已复现缺陷，已等价则不重复改；A5 保留现有能力，不扩订阅 |
| 小范围条件修复 | C8、C4 | C8 先证实派发问题；C4 先证实 tier/计价契约，未知不能猜 |
| 热路径候选 | B3 → B1 → B2 → B4；C7 | 语义不变且完成相关结构计数、分配与生命周期证据后纳入；无收益或代价失衡则记录不采用，不为了“完成编号”强改 |
| 本轮暂缓、保留后续评估 | C1–C3、C5、C6、D1–D3、其余 P2 | 不自动纳入本轮，也不让审核阶段以“补全”为由扩张到 codemode、工具暴露统一、打包/工具链或多 provider 新能力 |

建议顺序：确认基线与归属 → A1/A3 → A2/A4 → A5 → C9 与满足条件的 C8/C4 → B3/B1/B2/B4 → C7 → 本地复核与新 PR。A3/C7 同文件串行完成；共享 session、provider 或渲染状态的任务不得并行改同一所有权链。

若 A5 回归实际复现 P2 中摘要参数/提示词造成当前压缩失败，可作为 A5 的直接根因修复并关联原编号；这不是授权无依据重写摘要提示词或扩展整套 provider 能力。A3/C7 共用语料发现的协议正确性缺陷归 A3，不因 C7 性能优化不采用而撤回正确性修复。

暂缓项保留原分析，不代表否定；要进入后续 PR 时重新立范围和验收。最终逐项标记“已修复 / 已等价 / 无收益不采用 / 待证实或阻塞”，禁止默默漏项。正确性阻塞不能用“收益不足”关闭。

### 6.2 性能、闭包与正则的归属契约（新增要求）

先读取 `AGENTS.md`、适用的局部说明及 `docs/performance/hot-path-allocation-contract.md`。审核从生产者、helper、事件桥接、消费者一直覆盖到释放点；把分配移进 helper 不算消除。已有零分配限制、AST 约束和生命周期门槛不得放宽。

| 对象或行为 | 正确归属 / 约束 |
| --- | --- |
| 稳定回调、闭包 | 无状态模块函数，或 owner 生命周期内创建一次的实例回调；正常 delta/frame/progress 派发不新建箭头函数、函数表达式、Promise executor、then/catch/finally/timer 回调或循环内 bind。request/session 生命周期允许的回调须有明确 owner 和释放点，不把它捕获的会话留在全局。低频豁免精确到函数 |
| 固定正则 | 无跨调用状态的静态规则归模块常量；热路径不反复构造 literal/`new RegExp`。`g`/`y` 的 `lastIndex` 是可变状态，不能无条件提升到模块共享；扫描需要状态时归单次操作或明确实例，证明重入/异步安全并管理 reset。动态规则在对应配置/模型生命周期编译，不做无界全局缓存 |
| parser 游标、decoder、缓冲 | 归当前 stream；有界处理已消费前缀和超大尾部，不把请求状态做成共享 scratch，不在每帧/事件用 split/filter/map 链制造中间数组 |
| footer/Markdown/Box 缓存 | 归对应 session 或 component；键覆盖真实依赖，换会话/源文本/主题/模型按各自语义失效。重排失效不等于资源释放；release/dispose 必须断开大文本与 token 树引用 |
| 临时数组与 listener 快照 | 真正 scratch 才能复用；返回调用者/扩展的数组不是 scratch。记录容量、owner、normal/throw/abort/dispose 清理与超大 backing store 的丢弃策略。不可用全局可变数组换取表面零分配 |
| Promise、AbortController、wrapper | 服从已有 normal-frame/delta/progress 零分配门槛；只在已有明确异步或生命周期边界使用，不为每个事件包装 options/signal 对象 |
| 大字符串与对象池 | 不重复物化完整帧/结果、整串 hash 或日志复制。默认不用对象池；只有满足现有契约全部 profiling、容量、释放和量化收益门槛才允许 |

**避免过度防御化**：在外部协议、凭据、持久化和扩展入口做必要校验；内部已建立的不变量不在每层或每次循环重复验证。优先早返回、单一状态来源、复用现有 helper 与真实生命周期；不新造通用重试/健康检查/事件总线/配置体系。不吞错伪装成功、不用宽泛 fallback 掩盖协议错误，也不为了降低代码行数删除必要的配对、权限、错误和清理语义。只清理本轮直接相关的死分支与重复逻辑，不夹带全仓重构、无关格式化和依赖升级。

### 6.3 Opus 与 Codex 的分工和 Git 边界

Opus 在确认当前 `origin/main` 后创建新的实现分支；原工作区有用户改动时使用独立 worktree，不 stash/reset/覆盖。本文只维护一个受控位置，建议 `docs/upstream-pi-0.99.1-diff-assessment.md`；已存在于其他受控位置则原位更新，并在交接中写实际路径，不复制多份计划。

Opus 获得的本轮授权是：同范围源码/测试/必要文档修改、本地验证和小 commit；交接时给出分支、worktree、基线、HEAD、逐项状态和证据，暂不推送或开 PR。Codex 接手同一分支，独立审核完整变更及调用链、补齐同范围遗漏和必要回归，再提交、推送，创建一个以 `main` 为 base 的新 PR；不得复用无关旧 PR、直接推 main、force-push、发布 tag 或自动合并。若本任务已存在对应新 PR，只继续该 PR，不重复创建。

## 7. 验收、测试去重与远端交付（修订）

### 7.1 验证最小化，不降低覆盖

**基线事实**：根 `package.json` 已提供 `test:unit`、`test:hot`、`test:contract`、`test` 与 `verify`；`verify` 为 `check → build:offline → npm test`。统一 runner 默认发现根 `tests/**/*.test.*`，完整/单元入口另运行 memory workspace。只把用例留在 `packages/ai/test` 等包目录，不能证明默认 CI 会执行它。

1. 开始时核对现有 runner/脚本和受影响夹具一次。用 `npm test -- --list` 检查根测试发现结果；不虚构 runner 没有的 `--filter` 参数。优先扩展已有夹具、使用现有 suite；没有选择器就使用已有入口，不为本任务再造一套 runner。
2. 每个修复保留能在修复前失败、修复后通过的最小回归；相同机制用参数化表，语义不同的协议/生命周期用例不能为去重而删掉。正常、失败、abort/dispose 的适用断言复用同一 fixture owner。
3. 开发阶段只跑最小相关 suite/夹具；同一依赖链修改合并跑测。不要每个 commit 都跑全仓，也不要在 `npm run verify` 后无理由再依次跑其全部子命令或重新跑 `test:unit/hot/contract`。
4. 热路径只跑触及链路的源约束、结构/分配和生命周期 benchmark。同一生产基准可服务多个相关项；先确认基准真的覆盖目标，必要时最小扩展，不复制平行 benchmark 或删减现有门槛。性能优化要有可比的同机 baseline/candidate，性能无收益则不采用。
5. 收敛后的本地候选运行一次 `npm run verify`。同 SHA、相同环境与依赖的完整成功证据可以在 Opus/Codex 交接间复用；审核者独立复核关键风险而不是机械重跑全部。后续改动先补跑受影响检查，并为最终候选补齐当前 SHA 的完整门槛证据；旧 head 的绿灯不能充当新 head 通过。

不因为脚本多就删除现有测试文件或调整 CI 覆盖。仅当确认有同等语义的重复执行，才最小去重；不修改快照、阈值、skip 条件或断言去迎合实现。本轮不新建与现有入口等价的 `test:pi099`、`verify:all-again`、独立验收工程或重复 CI 工作流。

### 7.2 本轮最小证据矩阵

| 变更 | 必须保留的证据 |
| --- | --- |
| A1–A4、C9；C8 若修改 | 离线生产调用链回归：未完成工具不执行、工具/结果/自定义消息顺序、SSE 正常与 EOF、首条 user 持久化、参数终止符；C8 另含订阅变更与重入 |
| A5；C4 若修改 | 认证/压缩 contract、失败关闭与不重复发送、脱敏、成功后续接、不同认证/计费路径不串用；C4 的实际契约来源。线上账号 smoke 不属于默认 CI |
| B1–B4 | 同一 TUI 生产夹具的结构计数与 sampled/exact allocations，复用相关 frame/Markdown/retained-lifecycle 基准；分别覆盖宽度语义、Box 背景、footer 失效及 token release |
| C7 | 覆盖真实 parser 的 chunk 语料、结构/分配数据和 stream 结束/abort 释放；不能只报告事件分发耗时 |
| 最终候选 | 当前 SHA 的 `verify` / 远端 Linux 与 Windows CI；新增测试在真实执行日志中可见，不仅存在于磁盘 |

token/成本沿用原口径：同一验收任务的普通请求、失败重试、压缩摘要、续读/辅助调用分别记录未缓存输入、cache read/write、输出和请求数；估算 token、provider usage、费用是不同指标。没有调用或没有计价依据的项标“未测/未知”，不填 0 冒充实测。

热路径沿用原契约：确定性结构计数 + 分配 profile/精确计数 + 适用的 normal/throw/abort/dispose 释放证据。环境只记录一次（基线/候选、Node、CPU、尺寸、样本/配置）；不要为每项复制一份长报告。CI 负责确定性约束，同机 profiling 负责分配/时序对比；不把机器噪声写成跨机器收益保证。

### 7.3 新 PR、`@codex review` 与 CI

本次静态读取的 `.github/workflows/ci.yml` 已在 `pull_request` 和 `main` push 触发，并分别以 PR 的 exact head checkout 跑 Linux/Windows 的 `npm ci → check → build:offline → npm test`。无需为本轮再加一份重复流程；功能分支仅 push 尚不等于该 PR 流程已执行，开 PR 后核实实际运行。

Codex 本地审查与修复收敛后执行：

1. 提交同范围改动、正常推送本任务新分支；核对本地 HEAD、远端分支 SHA 与 PR head 一致。创建/更新本任务唯一的新 PR，正文写范围、暂缓项、主要风险与验证证据，不附凭据或真实会话。
2. 在 PR 评论中使用精确触发词 `@codex review`，附当前 HEAD 与重点：完整生产调用链、工具顺序、认证/计费来源、压缩 failed-closed、热路径闭包/正则/缓存归属和测试发现。先核对对应仓库已连接并允许代码审查；不可用则明确记录阻塞，不反复刷评论或伪造已审。
3. 分别读取该 PR 的 review/comments 与当前 head 的 CI runs/jobs/logs。机器人接受请求、没有留言、CI queued/skipped 都不是“审查通过”。`@codex review` 是代码审查，不代替 CI 或本地正确性回归。
4. 对已返回且可复现的同范围问题追加小修、重新验证并推送。核对反馈实际覆盖的 SHA；最新 head 尚未被覆盖时再请求一次审查，不在同一 SHA 重复触发。反馈存在争议时用当前代码/回归解释，不能为消除评论盲目改契约。
5. 最终报告 PR、分支、完整 HEAD、远端一致性、当前 SHA 两平台 CI 状态/运行链接、review 覆盖 SHA/结论、未解决风险及线上认证是否实测。只在观察到对应证据后标“通过”；权限、额度、时间窗口或执行环境不足时按 pending/blocked 交接，不声称后续会自动完成，也不自动合并。

PR 的 `AGENTS.md` 已要求完整热路径审核。新增正则归属要求如当前规范缺失，可在已有契约中做一处简短补充并链接；不要为本任务复制整份规则或把机械格式检查写成大量审查条款。

## 8. 源码依据（本地路径）

上游（`D:\RMProjects\TempPi\pi\packages`）：
- `coding-agent/CHANGELOG.md`、`ai/CHANGELOG.md`、`agent/CHANGELOG.md`、`tui/CHANGELOG.md`（0.84.1–0.99.1 段）
- `ai/src/api/openai-responses-shared.ts:764-777`（未完成工具调用检查）
- `ai/src/api/openai-codex-responses.ts` `parseSSE`（EOF 残余帧）
- `ai/src/api/openai-responses.ts:386-398`（`fast` 计价）
- `ai/src/utils/retry.ts:41`（520）
- `tui/src/utils.ts:250-266,430-482`（`visibleWidth` 快速路径）
- `tui/src/components/box.ts:100-170`
- `tui/src/components/markdown.ts:249-307`（`cachedTokens`）
- `coding-agent/src/modes/interactive/components/footer.ts:97-157`（`getSessionStats`）
- `coding-agent/src/core/session-manager.ts:749-768`（`findMostRecentSession`）、`:1160-1185`（`_persist`）、`:1874`（`findById`）
- `coding-agent/src/core/agent-session.ts:2225-2270`（`_pendingCustomMessages`）、`:686-720`（嵌套工具调用）
- `coding-agent/src/core/nested-tool-calls.ts`、`coding-agent/src/extensions/codemode/*`、`codemode/src/*`
- `coding-agent/docs/cli.md:145-180`（codemode 与 tool_search）、`coding-agent/docs/models.md:68-99`（inputLimits / promptCache）
- `scripts/build-coding-agent-bundle.mjs`（打包 + `enableCompileCache`）

Super Pi（`D:\RMProjects\Pi\packages`）：
- `ai/src/api/openai-responses-shared.ts:760`、`ai/src/api/openai-codex-responses.ts:826`、`ai/src/api/openai-responses.ts:386`
- `tui/src/utils.ts:60,260-313,469`、`tui/src/components/box.ts:97-152`、`tui/src/components/markdown.ts:251,436-513`
- `coding-agent/src/modes/interactive/components/footer.ts:92-121`
- `coding-agent/src/core/session-manager.ts:653,1040-1063,1326,1671`
- `coding-agent/src/core/agent-session.ts:2922-2955,4761`
- `coding-agent/src/main.ts:260-292`、`coding-agent/src/cli/args.ts:204`、`coding-agent/src/modes/rpc/rpc-client.ts:521`
- `coding-agent/src/core/compaction/compaction.ts:740,985,1140`
- `coding-agent/src/utils/image-resize-core.ts:25-28`
- `plan-mode/src/plan-mode.ts:533`、`plan-mode/src/presentation.ts:80`


### 8.1 补充依据与证据边界

- 本修订使用的固定源码基线：`dragonbaba/super-pi@ef8ac684de2ee46441b2a3deca4a67e4239e1c28`。
- 已读取：根 `AGENTS.md`、`docs/performance/hot-path-allocation-contract.md`、`package.json`、`scripts/test.mjs`、`.github/workflows/ci.yml`。本轮验证与 Git 规则基于这些内容制定，不声称已执行其中命令。
- 前一轮补充读取：`packages/ai/src/auth/oauth/openai-codex.ts`、`packages/ai/src/auth/resolve.ts`、`packages/ai/src/api/openai-codex-responses.ts` 相关区段及 `packages/openai-server-compaction/README.md`。认证代码存在与 README 契约，不等于运行时测试或真实账号有效性证明。
- OpenAI 官方 GitHub review 说明，2026-09-30 读取：`https://developers.openai.com/codex/integrations/github/`（当时重定向至 `https://learn.chatgpt.com/docs/third-party/github`）。只用于核实 `@codex review`、仓库连接/设置及审查不能替代测试；与本项目是否采用 ChatGPT 订阅接入无关。
- v1.1 对 B2、C4、C7、C8 中未实测的性能/计费/容器行为断言作了显式限定，不悄悄当成新事实。C1–C6、D1–D3 和 P2 保留的原始分析不代表本次逐条外部复核；实施前依其各自门槛确认。

## 9. 实施交接记录（由执行者就地维护）

当前状态：Codex 独立审核及同范围修复已完成；按授权交付 Draft PR，完整本地验证受 Windows 测试清理阻塞。远端最终 HEAD、PR、两平台 CI 与 review 状态在 PR 正文及交付回复记录。本节原交接声明保留为历史证据，独立结论见 §9.1。

| 项 | 值 |
| --- | --- |
| 文档 | 本文件 `docs/upstream-pi-0.99.1-diff-assessment.md`（修订稿原位更新，仅此一份） |
| 分支 / worktree | `feat/upstream-0991-absorb` / `D:\RMProjects\Pi-upstream-0991`（主工作区 `D:\RMProjects\Pi` 的用户未跟踪文件未动） |
| 基线 | `ef8ac684de2ee46441b2a3deca4a67e4239e1c28` |
| 已验证代码 HEAD | `09094442ab40042c3172ee7b629e710a99f94d72`（其后只有本节所在的文档 commit，不改源码与测试） |
| 在线状态 | 全部为离线夹具（`SP_OFFLINE=1`、注入 fetch、合成哨兵秘密）；**账号在线有效性未实测** |

状态口径：**已修复**（有先失败的最小回归，且已运行通过）；**已等价**（现有实现已满足，本轮补回归或静态核对并注明）；**无收益不采用**（已测量，改动已撤回）；**待证实/阻塞**；**暂缓**。

| 切片 | 状态 | 实现/验证证据或不采用原因 |
| --- | --- | --- |
| A1 未完成工具调用 | 已修复 | `58561b934`、`f1e74e840`：`openai-responses-shared.ts` 在任一调用仍持有 scratch 缓冲时拒绝终态 toolUse；Codex SSE 共用 `processResponsesStream`，改为报告错误结果。`tests/provider-contract/responses-terminal-tool-calls.contract.test.ts`：缺 `output_index`/未 done 的函数与自定义调用被拒，已完成调用保留，截断响应仍走 length，Agent 不执行未完成调用 |
| A2 自定义消息顺序 | 已修复 | `643189cf8`、`f1e74e840`：流式期间 `triggerTurn:false` 的消息排队，在 turn_end、settle 或下一次 prompt 前写入，写入历史前不发事件。`tests/custom-message-ordering.test.ts`：工具调用期间发送的消息落在本轮之后；abort 后恰好释放一次；空闲时立即写入。上游附带的 `getQueuedMessages` 改动在 Super Pi 无对应 API，N/A |
| A3 Codex SSE 残余帧 / CRLF | 已修复 | EOF：`f5a53829a`，读到 done 时先 flush decoder、补帧结束再解析，截断的残余帧报 `Invalid Codex SSE JSON`。CRLF：`53fda4afc`，与 C7 共用的语料发现 CRLF 流会被缓存到 EOF 后当成一帧解析失败（先失败 4 例），按 §6 归入 A3 单独修复。夹具 `tests/helpers/responses-sse-fixture.ts`，回归 `tests/provider-contract/codex-sse-framing.contract.test.ts`（LF/CRLF × 有/无结尾空行 × 整块/3 字节分片） |
| A4 首条用户消息落盘 | 已修复 | `9cdd2f21f`：存在 user 或 assistant 消息即创建会话文件，只在未 flush 时检查，分支会话同规则；保留原子首写。`tests/session-first-user-persistence.test.ts`：仅 setup 的会话不留文件；首条 user 在 assistant 回复前落盘；只含 user 的分支按新对话写入。进程内夹具，不据此声称断电持久性 |
| A5-a 认证与诊断 | 已修复 + 已等价 | 已修复 `7d666f1de`：token/设备码错误不再回显原始响应、token、授权码或 JSON.parse 消息，只报告状态、校验过的 OAuth 错误码和缺失字段名。已等价（补回归）：临近过期在请求边界只刷新一次并使用新 token；刷新失败 fail-closed，不回退环境 key，保留凭据，秘密被脱敏。`tests/provider-contract/openai-codex-auth-diagnostics.contract.test.ts`（合成哨兵秘密） |
| A5-b 压缩边界 | 已等价（补回归） | `dee4836c4`：只有输出前明确的 400/404（`compaction_trigger`/`remote_compaction_v2`）才回退一次 unary；通用 400、401/403/429/5xx、畸形/不完整流、输出后错误和 abort 都不再发送；unary 也失败时不重试；v2 成功只发一次请求并保留 opaque item；GPT 认证失败返回 `{ cancel: true }` 和纯枚举遥测；非 GPT 保持默认回退。`tests/provider-contract/openai-remote-compaction-fallback.contract.test.ts`。continuation/opaque 状态在会话切换、模型、端点或身份变化时的失效只做了静态阅读，未加运行时回归；摘要 `toolChoice`/提示词未复现（P2），未改 |
| C9 `--` 终止符 | 已修复 | `07e848aa2`：`--` 之后都视为消息或 @file，启动时的 `--offline` 预扫描不再匹配其后参数，`--help` 已补说明。`tests/cli-args-terminator.test.ts` |
| C8 RpcClient 派发 | 已修复（已复现） | 先复现：监听器在派发中取消订阅会 splice 活数组，导致下一个监听器漏掉该事件；派发中新增的监听器会收到正在派发的事件。`2518020b1`：订阅/退订时写时复制，派发时对捕获的数组用下标循环，得到快照语义且不按事件复制。`tests/rpc-client-dispatch.test.ts`：自退订、重入派发、1000 次稳态派发数组身份不变，并做结构检查（`handleLine` 无 spread/slice/filter/map） |
| C4 Fast service tier | 已修复（依据已核实） | 依据：OpenAI 官方定价页 <https://developers.openai.com/api/docs/pricing>（2026-07-30 起 Priority processing 更名 Fast mode：标准价 2×，gpt-5.5 为 2.5×）；上游 issue <https://github.com/earendil-works/pi/issues/10034>。`d9bfbba91`：Responses 与 Codex 倍率把 `"fast"` 按 priority 计价，档位优先级不变（有上报档位就用上报的，没有才用请求档位）。`tests/provider-contract/openai-service-tier-pricing.contract.test.ts`，2 API × 8 例。**待证实（未改）**：上游 #3307 的 Codex `"default"` 档位覆盖行为；Codex 订阅费用仍是按 API 价换算的估算值 |
| B3 Footer 会话扫描 | 已采用 | `0cfc8062d`：按 (sessionManager, sessionId, leafId, entryCount) 缓存 usage 合计、缓存命中率和会话名（新增 O(1) `SessionManager.getEntryCount()`）；`setSession`/`dispose` 时释放，上下文用量仍每帧读取。采样分配：1k 条目每次渲染约 26µs/43KB，10k 约 138µs/323KB，改后稳态约 8–10µs/约 6KB，与历史长度无关。`tests/footer-session-scan.test.ts`（100 帧 1 次扫描；追加、改名、切换能刷新；释放）；`tests/alpha-footer-scans.test.ts` 更新为未变历史只复制 1 次 |
| B1 `visibleWidth` ASCII+ANSI 快速路径 | 无收益不采用 | 微基准：缓存命中（200 行）9ns → 快速路径约 400ns（回退）；未命中（2000 行）8.7µs/8.8KB → 约 350ns/0B。生产基准无改善：`bench:tui-frame-allocations --fixture production-main` 7024 → 7008/6995 B/frame；`bench:tui-transcript --cpu-only --full-history` p50 在噪声内（约 3.9–4.0ms 对 3.8–4.0ms）；`bench:tui-retained-lifecycle` meanMs 2990/2962 对 3000/2954。生产行宽测量基本都命中缓存，已撤回 |
| B2 Box 未填充行缓存比较 | 无收益不采用 | 微基准（40 行保留子组件）：约 3.7µs/约 5.4KB → 约 0.25µs/约 544B/帧。生产基准无差异：`bench:tui-frame-allocations` 6998.6 对 6997.9 B/frame；`bench:tui-paced-tool-leaf` 四类 B/delivery 两轮都在噪声内（如 generic 38456/39051 对 38628/38810），CPU p50 持平。原因：TUI 已有保留式身份缓存，稳态帧不重渲染未变的 Box；工具进度帧内容每次都变。已撤回 |
| B4 Markdown token 复用 | 无收益不采用（代价失衡） | 实现后测量：仅宽度变化的重渲染 CPU 降 44–49%（1.7K/6.9K/27.7K 字符：0.284/1.035/4.117ms → 0.159/0.559/2.117ms）。但完成的 `RetainedItem` 会在整个会话期间持有内部组件，每个已渲染的 Markdown 保留堆约翻倍（200 个约 1.4K 字符的组件：6.51MB → 12.93MB，每个 32.5KB → 64.6KB）；`RELEASE_COMPONENT_RENDER_CACHE` 只在最终卸载时触发。收益只在少见的 resize/主题切换且仅限视口内的项，代价是全会话常驻堆，已撤回。若以后要做，需要一个只覆盖视口的 token 所有权状态，属新设计 |
| C7 Codex SSE 解析分配 | 已采用 | `09094442a`（与 A3 分 commit、共用夹具与 parser）：游标逐行扫描 LF/CRLF，按帧累积 data 行，每次读取最多压缩一次已消费前缀；游标、残余和待处理 data 都是单个 stream 的局部状态。`bench:stream` 不覆盖 `parseSSE`，改用生产 `streamCodex` + 注入 fetch 的采样堆剖析（2000 个文本 delta）：LF 1KiB 读取 2377 → 1838 B/delta（`parseSSE` 1434 → 898），CRLF 2655 → 1844（1714 → 905），每个 stream CPU 约 19.8 → 13.3ms（1KiB）、约 18.5 → 11.6ms（16KiB）；split/filter/map/join/trim/replace 分配归零，剩下的是 JSON.parse 输出、payload 切片和 decode。回归：同一 framing 文件新增注释、event/id/retry、空帧、多行 data、`[DONE]` × LF/CRLF × 1/5/4096 字节读取；abort 中途取消并释放响应 body（cancel 1 次、锁释放）；结构检查 |
| C1–C3/C5/C6/D1–D3/其余 P2 | 暂缓 | 按 §6.1 未动；未顺带做 codemode、统一工具暴露、打包或工具链升级 |

**已执行检查（基于 `09094442a`）**

- 开发期只跑相关检查：各切片的单文件 `node --test`、`npx tsgo --noEmit`（通过）；`tests/provider-contract/*.test.ts` 共 122/122 通过（C7 后）。
- `npm test -- --list`：新增或修改的 11 个回归文件都被根入口发现（footer-session-scan、alpha-footer-scans、cli-args-terminator、custom-message-ordering、rpc-client-dispatch、session-first-user-persistence，以及 provider-contract 下的 codex-sse-framing、openai-codex-auth-diagnostics、openai-remote-compaction-fallback、openai-service-tier-pricing、responses-terminal-tool-calls）。
- `npm run verify` 一次（约 4m12s），**退出码 1**：`tsgo --noEmit` 与 `build:offline` 通过；`npm test` 在字母序第 93 个文件 `native-file-metadata.test.ts` 失败并停止（runner 遇到失败即停），此前 92 个文件退出码 0（1354 个用例通过）。失败的 2 例是 `N2 Windows denied content-write ACL…` 和 `N2 Windows parent FILE_ADD_FILE denial…`，都期望 ACL 拒绝导致写入失败；本机以提权 Administrator 运行，在基线 `ef8ac684d` 上单独运行同一文件也是 34 通过 2 失败，与本分支无关（本分支不触及 native 文件代码）。
- 因 runner 在上述失败处停止，其余 110 个入口（109 个文件 + `@super-pi/memory` workspace）用临时驱动逐个运行，参数、环境与隔离目录与 `scripts/test.mjs` 的 runChild 相同，只去掉遇错即停：1533 个用例通过，1 个失败。失败的是 `native-source-delivery.test.ts` 的打包用例：本机 npm 的 `pack --workspace --json` 输出以包名为键的对象而非数组，`JSON.parse(stdout)[0]` 为 undefined；基线上结果相同，属既有工具链差异。
- 未运行：真实账号请求、CI、远端 review。

**Opus 交接时未解决 / 待证实（独立复核更新见 §9.1）**

- 账号在线有效性未实测（认证、普通请求、远程压缩与续接都只有离线夹具）。
- C4：上游 #3307 的 Codex `"default"` 档位覆盖行为待证实，未改。
- A5-b：continuation/opaque 状态失效只做了静态阅读，没有运行时回归。
- `npm run verify` 在本机的两处失败（提权下的 ACL 拒绝用例、npm `pack --json` 输出形状）与基线一致，需要在非提权环境或 CI 中确认。
- B4：若以后要采用，需要先设计只覆盖视口的 token 所有权，不在本轮范围。

交接只需追加：实际文档路径、工作分支/worktree、基线和当前 HEAD、逐项状态、已执行命令/结果、性能证据位置及阻塞。最终远端 SHA、PR/review/CI 链接以 PR 正文和交付回复记录，避免为了回填自身最终 commit SHA 再生成一个未经验证的新 head。

### 9.1 Codex 独立审核与追加修复

接手时 worktree 干净，分支及完整 HEAD 与交接一致；远端无此分支/PR。核实 `09094442a..f094febb6` 仅修改本文件。审核覆盖固定基线至候选的全部生产改动及其调用链，没有重写 Opus commits；主工作区用户文件未处理。以下结论不沿用“已修复/已等价”的交接断言。

| 项 | 独立结果及证据 |
| --- | --- |
| A1/A3/C9/C8 | 保留实现。Responses/Codex → shared processor → Agent 的实际执行回归：正常 toolUse 恰好执行一次；缺 done/error/abort 不执行；length 保留原有失败工具结果后继续的语义。SSE 原 LF/CRLF、跨 chunk/UTF-8、EOF、多 data 行、畸形/取消语料保留。CLI 启动预扫描与 @file/消息终止符保留。RPC 外层快照、重入、顺序、原异常语义、取消订阅释放通过，稳态不复制订阅数组。 |
| A2 | 复现旧实现 state/持久化有自定义消息、Agent 独立 context 的下一次请求却没有。追加同步及 FIFO 重入排空修复；断言下一次真实 payload、工具结果先于 custom、恰好一次；另补请求失败 settle、abort、实际 runtime replacement 的会话归属及两个 pending 容器释放。 |
| A4 | 新增明确 IPC 同步后的跨进程杀写入者/重开回归；只终止本测试的确切 ChildProcess，不正常关闭来触发额外落盘。验证首条 user 可恢复、尚无 assistant，复用已有空会话/原子首写夹具。此证据不证明断电持久性。 |
| A5-b | `openai-compaction-lifecycle.contract.test.ts` 38 项生产 Session/SDK/认证/压缩/传输离线回归。修复 API 请求预览缺失与同模型 Responses 文本 item identity 丢失；以请求边界的 provider/API/端点/身份/路由头摘要限定 opaque 复用，Codex 同身份正常 token 轮换兼容；普通请求与压缩实际复用认证 resolver 刷新/锁，非 delta 凭据读取。覆盖成功压缩后下一次真实 payload/次数/磁盘历史，refresh、resume、switch、fork/tree 前后、模型/端点/身份及返回兼容环境；legacy 无 scope 使用可移植本地历史。临时 live continuation 与持久 opaque 分开失效。 |
| A5 追加真实问题 | Codex WS 缓存未核对 URL；直接 API WS 忽略配置路径/有效路由头；跨模型/身份往返时后续本地回复丢失；一实例 shutdown 清除其他会话的 opaque 状态。均有先失败回归和最小修复。后续本地回复保留为可移植历史，跨身份私有 reasoning/item 签名不复用，重开会话也验证。清理限定于 owner 的会话；不清除持久历史。GPT 远程失败及必需可移植摘要失败断言 failed-closed、无成功 entry、旧历史留存及失败后的下一请求；非 GPT 原本地回退保留。 |
| C4 | 核实目录 Standard 价格 → calculateCost（含长上下文 tier）→ served service_tier 单次倍率 → footer。公开 API 实际 default 优先于请求 fast/priority，未采用 #3307 的猜测覆盖。官方 Fast 文档证实别名及 GPT-5.6 Sol 当前 Standard 4/20、长上下文 8/30 美元/百万 input/output、Fast 2x；修正此模型两通道目录/生成器及 Codex 旧 2.5x，并补直接 API WS Fast 别名遗漏。订阅显示为 `(API est., sub)`，不表示实际扣款。GPT-5.4/5.5 Standard 价格核对官方模型页；5.5 既有倍率保留，未声称此次外部重新证明其所有档位。 |
| B3 | 保留收益；修正 count 与 getEntries 对重复 id/多 header 的过滤口径，O(1) 计数；增加仅属 manager 的 reload generation，覆盖同 id/leaf/count 的重载。追加/rename/branch/compaction/session switch/dispose 均验证。历史汇总没有模型依赖；实时 context usage 单独读取，没有 revision bus。 |
| B1/B2/B4 与暂缓项 | 基线到候选的 `packages/tui` 无变更，撤回干净，不重新优化；C1–C3/C5/C6/D1–D3/其余 P2 保持暂缓。 |

审核调用链：SDK/provider 请求构建及 auth resolver → extension request/header hooks → streamCodex/Responses WS → parseSSE/mapCodexEvents/processResponsesStream → EventStream → Agent/AgentSession → persistence/next-turn context；RPC JSONL → handleLine → listeners；Interactive render → Footer → SessionManager/getSessionScan → usage totals/排版。新增 scope 计算只在请求/压缩边界，缓存归 session/manager/component，稳定回调沿既有 owner 生命周期，无新 delta 闭包、Promise、AbortController、包装数组、全局 scratch、无界 capability cache 或对象池。保留既有异步 read/yield/EventStream 边界及其分配，未宣称整条流或 footer 零分配。

必要证据保存在本 worktree 的忽略目录 `.artifacts/upstream-0991-audit/`，未提交第二套 runner 或新报告：

- `final-contract.log`：根 contract runner 13 文件/174 通过；`final-hot.log`：根 AST/source 7 文件/38 通过；`final-affected.log`：根 `run()` 的 7 个受影响入口及 memory workspace，37 通过。临时选择入口只 import 原文件，复用原 runChild 的 cwd、HOME/USERPROFILE/XDG/SP 隔离、Node/GC 参数及 fail-fast；测试目录与 memory 仍由原 runner 管理。新增文件由 `test-list.log` 的根发现入口列出。`final-check.log`、`final-build.log` 通过。
- `final-verify.log`：`9c6477c6a` 候选 `verify` **退出 1**，check/build 通过，72 文件退出 0，LSP junction 清理 ENOTEMPTY 后停止；其后的可移植尾部/owner 修复用 check、contract、hot 校验，没有循环重跑已诊断的环境失败。Opus 的 `verify` 退出 1 保持原口径，原临时补跑驱动/原始性能日志未取得，不能独立确认其全部配置声明。
- `baseline-acl.log`：同 Node v26.4.0/npm 12.0.1、提权 Administrator 的基线独立回归 37 通过/21 平台 skip，两条 ACL 拒绝均通过；不能把“提权导致”当已证明根因。`remainder-configured-bash.log` 中当前候选的 native-file-metadata 与 native-source-delivery 也退出 0。`baseline-pack.log`、`pack-output.json` 及本地 npm 12 pack/logTar 源证明已知按包名索引对象格式；最小测试边界适配限定 npm 12，并严格校验唯一目标、版本/产物/所需文件及离线 installed runtime，单独提交，没有未知格式 fallback。
- `baseline-lsp.log` 与 `final-verify.log` 独立复现同位置 ENOTEMPTY，精确根因未证明，未改 LSP/权限断言。补跑原先因 Git Bash 不在 PATH 失败；仅为该子进程加已有 `D:\Git\bin` 后推进至另一既有 junction 清理失败（read-evidence-result-boundaries）。`remainder*.log` 是部分补充证据，不是全通过；机器级设置/全局工具链未改。剩余完整验证由当前 HEAD 的适用 CI 检查。
- `profile.jsonl`：同机 Intel i7-14700KF/Node v26.4.0、5 warmup/30 stream 样本，**生产 streamCodex + 注入 fetch 的离线夹具**。C7 基线为含 A3 的 `53fda4afc`，候选 parser 与 `9c6477c6a` 相同（之后只改计价/压缩扩展，不改 parser）。双方 2000 delta/2004 events/最终 2000 字符且正常结束；LF 1/16 KiB sampled B/delta 3065→2481、2944→2402；CRLF 3245→2482、3120→2426。p50 10.16→7.27、8.50→6.32、9.90→7.10、9.17→6.32 ms。parser 逐帧 split/filter/map/join/CRLF replace 为 0，buffer/data 清理先于 await cancel。 |
- 同一 profile 的 B3 基线 `0cfc8062d^`，1000/10000 条历史、300 frames，基线每次扫描/复制，候选 warm 后扫描/复制 0；采样每 frame 41.3/245.6 KB→11.2/8.8 KB，仍含 footer 排版分配。`lifecycle.jsonl`：C8 100000 events/1000000 deliveries，baseline/candidate 104.9→64.0 B/event，派发数组复制 1→0、退订后 listener 0；C7 normal/error/abort 5 MiB 未读夹具 cancel 1、reader unlock、受控 GC 后 chunk/body/response WeakRef 全释放。`parser-consumer.json` 对同生产 parseSSE 仅加测试 export，验证消费者 return 后 parser/大 chunk/body/response 释放；外层 EventStream 的提前退出仍需调用方 abort，不能等同于它自动取消上游，通用语义未在本 PR 重写。
- `frame-profile.json`：现有 production-main 分配基准 2000 frames，frame Promise/AbortController/wrapper/full-size copies 均 0，frame string 1/frame，dispose 后 retained/composition reference 0。B1/B2/B4 原测量结论保留，但未把未取得的原始日志当独立验证。

认证诊断追加：`auth-code-before.log` 复现字符形状合法的合成秘密仍能经 error/code 字段泄漏到 message/stack；改为模块级已知 OAuth/设备授权错误码集合，未知码仅保留 HTTP 状态。两条新增边界回归通过，不改变刷新锁、账户选择或 delta 路径。

验收收尾追加：定点核对本 PR 的生产消费者发现 `Agent.streamAssistantResponse → processEvents → publishAwaited` 的监听器异常会退出消费，但 `runWithLifecycle` 原异常收尾未取消已启动的 provider；`finishRun` 随后释放 activeRun，失去请求 owner。`consumer-owner-before.log` 的实际 Codex SSE 夹具先失败（signal 未 abort）。最小修复在 run owner 的 catch 中 abort 原 controller，再按 abort 前的状态记录原错误；不改 EventStream、正常 delta 路径或事件异常传播策略。新增根 contract 用例断言 reader cancel 恰好一次、锁释放、producer aborted、Agent 原 error 分类及下一次请求正常完成。请求放弃的既有边界为 `AgentSession.abort → Agent.abort`；会话替换/最终释放为 `AgentSessionRuntime.performSessionTeardown → session.abort/等待 idle → session.dispose`，已有 `custom-message-ordering` runtime replacement 与 `alpha-lifecycle` 回归复用。`consumer-owner-contract.log` 13 文件/175 通过，`consumer-owner-hot.log` 38 通过，`consumer-owner-affected.log` 3 相关根入口加 memory workspace 共 21 通过，`consumer-owner-check.log`/`consumer-owner-build.log` 通过。正常调用链的闭包/正则/缓存归属及分配不变，既有性能与受控 GC 证据继续有效；仅追加异常 owner 取消证据，不重新运行全量性能实验。交接 HEAD 的 Windows CI 已结束且读取日志，新增回归、两项 ACL 拒绝、pack 及 junction 路径实际执行成功；新代码 HEAD 的两平台 CI 单独在 PR 正文记录，不复用旧 HEAD 绿灯。

价格依据（2026-09-30）：[官方 Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)、[价格页](https://developers.openai.com/api/docs/pricing)、[GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)、[GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5)。API 等价估价与实际订阅扣款分开；Codex #3307 仍待证实。**在线有效性未实测**，没有用离线夹具替代真实账号结论。

资源清理限制：自动审批检查拒绝对本任务记录的两个 ENOTEMPTY 临时目录和本地 pack 产物执行清理（仅返回 blocked by policy）；保留这些记录，没有绕过。最终远端结果只回填 PR 正文与回复，避免文档 SHA 循环。

定点追修（#53，2026-09-30）：按用户保留的两项组合指令单独复现，不以 #54 的性能交付或 CI 关闭它们。真实 ModelRuntime → SDK header hooks → Responses/Codex transport 夹具证实：成功压缩后的 idle/工具期间排队 custom 消息未进入 opaque replay；最终 Project header 改变后 API 仍复用旧 response id，Codex 仍发送不兼容 opaque。custom append 现在在原 turn_end/settle/next-prompt 边界等待同一 extension message_end，再将最终对象落盘并通知 session 订阅者；不重复事件或落盘。排空已消费的位置先推进，hook 失败仍落盘，settle 的 finally 释放 active/idle 所有权；idle hook 等待期间替换会话的回归断言只写旧 manager、不串新会话。Responses/Codex 和直接 API WS/HTTP fallback 将本次已解析的 auth、端点及 header transforms 结果沿原 onPayload 传给 before_provider_request，不重新读取 registry 代替 dispatch 快照，也不重复执行 header hooks。native Codex compactor 返回瞬时有效 auth，扩展只持久化 scope digest；ChatGPT-Account-Id 按 transport 的 token 最终覆盖行为计算，而非按无效 header override 判定。普通同身份 token 轮换兼容性保留。

新增根生命周期回归共 14 项，原 38 项合计 52：实际 outgoing payload/header、请求次数、tool result 在 custom 前、哨兵恰好一次、Agent context 和重开后的持久条目一致；Project/Organization 注入/变更/删除、模型默认 header 删除/恢复、token-owned Codex account header、单次有效 credential lookup、异步 custom owner 替换均通过。`.artifacts/targeted-followup/before.log` 保存修复前失败；`affected-final.log` 复用根 runner 的 5 文件及 memory 共 76 项；`contract-final.log`、`hot.log`、`check-final.log`、`build-final.log` 记录受影响验证。新增等待属于 custom/turn/request 边界，不在 delta/render 路径创建函数、正则、Promise 或扫描完整历史；原 C7/parser、frame 与受控 GC 证据复用。完整 HEAD、最终两平台 CI 及远端审查状态只更新原 PR 正文；#54 由其 owner 正常同步本追修，不在两分支独立复制修复。原本地 verify 退出 1、未证明的 junction 清理根因、远端额度阻塞及在线有效性未实测结论继续保留。
