# Pi 历史修复补漏：详细任务与实施规范

状态：**H00–H05（含 H02-A/B）已合并；H06 已完成本地验收，H07–H10 待实施。** 用户已授权按顺序创建独立 PR，首次推送后等待 reviewer，每次后续推送单独 `@codex review`；当前最终 head 审查无未处理意见且 CI 全部通过后可合并，并按精确身份删除两端旧分支。下文待办和验收条件不代表已经实施或通过；规划阶段的历史记录保留在 §9，H00 执行记录见 §10，各实现项记录见下表。

日期：2026-11-04，Asia/Tokyo。任务前缀使用 **H**，避免与上一轮 T01–T12、F01–F06 混淆。后续每项先更新自己的设计和证据，再动生产代码。

## 1. 基线、范围与证据口径

| 项目 | 本轮固定事实 |
| --- | --- |
| 本地基线 | `b2c42768ff46d68bc847f151884737644848ce17`，分支 main；包含上一轮最后一个修复 PR [#197](https://github.com/dragonbaba/super-pi/pull/197) |
| 本地交付状态 | T01–T12 已合并；基线包含一个尚未推送的补丁文件清理提交。实施前重新检查工作区、分支和远端状态，不覆盖用户改动 |
| 派生起点 | Pi v0.84.1；本项目包版本独立，不按版本号差值整体覆盖上游 |
| 上游稳定版 | [v1.5.0](https://github.com/earendil-works/pi/releases/tag/v1.5.0)，`f9a26365568127461c47a07a37dcb42c140a3ac5` |
| 上游未发布快照 | `676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d`；main 后续变化不自动混入本轮结论 |
| 执行环境 | Windows / PowerShell，当前 Node **v26.13.0**；只验证当前 Node 26，不安装或测试 Node 22/24，也不改变 engines 声明来代替兼容性判断 |
| 已有记录 | [1.0 对照](upstream-pi-1.0.0-diff-assessment.md)、[1.1 任务记录](upstream-pi-1.1.0-task-plan.md)、[1.5 实施记录](upstream-pi-1.5.0-implementation-plan.md) |

历史稳定版清单共 22 个：

- v0.84.2、v0.84.3、v0.84.4。
- v0.85.0、v0.85.1、v0.86.0、v0.86.1、v0.87.0、v0.87.1。
- v0.99.0、v0.99.1、v0.99.2。
- v1.0.0、v1.0.1、v1.0.2、v1.0.3、v1.0.4、v1.1.0。
- v1.2.0、v1.3.0、v1.4.0、v1.5.0。

六个重点包为 coding-agent、ai、agent、tui、mcp、codemode；某包在某版尚未存在时标为不适用，不能算漏查。发布记录引用的跨包修复去重，但保留每个来源到本地行为的映射。范围覆盖不等于已经逐提交完成语义审计，H00 负责补足逐项可追踪清单。

证据分级：

- **R：本地运行观察。** 必须说明是生产函数、隔离 CLI，还是完整集成；不能把函数夹具写成真实 provider/终端验收。
- **S：源码确认。** 已定位明确旧行为，仍需在实施前建立失败回归。
- **V：待验证。** 有相关上游修复，但尚未证明本地存在同一问题。
- **E：已有实现或等效行为。** 给出本地源码、测试或合并记录；不重复移植。
- **F：功能选择。** 不作为缺陷自动实施。

## 2. 任务清单与顺序

默认顺序：**H00 → H01 → H02 → H03 → H04 → H05 → H06 → H07 → H08 → H09 → H10**。H02 如被定向验证排除，记录证据后继续；H00 新发现的独立问题追加编号，先写方案再插入适当顺序，不塞进正在审查的 PR。

| ID | 任务 | 上游来源 | 证据 | 初始状态 / 优先级 |
| --- | --- | --- | --- | --- |
| H00 | 建立历史版本逐项映射与遗漏清单 | v0.84.2–v1.5.0、固定未发布快照 | [清单](evidence/pi-history-followup-inventory.json)；V 保持待验证 | 已交付 #198；清理受阻见 §10 |
| H01 | RPC 空闲 shutdown 主动完成关闭 | 未发布 | R：隔离 CLI；[实施与合并记录](repairs/pi-history-h01-rpc-idle-shutdown.md) | 已合并 #199；缓存清理受阻 |
| H02 | RPC/print 重复关闭共享清理完成点 | 未发布 | A/B：真实 CLI 失败基线；[RPC 记录](repairs/pi-history-h02a-rpc-overlap-shutdown.md)、[print 记录](repairs/pi-history-h02b-print-overlap-shutdown.md) | 已合并 #200/#201；临时缓存清理受阻 |
| H03 | print 最终输出截断返回非零状态 | v1.2.0 | R：真实 CLI；[实施记录](repairs/pi-history-h03-print-length.md) | 已合并 #202；临时缓存清理受阻 |
| H04 | 跨模型历史不把 thinking 转为正文 | v1.3.0 | R：生产函数、实际 SDK 请求、分配/释放；[实施记录](repairs/pi-history-h04-thinking-history.md) | 已合并 #203；缓存清理受阻 |
| H05 | Anthropic 非 strict 工具保留 schema 根定义 | 未发布 | R：SDK、确定性分配/释放；[实施记录](repairs/pi-history-h05-anthropic-schema-definitions.md) | 已合并 #204；缓存清理受阻 |
| H06 | split-turn 压缩接收用户指令 | v1.4.0 | R：SDK/AgentSession、分配/释放；[实施记录](repairs/pi-history-h06-compaction-instructions.md) | 已实施，待审查 / P1 |
| H07 | 内置 grep 隔离 RIPGREP_CONFIG_PATH | v1.4.0 | S | 待失败回归 / P1 |
| H08 | grep 上下文避免整文件加载 | 未发布 | S | 待基线与完整链审计 / P1 |
| H09 | 提示模板保留空引号参数 | v1.3.0 | R：生产函数 | 待复现固化 / P2 |
| H10 | SDK streamProxy 工具参数增量解析 | v1.5.0 | S；上一轮明确范围外 | 待基线与完整链审计 / P2 |

每项状态只按真实证据推进：`待验证 → 设计就绪 → 实施中 → 待审查 → 待合并 → 已交付`。另有 `已排除`，必须记录原因和覆盖边界。设计就绪的最低条件是：根因、失败输入、实际调用链、改动范围、性能性质、资源所有者及验收命令均明确。

## 3. 代码规范

1. **以当前调用者需求为边界。** 优先修改已有函数和类型；不为单个修复新增通用执行框架、第二套关闭状态机、全局缓存、预留配置项或无消费者的抽象。
2. **输入在所属边界校验一次。** 外部配置、RPC/provider 数据、工具参数的必要检查应落在入口；内部使用已建立的事实。授权和写入前必要的状态复核保留，不逐层重复 schema parse、序列化、类型探测或 filesystem 身份查询。
3. **失败保持真实含义。** 取消、未执行、执行失败、输出截断和部分成功不能混为成功。禁止 catch 后返回空对象/空串、换 provider、换目录、改权限、改认证来源，或重放有副作用的操作。
4. **不增加推测性兜底。** 新重试、备用解析器、自动降级和兼容分支必须对应已复现故障或明确协议要求，写清触发条件、次数、owner 和退出点；本计划默认不引入这些机制。
5. **保留本地能力。** 不回退项目信任、Windows Sandbox、工具准入、认证来源、会话持久化、历史投影、用量记录及取消语义；不能为照搬上游而改变本地成本策略。
6. **明确数据所有权。** 不修改调用方持有的原消息/schema，不让 mutable scratch 泄漏到扩展或消费者；资源状态由已有 owner 管理，生命周期内创建、退出时释放。
7. **保持类型和对象形状。** 使用已有类型及可判别联合；不以新增 `any`、非空断言堆叠或类型强转掩盖协议差异。可选引用以 `undefined` 释放，不用 `delete` 改变热对象形状。
8. **处理当前问题，不顺手重构。** 不批量格式化、全仓重命名、升级无关依赖、扩展 API 或改写历史记录。完整链审计发现相关旧成本时，明确纳入本项或独立拆项，不藏在 helper 中。
9. **测试可观察行为。** 优先真实公开入口、真实 parser/stream 和离线协议 fixture；只替换网络、计时或故障注入边界。禁止仅重写一遍实现作测试、重复相同矩阵，或用跳过失败代替诊断。
10. **注释说明原因与约束。** 记录协议、所有权、取消时序和性能边界，不写重复代码表面行为的注释。

每个 PR 必须说明：保留的必要校验、避免或移除的重复校验、错误如何传递、新增状态为何必要、哪些本地行为需要保持。

## 4. 性能规范与硬门禁

本节服从现行 [Hot-path allocation contract](performance/hot-path-allocation-contract.md)。编码前重新阅读契约；这里是任务验收映射，不能替代完整契约，也不能为本轮修改降低门禁。

### 4.1 完整生产链

对 provider delta、消息/工具进度、事件交付、交互更新、布局/渲染、终端帧、大结果处理和 Evidence Ledger 查询，必须从生产者审计到完成、失败、取消、clear/dispose 的释放边界。既有 helper、SDK 适配、订阅者和消费者都在范围内。

H04/H05/H06 涉及历史或请求数据，须记录真实输入规模和重复调用位置；不能因为“每请求一次”就免除大结果处理审计。H01/H02 的关闭状态属于低频生命周期，但对普通事件/进度增加的判断或包装仍按热路径计数。H07/H08 需确认工具在宿主、Sandbox、注入 operations 各入口的实际路由，不能只测试孤立 helper。

### 4.2 数值和所有权要求

| 项目 | 必须满足 |
| --- | --- |
| 高频回调 | 常规 frame/delta/progress 内 inline arrow/function、Promise executor、then/catch/finally 回调、逐事件 timer 回调、循环 bind 均为 0；稳定回调随 owner 创建一次 |
| 异步分配 | 常规 frame/provider-delta/tool-progress 每次 Promise、AbortController、signal/options wrapper、Promise tail/数组均为 0 |
| 低频例外 | 只点名实际启动、停止、fatal cleanup、显式命令、切换和生命周期 deadline 函数；禁止整类/整文件豁免 |
| 临时容器 | 不逐更新创建包装对象、spread、Object.assign、Map/Set；必要数组/scratch 明确容量、owner、每个退出点及超大 backing store 丢弃条件 |
| 数据处理 | 不逐 delta 重解析累计完整参数，不重复扫描/复制完整历史或大结果，不对超长单行生成无界行数组 |
| 终端帧 | active write ≤ 1；pending latest ≤ 1；queue high-water ≤ 2；每帧完整物化 ≤ 1；应用层完整副本 = 0；每 busy cycle shared deferred ≤ 1 |
| 背压 | 物理 write 的 callback 与 drain 完成条件保留；逻辑取消不能提前释放物理 writer 所有权，迟到回调不能完成新代次 |
| 事件链 | Agent latest observer → AgentSession → 内置 InteractiveMode 的常规交付保持同步；不逐事件创建 rejection observer 或 async 包装 |
| 引用释放 | 成功、错误、取消、清空、dispose 后验证字符串、容器、监听器、timer 和 waiter 的释放；不能只清一个状态标志 |

完整调用链已有的协议事件、实际交付时的隔离快照等成本必须单独计量和说明，不能把“没有新增分配”写成“整条链零分配”，也不能为压低数字删除对外必要的隔离和通知语义。

默认不引入对象池。确需例外时先有 profiler 证据，并满足契约全部所有权、容量、重入、异常、取消、双重释放和引用清空条件；采样分配至少下降 20%、CPU p95 回退不超过 5%、最终堆增长不超过 10%。禁止池化消息、事件、工具结果、provider payload、Promise、字符串及契约禁止的跨异步对象。

### 4.3 三类必需证据

每个热路径任务同时提交：

1. **确定性结构计数**：每 delta/事件的扫描字符数、parse 次数、Promise/wrapper/数组数，或 active/pending 引用及队列深度。
2. **allocation profile 或精确分配计数**：记录采样方式、主要分配栈、输入规模和单位成本。性能计数 hook 与计时/profile 分开采集。
3. **生命周期证据**：受控 GC、引用计数/WeakRef 或 owner 释放观察；保持必要的长寿命 owner 存活，证明不是把整个程序退出误当成清理成功。

同机、同 Node、同 fixture，对照固定基线与候选源码哈希；基准串行运行，不与构建/测试争抢资源。计时或一次 heap delta 不能替代三类证据。未测量就记录待验证，不宣称提速或降低内存。

## 5. 独立临时目录规范

### 5.1 目录与作用域

统一使用仓库内独立根目录：

```text
<repository>/.task-tmp/<task-id>-<unique-id>/
  resources.json
  logs/
  downloads/
  profiles/
  fixtures/
```

上述子目录按实际需要创建，不预建空目录树。`.task-tmp` 已加入根 `.gitignore`。每次任务/运行用唯一子目录，不复用上个任务的临时根；正常 Git 管理文件不受影响，但**禁止把任务日志、探针、下载、性能采样、fixture 或清理清单放进 .git**。

启动测试、构建或子进程前，只在该子进程的环境中将 `TMP`、`TEMP`、`TMPDIR` 指向本任务根；先验证该子进程的 `os.tmpdir()` 确实落在此处。需要隔离 home/agentDir 时也放在本任务根，沿用现有测试隔离能力，不读取真实凭据。

不得修改系统/用户永久环境变量，不重设 `HOME`/`CODEX_HOME` 等变量作为脚本工作变量。使用 `taskRoot` 等专用变量。现有 `removeOwnedFixture()` 要求 fixture 为当前 `os.tmpdir()` 的直接子目录，故应在子进程启动前设置临时环境，沿用其所有权约束，不删除该断言或改造为任意目录删除器。

### 5.2 资源登记

创建资源即登记，至少包含：

- task ID、仓库绝对路径、任务根绝对路径、创建时间，以及本任务是否创建了共享父目录。
- 创建的文件/子目录、外部资源的精确路径及用途；符号链接/junction 单独登记链接和目标，目标默认不归本任务所有。
- 子进程 PID、启动时间或其他可复核身份、命令用途、退出状态；不能仅凭进程名终止。
- 清理状态和失败原因。不把 token、auth 文件内容、真实用户配置或完整私密会话写入清单。

子进程通过现有 fixture/runner 登记其资源，不为本计划新增通用后台清理服务。需要等待审核时，只保留仍有用途的材料，不因等待而保留已可释放的进程或大采样文件。

### 5.3 保存正式证据后清理

1. 将必要命令、源码哈希、基线/候选计数、结果、限制和 PR/CI 链接写入任务记录或 `docs/evidence/`。大日志/heap profile 默认不提交；必要原始证据精确筛选、去敏后再保留。
2. 等待本任务子进程退出，关闭持有的文件、流、timer、监听器和测试服务。
3. 在删除动作前重新验证登记的绝对路径仍位于当前仓库的 `.task-tmp` 内，检查实际父目录和 reparse/link 边界。目录内链接仅删除链接本身，不沿链接删除外部目标。
4. 按清单删除本任务资源，最后删除本任务根；共享 `.task-tmp` 仅在本任务创建且已为空时删除。禁止通配清理别的任务目录、广泛扫描 Temp、`git clean` 或按猜测杀进程。
5. 验证登记路径已不存在、没有自有进程遗留、Git diff/status 只包含预期交付文件。只有验证后才能记录已清理。
6. 若工具策略拦截，保留清单和未清理资源，报告精确路径及原始原因；不切换 shell/API 绕过，不重复询问已给出的许可，不把失败记为成功。

历史遗留的系统 Temp 目录不因本规则自动转为本任务所有，也不搬迁到新目录后绕过策略删除。独立目录解决后续归属与清理方式，**不保证任何删除操作自动获批**。

## 6. 各任务实施细则

### H00：历史版本映射

- **目标**：让每个候选能追溯到版本、包、发布条目/提交、本地源码、既有 PR 和当前结论。
- **交付**：按需创建 `docs/evidence/pi-history-followup-inventory.json`，字段包含稳定 ID、来源版本/包/固定 ref、来源 URL、本地入口、R/S/V/E/F、证据说明、对应任务、排除原因及核对日期。不把同一跨包修复计算成多个缺陷。
- **方法**：先核对 0.84.2–1.1.0 的既有吸收证据，再补 1.2–1.5 未映射项；未发布内容独立分组。历史文档或 .git 原始日志已不在工作区时，使用真实 Git 历史、PR/CI 和当前源码核实，不编造缺失证据。
- **验收**：22 个版本均有覆盖状态；六包条目完成分类或明确待验证；E 有本地依据，F 有范围理由。不能仅凭关键字命中、文档勾选或“以前做过”关闭条目。
- **边界**：本轮不因目录/依赖/模型元数据变化自动升级全仓。H00 是审计任务，不在其中夹带生产修复。

### H01：RPC 空闲关闭

- **入口与链路**：扩展 `ctx.shutdown()` → [rpc-mode.ts](../packages/coding-agent/src/modes/rpc/rpc-mode.ts) 的 shutdown handler → runtimeHost dispose → session/MCP/子进程释放 → 输出结束/进程退出。
- **已观察**：隔离 CLI 的 stdin 保持打开时，调用 shutdown 后 750 ms 进程仍在；随后发送 get_state，出现 shutdown 事件并退出 0。这是历史探针观察，不把 750 ms 设为产品关闭期限。
- **最小方案**：在现有关闭 owner 上让空闲 shutdown 主动进入关闭流程；运行中的关闭仍遵循当前活动任务取消/收尾语义。复用现有 owner，不加轮询、固定 sleep 或额外 shutdown 框架。
- **验收**：stdin 打开且不再发送命令时能退出；活动运行关闭无重复事件/重复 dispose；扩展关闭错误按既有规则传播；没有调用真实 provider。
- **性能/释放**：生命周期入口可创建一次必要状态；普通 RPC 命令和 agent 事件不新增逐次 Promise/闭包。记录 dispose 次数、shutdown 事件数及自有 timer/listener/child 清零。
- **来源**：[上游 #11599](https://github.com/earendil-works/pi/issues/11599)。

### H02：重复关闭不提前退出

- **证据边界**：RPC 正在关闭时的再次调用会走快速退出；print 的 disposed 标志在异步 dispose 完成前设置。源码有风险，尚未复现 EOF/信号交叠截断清理，不能预写“已丢失凭据”之类结果。
- **入口与链路**：RPC stdin EOF/信号/扩展关闭，以及 [print-mode.ts](../packages/coding-agent/src/modes/print-mode.ts) 信号关闭 → 现有 runtimeHost dispose → 最终退出。
- **先验证**：使用可控的 dispose 完成闸门，在真实进程上触发重复关闭；按平台支持验证 EOF/信号组合，避免用 Windows 的强制终止假装 POSIX 信号语义。
- **最小方案**：仅在复现后，让同一 owner 的重复关闭等待同一个完成点；dispose 一次、最终退出一次。清理失败和首次退出原因按先行设计明确，不引入每次关闭的新 Promise tail 或无限等待重试。
- **拆分**：RPC 和 print 若共享根因与 owner 可在一个 PR 验收；若各自需独立实现，拆为 H02-A/B，不能以“都叫 shutdown”为由合并不相关改动。
- **验收**：重复请求不能提前跳过未完成清理，清理 rejection 不成为未处理异常；成功/失败/重复/取消路径释放引用。未复现则记录 E 或排除，不做推测性防御。
- **来源**：[固定快照 coding-agent changelog](https://github.com/earendil-works/pi/blob/676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d/packages/coding-agent/CHANGELOG.md)。

### H03：print 截断退出状态

- **入口**：[runPrintMode](../packages/coding-agent/src/modes/print-mode.ts) 的最终 assistant 状态判定；生产函数夹具已经观察到 length 返回 0。
- **最小方案**：保留已生成文本到 stdout，向 stderr 输出明确截断说明，并返回非零退出状态。正常 stop 和现有 error/aborted 行为保持一致，不新增自动续写或重试。
- **先行决定**：核对 text 与 JSON 模式的现有协议及上游修复范围；JSON 事件不得混入纯文本警告。若拟改变 JSON 的退出码，先单列兼容性结论再实施。
- **验收**：length/stop/error/aborted 最小矩阵；至少一个使用离线 fake provider 的 CLI 端到端例子验证实际进程退出码，不能仅断言函数返回值；dispose 仍恰好一次。
- **性能**：最终态低频分支，不额外拼接完整回答，不增加流式输出阶段的扫描/包装。
- **来源**：[上游 #10799](https://github.com/earendil-works/pi/issues/10799)，v1.2.0。

### H04：跨模型 thinking 处理

- **入口与链路**：请求历史 → [transform-messages.ts](../packages/ai/src/api/transform-messages.ts) → provider payload；核对同一转换是否也服务摘要、重放和 SDK。
- **已观察**：生产 transformMessages 将另一模型的 thinking 变成 text，与最终回答并列进入目标上下文。
- **最小方案**：沿用已有模型身份判定，对跨模型 thinking 做省略，不把它降格为正文；保留同模型的合法 thinking/signature replay 及既有 redacted 规则。原始会话历史和用量不改写。
- **验收**：同/不同模型、不同 provider/API、签名/无签名/redacted/空 thinking；正常文本和工具调用顺序不变；输入消息不被修改；至少覆盖实际 provider payload 的关键例子。
- **性能**：沿既有遍历完成，不新增第二遍完整历史过滤、深拷贝或 JSON 往返。统计实际遍历与结果分配，核对大历史请求后的引用释放。
- **来源**：[上游 #10995](https://github.com/earendil-works/pi/issues/10995)，v1.3.0。

### H05：非 strict schema 根定义

- **入口与链路**：工具声明 → strict 能力决策 → [anthropic-messages.ts](../packages/ai/src/api/anthropic-messages.ts) convertTools → SDK 请求体。
- **根因**：非 strict 分支重建 type/properties/required，根级 $defs/definitions 被丢弃，嵌套 $ref 可能仍引用这些定义。
- **最小方案**：在现有工具转换边界保留所需的合法根级 schema 语义；区分 strict/non-strict 的协议要求，不做引用内联、schema 迁移或备用校验器，也不因服务端拒绝而自动放宽 strict。
- **验收**：真实出站 payload 中保留 $defs/definitions 与引用；嵌套数组/对象引用、无根定义对照、strict 对照；调用方 schema 无突变。服务端允许的其他根字段先核查再决定，不无条件复制未知字段。
- **性能**：工具转换和已有缓存失效边界各算一次；不在每个 token/delta 遍历 schema。记录既有 clone 与新增复制成本，不以新增 structuredClone 掩盖共享引用问题。
- **来源**：[上游 #9557](https://github.com/earendil-works/pi/issues/9557)，未发布。

### H06：split-turn 压缩指令

- **入口与链路**：/compact 或 SDK customInstructions → compact → [generateTurnPrefixSummary](../packages/coding-agent/src/core/compaction/compaction.ts) → completeSummarization → 已有认证/stream 边界。
- **根因**：history summary 接收 customInstructions，而 turn-prefix 调用和签名没有这个参数。
- **最小方案**：把同一用户指令传到实际生成 turn-prefix 摘要的请求，沿用现有指令拼接规则；不增加模型请求、不改输出预算、不改变权限或把历史文本提升为系统指令。
- **验收**：只有 turn-prefix、history + turn-prefix、非 split、无指令四种情形；检查实际请求中的指令数量和位置，取消/错误不保存不完整摘要。保留原有回合边界、文件操作记录和认证来源。
- **性能**：大历史只经过原有必要转换，避免为验证指令再次序列化完整会话；记录请求次数、序列化次数和临时历史引用释放。
- **来源**：[上游 #11058](https://github.com/earendil-works/pi/issues/11058)，v1.4.0。

### H07：grep 配置隔离

- **入口与链路**：内置工具注册 → [grep.ts](../packages/coding-agent/src/core/tools/grep.ts) → rg 子进程；先核对 Sandbox/宿主/自定义 operations 的实际入口。
- **最小方案**：在本工具自己的 rg 调用中禁用用户配置文件，保留 literal、glob、大小写、隐藏文件等显式工具参数。不要修改用户 rg 配置、全局环境，或批量改变所有 shell 搜索行为。
- **验收**：隔离 fixture 的 RIPGREP_CONFIG_PATH 设置 --fixed-strings，regex 查询仍按工具参数工作；literal=true 对照；无配置路径对照；检查最终 spawn 参数和实际搜索结果。
- **性能/释放**：静态参数只在命令启动边界设置，不新增每行校验；进程/管道/fixture 用后释放。
- **来源**：[上游 #11203](https://github.com/earendil-works/pi/issues/11203)，v1.4.0。

### H08：grep 上下文内存

- **入口与链路**：工具执行/授权 → rg JSON stdout → match/context 解码 → 分组/截断 → 工具结果 → 结果预算与展示 → 取消/dispose。先确认真实消费者，不以 provider/TUI 缓存替代本层审计。
- **根因**：当前上下文分支为命中文件调用 readFile，再替换换行并 split 整文件，缓存完整行数组。
- **最小方案**：优先消费 rg 自身提供的上下文事件，按现有输出上限有界处理；重叠上下文、匹配计数和显示顺序保持语义。custom operations 的能力和兼容性必须先说明，不静默退回整文件读取。
- **验收**：上下文重叠/不重叠、多个文件、首尾行、无末尾换行、LF/CRLF/单 CR、UTF-8/UTF-16、JSON 的 text/bytes 表达、超长单行、取消和 rg 错误。按实际支持范围选代表输入；不为未支持格式添加猜测解码链。
- **确定性门禁**：默认 rg 上下文路径整文件 readFile 次数 = 0、整文件 split 次数 = 0；扫描量随输入线性；保留的上下文行/字节有明确容量，并与命中文件总大小无关。容量公式和结果预算在编码前写定，不编造事后阈值。
- **性能证据**：同命中片段、递增文件规模对照基线/候选；有界 fixture，不通过实际 OOM 证明问题。提供扫描/复制计数、allocation 栈、峰值、受控 GC 与取消释放。
- **拆分边界**：匹配数恰好等于 limit 的截断误报，以及 find/ls 的非正 limit 规则先归 V02，独立根因不得夹带到本 PR。
- **来源**：[上游 #9276](https://github.com/earendil-works/pi/issues/9276)，未发布。

### H09：空引号参数

- **入口与链路**：提示命令输入 → [parseCommandArgs](../packages/coding-agent/src/core/prompt-templates.ts) → substituteArgs → 模板展开。
- **已观察**：输入 `"" next` 返回 `["next"]`，空位置参数丢失。
- **最小方案**：区分“参数已开始”和“字符串非空”，保留显式空引号参数。遵守现有解析规则，不升级为完整 shell parser，不增加 shell 执行或新转义语法。
- **验收**：双/单空引号、中间/末尾空参数、连续空参数、带空格引号、相邻片段拼接、普通空白、现有未闭合引号行为；经 substituteArgs 验证 $1/$2、默认值及参数切片不再错位。
- **性能**：单次线性扫描，状态为固定原始字段；不增加正则 tokenizer、每字符对象或第二次解析。
- **来源**：[上游 #10867](https://github.com/earendil-works/pi/issues/10867)，v1.3.0。

### H10：SDK streamProxy 增量参数

- **范围说明**：上一轮 T06 只覆盖内置 API adapter，明确排除了可选 SDK streamProxy。本项补这个入口，不启用新的默认 proxy 路由。
- **入口与链路**：proxy 网络事件 → [proxy.ts](../packages/agent/src/proxy.ts) → 工具参数状态 → AssistantMessageEventStream → Agent/SDK 消费者 → 实际事件/渲染链和终态释放。
- **根因**：toolcall_delta 累计 partialJson、对全文 parseStreamingJson，并复制 content 触发更新；长参数形成重复扫描与分配。
- **最小方案**：复用现有增量参数解析能力，以每个活动 tool call 为 owner；保留事件顺序、实际 snapshot 隔离和终态元数据（包括 namespace/thoughtSignature）。异常、取消、完成都释放 parser/raw 引用。
- **验收**：Unicode/转义跨块、嵌套/数组/字符串、多并行工具、空 delta、最终参数权威性、非法/不完整 JSON、提前取消、终态缺失及重复事件边界；按现有 proxy 协议验证，不增加新协议兜底。
- **性能门禁**：累计全文重解析次数 = 0；扫描字符数随输入线性；不在 delta 内新增闭包、Promise、controller、wrapper 或 content spread；原始参数不挂在扩展可见 partial 上；终态后无遗留 parser/大字符串引用。
- **基准**：先核对 scripts/bench/provider-tool-args.ts 的接口再复用；它不能未经适配就当作 proxy 测量。用实际 streamProxy 驱动输入，同时验证下游 stream、session event、paced tool-args 和 frame queue 门禁。
- **来源**：[agent v1.5.0 changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/CHANGELOG.md)、[上游 #9265](https://github.com/earendil-works/pi/issues/9265)。

## 7. 已有能力、待验证项和产品候选

下列 E 结论来自前轮源码/测试记录；本轮未重新运行它们，不填写新的通过计数：

| 分类 | 项目 | 处理 |
| --- | --- | --- |
| E | Mistral 响应头超时与正文读取分离 | 已有实现和 tests/mistral-header-timeout.test.ts，不重新迁移 |
| E | 截断工具调用后的孤立结果清理 | tests/pi087-length-recovery.test.ts 已有对应回归；检查 H04 不破坏它 |
| E | SDK proxy 完成事件保留 namespace 等元数据 | 当前 toolcall_end 已复制这些字段；H10 必须保留 |
| E | MCP 刷新阶段注册/交互授权保护 | 当前 oauth.js 已区分刷新和交互登录；不能将整个 OAuth 系统判为缺失 |
| V01 | OpenRouter 新 token 裕量 | 与本地 usage anchor、输入估算和输出预算对照后再决定；不直接全局套用比例、不新增自动重试 |
| V02 | grep 精确 limit、find/ls 非正 limit | 定向复现并确定公开参数语义；成立则按独立根因追加任务 |
| V03 | v1.2 启动中 busy、扩展触发 before_agent_start | 核对本地 run owner/自定义消息路径，不仅比较函数名 |
| V04 | v1.4 空白工具输出、并发扩展对话框等 | 在 H00 映射到真实本地入口后复现；尚不能写成确定缺陷 |
| F | models Schema/生成配置文档、扩展更新说明、费用来源 | 与已有 settings/keybindings Schema 区分，不自动整体迁移 schema 验证器 |
| F | OpenRouter 账户目录、Codemode worker 等待 | 单独产品决策，涉及身份/缓存或队列容量时先设计 |

V 项没有复现不改生产代码，F 项没有采纳不计入必须完成的缺陷。依赖公告、模型目录或价格如后续确需修改，使用实施日权威来源重新核对；本计划不复用历史审计数量作为现状。

## 8. 验证与交付流程

### 8.1 每个实现 PR 的验证顺序

1. 核对最新目标文件、依赖任务、工作区和当前 Node 26；建立本任务独立临时目录及资源清单。
2. 固化最小失败回归，记录失败原因；不能将夹具环境失败当成生产缺陷。
3. 更新先行设计和完整链审计，实施最小改动，运行相关回归。
4. 热路径运行相关 AST/source invariants、allocation benchmark 与生命周期验证；选择真实相关的门禁，不重复跑所有无关基准。
5. 对生产代码改动运行 `npm.cmd run check`、`npm.cmd --offline run build:offline`，以及仓库要求的 `npm.cmd test`。全套覆盖后不再次重复 hot/contract 子集，除非有新增改动或待诊断失败。
6. 检查最终 diff、证据、资源清理和未覆盖环境；只有最终候选的通过结果可作为交付依据。

现有可复用门禁包括：

- tests/source-invariants.test.ts、tests/stream-hot-paths.test.ts、tests/provider-tool-args-hot-paths.test.ts。
- tests/tui-frame-hot-paths.test.ts、tests/provider-contract/streamed-tool-argument-ownership.contract.test.ts、tests/provider-contract/tool-argument-recovery.contract.test.ts。
- `npm.cmd run bench:stream`、`npm.cmd run bench:tui-session-event-allocations`、`npm.cmd run bench:tui-paced-streamed-tool-args`、`npm.cmd run bench:tui-frame-queue`。

这些是已存在的入口，不是每个任务都必须机械全跑。各项开始前确定最小适用集合和具体 CLI 参数；新增 H08/H10 专用基准确有必要时再写。只有文档/忽略规则变更时，检查链接、内容一致性、git diff --check 和临时目录清理，不为此启动全量构建或生产测试。

失败时先区分生产根因、测试夹具、环境、编译和资源泄漏，再修复对应问题。不得切换 Node 版本、放宽断言、跳过测试、减少矩阵或盲目重跑来获得绿色结果。性能波动需要可重复证据，不使用一次时间差下结论。

### 8.2 独立 PR 与 reviewer 闭环

实施阶段沿用用户已确定的流程：

1. 一个独立根因/验收目标对应一个新分支和新 PR，建议 `codex/history-hNN-<topic>`。已有已合并 PR 不复用，无关修复不混入。
2. 完成设计、失败回归、修复、必要验证与自审后再提交、推送并创建 PR。检查上轮本地未推送提交的归属，不能不加说明地混入本项。
3. 创建 PR 后独立评论准确文本 `@codex review`，记录评论 URL、PR URL 和 head SHA；正文提到 Codex 不代表已请求审核。
4. 等待 reviewer 对当前最终 head 完成审核，并核对正式 reviews、行内线程和 comments。发现成立问题就在原 PR 修复、验证、推送，随后**额外单独 @codex review**，等待新 head。
5. 没有新 head 的审核完成证据、存在未处理有效发现或必需 CI 未全部成功时，不合并。旧 head 的无问题结论不套用到新提交。
6. 满足既有用户授权、当前 head 审核通过和必需 CI 后，按远端现行合并规则执行，并约束待合并 head 防止竞争。
7. 合并后验证 merge commit 已进入 main；按 PR/分支精确身份删除对应远端分支，同步本地，再删除确认已合并且无 worktree 占用的对应本地分支。禁止按名字模糊批量删除。
8. 更新正式任务记录和清理状态，再开始下一项。等待审核期间释放已无用资源；不需要用户重复批准已授权的相同步骤。

### 8.3 完成条件和记录模板

每项记录至少包含：

- 任务 ID、状态、上游版本/固定 SHA、前置任务、基线/最终源码 SHA。
- 根因、失败输入、生产调用链、最小改动、行为兼容与未覆盖环境。
- 必要校验、错误传播、状态/资源 owner、容量、正常/错误/取消/重复调用的释放点。
- 回归结果；热路径的结构计数、allocation/GC 证据和对象池决定。
- 最终 head 对应的 PR、主动复审、reviewer 结论、必需 CI、合并 SHA。
- 自有临时目录/进程的清理结果；失败保留精确路径和原因。

整轮结束要求：H00 清单无未分类条目；H01–H10 已交付或有证据排除；新增采纳项同样关闭；F/V 未采纳项单列，不伪装成修复完成。所有交付的分支和资源已按身份处理，遗留项明确列出。最后报告源码与构建所对应的提交，不用包版本号代表已安装版本。

## 9. 规划阶段历史记录（实施授权之前）

- 已读取仓库 AGENTS.md、现行性能契约、历史实施记录、测试/benchmark 入口及 fixture 清理约束。
- 已创建本方案，并将临时目录规范同步到仓库 AGENTS.md、将 /.task-tmp/ 加入 .gitignore、在文档导航加入入口。
- H00–H10 尚未实施。本次不运行生产测试/构建、不提交、不推送、不创建 PR。
- 文档验证已通过：13 个本地链接均存在，H00–H10 编号完整且不重复，7 个 npm 检查/基准命令和 9 个现有源码/测试入口存在；git diff --check 通过，临时目录被忽略。
- 使用当前 Node v26.13.0 的独立子进程验证了 os.tmpdir()，实际为本次创建的 `D:\RMProjects\Pi\.task-tmp\history-followup-plan-20261104-cd5c62a2fbd041f89760a31e878f13ba`，与 TMP/TEMP/TMPDIR 一致。临时资源只有 resources.json 和 validation.json，没有常驻子进程或外部资源。
- 上述计数和结果已保存在本节。随后尝试使用原生 PowerShell 按精确文件路径删除两个临时文件，再删除任务根和空父目录；自动审批在命令执行前拒绝，原始原因只有 `blocked by policy`。独立目录同样被拦截，不能将此前原因归结为仅禁止 .git 内清理。
- 清理后的只读核对确认：上述任务根内仍有 resources.json 和 validation.json，未发生删除；resources.json 已登记 blocked 状态与原因。没有切换 API/shell 绕过，没有请求重复授权。正式文档工作完成，**本次临时目录清理仍未完成**。

## 10. H00 清单映射与执行基线（2026-11-04）

### 范围与证据边界

- 分支 `codex/history-h00-inventory`，本地生产基线仍为 `b2c42768ff46d68bc847f151884737644848ce17`；远端 main 为 `7dc1220baa9ff7b3caa642d1da620fd66b62c722`。首次 PR 明确包含此前已存在的 `b2c42768f`（仅删除已应用的 clipboard 补丁文件），以及上轮未提交的 `.gitignore`、`AGENTS.md`、文档导航和本方案；未重写、丢弃或隐瞒这些改动。
- 已读取现行性能契约；本项仅修改规则、文档和审计数据，无生产路径变更，不新增运行时闭包、正则、缓存、对象池或协议状态。生产测试和 allocation benchmark 在对应实现任务运行，不用历史通过数量冒充本次执行。
- [逐项清单](evidence/pi-history-followup-inventory.json) 固定读取六包在 `676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d` 的 changelog。22 个稳定版 tag SHA 经 GitHub API 核实；每条同时保存发布 ref 和实际读取的快照 URL/行号。后者可能包含追补说明，**不宣称它就是发布当日的 changelog 文本**。
- 提取版本标题下、代码围栏外的顶层列表项，得到 **1,150 条来源记录**：coding-agent 733、ai 251、agent 21、tui 94、mcp 27、codemode 24。版本/包覆盖格为 138（22 个稳定版加一个未发布快照，各六包）。MCP/Codemode 在九个早期版本中的 18 个缺席格，额外使用 `object(expression: "v<version>:packages/<package>/package.json")` 核对为 null；这与“包存在但没有 changelog 条目”分开。
- 来源记录按当前评估组合计数为 **E 19、S 11、V 1,080、F 39、S+V 1**。这些是来源条数，包含摘要和跨包重复，**不是缺陷数量**。71 个评估节点中既有明确任务，也有待验证的入口分组；不能把入口分组数称为已审计根因数。
- **H00 本次交付的是来源覆盖、已核对候选和明确的待验证清单，不是 1,150 项全部完成语义审计。** 其余 V 的源码入口只标为搜索起点，证据明确标注尚未验证；267 项目前仅能定位包入口。搜索词和历史文档链接只用于继续查证，不能将 V 自动升级成 E/F 或关闭。V01–V04 与清单中其余未采纳 V 继续开放；本轮采纳的生产修复仍为 H01–H10。
- 不按 issue 编号合并根因：`#11599` 分别映射 H01/H02；`#9265` 的 provider、proxy、字符串保留等条目分别保留。grep 同一发布项中的上下文内存和精确 limit 分别引用 H08/V02；不会将修复一个问题写成整个来源条目都已完成。

### 当前源码核对

H01 的 shutdown handler 仅设置标志；H03 最终 text-mode 判定未处理 length；H04 跨模型 thinking 转 text；H05 非 strict schema 丢根定义；H06 turn-prefix 不接收 customInstructions；H07 rg 参数没有 `--no-config`；H08 仍读完整文件并 split；H09 用非空字符串决定是否提交参数；H10 仍累计 partialJson 后全文解析。这些在本基线标 S，之前的 R 观察保留为历史证据，各实现项仍需先建立失败回归。

H02 保持 V：RPC 的重复 shutdown 会直接退出，print 在异步 dispose 完成前设置 disposed；没有新的真实重叠关闭运行证据。Mistral 响应头超时、截断回合清理、保存的信任决定、exec 有界输出/生命周期、多语言工具检索、路径身份、MCP URL 协议、首条 user 持久化、未完成工具拒绝及自定义消息顺序等 E 节点链接当前源码/测试和已有 PR。这里的源码/测试检查不代表重新运行了这些回归，也不扩大既有覆盖边界。

早期 `upstream-pi-0.99.1-diff-assessment.md` 已从当前树移除，因此通过 `git show ace4fda133b9c845c790d94013d9f460a2042367:docs/upstream-pi-0.99.1-diff-assessment.md` 阅读实际历史记录。清单保存该固定链接，未重建不存在的日志、未复用旧测试数量。

### 验收与资源

本地验收通过：1,150 个来源 ID 唯一、138 个覆盖格唯一、71 个评估节点引用有效、F 均有排除理由、E 均有具体本地依据；六份来源文件哈希、全部 1,150 条来源首行哈希、63 个当前源码/测试文件哈希和 15 个文档本地链接匹配；`git diff --check` 通过。使用独立 Node 子进程执行只读校验，退出 0。没有运行生产测试、构建或 allocation benchmark。清单的 `localEvidence` 固定入口/测试的 SHA-256；V 的文件哈希不证明该文件已完成语义审计。

可从仓库根用 `node --input-type=module -e 'import fs from "node:fs";const x=JSON.parse(fs.readFileSync("docs/evidence/pi-history-followup-inventory.json","utf8"));console.log(x.entries.length,new Set(x.entries.map(e=>e.id)).size,x.coverage.length,x.assessments.length,x.localEvidence.length)'` 复核持久计数，预期为 `1150 1150 138 71 63`。完整来源复核按清单 method 下载固定 ref 的六个文件，比较 sourceFiles 哈希及 sourceUrl 对应首行（移除列表前缀 `- ` 后）的 SHA-256；不要对当前上游 main 取样。

本项任务根为 `D:\RMProjects\Pi\.task-tmp\history-h00-f77231595ab649e0bad0021a3d5968fa`，共享 `.task-tmp` 并非本项创建。当前 Node v26.13.0 子进程已确认 `os.tmpdir()` 与 TMP/TEMP/TMPDIR 一致。下载的六个公开 changelog、提取/构造脚本和中间数据均登记在该根的 resources.json；无常驻测试服务。一次 codemode 下载因网络 EOF 失败，随后同一固定 ref 经 GitHub API 成功取得；该错误没有被当成生产缺陷。

提交前已检查 `.task-tmp`/任务根均无 reparse 边界、根内文件全部在清单内；按精确路径删除了六个下载文件及提取/构造/校验脚本、中间 JSON/TXT 和 validation.json，逐项确认已不存在。只保留 resources.json 与供 `gh pr create --body-file` 使用的 pr-body.md，PR 创建后删除这两个文件和空任务根。无常驻测试服务或后台下载进程。

旧规划任务的 blocked 清理记录仍保留，本项不接管或删除该旧任务根。PR/当前 head 审查与 CI 尚未发生，不预写通过、合并或分支清理成功；后续结果以同 head 的 PR 回执记录。

### H00 合并回执

[PR #198](https://github.com/dragonbaba/super-pi/pull/198) 的最终 head 为 `30dc4865300ef3ca66c6ceb91cee0ea98fe23d4c`。[主动审查请求](https://github.com/dragonbaba/super-pi/pull/198#issuecomment-6621663101) 后，[Codex 回执](https://github.com/dragonbaba/super-pi/pull/198#issuecomment-6621699153) 和 summary 均确认同 head completed/no findings；正式 reviews 和行内线程为空。[CI](https://github.com/dragonbaba/super-pi/actions/runs/41766686873) 六个 Node 26.13 分片全部 success。锁定该 head 普通合并为 `3174bf87c87750213e0ccf437f23ffaa17d5bcbc`，已验证进入远端 main；本地 main 快进同步，远端和本地 `codex/history-h00-inventory` 均已删除且无其他 worktree 占用。

最后两份文件和任务根的清理命令被自动审批在执行前拒绝，唯一原始原因是 `blocked by policy`。只读确认仍剩 `D:\RMProjects\Pi\.task-tmp\history-h00-f77231595ab649e0bad0021a3d5968fa\resources.json`、同目录 pr-body.md 及任务根；manifest 已登记 blocked。未切换删除机制或重新接管旧任务根，未声称全部清理成功。[清理回执](https://github.com/dragonbaba/super-pi/pull/198#issuecomment-6621681760) 已记录到同一 PR；此限制保留到整轮交付报告。
