# 工具失败恢复与快照编辑：修复与验证记录

日期：2026-09-16。仓库：`dragonbaba/super-pi`。

- 分支：`fix/tool-recovery-edit-ux`
- 工作目录：`D:/RMProjects/Pi-tool-recovery-edit-ux`，独立 Git worktree。
- 基础：本次 fetch 后的 `origin/main`，`35928231f335d938d6603cf4cdcea423e4466f90`。
- 原工作区的未跟踪计划文件留在原处。截至下述验证完成时尚未 commit、push 或创建 PR；后续提交与审查记录见 Git/GitHub。本任务没有 merge、stash、reset 或清理已有分支。
- 环境：Windows x64，Node `v26.4.0`；依赖用锁文件执行 `npm ci --ignore-scripts` 安装。

## 已证实的机制和修复

| 项目 | 当前源码/fixture 证据 | 修改 |
| --- | --- | --- |
| Shell | 循环与管道两种 Chrome 结构，当前检查器首个拒绝均为 executable 位置的 `$CHROME`。此前多个原因共用包含 heredoc 建议的字符串。 | 在原拒绝分支产生简短原因；保持判定次序与所有拒绝条件。动态数据参数不变成动态执行器错误。修正为字面量仍须当前授权。 |
| 参数 | JSON salvage 的 WeakSet 标记与 schema 校验原本分开。Responses 收尾存在空输入兜底 `{}`，会丢失参数未形成的事实。 | 删除这个兜底，保留合法分片收尾；不增加 delta 解析。分别输出 `TOOL_ARGS_INCOMPLETE`、`TOOL_ARGS_INVALID`；确认输出上限的整响应拒绝保留原语义。 |
| 顶层 snapshot | `SNAPSHOT_REQUIRED` 的触发是 LINE#ID 字段存在、但顶层 snapshot 不是字符串；并未查询读取证据的新鲜度。 | 指导补入已收到的配套顶层 ID，仅在不可用、过期或范围不足时重读；补充内部模式缺字段与混用提示。 |
| 模型读取视图 | 原投影按字符保留头尾，可以截断源码行；终端 discovery 本来就在 UI，不能把它当成模型收到的文本。 | 已验证的 read 输出携带有界布局提示；保留完整前缀行、完整配套元信息及其前后注释。放不下完整行时使用明确的整段省略视图；连恢复提示也放不下才阻断请求。折叠 UI 不再重复 continuation/artifact 状态。 |
| 语法拒绝 | `.js/.mjs/.cjs` 明确使用 JS ScriptKind；解析器来自宿主固定 TypeScript；原有门禁按诊断代码/消息计数比较前后。 | 保留这些语义。失败时将 UTF-16 诊断偏移映射到既有 UTF-8 编辑记录；能确定时报告零基 `edits[i].newLines[j]`，不确定则不归因。 |
| 合并编辑 | 已有最多 20 个操作、字节限制、重叠检查、单文件原子替换与成功后旧快照失效。 | 精炼既有说明，包含同一绑定的声明与已知引用。fixture 一次修改声明、引用、标签和重复计算，验证结果与调用次数；未实现第二套批量机制。 |

仅凭用户日志无法确认其具体 JS 语法缺陷，也无法确认那一次 read 的实际 provider 输入。本轮复现的是命令结构和最小源码/编辑 fixture；没有访问用户 Chrome、没有执行日志命令，没有断言用户文件缺少反引号或被误按 TSX 解析。

## 反馈示例

```text
[SHELL_DYNAMIC_EXECUTABLE] This Bash call was not executed: executable position uses a variable or dynamic expression ($CHROME).
Retry: use the quoted literal executable path in a foreground command; resubmit for authorization.

[TOOL_ARGS_INCOMPLETE] edit was not executed: arguments were incomplete when the response ended.
Retry: re-issue only this tool call with complete JSON arguments.

[TOOL_ARGS_INVALID] "edit" was not executed: validation failed.
  - "/": Supply required fields "path".
Retry: correct the listed fields using the active tool schema.

[SNAPSHOT_REQUIRED] Missing top-level "snapshot" for LINE#ID edits (not inside edits[0]). No change.
Retry: copy the snapshot ID paired with these anchors from the completed read. Read again only if that snapshot is unavailable, stale, or does not cover the target.
```

错误分类与遥测兼容旧前缀和新增代码，保留现有持久化类别。参数未完成有单独的 cause，不被遥测记为已确认的 schema 失败。错误不回显完整命令、参数或 provider 响应。

## 生产调用链审查

1. Shell：注册 Bash → `ExtensionRunner` preflight → lifecycle 原始扫描分支 → permission controller → final authorization consume/release → Bash backend。拒绝不调用 backend，晚到的参数/权限变化仍被最终检查拒绝。
2. 参数：Chat/Responses provider 分片 → `parseStreamingJson` → 收尾解析/标记 → Agent `prepareToolCall` 或确认 length 的拒绝边界 → schema 校验 → 工具执行/结果事件 → 最终 UI。原有每 delta 的累计参数解析和流式 UI 能力保留；本次没有增加一次 delta 解析、全文扫描或响应副本。
3. read：原生专用 read → `issueSnapshotForRead` 验证稳定文件与原生可见输出一致 → LINE#ID 和注释 → tool-result hook/持久化 canonical content → `ToolResultPresentationOwner` 扫描与有界投影 → `convertToLlm`/模型投影 → provider wire 编码；UI 使用独立 presentation sidecar。测试同时检查宿主最终 context 和实际序列化 Chat 请求。
4. 投影：`scanSource` → `projectLegacyContent` → `buildProjection` → 边界定位 → modelContent；continuation 使用同一 source/cursor/digest 和边界定位；清理沿 `release`、`clearProjectionRecords`、`dispose`。
5. UI：provider/Agent 事件 → coalesced dispatcher → AgentSession → InteractiveMode → ToolExecutionComponent → retained viewport/render。最终参数未完成状态只增加 primitive 状态位和失败标题；正常增量路径不构造这个标题。
6. 编辑：单文件队列 → receipt 路径/身份/内容检查 → 已有 full/compact byte edits → before/after parse diagnostics → 原子替换前再次身份/hash 校验 → readback → 失效/释放。诊断映射复用最多 20 个既有 byte edit 对象；额外文本偏移转换只发生在失败路径。语法检查结束通过 `finally` 释放 byte edit 引用。

`readBoundary` 仅表示 canonical 文本块按完整行或完整元信息裁剪，不是快照凭据、签名或授权。只在实际 read 快照签发成功后由生产方标注，不扫描任意正文中的 `[Snapshot edit]` 来授予权限。布局提示进入既有 source identity 校验；provider wire 不包含此字段。receipt 的原生读取范围、存储上限和新鲜度检查没有扩大或伪造。旧版本历史文本没有这种布局提示，不会因此恢复当前可写权限。

## 验证命令

均从本 worktree 执行；使用项目现有 Node test runner 约定。

```powershell
npm run check
npm run build:offline

node --experimental-strip-types --test tests/mutation-contract-recovery.test.ts tests/tool-lifecycle-postmerge.test.ts tests/tool-recovery-shell.test.ts tests/tool-reliability-recovery.test.ts tests/bash-heredoc-binding.test.ts tests/provider-contract/tool-argument-recovery.contract.test.ts tests/provider-contract/openai-custom-tool-generation.contract.test.ts tests/provider-contract/streamed-tool-argument-ownership.contract.test.ts

$testFiles = @(rg --files tests | Where-Object { $_ -match '(tool-result-.*|tool-token-estimator-source-invariants|stream-hot-paths|agent-stream-coalescing|alpha-upstream-truncation|tui-real-hot-paths|tui-hot-paths|tui-frame-hot-paths|source-invariants)\.test\.ts$' })
node --experimental-strip-types --test --test-concurrency=1 @testFiles

node --experimental-strip-types --test tests/tool-reliability-recovery.test.ts tests/tool-result-contextual-budget-source-invariants.test.ts
npm run bench:tool-result-budgeted-model-view
npm run bench:tui-tool-leaf-allocations
npm run bench:tui-paced-streamed-tool-args
git diff --check
```

相关回归包括：两个 Chrome 结构、字面量/动态参数区分、preflight 零进程和拒绝授权；真实 provider 分片与空参数收尾、兄弟调用不重放；顶层 snapshot 补参无需重读、错配/过期/外部修改/提交前竞态、失败保留快照、成功后旧快照拒绝；整行投影、超长行、预算不足、历史续读、伪造快照正文不能签发；JS 模板、级联诊断、诊断基线、BOM/CRLF/中文/非 BMP、EOF 自动分隔换行与主动空行；原子批量及针对性运行结果验证。

首轮结果：核心回归 8 文件，160 项全部通过；广泛投影/流式/TUI 回归 22 文件，175 项，174 通过、1 项 measurement child 按设计跳过、0 失败。补充解析器不可用的错误分类断言后，分类与投影 source invariants 的 48 项全部通过。静态检查、离线构建和 diff 检查通过。复审收尾的新增验证见下文，并非全仓所有平台测试。

## 分配与生命周期观测

以下是首轮修复时 Windows 本机、基础提交加当时未提交 diff 的观测值；复审后的新测量单列在下文。不是纯 main 基准，也不是线上模型成本或改进百分比。

- 投影完整 AST 不变量：0 arrow/function expression、0 Promise/AbortController、0 新 Set/WeakMap、0 全结果序列化/全文复制/临时行数组；仍只有原有 session 投影 Map。新增 read 分支只在原 SourceScan 对象增加两个整数，不增加全局存储或对象池。
- 快照裁剪专项：16 个记录，16 次源估算扫描、16 次 digest、48 个有界投影数组；清理后 record/保留字符数为 0，受控 GC 后 owner/model 数组弱引用为 0。该专项用 HeapProfiler 1024-byte sampling，并设固定投影分配上限。
- `tool-result-budgeted-model-view`：7 种 direct fixture 全部在预算内。64 KiB / 1 MiB / 10 MiB 输入的采样分配分别为 8167.6 / 8290.8 / 6958.4 bytes/result。无完整字符串副本或临时行数组。8 次受控 GC 的 heap slope 为 14 bytes/cycle；所有 presentation/model/UI/source/provider clone 弱引用为 0；clear 后 entries/code units 为 0。
- `tui-tool-leaf-allocations`：每种 fixture 20,000 次更新。generic/built-in/custom/image 采样分别约 839.35 / 778.45 / 1025.83 / 1355.38 bytes/update；builtInPromises、schedulerPendingTasks 为 0。原有 built-in/custom renderer 的 render-context 和 wrapper 分配仍存在，未把它们声称为零；本改动不增加正常路径的此类分配。
- `tui-paced-streamed-tool-args`：10 场景各 20,000 次更新。普通 5 场景采样约 2070–2716 bytes/raw update；cardinality 压力场景仍有约 1.39–2.47 MB/raw update 的现有大参数快照/序列化/排版分配，未声称已解决。各场景 metadata HWM 为 1–16，flush 后 metadata、pendingKeys、schedulerPendingTasks、builtInPromises 均为 0；内联 closure、Promise tail/array 不变量为 0。
- 真实 Agent/extension 恢复 fixture 另外验证成功、拒绝、abort、disposal 后 pending calls/final authorization 和 owner 引用释放。没有新增池或缓存。

测试中的旧文案长度观测采用 JS `string.length`（UTF-16 code units）和 `cl100k_base` fixture tokenization，不等于当前模型实际 token 计费。本次没有模型回放，不能据此声称一次恢复成功率、批量选择率或任务 token 成本提高。

## 读取投影复审收尾（同一分支、同一工作目录）

本次只处理元信息位置与预算失败恢复链。没有重新建分支，没有修改 agent loop 的闭包/事件分配、通用 TUI 性能、权限或模型配置；之前的源码改动全部保留。用户描述的 Node 测试期间滚动卡顿未作性能归因，也未声称已解决。

### 复现、修复与边界

- **位置问题已复现**：使用真实 `estimateToolOutputTokens` 计算，完整第一行、恢复 notice、配套元信息及短注释需要 218 estimated tokens，测试预算为 250。原来的 `[lines, metadata, note]` 抛出预算不足；`[lines, note, metadata]` 丢弃短注释；没有注释的对照通过。这不是容量不足。
- `scanSource` 在既有扫描对象中记录前缀/后缀文本长度两个整数，`projectLegacyContent` 按源码块后整个真实后缀保留元信息及前后注释。`requireReadProjection` 的最小回退不再要求元信息处于最后一块。测试额外强制密度估算舍掉可容纳的第一行，验证最小完整行回退确实执行。
- cursor 沿用原有区间编码；测试逐块续读到结束，将已投影前缀与遗漏源码拼回原文，验证没有缺口、重复或注释误入遗漏范围。元信息位置改变仍改变 source identity，旧 cursor 拒绝该变化；估算与截断计数一致。没有改动 receipt 可写范围。
- 续读可能只返回配对中的元信息块；交付时复用 `stripMcpSources` 剥离 canonical 布局标记，避免后续投影把历史半对布局误判为新的原生 read。实际 API 的末尾 chunk 进入 SDK 离线请求的回归通过；此测试明确构造历史 tool/result 对，不声称运行了一个新的注册续读工具。历史元信息文本仍可保留，但不会签发新快照。
- 布局要求一个源码行块、其后一个配套元信息块。普通文本可位于元信息前后；缺失、重复、颠倒布局提示使用现有异常类型的 `invalid-read-layout` 子码。宿主保留 canonical 成功状态，用户收到布局原因，不冒充 token 不足。该异常子码不改变持久化工具状态或新增授权。
- **历史阻断已复现**：真实 SDK、read 和 tool-result hook 产生含 12,000 字符首行的读取。修复前后续 provider 请求在转换阶段被挡住，只形成最初 1 个请求，无法到达计划的短范围补读；单独短范围 read 的对照原本可以形成 2 个请求。
- 修复复用 `buildFullOmissionProjection`、原 cursor/artifact 与记录存储。若不能保留完整行及配套信息，但能放下恢复提示，返回明确的 `Read output omitted: budget ...` 模型视图，**不含 snapshot ID、LINE#ID 或源代码**。canonical 内容、执行状态和文件不变；历史重投影与上下文分摊共用该路径。
- 新的恢复 fixture 实际形成“首次 read → 省略提示 → offset=2/limit=1 的 read → 正常后续请求”，共 3 个离线 provider 请求、2 次真实 read。旧结果仍完整持久化；重新打开保存的会话后第 4 个请求成功形成，没有第 3 次 read。这是脚本化离线恢复链，不是模型自主选择能力评估。

| 失败/交付边界 | 实际接收方和已验证的恢复 |
| --- | --- |
| 成功结果交付，512-token 预算放不下超长行 | UI 事件仍是读取成功、canonical 完整；模型得到整段省略提示，随后短范围补读可达。 |
| 最低预算 1，连恢复 notice 也放不下 | 宿主交付并保存读取成功；下一请求在发送前停止，用户的 assistant error 事件包含 read 原因、offset/limit 条件与增加预算动作。模型没有收到该失败请求。 |
| 同一旧结果留在历史，预算仍为 1 | 再次用户请求仍阻断，但不会自动循环、重放 read 或改变文件。调整 SDK presentation 配置为 512 并恢复保存的会话后，新请求及短范围补读成功。 |
| 两个独立 read，256 的同轮预算分为 128 | 两次读取均完成；request-preparation 的 result-batch-budget 包装保留底层 `Read budget 128` 和恢复动作。调整容量并恢复会话后请求形成，调用数仍为 2。 |
| 两个独立 read，512 的同轮预算分为 256 | 两份省略提示可发送，总工具输出估算不超过 512；结果顺序及成功状态保留。 |
| 实际转换 envelope 只剩 128 context tokens | 生产 coordinator 产生 context-headroom 错误，用户收到具体 read 原因；恢复 context 容量后请求形成，旧 read 未重复。测试没有注入假异常。 |
| SDK 包装历史投影错误 | 保留最多 600 UTF-16 code units 的底层原因；不会只剩通用“调整预算”。受测完整错误小于 1,400 code units。 |

若 layout hook 已产生无效的持久化布局，该内容不会被自动迁移或伪装成预算错误；这是宿主集成故障，需要修复 hook 及受影响的历史布局。本轮测试验证其原因与成功状态交付，不声称单纯增加预算能修复布局。

### 实际源码复核

重新读取完整 diff 和对应实现，而非仅引用首轮报告：Responses 收尾确实移除了空串到 `{}` 的兜底，合法分片/最终 scratch 释放由 provider contract 测试验证；语法映射复用已排序 byte edits，失败路径 UTF-16→UTF-8 转换，BOM/CRLF/中文/非 BMP 和 EOF separator 的测试通过；布局标注只在稳定 native-read 投影匹配后签发，真实 SDK hook 验证元信息与尾注的实际顺序；UI 参数未完成标题和模型/UI 分离回归通过。这些文件本轮没有另作功能改动。

本轮生产修改位置为 `tool-result-presentation.ts`、`sdk.ts`、`agent-session.ts`；新增 `tests/tool-result-read-recovery.test.ts`，并把旧的“超长行必须抛错”测试改为检查明确省略、零锚点与原有续读边界，未删除安全断言。

### 本轮执行与性能证据

```powershell
node --experimental-strip-types --test tests/tool-result-read-recovery.test.ts
node --experimental-strip-types --test tests/tool-result-read-recovery.test.ts tests/mutation-contract-recovery.test.ts tests/tool-result-presentation-source-invariants.test.ts tests/tool-result-contextual-budget-source-invariants.test.ts
# 另执行上文完整 8 文件核心命令及广泛回归的 rg 文件选择命令。
npm run check
npm run build:offline
npm run bench:tool-result-budgeted-model-view
npm run bench:tool-result-contextual-budget
git diff --check
```

- 新增专项最终 **15/15 通过**；专项与两份 source invariants 的组合 **24/24 通过**。最终广泛回归 23 文件 **190 项，189 通过、1 项按设计跳过、0 失败**，包含全部新增专项。重新执行首轮完整核心命令 **160/160 通过**。静态检查与离线构建通过。
- 生产调用链：native read → 快照签发 → tool-result hooks → AgentSession canonical 交付/保存与 presentation → SDK convertToLlm → 历史/当前轮投影分摊 → 离线 Chat wire；续读和 artifact 经原 identity 验证，记录在 clear/dispose 释放。常规结果投影只在既有 SourceScan 增加两个数值字段，不增加对象、闭包、Promise、全文复制或存储层。续读边界若返回完整带标记块，既有剥离函数会创建一个有界外层数组和对应文本块封装，复用文本字符串；没有复制源码。原有投影数组、记录和封装对象仍存在，不声称正常路径零分配。
- 新的混合注释/整段省略分配专项：16 source scans、16 digests、48 resident history hits、8 个历史 continuation chunks、72 个有界投影数组；最新采样投影站点合计 **122,168 bytes**（HeapProfiler 1024-byte sampling）。clear 后 entries/保留字符数为 0，受控 GC 后受测 owner、presentation、model/provider/continuation 数组引用为 0。失败分支有界分配不等于每个正常结果零分配。
- `tool-result-budgeted-model-view` 的 7 类结果均在 1024 预算内；tiny / 64 KiB / 1 MiB / 10 MiB / 多块 / 文本图片 / ANSI 的最终采样为 **4512.8 / 7857.2 / 7604 / 7068.4 / 9149.2 / 9164.4 / 4747.2 bytes/result**。1 MiB 样本主要站点为 buildProjection、createCursor、createScanState。8 次 GC slope 为 **14 bytes/cycle**，所有受测 presentation/model/UI/source/provider clone 弱引用为 0，clear 后记录与字符数为 0。
- `tool-result-contextual-budget` 对 1/2/4/8 个结果分别观测到 25/50/100/200 次 projection passes；每类 20 次测量的最终采样合计 **117,128 / 272,976 / 655,512 / 1,336,624 bytes**，最大总输出为 **1023 / 1024 / 1022 / 1024 estimated tokens**。协调器 HWM=1，结束后 active=0；clear 后记录、字符数及弱引用为 0，12 次 GC slope 约 **−74.24 bytes/cycle**。
- AST/source invariants 通过：新增 closure、Promise/AbortController、全结果序列化/复制、临时行数组、新 Map/Set/对象池均为 0。采样值相对首轮有波动，本轮没有实施通用性能优化，也没有据此声称分配总量或 CPU 时延下降。

## 限制

- 没有复现用户私有源文件的具体语法根因，没有真实启动浏览器或调用在线 provider。
- 不执行类型检查来保证编辑语义；批量 fixture 的引用/行为由针对性运行验证，语法门禁仍只比较 parse diagnostics。
- 不自动补参数、选择最近快照、重新授权、合并独立请求或重放批次。测试证明工具协议可正确恢复，不证明模型一定选择该恢复动作。
- 历史 continuation/artifact 只读历史结果；需要新编辑证据时仍走新的专用 read 和当前身份/内容校验。compact 快照签发适用性沿用现有 native-read 一致性条件。
