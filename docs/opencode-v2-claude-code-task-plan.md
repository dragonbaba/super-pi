# OpenCode v2 与 Claude Code 借鉴任务计划

先巩固 Super Pi 已有的后台完成通知与主会话续跑，再改进结果交付、子代理续跑和上下文压缩；Codemode 的工具发现与执行成本独立评估。需要改变会话持久化、远程协议或文件恢复语义的功能单独评估，不将上游实现整体移植进当前运行时。

状态：2026-10-14（Asia/Tokyo）#136–#146 已按用户授权合并。#146 最终提交 `ed6982ef5` 的六项 CI 通过、Codex 自动审查无反馈，合并提交为 `7e68cc3f3c0a67a6afdd4e17cbe184632422786b`。OC01、OC02、OC03 进程内窗口、OC04 单项子代理移交、OC05 已结束任务续跑发现、OC07 客户端重连核查、OC08 只读变更来源、OC10 核查及 OC11 有界 Worker 池已完成；OC09 沿用显式检查点续跑、延期自动执行恢复。本轮追加 OC11 正式源码 CLI 的 Codemode 集成核查，保留既有生产实现和运行方式。OC04 shell/批次移交、OC05 运行中纠偏、OC06 真实模型效果、OC08 跨任务归属/回退及 OC11 Bun 分配门禁与真实负载仍待后续；完整 CLI 发布包验收以未来实际发布形式为前提。继续沿用 §2.3 的 PR/审查流程。

## 1 对照基线与结论边界

- 本地基线：`af067d5efe3bc61128a4cda3162d23e908d3ece5`。开始任一任务前检查当前实现、相关在途修改及适用的 `AGENTS.md`，不要按本基线覆盖后续修复。
- OpenCode：用户指定的 `v2` 分支，二次查询仍为 [`4617210822bdbb31e5749751afbfb4584ccedac8`](https://github.com/anomalyco/opencode/tree/4617210822bdbb31e5749751afbfb4584ccedac8)。这是开发分支的固定源码快照，不代表所有已发布版本。
- Claude Code：2026-10-13 查询的[子代理官方文档][C1]与[团队官方文档][C2]。仅据此确认公开行为，不推断其闭源调度器、存储格式或内部实现与 OpenCode 相同。
- 证据分类：**E** 已有能力，**S** 源码确认的差异，**M** 本地限定 fixture 的实测，**V** 需先验证的边界，**C** 有前置条件的功能候选。源码差异不等于已复现故障；局部测量不代表完整产品性能；候选不等于必须建设的新子系统。

下表记录第一批实施前的固定基线；当前实现和验收结果见 §5。

| 核对项 | 基线证据与任务含义 |
| --- | --- |
| 后台完成唤醒 | **E**。Pi 的 shell 与子代理完成通知均使用 `triggerTurn: true`、`deliverAs: "followUp"`。空闲入口启动模型回合，运行中先排队；不重复建设后台任务管理器。 |
| 运行中消费时机 | **S**。Pi 在当前工具循环准备结束时取 follow-up；OpenCode synthetic 默认进入 `steer` 通道，在允许的步骤边界处理。两者都能通知，但响应时机不同，不能将 steer 理解为任意时刻取消正在运行的工具。 |
| 回合收尾 | **V**。Pi 有结束后队列检查，也有 `agent_settled` 嵌套回合测试；仍需覆盖检查队列、异步清理、空闲切换之间的通知时序，不能直接断言已有漏唤醒故障。OpenCode 的 `pendingWake` 与后继执行提供了可参考的边界设计。[O1]、[O2] |
| 通知交付保证 | **S**。OpenCode 按通知 ID 接纳消息并在接纳后清除后台通知标记；其测试覆盖观察者跨位置服务回收后的单次通知。这支持幂等接纳设计，不证明模型调用或外部副作用具备严格 exactly-once 保证。[O3]、[O4]、[O5] |
| 完成结果 | **S**。Pi 子代理默认每批次通知一次，内容主要为计数，要求另查 status；OpenCode 子代理通知带最终文本。Pi 的 `completed` 仍可能包含容量交接，不等于分配目标全部完成。 |
| 来源与权限 | **S/V**。Pi `convertToLlm()` 将 custom 内容映射为 provider 的 user 角色，不自动传递 `customType`。这是来源标记的核查入口，不构成权限已被绕过的证明；直接加入子代理原文前必须保留自动事件与用户指令的区别。 |
| 用户停止与等待输入 | **V**。自然结束、当前回合中断、等待用户回答、取消某个子任务、会话销毁各有不同语义。OpenCode 会清除中断前的待唤醒意图，清理期间新到达的请求可能再启动执行；不能直接照搬为用户停止后的统一规则。[O1] |
| 重启后的行为 | **E/C**。Pi 恢复有界任务历史，将未完成记录标为 `interrupted`，不重放任务或完成通知；显式检查点可续跑。OpenCode 另有会话执行标记与重启恢复，正在运行的 shell 被报告为因重启取消，不直接重跑。[O6] |
| 远程状态 | **E/C**。Pi 已以有 revision 的 snapshot 为权威状态，progress 为临时 UI 提示；OpenCode 的按序号日志补读是不同设计。应先验证快照恢复是否满足需求，再决定是否增加持久事件回放。 |
| 摘要更新 | **S/V**。Pi 要求保留旧摘要全部信息，同时允许移除已不相关信息；OpenCode 强调精简合并和可恢复信息的引用。已确认提示策略不同，尚未用真实模型证明本地摘要必然持续膨胀。[O7] |

本地入口：[后台任务说明](background-tasks.md)、[子代理通知](../packages/extensions/subagent/index.ts)、[shell 通知](../packages/extensions/resource-lifecycle-guard/background-shell.ts)、[会话运行时](../packages/coding-agent/src/core/agent-session.ts)、[代理循环](../packages/agent/src/agent-loop.ts)、[模型消息转换](../packages/coding-agent/src/core/messages.ts)、[协议约定](../packages/protocol/README.md)。

Claude Code 官方确认后台报告通过后续回合的自动通知到达，支持子代理续聊和团队消息；用户明确停止的子代理具有单独的恢复限制。报告不代表用户授权。借鉴这些可观察的行为，不默认引入代理团队、任意互发消息或后台权限弹窗。[C1]、[C2]

## 2 所有任务必须遵守的性能与验证规则

### 2.1 实施前的性能门禁

**每个任务及审查修复轮次都必须遵守 [Hot-path allocation contract](performance/hot-path-allocation-contract.md) 和 [测试规范](testing.md)。不得先交付功能，再另开任务补性能合规。** 非热路径须说明判断依据，仍记录状态所有者、容量、资源身份和释放时机。

开始编码前在本任务记录中写明：问题或需求、现有能力、最小行为证据、改动范围、完整生产调用链、热路径判断、待用的已有测试与 benchmark。若已有实现满足验收，记录证据后关闭该核查项，不为完成清单而重构。

1. 事件、provider delta、工具进度、交互、渲染、终端写入、大结果处理及 Evidence Ledger 查找默认属于热路径。审计覆盖生产者到释放边界，包含调用到的旧 helper 和下游 UI；不得只看 diff。
2. 普通高频路径遵守契约的零逐事件闭包、Promise、AbortController、options/wrapper、Promise tail/array 约束。现存必要分配也须逐项审计，不能以“零新增”代替整条链的合规。调度唤醒采用有界状态，禁止逐通知新增轮询计时器或无界 Promise 链。允许的生命周期分配按确切函数与触发频率说明，不整类或整文件豁免。
3. 为队列、通知、任务结果、重放窗口和缓存明确条目数与字节上限、满载策略、所有者、淘汰与释放点。合并唤醒不等于丢弃任务完成事实；保留现有任务容量、输出和检查点边界，不增加 token/回合预算。
4. 不为通知/摘要重复复制完整日志、序列化整个历史或为单行大结果创建无界数组。终端仍保持 active/pending 各最多一帧、完整帧物化最多一次、应用级完整帧复制为零。任务持久化不新增逐 chunk/progress/frame 写盘。
5. 默认不引入对象池。确需采用时先提供 profiler 证据并满足契约全部准入要求，包括采样分配下降至少 20%、CPU p95 回退不超过 5%、最终堆增长不超过 10%；禁止池化契约列出的消息、事件、工具结果、Promise 等对象。
6. 热路径变更必须同时提供：**确定性结构计数、allocation profile 或精确分配计数、受控 GC 与引用释放证据**。运行相关 AST/source invariants 和分配 benchmark；同机同 fixture 比较基线/候选，记录提交或源码哈希、环境、命令和结果。耗时单值、一次 heap 样本或“CI 通过”不能代替这些证据。
7. 覆盖完成、异常、取消、clear、会话/树切换及 dispose 中实际受影响的释放路径；进程、文件、监听器和数据库句柄按本任务记录的身份清理，不扫目录猜测所有权，不广泛杀进程。

参考已有审计：[子代理管理](performance/subagent-task-management.md)、[后台 shell](performance/background-shell-tasks.md)、[任务历史](performance/task-history-persistence.md)、[任务检查点](performance/task-budgets-checkpoints.md)。历史测量值仅为对应版本的证据，实施时以当前基线重新测量受影响部分。

### 2.2 最小充分测试与文件复用

- 优先扩展已有行为测试、fixture、source invariant 和 benchmark；**默认不新增测试文件**。仅当新职责无法合理放入现有套件时新增最少文件，并在 PR 说明为何不能复用。不要每个任务、每个边界、每轮审查各建一份测试文件。
- 先运行最小相关检查；通过后，仅在改动影响扩大、发现新失败或存在未解决风险时扩大范围。相同代码和环境下不为增加证据数量重复跑同一检查。
- 用可控 deferred/事件门闩和小型表驱动用例验证时序；不依赖长 sleep、反复真实联网、无限轮询或大规模 soak。额外压力/多进程采样只在相关性能问题需要时使用。
- 验证实际生产入口及可观察结果，不只调用伪造的 `sendMessage` 收集器、不仅断言某个源码字符串存在，也不为简单可逆文案调整编写镜像测试。
- 按 [testing.md](testing.md) 完成改动所需的类型、构建及 CI 检查。`test:unit`、`test:hot`、`test:contract` 是定向子集，不在完整 `npm test` 前作为额外固定流水线全部再跑一遍。完整验证对应最终候选，修复轮次先重跑受影响检查，最终 head 仍须满足必要 CI。
- “避免过度测试”不豁免热路径契约的三类证据和相关不变量。文档独立变更只核对事实、链接、任务依赖与 diff，不运行全量构建和性能套件。
- Prompt 的离线夹具能证明组装、输入边界及错误处理，不能证明真实模型的语义压缩质量；两类证据分别记录，不用固定字符串断言冒充模型效果验收。

### 2.3 PR 与 Codex 审查闭环

本计划采用用户最新指定的流程，**覆盖旧任务文档中“创建 PR 后立即手动请求首轮审查”的约定，但不改写旧任务记录**。

1. 在对应实施与交付获得授权后，为独立根因或可独立验收的功能建立 `codex/<任务ID>-<简述>` 分支和新 PR。同一根因的必要跨包改动、测试及文档可合并交付；不为每个测试或微步骤单独开 PR，不向已合并/关闭的 PR 追加工作。
2. 提交前自审 diff，确认没有夹带用户或其他任务修改。PR 说明具体问题、结果行为、验证与性能证据、兼容边界和未覆盖环境。
3. **首次推送并创建 PR 后，远端会自动触发一次 Codex 审查；不要立即重复评论 `@codex review`。** 核实实际触发状态及所审 head，等待并读取 review、行内讨论和一般评论。用户提供的自动触发规则不是本地已核实的仓库配置；若实际未触发，先诊断状态并记录，再在既有交付授权下补发一次，避免重复请求。
4. 收到反馈后逐条核实：成立的问题和建议完成修复；不采纳或延期项说明理由、证据及后续任务。审查意见不自动授权扩大功能范围或削弱性能约束。
5. **因反馈完成修复后，提交并推送到原 PR，再在该 PR 单独发表评论 `@codex review`，手动请求复审。** 仅在 PR 正文写 `@codex`、本地记录或只 push 都不算请求完成。记录修复 head SHA 与评论 URL；发布失败时明确记录并补发。每批修复推送后请求一次，不逐条意见重复触发。
6. 持续执行“核实反馈 → 修复 → 最小相关验证 → 提交推送 → 手动复审”，直至当前范围的反馈处理完毕。后续生产代码变化使旧 head 的结论不再覆盖当前候选，应再次请求审查；同一 head 已有请求进行中时不重复评论。
7. 审查请求成功不代表审查完成，CI 成功也不代替审查。最终关闭记录须包含最终 head、PR、复审评论/结果、反馈处理表、必要 CI 与性能/生命周期证据；缺失或失败保持待处理。合并仍以用户授权为前提。

## 3 任务顺序与依赖

| 任务 | 优先级与证据 | 前置条件 | 完成产物 |
| --- | --- | --- | --- |
| OC01 会话通知与停止语义 | P0，E/V | 当前运行时基线 | 状态与时序契约，已证实缺口的最小修复 |
| OC02 有界结果通知与来源 | P1，S | OC01 确定接纳/消费边界 | 可直接使用的有限结果和自动事件标识 |
| OC03 完成通知的持久交付 | P1 候选，C | OC01、OC02；确定跨重启投递策略 | 最小通知记录与幂等接纳，或明确保留现状的决定 |
| OC04 前台任务转后台 | P1，C | OC01；现有执行器可移交所有权 | 不重启任务的后台化入口 |
| OC05 子代理续跑与定向消息 | P1，E/C | OC01、OC02 | 在现有检查点基础上的续跑入口与明确边界 |
| OC06 摘要精简与任务状态保留 | P1，S/V | 可独立执行；涉及通知时遵守 OC01/OC02 | 精简摘要策略及分层验证证据 |
| OC07 远程重连与事实补读 | P2 候选，E/C | 实际快照恢复需求及 OC03 适用性评估 | 快照方案验收，必要时增加有界事实补读 |
| OC08 变更归属与用户回退 | P2 候选，C | 变更记录、存储与冲突范围评估 | 先提供变更归属；回退独立交付 |
| OC09 进程重启后的执行恢复 | 后续候选，C | OC01、OC03、OC05 及明确产品需求 | 恢复设计决定；采用后独立实施 |
| OC10 Codemode 工具发现与目录更新 | P1，E/S/V | 可独立执行；复核已有 tool_search、MCP deferred 与动态指令 | 有界工具发现与提示稳定性，或现状已满足需求的证据 |
| OC11 Codemode 执行成本与数据边界 | P1 核查，M/V | §6 库级测量；先取得实际发布运行模式基线 | 分阶段成本与必要的最小优化，不预设替换引擎 |

推荐顺序为 OC01 → OC02，OC06、OC10 和 OC11 的基线核查可独立推进；其余按前置条件进入。OC10/OC11 同时修改 Codemode controller 时顺序实施。任务之间涉及同一 session、权限、消息或存储入口时顺序修改。同一任务的独立验收目标可分 PR，但不按编号机械制造 PR。子代理委派必须携带任务 ID、具体 scope、deliverable、stopCondition、性能门禁与验证范围，完成后返回证据，不自行继续其他任务。

## 4 任务实施清单

### OC01 会话通知与停止语义

入口：[AgentSession](../packages/coding-agent/src/core/agent-session.ts)、[Agent](../packages/agent/src/agent.ts)、[agent-loop](../packages/agent/src/agent-loop.ts)、[运行时替换](../packages/coding-agent/src/core/agent-session-runtime.ts)。上游参考 [O1]、[O2]。

- [x] 定义状态矩阵：自然空闲、模型/工具运行、回合收尾、重试/压缩、等待用户输入、显式中断、子任务取消、会话树切换、权限撤销和 dispose。分别规定记录、消费、唤醒及丢弃/隔离策略。
- [x] 保持自然空闲收到有效完成通知可继续；用户停止和等待用户回答不能被普通完成报告当成新的用户授权。明确“仅中断当前回合”与“暂停自动继续”的产品区别，不将新语义藏在一个 `aborted` 布尔值里。
- [x] 通过实际 session 入口验证最后一次取队列前后、清理期间、多个同时通知、通知与用户输入同到、取消/失败后迟到，以及 `agent_settled` 回调启动后继回合的所有权。确保没有并行主执行、队列遗留或旧回合清理覆盖新回合状态。
- [x] 明确 follow-up 与在安全步骤边界消费通知的取舍；不打断工具调用/结果配对，不默认把全部消息改成 steer。若发现确定缺口，在现有运行时做最小修复；只有证据表明分散状态难以保证契约时才抽取协调器。

**性能与最小验证：** 强制执行 §2。复用 [custom-message-ordering](../tests/custom-message-ordering.test.ts)、[agent-settled-aborted](../tests/agent-settled-aborted.test.ts)，等待输入边界复用 [permission-interaction](../tests/permission-interaction.test.ts)。使用现有离线模型 fixture 计数 provider 请求和实际消费次数。事件链变更运行相关 source invariants 与 [session-event allocation benchmark](../scripts/bench/tui-session-event-allocations.ts)，补充每忙周期唤醒/deferred 数、队列峰值及完成/取消/dispose 引用释放计数；不用整套 TUI 压测代替该问题的时序证据。

### OC02 有界结果通知与来源

入口：[子代理扩展](../packages/extensions/subagent/index.ts)、[后台 shell](../packages/extensions/resource-lifecycle-guard/background-shell.ts)、[任务记录](../packages/extensions/subagent/tasks.ts)、[消息转换](../packages/coding-agent/src/core/messages.ts)、[完成证据保护](../packages/extensions/false-success-guard/index.ts)。参考 [O3]、[C1]。

- [x] 让通知携带有界 task ID、状态、简短结果与结果引用；保留 shell 退出/取消/超时/输出记录失败事实，区分完成、部分成果、容量交接与失败，不用 `completed` 或模型摘要代替客观验证。
- [x] 为后台报告提供明确来源标识，保留父会话、分支及运行代次的路由身份；在实际 provider 消息转换和历史回放中验证该标识，不只在 UI/details 中标注。报告内的“用户已批准”等文字不能提升授权。
- [x] 保留 status 作为详细结果入口。仅在通知已完整覆盖验收所需事实时减少额外查询；不能先删除当前“读取终态后再报成功”的规则。没有可用摘要时使用有限原文/结果引用，不增加一次模型摘要调用。
- [x] 评估每批次通知与重要单任务完成的及时性；合并唤醒而保留所有结果身份，明确总字节上限、截断、结果已淘汰和投递失败的行为。正常流程不主动轮询，用户显式查进度仍可用。

**性能与最小验证：** 强制执行 §2。在 [subagent-management](../tests/subagent-management.test.ts)、[background-shell-tasks](../tests/background-shell-tasks.test.ts) 与既有消息转换 fixture 中补最小用例。复用 [subagent benchmark](../scripts/bench/subagent-management.ts)、[shell benchmark](../scripts/bench/background-shell-tasks.ts) 中实际受影响者及对应热路径不变量，记录通知总字节、复制/序列化次数、持有结果引用和释放点；不得逐输出事件构建摘要或复制整批任务数组。

### OC03 完成通知的持久交付

入口：[task-history](../packages/extensions/task-history.ts)、[任务所有者](../packages/extensions/subagent/tasks.ts)、[session-manager](../packages/coding-agent/src/core/session-manager.ts)。现有约定见 [任务历史方案](task-history-persistence-plan.md)；参考 [O2]、[O4]。

- [x] 确定终态保存、通知接纳、进入模型上下文与处理确认的不同故障窗口，见 §5 第三轮。修复 idle trigger 等待既有 drain 失败后丢失未消费报告的问题；不宣称端到端 exactly-once。
- [ ] 如采用持久通知，优先复用现有有界历史/会话存储，设计稳定通知 ID、schema 迁移、接纳去重与确认边界。只保存足够恢复通知的有限字段，规定磁盘失败、容量满、任务历史淘汰及孤立引用策略。
- [x] 保留现有默认不重发历史通知、不自动运行的恢复策略。新策略若采用，仍须另行定义启用范围、暂停保留、分支/权限代次和过期处理，不恢复旧权限、重放副作用或自动认可历史验证成功。
- [x] 本轮仅关闭已证实的进程内交付窗口。持久通知仍为上项条件候选，不新增 outbox/schema/确认标记，不提前实现 OC09。

**性能与最小验证：** 强制执行 §2。复用 [task-history](../tests/task-history.test.ts) 及其已有退出 writer fixture、[task-history-hot-paths](../tests/task-history-hot-paths.test.ts)；仅在各持久边界注入必要失败。复用 [task-history benchmark](../scripts/bench/task-history.ts)，记录生命周期写入数、通知条目/字节上限、打开句柄和释放计数；逐 chunk/progress/frame 新增写入必须为零。投递语义变更追加 OC01 的相关用例，不重跑不受影响的完整渲染基准。

### OC04 前台任务转后台

入口：[managed-tasks](../packages/extensions/managed-tasks.ts)、[subagent](../packages/extensions/subagent/index.ts)、[shell 后台接口](../packages/coding-agent/src/core/tools/shell-background.ts)、[后台 shell 所有者](../packages/extensions/resource-lifecycle-guard/background-shell.ts)。参考 [O8]。

- [x] 分别核查 shell 与子代理的所有权。单项子代理保留同一进程/任务 ID、输出、授权和调度槽，解除前台等待而不重启；shell 的现有启动所有权不足以安全移交，保留启动时后台选项。
- [x] 单项移交覆盖完成、取消、容量满、权限撤销、树切换和 dispose；结果只走前台或一次后台完成通知，session pending operation 持续拥有执行和清理责任。
- [x] 通过 `/tasks background <id>` 及 `tasks` action 暴露单项移交。TUI/RPC 和有效内置管理工具必需；Print/JSON、shell、批次/chain、后台/终态/取消中任务明确拒绝，不新增快捷键或守护进程。
- [ ] shell 及 parallel/chain 的运行中移交仍未实现；需先解决 shell 启动时所有权以及单 ID 对整批执行的语义，不能将本轮单项支持写成全部 OC04 完成。

**性能与最小验证：** 强制执行 §2。复用 shell/subagent 管理测试及现有 child fixture，选择支持的执行器验证身份不变与单次完成；按受影响消费者运行已有 shell/subagent benchmark。移交仅允许生命周期分配，不新增输出复制、逐进度状态发布或计时器；平台特有进程树行为在相应 CI 验证。

**本轮实施前记录（基线 `769baee88`）：** 子代理前台调用已建立 session-owned task、reservation 和 pending operation，但执行 signal 永久组合父回合 signal，返回值只能等待 operation。`AgentSession.prompt → _tryExecuteExtensionCommand` 已允许流式期间立即执行 `/tasks`，无需新增 UI 轮询。先实现单项调用的显式移交，保留 PID/task ID/原超时/同一调度槽，通过可断开的父回合取消监听器和一次性前台 deferred 解除等待；authority 与 task controller 继续拥有取消权。移交前复核 TUI/RPC、有效内置管理工具、未完成/未取消、工作区写入隔离。并行/chain 不隐式整批移交。

shell 审计链为 final shell authorization → cwd binding → bash execute → local operations → WindowsShellJob/child observation → output/log cleanup → background owner。前台尚无 managed task，cwd authority 固定捕获原 signal，Windows Job 只在后台启动时建立；本轮不假装已有安全移交能力，也不重启命令。替换执行器同样不支持。

子代理完整生产链：authorization/delegation → execute → scheduler/reservation → runSingleAgent → SubagentProcessRun stdout/JSON/有界消息保留 → 启动/终态快照 → Agent observer clone/freeze → AgentSession → InteractiveMode → tool renderer/frame queue；终态经 tasks.finish → reservation/pending 清理 → 原前台结果或一次完成通知。新状态仅位于调用/命令/完成/取消生命周期；逐 stdout/progress/frame 不加闭包、Promise、controller、wrapper、数组或定时器，不建对象池。需检查移交后不再保留原 onUpdate/父 signal/前台 deferred，终态从目录移除 handle，仍等待同一进程清理。复用 subagent-management、subagent-hot-paths 与现有 child fixture；运行既有 subagent-management benchmark 的当前基线/候选并扩展生命周期计数，提供可控完成/取消/销毁和 GC 证据。不运行本地全量测试。

**本轮验收：** 真实 child 的 PID/ID 不变、前后各占 1 个 running/outstanding/reserved 槽，父回合 abort 后仍存活，终态通知一次且不再向旧 onUpdate 发布。已有 8/8 容量时 queued 单项移交仍保持 8/8；当前授权与内置工具 schema 身份重新检查，原工作区 writer 和批次拒绝。真实 ExtensionRunner/Agent dispatch 经正常 delegation 后，用运行期间的 `/tasks` 命令移交成功；不能同时派发第二个模型工具的既有主执行锁仍生效。failure/cancel/permission/tree/shutdown 均沿原进程清理和终态规则。新 helper 的终态额外清空代理 AbortController：自审 GC 初测发现 abort 场景 64 个父 signal 随该 controller 保留，清理后归零。

详细调用链、计数和原始基线/候选样本见 [OC04 性能证据](performance/oc04-foreground-handoff.json)。8/16/64 子进程表示的 1000-event fixture，采样字节/事件为基线 8834.696/8541.720/8524.936、候选 8731.920/8626.616/8728.328；两侧逐事件快照与全消息重新序列化均为 0，不据单次波动声称提速。既有 344 个跟踪引用 GC 后保留 0；新增 256 次生命周期夹具（64 次仍在执行的移交 owner 保持强引用）中，768 个前台 signal/callback/wait 引用保留 0，监听器和迟到发布为 0。新增每单项生命周期一个 deferred、一个 controller、两个稳定回调及启动/终态处理；每次 stdout/progress/frame 新增为 0，移交计时器为 0。

复用现有测试文件增加 5 项管理用例和 1 项 source invariant，并扩展原真实扩展集成用例；没有新测试文件。管理/source invariants 共 39 pass、1 个 POSIX 项在 Windows skip，另有 2 项扩展管理集成通过。修复 controller 释放后仅重跑受影响 9 项、同一 benchmark、类型检查、coding-agent 构建和 benchmark strict typecheck；没有本地全量测试。PR/审查/最终 CI 结果在 PR 记录，避免只为填写远端状态再触发 CI。没有测真实模型或完整 UI 性能，也没有改动原超时、process-tree、frame queue 或持久化协议。

### OC05 子代理续跑与定向消息

入口：[subagent](../packages/extensions/subagent/index.ts)、[统一任务入口](../packages/extensions/managed-tasks.ts)、[任务历史与检查点](../packages/extensions/task-history.ts)。现有边界见 [后台任务说明](background-tasks.md)；参考 [O9]、[C1]。

- [x] 优先改善已有 `checkpoint: true`、`resumeTaskId` 的发现和使用体验，保留每次续跑的新任务 ID。若需要稳定子代理身份，将其与本次运行 ID 区分；重名、旧代次和跨父会话目标明确拒绝或要求重新定位。
- [x] 保留新任务的 scope/deliverable/stopCondition、当前角色/模型/权限核查、精确工作区身份及写入冲突检查。没有检查点、检查点损坏或达到交接线时给出可执行交接，不虚构完整上下文或绕过容量上限。
- [ ] 将“已结束子代理的续跑”与“运行中定向纠偏”分阶段验收；后者只有在子进程已有安全输入边界或明确新增协议后采用，保证顺序、取消与消息源身份。代理消息不授予用户权限，不让已明确取消的任务被普通消息自动复活。
- [x] 保留一次性任务的轻量路径；不默认长期保存全部子代理对话，不同时引入任意互发消息、代理团队和嵌套委派。

**性能与最小验证：** 强制执行 §2。复用 [task-checkpoints](../tests/task-checkpoints.test.ts)、subagent 管理与热路径测试；当前 IPC 与检查点 fixture 足够时不新建服务。按修改范围复用 [subagent benchmark](../scripts/bench/subagent-management.ts) 或 [task-history benchmark](../scripts/bench/task-history.ts)，计数消息/检查点容量、IPC 字节、监听器与取消后的引用释放，不逐 token 保存完整历史。

### OC06 摘要精简与任务状态保留

入口：[compaction](../packages/coding-agent/src/core/compaction/compaction.ts)、[会话管理](../packages/coding-agent/src/core/session-manager.ts)、[provider-aware compaction](../packages/provider-aware-compaction/src/index.ts)。参考 [O7]。

- [x] 调整“保留全部旧信息”的更新导向，将旧摘要与新证据精简合并；允许折叠已完成细节、移除已被替代结论，以必要文件/任务引用替代长日志和逐编辑清单。
- [x] 明确保留用户目标与约束、关键决策及理由、未解决问题、正在运行/等待的任务 ID、部分结果和下一步。仓库规则仅在能重新加载且来源确为规则文件时省略，不能将用户亲自补充的约束误当作可丢弃配置。
- [x] 不让压缩跨越消息配对、待投递通知或用户交互边界；确保任务 ID 尚可查询，过期引用明确表达不确定性。保留 provider 原生/不透明压缩路径、失败恢复及中断不提交半份摘要的现有约定。
- [ ] 用少量代表性长任务样本比较多轮摘要的长度与事实保留。离线测试负责 prompt 组装和保存边界；真实模型效果采用有限次数的定向评估，记录模型、输入和遗漏，不把模型输出作为易抖动的常规 CI golden。

**性能与最小验证：** 强制执行 §2。优先复用 [pi087-length-recovery](../tests/pi087-length-recovery.test.ts)、[compaction lifecycle](../tests/provider-contract/openai-compaction-lifecycle.contract.test.ts) 中受影响 fixture。只改提示策略时不跑全套渲染 benchmark；触及历史投影/大结果处理时使用 [prefix benchmark](../scripts/bench/prefix-build.ts) 或最接近的现有生产基准并补必要计数，证明没有新增整份历史复制、重复 token 估算或截断造成的约束丢失。没有实际模型评估时如实保留效果验收项。

### OC07 远程重连与事实补读

入口：[protocol](../packages/protocol/src/schemas.ts)、[server sessions](../packages/server/src/sessions.ts)、[client state](../packages/client/src/state.ts)。参考 [O10]。

- [x] 完成现有 client revision snapshot、重连/重新附着和 lease 核查：快照可恢复已保存状态，低 revision 新 runtime 可重新附着，progress 保持临时提示；复现并修复旧连接余帧及租约异步续体越代问题。实验性 server 尚无 coding-agent 后台任务事实适配器，因此不声称已验证该业务的端到端恢复。
- [x] 条件评估完成：本轮没有新增任务事实协议或事件回放的已确认需求，保留权威快照。若后续接入持久任务事实，仍须另行验收会话序号、快照/增量衔接、重复/乱序、游标过期、慢客户端和版本兼容，不以本轮 client 验证替代。
- [x] 连接和会话代次隔离旧租约、pending acquisition、cleanup 与迟到响应；重连需显式获取新租约，不恢复旧执行授权。明确 snapshot 来源和订阅需 unsubscribe/client.dispose 的生命周期，不持久化 token/progress。

**性能与最小验证：** 强制执行 §2。优先复用 [rpc-client-dispatch](../tests/rpc-client-dispatch.test.ts) 和现有协议/状态夹具；以可控断连和单个有界窗口验证。扩展最接近的事件交付 benchmark，记录每事件分配、积压字节、回放分页和断连/dispose 后订阅释放；现有基准不覆盖时增加最小场景并说明原因，不先建设独立压测框架。

**本轮实施前记录（基线 `1d2c43db9`）：** 优先验证 client 的连接代次与 lease 所有权。已有 server/session revision 快照、断连后显式重连/重新附着、lease invalidation；server 仅为实验性 service 接口，没有完整 coding-agent daemon 或后台任务事实协议。代码审计发现两个待复现窗口：一次 decoder.push 产生多条旧帧时，第一条回调重连后余帧只检查 disconnected 布尔值；acquire/release 的异步续体则可能在断连清空计数后修改新连接同 ID 的 lease/缓存。先用真实 CBOR/Connection/PiClient 与可控内存 transport 在既有 rpc-client-dispatch 中复现，再决定最小代次隔离修复。暂不增加 replay、task schema、自动重新授权或进程恢复。

完整链：ByteTransport.onData → Connection decoder/handleMessage → PiClient pending/result/event → ClientState revision gate/listeners → session handle；断连经 Connection.fail → 清除 attachment/失效 lease/拒绝 pending → 新 handshake/reset → 显式 acquire → 权威 snapshot。server 侧审计 acquire/attach/runOperation/snapshot、disconnect/maybeDispose；忙运行时继续由 server 持有，重新附着取当前 snapshot，idle 无连接时 dispose。普通消息交付为热路径，只允许增加 primitive generation/identity 判断；异步 acquire/release/reconcile 属显式生命周期。复用既有 dispatch/source invariant 文件；stream-events benchmark 新增小型 remote-client 模式，因为原 fixture 仅覆盖 Agent 事件，不覆盖 CBOR 客户端。需提供基线/候选采样、每帧回调/deferred/队列计数、断连/取消/dispose 的引用释放；不跑完整 TUI 基准，不新增测试文件。

### OC08 变更归属与用户回退

入口：[原生文件操作](../packages/extensions/mutation-guard-write/index.ts)、[会话证据](../packages/extensions/mutation-guard-write/session-evidence.ts)、[session-manager](../packages/coding-agent/src/core/session-manager.ts)。参考 [O11]、[O12]。

- [x] 先核查并复用已有收据及 `/changes` diff：本轮补齐当前查看会话、唯一请求 entry 和结果/preparation/preview entry 的历史定位，支持原生工具和持久 Codemode nested call；没有另建 ledger。历史定位不等于执行归属，fork、子代理和旧记录没有可靠 origin/task 标记时明确不推断。
- [ ] 若后续需要跨 Session/子代理任务归属，先定义可靠的生产者 lineage 与旧数据兼容，再实施；不能用当前查看 Session 或 tool-call ID 字符串冒充执行者。该扩展未在本轮实现。
- [ ] 回退作为单独的用户显式操作，确定记录容量、保留时间和精确文件身份；检查用户或其他代理的后续修改，冲突不得覆盖。快照/恢复范围须说明未跟踪文件、删除/重命名、元数据、二进制及平台差异。
- [x] 明确本轮为只读历史定位：shell、网络、数据库和未接入收据的子代理副作用不构成完整文件清单；记录淘汰后不保证重建，更不承诺回退。没有引入 Git reset/clean、工作区快照或自动执行。

**性能与最小验证：** 强制执行 §2。先复用 [native-file-operations](../tests/native-file-operations.test.ts)、[native-file-metadata](../tests/native-file-metadata.test.ts) 的相关 fixture；只有采用恢复功能才增加对应冲突用例。复用 [native-files lifecycle benchmark](../scripts/bench/native-files-lifecycle.ts) 中适用部分，审计大文件读取/复制、存储上限与句柄释放；禁止逐 delta 扫描工作区、拍整仓快照或把常规验证升级成默认多进程成本采样。

**本轮实施前记录（基线 `7e05000f8`）：** 已有 `/changes` 重建最近 512 个 Session entry 中最多 128 个文件条目，具备受限 diff、当前状态核验和剩余工作草稿；已有 request/intent/result 唯一性、顺序、hash 与权限边界。不重复建设 ledger 或恢复器。详情目前只显示 item ID/状态，未显示其唯一请求 entry 与结果 entry；先用既有真实 mutation fixture 的 `/changes View` 复现缺少来源信息，补充有界来源展示。当前查看的 Session 不等于历史执行 Session（fork 可复制历史）；任务/子代理归属没有可靠记录时不推断。只显示成功配对的请求 entry；截断、重复、失配保持 unavailable。

完整调用链：native write/edit/file_batch → 持久 request/intent/result（及 Codemode nested custom call/result）→ Session index → 显式 `/changes` → recentMutationEntries → collectChanges/collectStructuredMutationReceipts → 唯一请求绑定 → 详情文字/batchExpandedSummary → ChangeViewer 缓存与可见行 → 现有 UI/frame queue → dispose。只在显式命令及弹窗准备阶段增加 primitive entry ID 字段和来源文字；不修改收据生产、Evidence Ledger lookup、render/input、逐帧队列、差异生成或文件提交。请求 map ≤512、返回条目 ≤128；新增字符串引用随命令结束释放，详情沿既有 64 KiB/行数和数值滚动索引上限销毁。保持热路径 closure/Promise/AbortController/wrapper/array 新增为 0。先复用 file-change-recovery 的真实命令/恢复 fixture、source-invariants 和 file-change-viewer 的 opt-in allocation/释放场景；不跑未受影响的原生提交多进程采样或完整 TUI benchmark，不新建测试文件。回退仍需独立的持久 preimage/身份冲突设计，现有收据和 diff 不构成恢复备份。

### OC09 进程重启后的执行恢复

本项为有条件的后续设计，不能与 OC03 的“通知可恢复”混为一项能力。Pi 当前退出会清理任务，历史恢复不授予执行权；参考 [O6] 的执行 claim、恢复次数限制与 shell 差异。

- [x] 区分 UI 重连、同进程会话重新附着、退出后的显式继续和服务重启自动继续：UI 重连复用 OC07 快照；替换/树切换后原运行授权已撤销；退出后使用历史与显式检查点。当前不引入常驻服务。
- [x] 完成条件评估：本轮不采用自动执行恢复。写前执行标记、单运行时所有权、持久停止语义、恢复失败次数上限、权限重查及子父恢复次序列为未来实施门禁，尚未实现，详见下文。
- [x] 核查副作用和授权边界：shell 不续跑；子代理仅按新授权、新 ID 显式继续，不自动重放历史工具。读取历史不发送恢复通知，不反向唤醒会话；跨主机和旧 PID 不授予执行权。
- [x] 输出采用/延期决定及兼容方案。本轮完成设计核查，自动执行恢复延期；若以后采用，另开独立实现 PR。

**性能与最小验证：** 强制执行 §2。采用后复用 task-history/checkpoint 的真实退出与恢复 fixture 及现有生命周期 benchmark；只对新增持久边界加入确定性崩溃点，计数恢复尝试、打开句柄和持有引用。不用反复杀真实应用、真实模型长跑或全仓恢复试验作为默认测试。

**本轮核查范围（2026-10-13，基线 `3fdac32d8`）：** 先验证现有显式继续能否满足当前需求，再决定是否采用自动执行恢复。生产链为会话配置 → `SubagentTasks.configureHistory` → `TaskHistory.load/open` 的身份、写入者与记录校验 → 有界终态历史；显式 `resumeTaskId` → 当前授权与角色/工作区检查 → `readCheckpoint` → 新任务接纳/启动 → `SubagentControl` / `ChildControl` 的 ready/begin/turn 确认 → 原有子进程执行 → 终态持久化与通知 → 会话/UI → 清理。读取恢复记录不会进入执行或通知链。

本轮仅作设计决定和说明修正，不修改生产代码、协议、存储或热路径。复用 `task-history`、`task-checkpoints`、`task-control` 和 `task-history-hot-paths` 的已有小型用例，以及 `subagent-management` 中一次真实离线子进程的显式续跑用例；不新增测试文件，不重复本地全量测试、构建或性能采样。历史数据库由会话/任务类别唯一写入者持有；任务最多 256 个活动项加 256 个终态项，检查点每项最多 1 MiB/128 条消息。恢复记录无 controller，等待立即完成；历史关闭释放 statement/数据库，任务结束释放 controller/waiter，结果引用在淘汰/dispose 时清除，控制通道 dispose 清除消息监听器、待确认计时器及 seed/checkpoint 引用。若核查发现需要生产修复，再按 §2 补充受影响调用链和性能证据。

**采用决定及现有边界：** 保留当前运行模式。当前需求可由同运行实例的 UI 重连、可查询的终态历史和重新授权的显式检查点继续覆盖；没有发现必须引入服务重启自动执行的行为缺口。此结论不代表自动恢复已实现，也不证明能安全重复已执行的外部操作。

| 场景 | 当前可依赖的行为 / 限制 |
| --- | --- |
| UI 连接断开，原服务仍在运行 | 使用 OC07 revision snapshot/lease 恢复观察；不因此创建替代任务。会话替换、树切换、权限撤销的任务不能靠重新附着恢复授权。 |
| 写入者退出，已保存终态 | 保留 completed/failed/cancelled 及有界结果；恢复记录无 controller，等待立即返回，取消不操作旧 PID。 |
| 写入者退出，尚未保存终态或终态保存失败 | 全量校验有界记录后改为 interrupted。只表示缺少持久终态，不能断言执行失败、无副作用或子进程已退出。 |
| 取消过程中退出 | `SubagentTasks.cancel` 只在内存标记 cancelling 并发出 abort，终态在 finish 时保存；此前退出会恢复为 interrupted。它不是持久停止标记，不能用来决定自动恢复。 |
| 有完整检查点的子代理 | 原任务须终态；新请求检查当前授权、角色、canonical cwd 及 dev/inode，创建新 ID。begin 在确认前保存 pending，只有完整回合能更新可续跑上下文；历史工具调用不直接重放。 |
| pending 检查点或不完整回合 | 保留最后完整上下文并提醒检查副作用；pending 是回合级不确定性标记，不是工具完成账本。续跑的新指令在首个完整回合保存前不进入持久上下文。 |
| 普通 shell、缺失/过期检查点、内存会话 | shell 无检查点续跑；检查点缺失时须在核实现场后授权新任务。内存会话拒绝持久检查点，容量临界时按交接拆分新任务。 |
| 存活/不可确认的旧写入者、跨主机或存储身份变化 | 拒绝接管历史并阻止新任务；仅本机 PID 确定不存在才接管遗留写入者。PID 复用会保守拒绝，不能通过超时、杀旧 PID 或历史授权绕过。 |

**未来采用的门禁（未实施）：** 必须先有服务重启后自动继续的明确需求，并单独评审以下设计。现有 SQLite owner 是历史写入互斥，不能升级解释为执行 claim。

1. 在启动前持久写入执行意图、唯一执行身份和单运行时 claim；所有执行入口都校验该 claim，旧进程或旧世代不得继续提交工作。丢失所有权及存活子进程的收敛方式须明确；跨主机恢复默认拒绝。
2. 将用户取消、暂停和权限撤销持久化，并在接纳恢复前检查；定义与 claim/终态的原子顺序，迟到的通知不能撤销停止状态。恢复失败计数须在尝试前落盘，给出有限上限、达到上限后的显式人工继续及重置条件；具体数值在独立实现 PR 的验收中确定，不增加模型 token/回合配额。
3. 恢复时重查当前角色、权限、模型配置和精确工作区身份，不恢复旧授权。先核对父会话有效性与停止状态，再核对子任务和可能仍存活的进程、已发生的外部副作用，最后决定是否创建新的执行及交付结果；不能让父子同时重复接纳同一项工作。
4. 已执行但未确认的非幂等工具默认转为需要人工核对，不自动重放；只有具有可验证幂等/对账协议的操作才可另行评估。普通 shell 继续保持独立的“中断待核查”语义，不能凭命令字符串或旧 PID 续跑。通知接纳去重与执行去重分别设计。
5. 在写入意图、claim 接管、工具返回未提交、取消未完成、父子恢复交界处加入有限确定性故障点，复用现有 fixture；验证恢复尝试计数、重复副作用防护和资源释放。涉及热路径时补齐 §2 的结构计数、allocation profile 与受控 GC 证据。

**兼容与迁移：** 本轮不改 schema、协议或配置；继续使用已有 `*.tasks-*-v1.sqlite` 路径及内部 schema v2，已有 v1 → v2 检查点迁移保持不变。旧历史没有执行 claim、持久停止或完整副作用账本，未来迁移只能默认按历史观察导入，不能从 queued/running/pending 推导自动执行许可。自动恢复必须显式启用并定义版本、失败回滚与降级策略；当前旧版程序拒绝 v2 的边界继续保留，不静默降级或覆盖原始记录。用户操作步骤见[后台任务说明](background-tasks.md#重启后继续工作的步骤)。

**核查证据：** Windows / Node v26.4.0，生产基线 `3fdac32d8`。下列既有检查各执行一次：四文件共 36 通过、1 个 POSIX 专项跳过；独立子进程续跑用例 1 通过。验证覆盖未 dispose 的真实写入者退出后恢复、写入者互斥/跨主机拒绝、存储错误/迁移/身份变化、pending 保留、当前授权及新 ID、容量交接及控制通道监听器释放，source invariant 确认普通任务持久化只由 create/start/finish 到达。退出 fixture 是真实子进程正常退出但不主动关闭历史，**不是强杀、掉电或真实模型故障测试**；不据此声称已验证这些故障。生产实现与性能未变，不重新采样旧 benchmark 或宣称性能改善。

```sh
node --experimental-strip-types --test tests/task-history.test.ts tests/task-checkpoints.test.ts tests/task-control.test.ts tests/task-history-hot-paths.test.ts
node --experimental-strip-types --test --test-name-pattern='real completed checkpoint continues' tests/subagent-management.test.ts
```

### OC10 Codemode 工具发现与目录更新

入口：[CodemodeController](../packages/coding-agent/src/core/codemode.ts)、[工具分类](../packages/tool-classification/README.md)、[动态指令](../packages/dynamic-instructions/README.md)、[声明渲染](../packages/codemode/src/declarations.ts)。对照 §6 及 [O15]、[O18]、[O19]。

- [x] 验证当前 `ALL_TOOLS`、`describeTools`、真实 `tool_search` 与 MCP deferred 的可见性、激活和权限关系；已有能力不重复建设。完成 8/512 项目录的调用数、声明字节与 schema 访问测量，结果见 §6.4。
- [x] 条件评估完成：本次未证明需要新增搜索、namespace 分页或目录日志；保留现有入口与预算。搜索不可激活策略禁止的工具，过期名称/缓存不绕过当前调用授权。真实模型 token/缓存收益尚未测量，后续有证据再扩展。
- [x] 核查工具增删/schema 更新：MCP 激活与 schema 更新不改写内联前缀，删除失效，当前 schema 验证与权限保持。新增本地工具仍会更新有界声明；不新增动态日志，详见 §6.4。
- [x] 核对目录所有者、容量、数组短路、wrapper 更新、策略限制、reload/分支恢复和 dispose；修复关闭后仍持有名称映射及内联声明的问题。当前注册入口以替换 definition 刷新，不承诺任意绕过入口的原地 schema 修改会自动失效；执行授权不依赖数组身份。

**性能与最小验证：** 强制执行 §2。复用 [codemode-session](../tests/codemode-session.test.ts)、[codemode-guardrails](../tests/codemode-guardrails.test.ts)、[codemode-hot-paths](../tests/codemode-hot-paths.test.ts) 和相关工具发现已有 fixture；按改动选择 [codemode-preexecution](../scripts/bench/codemode-preexecution.ts) 或 [codemode-session benchmark](../scripts/bench/codemode-session.ts)。记录不变回合的目录构建/签名渲染/序列化次数、返回字节、缓存峰值和切换/dispose 释放。默认不新增测试文件、不逐回合全量扫描或排序目录、不全量序列化后再计算 hash 来假装复用。

### OC11 Codemode 执行成本与数据边界

入口：[host](../packages/codemode/src/runtime/host.ts)、[worker](../packages/codemode/src/runtime/worker.ts)、[prelude](../packages/codemode/src/runtime/prelude-source.ts)、[WASM 缓存](../packages/codemode/src/wasm.ts)、[controller](../packages/coding-agent/src/core/codemode.ts)、[嵌套调度](../packages/agent/src/nested-tool-dispatch.ts)、[结果处理](../packages/coding-agent/src/core/codemode-result.ts)。对照 §6，不直接照搬上游宿主内解释器。

- [x] 在 Node CLI 使用的本地 tsc 编译模式拆分首次模块加载、WASM 读取/编译、Worker 创建、VM/prelude 初始化、执行/bridge 和退出成本，见 §5 第四阶段。复用短调用、批次和 CPU fixture；编译产物不是已安装发布包，执行/bridge 内部没有继续细分，不能当作发布版 SLA。
- [x] 基线定位线程启动/模块加载成本后，按用户明确要求实现单槽 Worker 池，复用线程和模块，保持每脚本独立 VM。相同 30 个短脚本与 100 次工具批处理分别测量，未绕过权限、guard 或模型读取证据；真实模型/I/O 收益仍不外推。
- [x] 完成脚本/Worker/host/controller/nested dispatch/guard/结果约束与收据/VM/展示释放的源码审计，实测启动 JSON 与参数/结果消息的字符和 UTF-8 字节。区分消息载荷计数与内部复制/总堆分配；未证明产品层重复验证可以安全删除，保留现有边界。后续优化仍需对应分配证据。
- [x] 保留脚本级取消、VM 内存/输出/bridge/调用上限、可信读最多 4 并发、修改串行、工具当前授权和副作用状态。复用 runtime/session 用例核验未 await、忽略取消的宿主调用、迟到结果、目录/状态恢复；Worker 停止仍不等于任意宿主 JavaScript 已停止。
- [x] 按用户后续授权加入有界 Worker 资源复用，保留 QuickJS；独立端口隔离执行，VM dispose 后才归还，错误/取消/过大内存淘汰，空闲和使用次数有界。宿主 allocation、Worker 内部采样/VM 引用释放及相同负载收益见 §5；完整 CLI 发布包、Bun 分配门禁与真实模型负载仍待测。
- [x] Node 本地打包安装核查：按 Codemode 的 files/exports 打包，在独立目录安装后从公共入口与同一 Worker/依赖/WASM 测量。池对照通过原有门禁，未发现需修改生产实现的安装问题；这是当前源码的库级 npm 包，不是已发布完整 CLI，见 §5 后续记录。
- [x] Bun 1.4.0 / Windows 库级兼容核查：显式嵌入 Worker/WASM 的独立 EXE 完成短脚本、工具调用、隔离和关闭检查，宿主引用释放通过，见 §5。仅记录有界时延与存活堆；未完成 JSC/Worker 分配和 CPU 门禁，不改变运行时或池默认值。
- [x] 当前正式源码 CLI 集成：沿用默认资源与真实原生工具，验证目录、读取证据约束、提交收据、跨脚本 VM/store 边界、错误后显式继续及自然退出的 Worker 关闭，见 §5。仓库尚无完整 CLI 发布包，不用库级 EXE 或私有扩展打包替代未来发布验收。

**性能与最小验证：** 强制执行 §2。复用 [codemode-runtime](../tests/codemode-runtime.test.ts)、[worker-recovery](../tests/codemode-worker-recovery.test.ts)、[codemode-guardrails](../tests/codemode-guardrails.test.ts) 中实际受影响者；运行对应 [hot-path invariants](../tests/codemode-hot-paths.test.ts) 和 [runtime benchmark](../scripts/bench/codemode-runtime.ts)，涉及策略/展示时才扩大到已有 dispatch/session/tree 基准。提供每脚本 Worker/VM 次数、每调用复制与序列化字节、并发/队列峰值、allocation 和 GC/引用释放证据；若改到 Worker 内部分配，宿主 inspector 样本不够，须补该线程/VM 的相应证据。§6 是诊断基线，不是未来优化的验收结果。

**安装包核查实施前记录（2026-10-13，基线 `a812bb14f`，#144 已合并）：** 现有成本数据来自仓库 dist；本轮验证按当前 `files`/exports 打出的 Codemode npm 包安装到独立目录后，Worker、依赖和 WASM 是否从该安装解析，单槽池是否仍满足已有计数/分配/释放门禁。复用现有 runtime benchmark 及 Worker pool helper，新增显式安装包入口，诊断 Worker 也必须读取同一安装文件，避免主线程测安装包而 Worker 探针仍读仓库 dist。仅按需构建 codemode、打包并在本任务独占临时目录离线安装，不发布 npm 包或改全局安装；记录包和运行文件指纹，最终按创建的准确身份清理。

审计链为安装包 exports → host/defaultWorkerUrl → WASM resolver/cache → WorkerPool.acquire → 独立 MessageChannel → Worker/QuickJS/prelude → 工具 bridge/BoundedJson → VM dispose → pool release/retire → host close。产品 controller/nested dispatch 的权限、结果收据和 UI 链保持原有实现；此库级 fixture 不代表完整 CLI、Bun 打包或真实模型/I/O。生产代码和热路径预计不变；新增解析、指纹、采样及 WeakRef 只在按需 benchmark 生命周期，仍保持单槽/无等待队列、每脚本新 VM、相同短脚本和批次负载。已有 Node 环境可测，Bun 1.4.0 已安装但没有据此视为已验证其可执行文件。先复用既有 runtime/worker-recovery/hot-path 用例、基准独立 strict 类型检查和一次安装包池对照；不新增测试文件、不跑本地全量，只有复现产品缺口才扩大修复与性能范围。

## 5 完成与证据记录

### OC11 后续：正式源码 CLI 集成核查

2026-10-14（Asia/Tokyo），基线 `7e68cc3f3`，#146 已合并。仓库 README 与 coding-agent manifest 明确支持 `scripts/superpi.mjs` 源码启动，没有完整 CLI 发布包或既定 Bun 发布构建入口；不能把手工库级 EXE 当作产品发布产物。本轮继续验证实际可用的源码 CLI：默认资源装配 → 编译 CLI/main → JSON print session → model-facing Codemode → controller → pooled Worker/QuickJS → nested dispatch/原生读写 guard/收据 → 模型结果 → runtime dispose/Worker 退出。复用已有 `native-source-delivery` 和它的离线 provider/preload，在同一次有期限的 CLI 子进程中补齐工具目录、跨脚本 VM 隔离、错误后显式继续与 Worker 启停计数；不新增测试文件、不使用真实模型或网络，不建设发布系统。

现有 native fixture 已验证 exact/overwrite/snapshot 提交，本轮保留这些行为及权限/证据链，优先观察自然退出是否释放同一个单槽池。只在显式测试生命周期追加有界计数和断言，不改生产逐消息/工具进度/UI 路径；未发现生产缺口前不重跑已验收的分配对照或修改退出语义。子进程、stdout/stderr 和私有工作目录由既有 fixture 持有，保持期限、输出上限与按身份清理。若复现运行时缺口，先记录反例，再按 §2 补生产调用链审计、最小修复、相关 AST/allocation/GC 证据。

**实现与结果。** 只扩展既有 [source delivery 用例](../tests/native-source-delivery.test.ts)、[离线 provider](../tests/fixtures/native-source-entry.mjs) 和 [离线 preload](../tests/fixtures/native-offline-preload.mjs)，无生产改动、无新测试文件。一次真实 `scripts/superpi.mjs --mode json --print --no-session` 子进程使用默认资源，由离线 provider 顺序驱动 10 个脚本 / 11 次模型请求。provider 只看见 Codemode 入口，普通 read/edit/write 在 VM 的 `ALL_TOOLS` 与 `describeTools` 可用；四次原生 read 支撑原有三次 exact/overwrite/snapshot 提交，成功收据和最终文件内容断言保留。

新增的首个脚本在没有展示读取证据时尝试编辑，实际得到 `READ_REQUIRED`；下一次 provider 请求前直接读取夹具文件确认仍为 `before\n`。该 guard 发生在工具内部，不能推断为 Agent 的 `not_executed` 阶段；初始断言误用该字段的两次失败只修正了夹具判断，没有修改生产分类或给结果补造标记。成功脚本的自定义 global 在下一脚本不存在，显式提交的 store 值则保留；异常脚本尝试改写 global/store 后抛错，后继脚本显式确认 global 未泄漏且 store 仍为上次成功值。没有自动重试原调用或重复已完成修改。

可选 Worker 观察器只在此 CLI 测试的主线程启用，透传原 Worker 参数和消息，不改变 ref/unref、关闭或调度。10 次脚本复用/淘汰共启动 3 个 pooled Worker，物理退出 3 个，活动峰值 1、进程退出时活动数 0，网络尝试 0。stdout/stderr 各最多 2 MiB，子进程期限 55 秒、用例期限 60 秒，cwd/agent/HOME/USERPROFILE 隔离到单个已记录的临时目录；成功和断言失败均执行既有清理钩子。本轮未遗留探针目录或进程，之前轮次被策略拒绝清理的目录未触碰。

**最小验证与边界。** coding-agent 单包构建、类型检查、上述单个 CLI 用例及 9 项既有 Codemode hot-path 不变量通过；共享 preload 未启用观察器时保持原 Worker 也已单独核对。没有重复打包用例、本地全量测试或 Node/Bun allocation 采样。计数、命令、14 个源码/fixture 指纹追加于 [OC11 证据](performance/oc11-runtime-costs.json) 的 `sourceCliIntegration`，16 个历史章节原样保留。此轮关闭当前支持的 Node 源码 CLI 集成边界，不宣称性能提升、完整 CLI 堆/VM 引用回收或发布版验收；真实模型/I/O、交互式终端和未来发布包仍需各自有限验证。最终 head 的远端 CI/Codex 结果记入 PR。

### OC11 后续：Bun 运行模式核查

2026-10-14（Asia/Tokyo），基线 `e32b39aa1`，#145 已合并。先用已安装的 Bun 1.4.0 验证现有 Codemode 的短脚本、工具 bridge 和 Worker 关闭，再按 Bun 官方独立可执行文件约定提供显式 Worker 入口和嵌入 WASM。只有正确执行、取消和释放通过后才运行有限性能样本；Node inspector/CPU/GC 的历史数值不能替代 Bun/JSC 的证据。无明确生产缺口时不改运行时；运行环境本身不满足要求时保留限制与采用决定，不为得到性能数字削弱隔离。

审计链为源码或编译入口 → host/WASM cache → Worker 构造/线程消息与 pooled MessageChannel → QuickJS/prelude → host bridge/有界 JSON → VM dispose → Worker pool 归还/淘汰 → close。先复用既有 runtime/Worker fixture 和按需基准，不增加默认 CI 测试文件。探针仅在有界任务生命周期生成，使用本任务独占目录和有期限的子进程，按记录身份清理；不触及 controller 权限、结果证据或 UI 热路径。若需生产修复，先给出单变量复现，再按 §2 补齐相关不变量、分配及引用释放门禁。完整 CLI 和真实模型仍不在此库级核查内。

**结果与复现。** 新增单个按需 [Bun benchmark helper](../scripts/bench/codemode-bun.ts)，不加入默认测试发现；现有 Node inspector/Worker.cpuUsage 基准不能直接作为 JSC 分配证据，因此不混入同一采样实现。复用 #145 独立安装的 `@super-pi/codemode@0.84.1` / `quickjs-wasi@3.6.2`，10 个运行文件指纹仍匹配历史安装记录，其中 Codemode dist 也与当前仓库一致。按 [Bun 编译约定](https://bun.sh/docs/bundler/executables)将主入口和 Worker 入口一同编译、用 file import 嵌入 WASM；保持现有显式 `workerUrl` / `wasm` 选项，无需修改生产代码。EXE 复制到仅含该文件的目录后，在外层 30 秒期限内正常退出；报告的入口和 WASM 均为 Bun 嵌入路径。源入口也通过相同行为检查。完整 wrapper、runner、原始样本和指纹追加在 [现有 OC11 证据](performance/oc11-runtime-costs.json) 的 `bunRuntime`，旧证据不覆盖。

| 本次 Bun 1.4.0 / Windows 编译库 fixture | 每次新 Worker | 单槽复用 |
| --- | ---: | ---: |
| 30 个 warm 短脚本中位数 / p95 | 23.01 / 25.25 ms | 9.47 / 10.27 ms |
| 100 × 4 KiB 顺序工具批次 | 30.16 ms | 14.48 ms |
| 测量段 Worker 启动 / 关闭 | 32 / 32 | 1 / 0 |
| 故障及关闭检查后 Worker 启动 / 关闭 | 39 / 39 | 4 / 4 |
| 宿主 WeakRef 跟踪 / GC 后保留 | 36 / 0 | 36 / 0 |

两组各先做一次预热；WASM 首次读取/编译为 5.57 ms，另行记录。fixture 验证 global/store 隔离、脚本错误、超时、显式取消、运行中关闭、关闭后拒绝以及出错后显式再次执行。取消时 host signal 已中断，外部 abort listener 为 0，迟到 host Promise 被显式放行；最终活动执行为 0。引用覆盖 sandbox、工具数组/对象、30 个结果及 controller/signal，不声称覆盖 Worker 包装器、线程内部堆或 VM 原生引用。

**GC 诊断边界。** 首版在 Promise 恢复栈内执行五次 GC，源码和编译入口均观察到两个工具对象未释放。最小注册/调用/各生命周期对照在 Node 与 Bun 都释放，完整序列换到独立检查入口也释放，未据此认定产品泄漏。仅将五次 GC 改到独立 `setImmediate` 原生事件回调中执行后，两组源码及编译检查均保留 0；没有清空工具对象或降低断言。此证据定位了测量方式的影响，尚未确定 JSC 内部持有机制。

**性能结论与下一步。** 没有生产热路径变更、默认开关变化或新增对象池。此单进程、先新建后复用的有界样本只支持当前平台的库级兼容性及局部时延观察；[heapStats](https://bun.sh/reference/bun/jsc/heapStats) 是回收后的存活堆，[Bun heap profile](https://bun.sh/docs/project/benchmarking) 也不能替代累积分配采样。未测 JSC/Worker allocation 或独立 CPU p95，不宣称 Bun 已通过池准入门禁，不与历史 Node/OpenCode 样本作引擎排名。完整 CLI 发布产物、权限/UI 集成和真实模型/I/O 仍待各自有界验收。

**最小验证。** 新 helper 独立 strict 类型检查、9 项既有 Codemode 热路径不变量通过；无新测试文件、无本地全量测试、未重复 Node 池采样。新增文件仅为按需测量入口，资源由本任务独占目录和有期限的子进程持有。所有探针子进程已结束；按准确身份删除 `C:/Users/Administrator/AppData/Local/Temp/pi-oc11-bun-PGOKlX` 时被自动审批策略拒绝（blocked by policy），未换工具绕过，目录保留。最终 head 的 CI/Codex 结果记入 PR。

### OC11 后续：Node 本地打包安装核查

基线 `a812bb14f`，#144 已合并。Codemode 单包构建后，用 `npm pack --ignore-scripts --offline` 生成 74278 字节的 `@super-pi/codemode@0.84.1` 包，在独占临时 consumer 安装；没有发布包或改全局环境。初次离线安装因 QuickJS 缓存缺失失败，随后仅下载锁定的 `quickjs-wasi@3.6.2` tarball，校验 SHA-512 与仓库 lockfile 一致，再对两个本地归档离线安装。Codemode 归档 SHA-256 为 `5dc095ada5c11adb12665b63a090a610318ce0cd7c5db97647d78ac1621feca6`。安装不是 workspace 链接，Worker、QuickJS 与 WASM 都在同一临时安装树；关键运行文件与本次 dist 的哈希一致。

现有 `scripts/bench/codemode-runtime.ts` 增加 `--package-root <安装目录>/node_modules/@super-pi/codemode`，按 manifest 的公开 import 入口加载，输出实际入口、Worker 路径、版本及加载耗时。`--pool` 的 Worker/VM 诊断显式接收同一 worker URL，不能回落到仓库 dist。`--compiled` 和默认源码入口保留；安装包暂不支持 `--stages`，不混用现有仓库分段探针。基准之外用真实 bare import 验证公共导出，依次成功、失败、显式再执行后 2/2 Worker 关闭、活动执行为 0。

Windows / Node v26.4.0 的一次同进程池对照复用原 fixture：每种模式先预热，再记录 30 个短脚本及 100×4KiB 顺序工具批次。宿主分配只采样这两段，额外的 CPU 分组不混入；CPU p95 使用两组相同 keepalive 探针的 Worker.cpuUsage，每组 30×10 次。以下仅比较本次两种模式，不与旧日期样本混算。

| 指标 | 每次新 Worker | 单槽复用 |
| --- | ---: | ---: |
| warm 中位数 / p95 | 31.84 / 33.54 ms | 4.24 / 4.71 ms |
| 100 次工具批处理 | 38.10 ms | 9.26 ms |
| 宿主采样分配 | 2211664 B | 1112568 B（-49.7%） |
| Worker CPU 批次均摊 p95 | 12.2 ms/脚本 | 1.6 ms/脚本 |
| 关闭并 GC 后宿主 heapUsed | 10212632 B | 10259792 B（+0.46%） |
| 宿主对照 Worker 启动/关闭 | 332/332 | 6/6 |

两组宿主各 33 个跟踪引用最终保留 0；单独 CPU 探针为 301/301 与 5/5 Worker。安装后的 Worker 诊断创建/释放 31 个 VM，248 个 VM/实例/内存/data/catalog/store/interrupt/port 引用保留 0，close 后物理 Worker 引用为 0；WASM 线性内存峰值 10027008 B，Worker V8 采样 12541056 B、主要在 instantiate。该诊断包含探针开销，不代表 QuickJS 内部 malloc 总量或相对新线程的 Worker 分配改善。空闲池的进程 RSS 本次约多 11.25 MiB，数值有噪声，既有单槽、64 次、30 秒、64 MiB 淘汰约束不变。模块/WASM 已预热，不能把 warm 或新 sandbox 首次执行耗时写成 CLI 冷启动成本。

本轮仅修改两个按需基准文件和已有文档/证据；生产 Worker/VM、每工具 JSON/Promise/AbortController 和有界结果处理、controller 的授权/收据及 UI 路径没有变化，不声称整链零分配、零复制或真实模型提速。完整原始样本、命令、安装/依赖/基准指纹见 [OC11 证据](performance/oc11-runtime-costs.json) 的 `installedNodePackage`；原有历史证据保留。

最小验证：既有 runtime/worker-recovery/hot-path 共 41 项通过，codemode 单包构建和两个基准的独立 strict 类型检查通过。入口选择发生改变，因此另跑一次原 `--compiled` 入口确认 32/32 Worker、100 次调用、128 引用最终保留 0，不作为新一轮优化对照。没有新测试文件，没有本地全量、完整 TUI 或重复池采样。基准进程均已结束；按创建身份递归清理临时安装目录时被自动审批策略拒绝（blocked by policy），目录及归档保留，交付中提供准确位置。完整 CLI 发布安装、Bun 可执行文件及真实模型/I/O 仍待各自的有限验收；Bun 1.4.0 在场不算其运行模式已验证。最终 head 的 CI/Codex 结果记入 PR。

### 第七阶段：OC08 变更历史定位

基线 `7e05000f8`，#142 已合并；本轮复用已有 `/changes`，没有替换原生提交或持久化格式。原详情没有显示请求 entry，扩展既有实际 View 用例在基线上失败；新增一项 bounded entry ID 引用，沿已有唯一性、顺序、request hash/intent 绑定投影到结果。缺失、截断、未来请求、重复 entry 或匹配失败保持来源不可用。普通 assistant 请求和 Codemode 持久 nested custom 请求均指向其真实 entry。

详情展示 Session view / Request entry / Record entry，使用已有 metadata 转义和整体 report 预算，原差异、preview/未执行状态、核验及剩余草稿语义不变。重载及真实 Session fork 后 entry ID 保留，但当前查看会话不是历史执行归属；没有从任务名、shell 或路径猜测子代理任务，也没有将旧收据视为可回退备份。跨会话任务 lineage、冲突安全的恢复仍是独立条件项。

性能分类：修改位于显式 `/changes` 的重建与弹窗准备阶段，属于冷生命周期。请求 map/ChangeRecord 仅增加 primitive ID 引用；无新增索引、I/O、事件订阅、定时器或对象池。最多 512 个请求/128 个返回条目，ID ≤256 code units；单次 View 才构造来源说明，再由既有 64 KiB/400 行预算限制完整展示。render/input 和帧链代码未改，既有 viewport fixture 是回归保护，不是新增命令成本的测量。基线/候选 20000 次稳定 render 都新增 0 行，200 次 viewport 变化总计 4422 行、scrollBytes ≤786444；采样分别 1329984/1270624 B，不据单次波动宣称提速。受控 GC 与 dispose 后 body/scroll/cache/lifecycle references 均为 0。完整结果见 [OC08 记录](performance/oc08-change-attribution.json)。

验证复用 file-change-recovery：全文件首轮 111 pass、1 个 POSIX skip，新增 fork 夹具因展开无关 getter 而失败；改为只替换该上下文的 SessionManager 后仅重跑新增用例通过（最终覆盖 112 pass/1 skip）。另有真实 Codemode 嵌套写入恢复 1 项、相关 source invariants 2 项、viewer 7 项通过；类型检查通过。只新增一个测试用例、未新增测试文件，未运行本地全量套件。构建、最终 CI/Codex 审查与最终 head 在 PR 交付记录补充。

### 第六阶段：OC07 客户端重连与租约隔离

基线 `1d2c43db9`，对应 #141 已合并。初始真实 CBOR fixture 中，旧连接合并帧在回调重连后污染新握手、attach 响应与 async 续体之间断连却返回有效 lease 两项失败；权威 snapshot 恢复一项通过。修复使用既有连接 ID 和 lease/request 的 primitive generation，不增加 replay 队列、协议字段或自动重试。

- Connection 每条已解码消息检查所属连接；同批旧帧不进入新握手。Pending response 验证 session ID/代次后才应用状态；session_removed 后迟到的高 revision 不覆盖新 attachment。
- create/acquire/reconcile 在 async 续体检查代次，旧失败 cleanup 不扣减新连接同 ID 的 lease 数，不恢复旧 snapshot；断连和 session removal 释放 attachment/detachment/reconciliation 映射，finally 按 Promise 身份清理。
- 明确订阅生命周期：失效租约阻止 snapshot 回调，但 unsubscribe 或 client.dispose 才释放注册的监听器。断连后缓存可供离线查看，connect 重置、显式 attach 恢复权威状态。旧命令可能已被服务端接纳，不能因断连就推断副作用已回滚。

证据：[OC07 allocation/reference record](performance/oc07-reconnect-state.json)。同机 5000 次真实 CBOR progress 交付，采样分配由 **33849.8752** 到 **33900.7456 B/事件（约 +0.15%）**；不据此宣称性能加速或全链零分配。主要成本仍在既有 TypeBox 校验/CBOR decode，新增普通交付的 closure/Promise/AbortController/wrapper/array 均为 0，并移除无监听者时的空数组。没有新回放积压/分页、整份历史复制或 progress 写盘。客户端现有 pending/cache 容量与 numeric generation 历史未改写为有界存储，具体所有者/释放点见证据记录。

受控 GC 保持 3 个 owner 存活，最终 4/4 transport 关闭、19 个跟踪引用剩余 0；包含实际 connect/attach/disconnect/transport error/reconnect/dispose，释放结论以最终 unsubscribe/dispose 为边界。既有 dispatch 文件 11 项通过后，仅补跑 3 个边界用例及关联 AST，共新增检查 4/4 通过（共覆盖 14 个不同用例），未新建测试文件。类型检查、client build、benchmark 独立严格类型检查、原 Agent 基准最小 smoke 与 diff 检查通过；未重复本地全量测试。PR 的最终 head、CI 与远端 Codex 审查结果在交付记录中补充。

本轮关闭的是实验性 client 的 OC07 核查与已复现修复。完整后台任务事实适配、事件回放和服务重启续跑仍需具体需求；不据此提前关闭 OC09。

### 第四阶段：OC11 编译模式成本、数据边界与 Worker 池

基线为 #139 合并提交 `f099234ec938c3eafd31f7f458ca71acde1b23eb`。CLI 的 bin 指向 `dist/cli.js`，产品 controller 使用默认 Codemode worker；本阶段使用源码生成的 `dist/runtime/host.js` / `worker.js`，不冒充安装包或 Bun 可执行文件。完整源码链审计覆盖 sandbox/catalog/wasm cache → Execution → Worker → QuickJS/prelude → host handleCall → controller runChild/recordInvocation → NestedToolDispatch/agent 授权 → boundCodemodeResult/收据与引用 → host bounded JSON → VM settle → controller 展示/store/释放。以下先记录未修改生产代码时的历史基线，再记录用户要求的 Worker 池实施与验收。

**测量方式。** 复用 `scripts/bench/codemode-runtime.ts --compiled`，新增按需 `--stages` 分支及单个 benchmark helper。控制组运行原始编译 Worker；诊断组对当前编译文件作唯一锚点校验，生成只加时间戳/计数和绝对 import 的内存副本，经 data URL 启动。benchmark 内临时替换 Node Worker 构造器以传递 240 字节共享计数区，finally 关闭 sandbox 并恢复导出；无磁盘临时文件、常驻服务或生产诊断 API。计时与分配采样分开。每项预热 2 次原始执行，控制/诊断各 5 次、交替先后次序；这些是小样本定位数据，不是性能改善或稳定 p95 证明。

| 同机编译模式 fixture | 原始 Worker 中位数 ms | 诊断组中位数 ms |
| --- | ---: | ---: |
| `return 1` | 31.48 | 30.93 |
| 读取一次 4 KiB 后返回长度 | 30.45 | 30.41 |
| 同脚本顺序读取 100 × 4 KiB | 36.40 | 36.18 |
| 10 万次整数累加 | 32.57 | 32.00 |

no-op 的诊断分段中位数：线程启动至 bootstrap 16.99 ms、Worker 模块加载 5.33 ms、VM create 2.46 ms、prelude 编译/安装/lockdown 与目录 JSON 4.28 ms、脚本编译 0.03 ms、执行及 bridge 0.28 ms、退出 0.93 ms。同步 Worker 构造约 0.17 ms，已包含在线程启动区间，不能重复相加；各分段的中位数之和也不等于总时延中位数。主线程模块导入 5.93 ms、WASM 读取及首次编译 2.39 ms 单独记录，不混入 warm 调用。诊断副本有额外 bootstrap/计数成本，不把其分段作为完全无探针的生产追踪。

**数据边界与所有权。** 脚本字符串随 WorkerData 传递；已编译 WASM 缓存复用，但每次仍新建 Worker/VM。目录/全局/store 在 Worker 启动时各做一次既有 JSON 序列化进入 VM，本 fixture 分别为 50/2/2 字符。100 次顺序读取实测 100 条调用与 100 条响应，参数 200 字符/UTF-8 字节、结果 409800 字符/UTF-8 字节，pending 峰值 1、完成后 0。字符等于字节只因 fixture 为 ASCII，不能外推 Unicode。每个诊断脚本 VM create/完成各 1 次。

| 路径 | 必要处理与本轮结论 |
| --- | --- |
| VM 参数 → Worker → host | prelude JSON 编码、VM handle 转字符串、消息交付、host JSON.parse；消息长度计数不能证明 V8/QuickJS 内部复制次数或总分配。 |
| host → controller / nested dispatch | 参数大小核查、当前工具/权限/guard、可信读最多 4 并发与修改串行；本次顺序库 fixture 不冒充产品并发或授权基准。 |
| 产品结果/修改收据 | 修改参数及执行收据保存、bounded details 副本、输出约束、结果引用/读取证据各有独立语义；即使看到再次序列化，也不能直接删除或绕过。 |
| host 结果 → Worker → VM | BoundedJson 约束编码、消息交付、VM 字符串/JSON 解析。每响应载荷实测 4098 字符，未声称零复制或零分配。 |
| 脚本完成/取消 → 产品收尾 | VM 终止与宿主工具停止分开；现有 pending/AbortController/期限、context.finish、结果保存和释放保持不变，不重放副作用。 |

**验证与决定。** 诊断模式累计 48/48 Worker、1212 次 fixture 工具调用，91 个 Worker/buffer/sandbox/catalog/result 跟踪引用 GC 后保留 0。另运行一次原始编译模式 allocation 基准：32/32 Worker、100 次调用、128 引用保留 0，宿主采样 2701800 字节，warm 中位数 30.57 ms；采样不包含 Worker heap/QuickJS，也不与无 profiler 的小样本混算。37 项既有 runtime/worker recovery/AST 检查、类型检查及 codemode 单包构建通过。无新增测试文件、无本地全量测试；探索后补齐 VM/启动 JSON 计数，只以最终 harness 的样本验收。原始数据、指纹、命令与范围见 [OC11 证据](performance/oc11-runtime-costs.json)。

根类型检查不包含 scripts，因此另对基准入口及其 helper 做一次独立 strict 类型检查，通过；未将按需测量加入默认 CI 测试集合。

上述为用户要求 Worker 池之前的历史基线。其后按明确授权，在同一 #140 中实现并启用单槽 Worker 资源池；不将历史数据冒充池化后的结果。

**池的所有权与退出。** coding-agent controller 显式启用 `reuseWorker`；低层库默认仍为独立 Worker，以兼容已有调用和自定义 worker。每个 sandbox 最多一个物理线程、一个执行 owner，无等待队列，跨 sandbox 不共享。每次租用创建独立 MessageChannel、interrupt buffer、QuickJS VM 和 BridgeBudget；端口提供物理隔离，旧结果不能进入新脚本。归还同时核对线程与 Execution 身份，重复归还及旧 owner 均无效。Worker 等 VM 调用栈/微任务排空后 dispose，清除消息监听和 WASI memory 引用，再发送完成；host 中止未 await 调用、清理 pending/maps/端口后释放 owner。脚本失败、超时、取消或线程故障终止线程，等待物理退出后才可新建；退出等待期间已经取消的 Execution 在取槽前再次核对完成状态，不得抢占后续执行。该窄窗口补充既有池用例验证，只增加生命周期 primitive 检查，不重跑未改动的 allocation 负载（采样提交为 d5e4a4fa2）。空闲 30 秒、累计 64 次执行或 WASM 线性内存超过 64 MiB 也回收；空闲 Worker/timer 均 unref，close 终止活动和空闲资源。

**完整链路 allocation 审计。** 继续审计上表的 controller → sandbox → Worker/VM → host bridge → nested dispatch/权限/证据 → 序列化 → VM → 结果/状态保存及 close。新增分配仅在脚本/线程生命周期：每脚本一个 channel/端口对、启动消息和转移列表，acquire/start 的 Promise，VM 的固定回调及完成时 primitive 复用标记；每个 Worker 一个 owner/计数/稳定退出监听，空闲转换一个 deadline timer。消息交付、deliver、drain、host handleMessage 及进度链新增 callback/Promise/AbortController/包装数组均为 0。原有每实际工具调用的 pending/AbortController/执行 Promise、JSON 文本、结果对象继续保留；没有池化事件、结果、Promise 或 VM。64 MiB 判断从既有 WASI memory proxy 读取 buffer.byteLength，不复制内存或扫描 VM 对象图。AST 在既有 hot-path 文件中约束具名消息路径，生命周期例外明确为 main/captureMemory/bridge/API 初始化和 start/finish/acquire/retire。

**同机编译模式对照。** `--compiled --pool` 在同一进程分别用新线程和复用线程运行同样的 30 个 warm no-op 与一次 100×4KiB bridge，进程 CPU 样本仍偏零，因此 CPU 门禁改用独立 Worker.cpuUsage 测量 30 组×10 次脚本；两组均加相同的 keepalive bootstrap，确保一次性线程退出前能够读取 CPU。额外 CPU 对照共 301/301 与 5/5 Worker；该探针仅用于 CPU，计时/allocation 使用无探针 Worker。只采样 warm no-op/bridge 的宿主分配，不把 CPU 组重复计入 allocation。

| 指标 | 每次新 Worker | 单槽复用 |
| --- | ---: | ---: |
| warm 中位数 / p95 | 36.16 / 37.79 ms | 6.50 / 8.59 ms |
| 100 次读取批处理 | 45.35 ms | 18.03 ms |
| 宿主采样分配 | 2520120 B | 1200544 B（-52.4%） |
| CPU 批次均摊 p95 | 7.5 ms/脚本 | 1.6 ms/脚本 |
| 含 CPU 组的 Worker 启动/关闭 | 332/332 | 6/6 |
| 关闭并 GC 后宿主 heapUsed | 10077152 B | 10123600 B（+0.46%） |

宿主分配下降超过 20%、CPU p95 无回退、关闭后宿主 heap 增长低于 10%；这些是同机有限样本，不是端到端 SLA。空闲 RSS 约多 14.3 MiB（进程总量，带噪声），所以记录保留成本，并以空闲/次数/内存阈值限制；不声称池没有内存代价。首次脚本仍需要线程启动，warm 收益不能套用首次调用。

**Worker 内部与释放证据。** benchmark-only data URL 副本对 31 个新 VM（其中 30 个各分配 8 MiB）采样：Worker V8 allocation 12611224 B，主要在 WebAssembly instantiate；WASM 线性内存峰值 10027008 B。此采样含探针，不是相对新线程的 Worker 分配下降证明，也不包含 QuickJS 内部 malloc 总量。31/31 VM dispose，31/31 依赖库 instance/module/hostCallbacks/ownedHandles 清空；248 个 VM、WASM instance/memory、data/catalog/store/interrupt/port WeakRef 在每轮受控 GC 后保留 0，close 后 Worker 保留 0。宿主对照各 33 引用保留 0。生产 AgentSession 基准 242 次真实 fixture 读取、11/11 Worker、55 引用保留 0、pending evidence 0，第二批中位数 21.18 ms；这是本地离线 provider/I/O，不冒充真实模型效果。

**最小验证与限制。** 原有 runtime/recovery/hot-path 检查通过；只在已有 runtime/hot-path 文件加入 3 个行为用例和 1 个 AST 用例，覆盖复用、迟到结果、目录/配额/状态隔离、错误/超时/取消/close、重复与过期 owner、空闲淘汰、64 次/大内存淘汰，并复用 recovery 错误用例覆盖池线程加载失败。主脚本完成后会中断未 await 的无限 VM 微任务，保持已完成结果，再 dispose；最终对此变更重跑 28 项 runtime 检查通过。89 项既有 session 集成测试通过。修改后仅重跑受影响断言和 allocation/lifecycle 测量，未跑本地全量或新增测试文件。单包构建、根类型检查及基准独立 strict 检查通过；stage 探针适配后仍通过 48/48 Worker、1212 调用、91 引用保留 0。完整原始数据与当前指纹附于 [OC11 证据](performance/oc11-runtime-costs.json)。未测试安装包、Bun 及真实模型负载；Windows CPU 计时仍有粒度限制，不宣称细粒度 VM CPU 百分比。提交后按 §2.3 请求 Codex 手动复审，CI/审查结论记录到 PR，避免仅为状态反复提交触发全量 CI。

### 第三轮实施记录：OC03 进程内交付故障窗口

实施前基线：`614218b0312de486728c5b6f1358884d890cb31d`。历史任务已有同步终态事务、失败时保留 live result 并阻止新任务、重启将未确认完成标为 interrupted；不新增持久 outbox。当前优先复现：idle triggerTurn 报告在等待前一个 custom drain 时，前一 drain 失败是否导致新报告既未接纳也未保留。目标是保留原有 SDK 拒绝语义，将未消费报告保留至下一次显式排空/用户输入；不失败后自动唤醒、不重试模型或重放任务。

审计完整生产链：任务 finish / TaskHistory.save → shell/subagent sendMessage → 扩展 runtime adapter → AgentSession.sendCustomMessage → 共享 custom drain / _appendCustomMessage → SessionManager → prompt/队列消费 → provider 上下文、收尾与 dispose。普通 provider/message/tool progress → observer → InteractiveMode 同步通道继续按热路径合同检查。消息接纳/失败恢复属于具名低频生命周期，只允许复用已有队列和 drain owner；不增加 timer、Promise tail、持久写入或独立通知缓存。现有通用 custom 队列没有全局字节硬上限，本轮不把它描述为新的有界 outbox。

最小验证候选：扩展现有 custom-message-ordering 的共享 drain 失败用例，覆盖 triggerTurn 与 dispose；复用 agent-settled-aborted、permission-interaction 和 tui-frame-hot-paths。沿用 session event allocation benchmark 和现有 GC 生命周期验证；只有实际改到任务存储/输出消费者时才运行对应历史/shell/subagent 基准，不重复本地全量测试。

**实施结果与接纳语义。** 原代码在构造新报告之前 await 既有 drain；该 owner 拒绝时，新 triggerTurn 报告没有进入任何队列。已有故障注入用例扩展后，普通上下文消息保留 1 条，triggerTurn 分支实际为 0，复现遗漏。修复仅将已有 custom 消息构造前移，在等待失败且 session 未销毁时加入既有 pending custom 队列，仍向 SDK 调用者抛出原错误；下次显式排空/用户输入保存和投影该报告一次，不自动启动模型重试。dispose 时不重新入队。调用者收到拒绝不能当作没有任何本地接纳或副作用，不能盲目重发相同报告。

| 故障窗口 | 当前保证与恢复 |
| --- | --- |
| 终态保存失败 | live result 留在本次进程，历史错误阻止新任务；重启只依据已保存记录，未确认完成为 interrupted。已有 task-history 夹具覆盖，本轮不改存储。 |
| 终态保存成功，sendMessage 尚未接纳或因失效上下文拒绝 | 可查询有界任务历史；没有持久通知队列，重启不重发，不重放任务。 |
| 新 idle trigger 等待旧 drain 失败 | 本轮保留未消费报告至既有内存队列；SDK 仍拒绝，模型请求为 0。恢复后报告在会话记录及下一 provider 请求中各出现一次。 |
| 已进入运行中队列，尚未保存会话正文 | 进程内接纳不等于持久提交；进程退出可失去排队通知，任务历史仍按自己的事务恢复。 |
| 已保存报告或模型已看到后退出 | 会话上下文存在不等于模型已完成处理，也不证明外部副作用可重放；不新增 sent/processed 标记或端到端 exactly-once 声明。 |

**验证与性能。** 复用原测试文件，扩展共享 drain 的 trigger/disposed 两个分支，并在原 GC 生命周期用例中跟踪失败 drain 与未消费报告。74 项消息顺序、收尾、交互及 AST/source 约束通过，类型检查和 coding-agent 单包构建通过；0 新测试文件，没有本地全量测试。14 个 session/agent/signal/drain/report 引用受控 GC 后保留 0，dispose 后 pending 队列为 0。

同机 10000 次普通消息/工具事件、预热 1000 次，分配采样分别为 39.1808/39.6776 → 42.8208/41.4504 B/事件；合并 observer 为 523.4832 → 523.372 B/原始更新，合并 9999 次、实际投递/快照 1 次。规定的逐进度 Promise、闭包、wrapper、Promise tail/array 计数仍为 0。这些采样约束未改动的普通事件通道，包含原有调度/隔离成本，不是异常通知路径零分配或统计性能改善证明。sendCustomMessage 的每次显式接纳仍为一个既有 appMessage 和 async 调用，失败分支只将该对象放入原队列；无新 timer、deferred、Promise 链、存储写入或对象池。完整数据与指纹见 [OC03 证据](performance/oc03-notification-boundaries.json)。

**审查修复。** [PR #139 的 P2 反馈](https://github.com/dragonbaba/super-pi/pull/139#discussion_r4254601233)指出：保留队列没有活动 drain 时，新的 idle trigger 会先启动模型，旧报告才在 turn_end 追加。扩展同一个失败 fixture，复现会话保存顺序为 first/new/retained。现在 idle trigger 复用现有 `_flushPendingCustomMessages` 排空保留队列；等待期间若另一个回合开始，立即停止 idle 排空，交回运行中的队列机制，保留工具调用/结果配对。新的有效通知是新的唤醒，失败本身不自动重试。

修复后，75 项原定向检查通过，首个 provider 请求按旧/新顺序各见报告一次；类型检查和单包构建通过，14 个跟踪引用保留 0。只重测受影响的 session event 基准：消息/工具为 38.3064/39.4704 B/事件，合并 observer 为 528.1464 B/原始更新，零逐事件分配约束及 9999 次合并/1 次快照投递不变；不将单次样本解释为性能提升。完整修复指纹与样本见证据 JSON 的 `reviewFix`。未新增测试文件或重跑其他子系统/本地全量测试，推送后请求一次手动复审。

### 第二批实施记录

**OC05 实施前。** 基线为第一批合并提交 `1f5e8c6ac`。已核实 `checkpoint: true` / `resumeTaskId` 完成上下文保存与新 ID 续跑，执行前重新检查当前委派、角色、模型、工作区精确身份及冲突，原任务必须终态；普通任务仍不保存上下文。缺口是 list 没有检查点标记，统一/legacy status 的结构化数据没有检查点状态，且运行中的可用检查点被提示为可立即续跑。最小范围：统一有界的查询提示、列表标记与结构化 `checkpointAvailable`，复用现有 single-mode 入口，不增加 resume 工具、队列或存储字段。先复用 `subagent-management` 的真实子进程/检查点续跑与权限用例、`task-checkpoints` 的恢复/损坏/淘汰边界。

调用链：显式 tasks/subagent_tasks 或 /tasks 查询 → 有界 task record → 列表/状态投影 → 既有工具结果或 UI 通知；后续续跑仍走 subagent 授权 → readCheckpoint → scheduler → child IPC → 完整回合保存 → finish → dispose。查询与终态提示属于显式控制/低频生命周期，禁止在输出 chunk/progress 中读取、解析或保存检查点。状态只使用已有布尔值，不引入缓存、timer、Promise、对象池或额外 transcript 复制；受影响的 source invariants 和必要分配/释放证据按实际 diff 决定，不为文案重复全量测试。

**OC10 范围。** OC05 后独立核查实际 session 的 ALL_TOOLS/describeTools、tool_search/MCP deferred、工具增删与当前授权。复用现有 Codemode 测试/benchmark 对小目录和代表性大目录计数声明字节、schema 访问、目录更新及释放。先测量再决定是否需要生产改动，不预设新搜索 API、Worker 池或引擎替换。

**OC05 实施结果。** list 标出 checkpoint saved；统一 tasks、legacy subagent_tasks 与 /tasks 的状态明确区分没有完整检查点、已保存但仍在运行、已结束可提出新授权请求。结构化状态补充 agent/cwd/branchId 与 checkpointAvailable；可用检查点的终态报告给出既有续跑入口，仍受原来 8 项 / 8192 字符上限约束，不承诺当前权限或近容量检查点可无条件继续。查询仅读取任务记录布尔值，不加载或复制检查点正文。取消任务仍只能经新授权明确续跑，未增加运行中定向消息。

已有测试扩展真实子进程续跑、两个管理入口与 /tasks、跨父会话拒绝、活动检查点不能续跑及 Unicode/转义后的报告上限。相关管理/检查点/source 检查 37 通过、1 POSIX 条件跳过（修正 Windows 长短路径测试预期后仅重跑该项）；共享 shell 控制与历史恢复检查 36 通过、1 POSIX 条件跳过；类型检查和 diff 检查通过。无新增测试文件，无本地全量测试。stdout allocation 基线/候选约为 8889.87/8705.40、8848.96/8798.15、8442.27/8441.30 B/更新（8/16/64 children），全消息序列化与进度快照计数维持 0；完成/失败/取消/dispose 后所有者计数 0、344 个跟踪引用 GC 后保留 0。此测量约束未改动的高频链，不冒充低频字符串格式化零分配或统计性能收益；完整样本、命令和源码指纹见 [OC05 证据](performance/oc05-checkpoint-discovery.json)。PR 与最终 CI/审查状态待交付后记录。

### 第一批实施记录（本地验证完成）

交付记录：[PR #136](https://github.com/dragonbaba/super-pi/pull/136)，首个提交 `9c56756cda44178cd6780266ebdca40861db0f6f` 的 Linux/Windows 六个 CI 分片全部通过。首轮自动 Codex 审查指出三项有效问题，修复与补充验证记录如下。另一任务的 `upstream-pi-1.1.0-task-plan.md` 及其导航条目不纳入本 PR；不重复本地全量测试。修复 head、手动 `@codex review` 请求及最终审查/CI 结果在 PR 中记录，合并仍需另行授权。

**首轮审查修复（OC01/OC02）。** [旧公共 settled 事件](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253833062)在扩展回调后再次检查接纳代次，后继回合已开始时不向 RPC/UI 发送旧空闲事件。[暂停报告顺序](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253833068)复用 custom 队列按顺序完成 hook、保存和投递，prompt 在异步预检后、接纳前加入当前排空周期；并发唤醒等待排空后重新判断状态，避免丢掉第二份报告。[兼容查询入口](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253833070)同时指向 `tasks` / `subagent_tasks`，由已存在的仅 legacy 工具 fixture 验证。

重新审计完成通知 → 排空 → 扩展 hook → session 保存 → prompt 接纳 → Agent/事件分发 → RPC/UI/idle waiter → 释放的调用链。`AgentSession._drainPendingCustomMessages` 是低频生命周期边界：每个非空排空周期保留一个共享执行 Promise，并在发布 owner 前让出一次微任务；不建立逐报告 Promise tail 或计时器。空队列 flush 不再产生 async 返回 Promise。既有 append/hook 的异步调用仍存在，不声称终态处理零分配。并发测试检查共享 owner 身份及结束后的清零；正常、错误、取消后的 dispose 共跟踪 12 个 session/agent/signal/drain 引用，受控 GC 后保留 0。精确函数豁免记录在现有 AST 契约测试中，消息/进度的同步路径未改变。

修复验证复用已有测试文件：首轮定向 72 通过、1 项 POSIX 条件跳过；补充并发唤醒后相关顺序/收尾、后台 shell、状态及 AST/source 门禁 70 项通过。`npm run check` 与 coding-agent 构建通过，未再次运行 `npm test`。会话/子代理/shell 基准依次重测：消息/工具采样 41.18/39.99 B/事件，合并投递 9999/1；子代理 8881/8674/8604 B/更新，344 个引用保留 0；后台 shell 5322.62 B/chunk，通知 1 次、1165 字符，118 个引用保留 0，原生句柄归零。规定的逐进度 Promise/闭包/wrapper 等计数维持 0；噪声采样不作为性能提升结论。最新原始结果和指纹在证据 JSON 的 `reviewFix`，原有数据保留对应首个候选，未重测未改动的 Codemode 引擎。

**第二轮审查修复（OC01）。** `596eaf458` 六个 CI 分片通过后，[手动复审](https://github.com/dragonbaba/super-pi/pull/136#issuecomment-6136199766)发现[异步 settled hook 期间过早空闲](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253913744)。增加收尾深度与待发布取消标记两个标量，将后继回合接纳和收尾所有权分离：`isIdle`/idle waiter 及公共 settled 事件均等待全部嵌套收尾结束；新接纳清除旧待发布标记。释放放在 finally 中，沿用原有共享 idle Promise，不增加 timer、Promise 链、容器或对象池。现有嵌套用例分别拦住后继接纳前及完成后，验证真实 AgentSessionRuntime.dispose 在 hook 结束前不会失效会话。相关顺序/收尾/状态检查 32 项通过；收尾/运行时销毁/宿主操作/AST 检查 57 通过、6 项平台条件跳过；长度恢复 27 项通过。构建和类型检查通过。只重测受影响的 session 基准：消息/工具约 38.87/38.85 B/事件，相关契约计数仍为 0，12 个引用 GC 后保留 0；原始样本和当前指纹见证据 JSON 的 `settlementReviewFix`。未重跑不受影响的 shell/subagent/Codemode 或本地全量测试。

**第三轮审查修复（OC01）。** `ac3bd39e3` 六个 CI 分片通过。[报告排空的销毁边界](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253992661)改为由公共 `isIdle`/`waitForIdle` 持有 custom drain 活动，完成或失败的 finally 清除 owner 后统一发布空闲。[Goal/Plan 兼容性](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253992671)恢复扩展 `ctx.isIdle()` 原有的“未 streaming、可接纳回合”语义，与公共生命周期空闲分开；核心及交互快捷键上下文保持一致。重新审查 Goal 的 continuation/pending-queue dispatch、Plan 的 ready presentation、扩展上下文绑定及运行时 teardown 全链。现有回归断言扩展在收尾中看到可接纳状态，同时真实 runtime.dispose 必须等报告保存完成；现有真实 Plan 集成用例还验证计划卡片投递一次。会话/报告/交互 42 项、Plan 单项、AST/source/状态/销毁 48 项均通过，构建和类型检查通过。`AgentSession._publishIdleIfReady` 只在收尾或报告排空生命周期发布一次既有终态事件，不增加 Promise、计时器或容器；已列入精确函数豁免。session 基准重测为消息/工具约 40.96/40.83 B/事件，契约计数仍为 0，合并 9999/1，12 个引用 GC 后保留 0。最新指纹与原始样本位于 `idleSemanticsReviewFix`；其余基准及本地全量测试未重复运行。

**CI 契约衔接。** `633630b8a` 的 Linux 1/2 与 Windows 3/4 均在同一个旧 provider 契约用例失败，其余分片被 fail-fast 取消：[CI 38335517189](https://github.com/dragonbaba/super-pi/actions/runs/38335517189)。旧用例先等待替换完成再释放 custom hook，与“替换应等待报告保存”的新约定构成互等；调整为先启动替换并断言旧 owner 仍有效，再释放 hook，等待替换完成后保留原有新会话隔离/旧文件只保存一次的断言。仅修改已有测试与记录，无生产变化；对应 provider-contract 文件 52 项及类型检查通过，不重跑 allocation 或本地全量测试，继续复用 `idleSemanticsReviewFix` 的生产指纹与性能证据。

**第四轮审查修复（OC01）。** [空闲 SDK 投递过早返回成功](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4254057651)改为让普通/暂停状态的并发 `sendCustomMessage` 调用等待同一个排空 owner；前一 hook 导致排空失败时，等待者得到拒绝，未消费消息保留到下一次显式排空。核实扩展 `pi.sendMessage` 的返回类型及 adapter 均为 void，回调内投递不会等待自己的 hook；现有 idle 用例加入真实扩展重入验证。仅新增一个有必要的失败传播用例，仍位于既有 custom-message-ordering 文件；覆盖等待者不早报成功、共同拒绝、owner 释放及后续排空只保存一次。连同 CI 用例调整，相关收尾/消息/交互/provider 契约 95 项、AST 门禁 12 项、真实 Plan 单项通过，构建和类型检查通过。SDK await 的 Promise reaction 属于低频投递生命周期，不新建逐消息 deferred、Promise tail 或计时器；消息/进度链仍未变化。session allocation 约 41.97/42.92 B/消息或工具事件，相关契约计数 0，12 个引用 GC 后保留 0。最新生产指纹和原始结果在 `deliveryPromiseReviewFix`，不重复本地全量测试。

**第五轮审查修复（OC01 / 证据标识）。** `92403ff8c` 的六个 CI 分片通过后，复审指出[独立报告期间退出请求缺少唤醒](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4254112305)。TUI 扩展及快捷键退出入口改为合并重复请求、等待现有共享 idle waiter，并在唤醒后重新检查当前会话，覆盖没有 agent_settled 事件的空闲/暂停报告保存。没有新增事件、计时器或容器；一次显式退出的 async 操作和稳定拒绝观察属于低频生命周期，已在 AST 契约中明确列出函数。现有 shutdown 文件增加空闲/暂停两个用例，验证重复请求只确认/退出一次、报告先保存、owner 与终端监听释放。相关收尾/退出 37 项通过；AST 豁免清单同步后 12 项通过；构建、类型检查通过。session 基准消息/工具约 43.89/37.59 B/事件，规定计数仍为 0，合并 9999/1，12 个引用 GC 后保留 0。未重跑本地全量测试。

[证据指纹意见](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4254112310)经核实属于历史记录标识不清：第四轮 `deliveryPromiseReviewFix` 的 17 个指纹均与当时源文件匹配，顶层旧指纹对应首个候选。现将顶层 `files` 更新为当前 17 个指纹，`currentEvidence` 明确指向 `shutdownReviewFix`；旧顶层指纹迁至 `initialCandidateIdentity`，每轮历史记录固定标注其 `measuredRevision`。逐个核对这些提交的 tracked source 内容，未覆盖旧测量或将旧样本冒充当前结果；未改动的 shell/subagent/Codemode 仍沿用已标识版本的数据。最新 head 的 CI 和手动复审结果继续在 PR 中记录。

- 基线：`af067d5efe3bc61128a4cda3162d23e908d3ece5`；已有文档修改保留。范围：OC01 通知/收尾与等待输入边界、OC02 有界通知、OC06 摘要更新提示、OC11 编译模式基线。
- OC01 调用链：任务完成 → extension sendMessage → AgentSession.sendCustomMessage → Agent 队列/提示 → agent-loop → agent_end → post-run retry/compaction → custom flush → agent_settled → UI/idle waiter。先复现最终 flush 到消息、settled 回调启动后继回合和等待输入边界；不改 provider delta/progress 的同步事件通道。仅在回合接纳/结束生命周期增加有界标量状态，禁止逐通知 timer/promise tail。
- OC02 调用链：shell/subagent 终态 → 已有有界 task record → 一次完成通知 → custom 历史/模型投影。审计结果截断、来源、容量、旧会话路由和释放；不增加模型摘要调用，不复制完整任务日志。常规输出/进度路径保持原状。
- OC06 只调整现有摘要提示，覆盖初始摘要、增量摘要及任务状态保留；真实模型语义效果单独标记，不冒充离线断言已证明。
- 最小验证候选：现有 agent-settled-aborted、custom-message-ordering、permission-interaction、subagent-management、background-shell-tasks、摘要相关测试；按实际改动选择已有 source invariants 与 session-event/subagent/shell/runtime benchmark。复用现有文件；全量检查仅在最终代码候选运行，不在每个微步骤重复执行。
- OC11 复用 runtime benchmark，比较同机源码/编译 Worker，记录构建与测量命令；不修改生产引擎、不引入对象池。独立性能测量顺序执行，避免并行构建/测试污染耗时。

**OC01 / OC02 结果。** 离线 session fixture 先复现了最终 custom flush 到达消息滞留、旧 settled 清理覆盖仍在运行的后继回合、已销毁会话接纳通知、等待 ask_user 回答时被报告唤起，以及 custom 尾消息之后进入队列导致多一次模型请求。修复使用现有队列、接纳代次和最终同步检查；上下文尾消息之后也先消费通知，再请求模型。两个同时到达的完成报告各消费一次，当前回合加一次后续请求共 2 次；没有新增轮询、通知 Promise 链或调度器。

| 当前边界 | 完成报告的处理 |
| --- | --- |
| 自然空闲 | 有效报告启动回合，仍经过正常工具权限检查 |
| 模型/工具运行、重试、压缩 | 保留 follow-up 消费方式；不拆开工具调用与结果 |
| 最终异步清理 | 清理后再检查队列；跨 await 回到续跑入口时再检查取消/交互状态，关闭检查与接纳之间的窗口 |
| settled 回调已接纳后继回合 | 旧代次不能清除新回合状态或提前释放其 idle waiter |
| 等待 ask_user 回答 | 报告作为上下文保存，由真实用户输入继续 |
| 用户中断当前回合 | 该次收尾不续跑已排队通知；后续明确输入或新有效唤醒仍可继续，不等于永久暂停 |
| 取消某个子任务 | 报告该任务取消，其他任务独立；结果不代表副作用已回滚 |
| 权限撤销、树切换、替换、重载、销毁 | 现有 authority/generation 所有者撤销旧任务并抑制旧报告；dispose 入口另行拒绝迟到消息 |

通知格式统一为 host 自动报告，附任务 ID、agent、分支、终态、最多 512 字符的结果摘录及 status 入口；shell 独立保留退出、终止、输出完整性、日志/清理事实。最多列出 8 项，总长不超过 8192 UTF-16 字符（UTF-8 最多 24 KiB，转义后仍执行总上限）。超过预算的任务使用接纳返回的 ID 或 list；历史淘汰后引用失效。子代理继续每批一次，保留部分成果/容量交接提示，不额外请求模型摘要或提前解除终态验证要求。来源文字经真实 SessionManager 保存/重开和 convertToLlm 转换验证保留；父会话/权限/分支代次仍由现有运行时闭包负责路由，报告中的文字不创建授权。

任务数组仍由当前批次拥有，格式化只生成有界字符串，不保留 task/result 引用。报告留在会话历史直至原有会话/压缩生命周期释放；详细结果沿用每类最近 maxTasks 项、每项 12000 字符上限。通用 Agent 消息队列原本没有总条数/字节硬上限，本批只约束单份任务报告，不声称任意第三方扩展消息已全局有界；未增加新的待投递队列。投递失败仍可查询任务历史；持久重发属于 OC03。

**OC06 结果。** 初始和增量摘要均要求保留当前目标、用户约束、决策理由、未解决工作、任务 ID/状态与可查询结果，并区分验证事实和未验证报告。增量提示从保留全部旧信息改为精简合并，折叠已完成细节、移除重复和被替代结论。不改变历史序列化、token 估算或原生压缩实现。离线恢复/保存边界已验证；真实模型的多轮长度和事实保留效果仍未验收，保留对应待办。

**验证与资源。** `npm run check`、`npm run build:offline` 和 `npm test` 通过。全量验证后补充的 custom 尾消息修复通过相关会话、交互与压缩契约 135 项验证；最后对跨 await 取消窗口补充接纳前检查，重新构建并通过定向回归（最后一轮收尾/长度恢复 44 项全部通过）。相关 source invariants、后台任务和权限检查也通过；未重复整套测试。新增 7 个用例均位于已有测试文件，其余扩展现有断言，未新建测试文件。复用既有 AST/source invariants 和 4 类 benchmark，完整原始测量、命令、源文件及编译产物哈希见 [第一批证据](performance/opencode-batch1-evidence.json)。比较基线通过固定提交的临时源码模块进入相同 fixture；所有本批临时模块按创建身份清理。另修复既有 subagent benchmark 对已 export 类重复加 export 的基线导入问题及失败清理。

| 性能/生命周期项 | 基线 → 当前候选；确定性结果 |
| --- | --- |
| Session 普通消息/工具进度，10000 次、预热 1000 次 | 采样约 41.37/40.93 → 43.06/39.25 B/事件；逐投递 Promise、闭包、wrapper、Promise tail/array 计数均为 0 |
| 合并 observer 消息，10000 次 | 两边均合并 9999 次、实际投递/快照 1 次；Promise 与 rejection observer 为 0；采样 523.61 → 515.77 B/原始更新 |
| 子代理，8/16/64 children × 1000 次输出 | 全消息序列化/进度快照均为 0；采样 8733/8812/8759 → 8678/8727/8853 B/更新；344 个引用 GC 后保留 0 |
| 后台 shell，1000 chunks | 逐 chunk Promise、controller、历史写盘均为 0；终态通知 1 次，151 → 1161 字符；采样 5353.55 → 5315.39 B/chunk |
| 完成、失败、取消、销毁 | 子代理/任务所有者清零；shell 118 个引用 GC 后保留 0，原生 Job/process handles 归零；session 9 个引用 GC 后保留 0 |

这里的零是契约指定结构计数，不是总堆分配为零。仍有旧的解码、JSON 解析、迭代器、合并调度及隔离快照成本；样本保留具体 sites。单次 allocation profile 及亚毫秒 CPU 分位受采样/运行噪声影响，不据此宣称速度提升、通过对象池门禁或全应用零泄漏。

**OC11 编译基线。** `codemode-runtime.ts --compiled` 使用本地 `tsc` 的 host.js/worker.js，30 个 warm no-op、一次首次脚本及一次 100×4KiB host 读取，与源码模式顺序比较：

| 项目 | 源码模式 | 本地编译模式 |
| --- | ---: | ---: |
| 模块导入 | 12.61 ms | 5.62 ms |
| 首次 WASM 加载/编译 | 3.23 ms | 3.02 ms |
| 首次脚本 | 79.21 ms | 69.19 ms |
| warm no-op 中位数 / p95 | 42.01 / 45.45 ms | 30.86 / 33.03 ms |
| 一脚本内 100 次 host 读取 | 47.74 ms | 37.46 ms |
| Worker 启动/退出；GC 后保留引用 | 32/32；0/128 | 32/32；0/128 |

warm 指复用已编译 WASM，每次仍创建独立 Worker/VM；计时包含终止 Worker，close 为完成后的空闲关闭。这里只分别计量模块、WASM、目录构建和整体 execute；Worker 创建、VM/prelude、bridge、退出尚未逐阶段分离，也未补编译模式 CPU fixture。它是本地编译库基线，不是安装包/完整应用 SLA，不能与 §6 无 profiler 的上游数字混算。结论是源码模式确有额外固定成本，但编译模式仍有可测启动成本；保留 OC11 后续诊断项，不由此引入 Worker 池或更换引擎。

每个任务保留一段紧凑记录，优先更新本节或已有相应性能审计，不按每次尝试生成新文档、测试文件或大型日志副本：

- 任务 ID、当前状态、基线与最终 head、需求/缺陷证据、实际改动范围及依赖。
- 验证命令、结果、跳过平台、未验证边界；说明新增测试文件为何必要，或复用了哪些现有套件。
- 热路径完整调用链、原有/新增分配、结构计数、allocation 与 GC/释放证据、对象池决定；非热路径给出理由及资源边界。
- PR URL、首轮自动审查状态、修复提交与手动 `@codex review` 评论链接、逐条反馈处置、最终 head 的审查与 CI 结果。
- 清理的任务自有资源、遗留风险及用户授权的合并状态。实施通过但审查/CI 未完成时保持待验收；已有能力核查通过可以记录为无需修改，不制造空 PR。

当前基线验证：本会话上一轮已运行 `subagent-management.test.ts`、`background-shell-tasks.test.ts`、`custom-message-ordering.test.ts`，共 55 项，54 通过、1 项 POSIX 条件跳过、0 失败。这些检查支持现有管理与消息顺序行为；其中后台通知 harness 有 mock 接收器，不能据此声称全部真实主会话唤醒时序已覆盖。此次文档复核不重复运行相同套件，不将上游源码中的测试当作本地已执行结果。

## 6 Codemode 实现与性能对照

### 6.1 固定版本的实现差异

本节固定使用 `v2@4617210822bdbb31e5749751afbfb4584ccedac8` 的 `@opencode/codemode` 2.0.26；未将 GitHub `dev` 分支文档中的 API 或 TypeScript 支持描述混入。本地对照为本计划基线的 `@super-pi/codemode`，依赖 QuickJS WASI 3.6.2。

| 维度 | OpenCode v2 | 当前 Pi 与含义 |
| --- | --- | --- |
| 执行方式 | Acorn 解析脚本，Effect 驱动自有 AST 解释器和对象模型；支持定义的 JavaScript 子集。[O13]、[O14] | 每脚本独立 Node Worker + QuickJS/WASM。无需自建完整 JS 解释器，但有线程/VM 初始化与退出成本。 |
| 缓存 | 通用 `CodeMode.make` 可复用工具 trie、惰性 search index/catalog；每次脚本仍重新解析和创建执行状态。core adapter 的 `runtime(...).execute(code)` 每次重建工具树和 runtime。[O13]、[O15]、[O17] | WASM 编译结果按路径缓存（最多 4 项）；sandbox 缓存不变的工具快照/目录，controller 对相同工具数组短路。每次执行仍创建新 Worker/VM，不能把“warm”理解成复用线程。 |
| 工具数据边界 | 内部对象转宿主值，工具结果 `JSON.stringify → JSON.parse`，再递归转解释器对象。Effect Schema 会校验；通用包的 JSON Schema 仅供声明，应用工具层另有验证。[O15]、[O16]、[O22] | VM JSON → Worker 消息 → host 解析/策略/结果处理 → bounded JSON → VM 解析。跨线程并非唯一开销；两边都不是零复制。Pi 的读取证据、结果引用和收据不可为公平计时而从产品中移除。 |
| 发现与提示 | 按 namespace 汇总，默认约 2,000 token 的字符估算预算，pinned 项和 namespace 行可超出预算；源码仍有 namespace 总量上限 TODO。内置同步 `search` 默认 10 项，支持分页和精确签名；它也记入 tool-call limit。目录更新可选择更短的差量。[O15]、[O18]、[O19] | 已有 `ALL_TOOLS`、单次最多 16 名称的 `describeTools`、本地声明 32 Ki 字符上限和 MCP 延迟声明；还有 tool_search/deferred/动态指令设施。可借鉴统一的准确发现和目录更新，不能声称 Pi 完全没有延迟发现。 |
| 资源限制 | 通用包 `timeoutMs/maxToolCalls/maxOutputBytes` 未设置即不限制对应指标；该 core adapter 未传入这些 limits。但解释器有单字符串/数组、pending promises 和边界深度上限，不能称“毫无限制”。输出预算在结果产生后收敛，不等于执行中总堆配额。[O13]、[O14]、[O17]、[O20] | 默认 60 s、最大 300 s，VM 默认上限 256 MiB，256 次 bridge 调用，源码 128 Ki 字符，输出 1 Mi 字符，参数/结果累计各 8 Mi 字符等。字符、UTF-8 字节与 VM heap 不是同一指标；这些边界也不是整个宿主进程的总内存限额。 |
| 并发与取消 | 异步调用启动后可并发，脚本结束中断未完成工作，并对部分未处理 Promise 拒绝提供 warnings；超时与返回会等待 Effect 清理。[O14] | 库可并发桥接，产品层可信读最多 4 并发、修改串行。终止 Worker 能停止 VM，不能强杀忽略取消的宿主工具；controller 还需收敛子调用。两边都不能将“脚本结束”解释为副作用回滚。 |
| 宿主扩展 | core adapter 注入受限 `fetch` 扩展，HTTP 有 30 s 超时；不是执行任意 Node API。[O17]、[O21] | 默认不暴露直接 fetch/文件系统/Node API，外部能力走宿主工具。不能为了少一次 bridge 擅自改变此能力边界。 |
| 进度更新 | core 的工具 before/after hook 复制完整 calls 数组再发布 progress；单批 N 次调用的数组元素复制总量可达 O(N²)。这是源码成本分析，本次未测完整 core UI。[O17] | 不应照搬这种 progress 路径；必须遵守本项目零逐进度闭包/Promise/wrapper 及有界状态契约。学习上游行为不意味着采用它的分配方式。 |

上游的库、core adapter 和完整应用是三个不同测量层。本次未启动完整 OpenCode/Claude Code 应用，也没有宣称发现安全漏洞；应用其他层的权限、调度及资源政策不由通用包单独决定。

### 6.2 同机库级实测

原始样本、环境、fixture 源码、调用计数、复现命令及临时 harness 保存在 [测量证据 JSON](performance/opencode-v2-codemode-comparison.json)。环境为 Windows 11（10.0.22631）、i7-14700KF、Node v26.4.0；OpenCode 使用固定源码、Acorn 8.15.0、Effect 4.0.1，经 esbuild 0.28.1 仅打包自身模块，依赖保持 external。两边均在 Node 中运行，以控制运行时变量；**这不是 OpenCode 原生 Bun 与 Pi 发布产物的产品对跑**。

每个 fixture/变体预热 2 次，记录 15 次，轮换执行顺序，不开启 allocation profiler。共同使用 3 个无副作用 host fixture；普通工具只返回同一份数据，等待工具只设置 10 ms 计时器。OpenCode 显式设 60 s/256 calls/1 MiB 输出限制；Pi 沿用默认限制。样本使用 ASCII，仍不声称两边所有限制等价。

下表单位为 **ms，中位数（样本 p95）**。OpenCode 列包含每次 `CodeMode.make`，但不包含 core adapter 的工具注册树、progress hooks、web 扩展和产品策略。Pi 列复用 sandbox/catalog，包含每次新 Worker/VM 到 terminate 的完整库级调用，使用源码 `.ts` Worker。共同排除静态模块导入、host fixture 创建与首次 WASM 编译。10 万次循环作为单独进程中的追加单场景测量，未重复运行前六项。

| 场景 | OpenCode 每次 make | Pi 缓存目录、新 Worker |
| --- | ---: | ---: |
| `return 1` | 0.29（0.65） | 38.94（42.82） |
| 1 次读取 4 KiB 字符串，返回长度 | 0.43（0.79） | 37.72（39.93） |
| 同脚本顺序读取 100 × 4 KiB，返回累计长度 | 2.19（3.51） | 42.60（43.88） |
| 1 万次整数累加 | 20.06（24.34） | 37.84（39.80） |
| 10 万次整数累加 | 197.12（202.93） | 41.80（45.27） |
| 读取 500 行结构化对象后 filter/map/reduce（JSON 49,641 字节） | 5.14（10.12） | 38.14（40.45） |
| 8 个并行 host 调用，各设 10 ms 等待 | 18.55（35.85） | 61.35（74.29） |

证据中另存 OpenCode 复用 runtime 变体：no-op 中位数 0.37 ms，100 次读取 2.24 ms，10 万次循环 196.55 ms。只有 3 个工具时，重建/复用差异处于短计时的波动范围，不能据此推断大目录无缓存收益；也不能把通用包复用能力写成 core 已跨脚本复用。

这些结果支持三条有限结论：

1. **短脚本固定成本：** 本机 Pi 源码模式 warm 调用约 38–43 ms，OpenCode 同进程路径明显较低。首次 WASM 编译在主对照中约 2.53 ms；不能把剩余耗时全部归因于 WASM 编译，也不能按源码模式值承诺发布版时延。
2. **批处理与 CPU：** Pi 将 100 次短读取放在同一脚本时仍约 43 ms，说明此 fixture 中每次工具调用不重复承担完整 Worker 启停。10 万次循环中 Pi 已明显快于 AST 解释器；结论取决于负载，不能整体替换为“上游引擎更快”。
3. **产品收益仍需验证：** 8 并发场景仅测库，未经过 Pi 产品层的并发/修改规则。没有测真实文件、MCP、LLM、token 成本、provider 缓存命中、完整 UI、事件循环响应或两边总堆分配。15 个样本的 p95 只是本次描述统计，不能当成生产稳定分位或显著性证明。

### 6.3 分配、释放与借鉴决定

另外只运行一次现有 `node --expose-gc --experimental-strip-types scripts/bench/codemode-runtime.ts`，用于当前 Pi 的 allocation/释放证据：32 个 Worker 启动、32 个退出；100 个实际 host 调用；128 个 WeakRef 在受控 GC 后保留 0；宿主采样分配 2,455,680 字节。该基准的首次脚本为 84.40 ms，profiler 开启后的 warm 中位数 42.83 ms、p95 45.87 ms，100 次调用批次 48.83 ms。它与上表的 profiler-free 数据不能混算。

主对照和 CPU 追加分别也计数 102/102、17/17 个 Worker 启停，结束时 active executions 均为 0；WeakRef 证据仅来自前述现有基准，不外推到未跟踪对象。宿主 allocation 采样不包含 Worker heap/QuickJS 内存，也未测 OpenCode allocation，**因此不比较两边总内存高低**。本次没有生产修改，不借此宣称全部热路径或所有失败/取消路径已验收。

优先借鉴：有界、精确的工具发现；稳定执行说明与目录更新分离；结构化诊断；用分阶段成本解释短脚本与批次差异。对应 OC10/OC11，先核实本地已具备的部分，再优化已测出的成本。保留 Pi 的可终止 Worker、JS 引擎、证据/权限链和容量边界；不照搬逐进度整数组复制。用户后续要求的 Worker 复用按 §5 单独核验隔离、取消、容量、allocation 和释放。真实模型的 token/回合节省仍属待验证项。

本次只增加本节与一份可复现测量记录；没有新增测试文件、安装仓库依赖或运行全量测试。上游下载、依赖和 harness 使用任务专属临时目录；按已记录身份提交的清理请求被工具自动审批拒绝（仅返回 `blocked by policy`），该目录暂时保留，身份记录在测量 JSON。文档和复现材料不依赖其继续存在。

### 6.4 OC10 第二批核查记录

实施基线：PR #136 合并提交 `1f5e8c6ac6348f37027e6e0b89ff70dec8e7bd1e`。先审计当前 tool_classification → session 工具筛选/重建 → CodemodeController.setTools → sandbox snapshot/catalog → Worker ALL_TOOLS/describeTools → 当前 nested dispatch → result/close；同时核查 MCP deferred 元数据、动态指令与分支恢复。已有固定说明、32 Ki 字符内联预算、单次 16 名称 describe、MCP 延迟声明和当前授权检查；不能由 OpenCode 的更短 API 推断 Pi 缺少发现能力。

**已具备能力与边界。** 真实 `tool_search` 从 session 策略筛选后的注册目录匹配名称/描述，默认最多激活 6 项、显式上限 12，排除策略拥有的 Goal/Plan 等工具。`ALL_TOOLS` 是每次脚本开始时的快照；同脚本搜索后可使用 `callTool` 调用新激活工具，下一脚本才看到新目录。`describeTools` 最多查询 16 个名称，按当前工具与权限解析。MCP 激活/schema 更新保持内联前缀稳定，实际 adapter 重注册后，describe 返回新参数且旧参数在远端调用前被拒绝。本地增删会重新构造有界声明；不变的正常回合不重建 controller 描述或 sandbox snapshot/catalog。动态指令管理 instructions/skills，不是 Codemode 目录日志；此次没有新增并行日志。

现有注册预算是 4096 工具、名称最多 1024 字符、sandbox 目录最多 2 Mi UTF-16 字符；controller 内联说明限制 32768 字符，schema 声明有独立预算。局部声明可省略或退化为 `unknown`，所以 describe 不保证所有复杂 schema 都展开成精确 TypeScript 类型，实际调用仍由当前完整 schema 校验。显式搜索/注册属于低频入口，会扫描、排序或构建元数据；每个脚本仍新建 Worker 并传送目录，不能把宿主快照复用写成“零跨 Worker 复制”。此次未证明需要分页、新缓存、Worker 池或替换引擎。

**生产修复限于关闭生命周期。** `CodemodeController.close` 原先清空 descriptors/tools，却保留两张名称映射和内联声明。补齐清理并放入 `finally`，sandbox 关闭异常也释放 controller 拥有的元数据。对仍被外部持有的已关闭 owner，8/512 项场景删除一项后，名称映射条目合计从 14/1022 降到 0，额外声明从 2380/29845 字符降到 0。这不是声称旧 owner 永远无法 GC；原来在整个 owner 被释放后同样可回收。审查后另补 session 包装声明清理与关闭后的更新拒绝，见下文。

**性能证据。** 扩展现有 [codemode-session benchmark](../scripts/bench/codemode-session.ts) 的按需 `--catalog` 模式，不新增测试文件。8/512 项中本地工具 2/64 项，其他是 MCP 名称的元数据夹具；真实 adapter 行为由 session 测试覆盖。注册时本地 schema 的 properties getter 访问 6/192 次，MCP 为 0；这是访问数，不把它混称为 signature 函数调用数。一次脚本的查找 + 一次 describe 得到目标声明，返回 1116/1120 字符；内联 5038/32503 字节，Worker 元数据 JSON 765/52279 字节。不变回合 schema 访问均为 0，descriptor/snapshot/catalog 身份保持，删除后目标查询为空。无改动生产高频路径，新增逐事件闭包、Promise、controller、wrapper/array 为 0；`close` 的既有 async 边界、store reset 和 sandbox abort 是具名销毁生命周期，不伪装成逐事件零分配。

同机前后 catalog 宿主分配采样 16,071,232 → 16,675,432 字节，包含两次冷 session 与 6 个 Worker 启停，不代表速度或分配优化；确定性释放才是此次修复结论。两边 12 个跟踪引用在受控 GC 后均为 0，6/6 个 Worker 退出。现有完整 session benchmark 单次运行包含 242 次真实 read 子调用、22/22 Worker、55 个引用 GC 后保留 0、pending evidence 为 0；宿主采样 26,564,184 字节。原始数据、生产链、指纹和范围见 [OC10 证据](performance/oc10-catalog-audit.json)。没有测真实模型、provider token/cache、完整 UI、Worker heap、MCP 服务或总内存峰值，不外推这些收益。

**最小验证。** 类型检查、coding-agent 单包构建、Codemode session/runtime/guardrails/hot-paths 与 tool-selection 共 129 项定向验证通过。新增关闭清理断言曾在旧生产代码上复现 100 项映射未释放；关闭异常和真实 tool_search 的两个新用例仍在原 session 测试文件。schema 更新断言首次取到了 fixture 累积历史中的旧结果，修正索引后仅重跑该 MCP 用例；其余 128 项不重复执行。AST/source invariants 复用既有文件；没有本地全量测试。测试/基准临时资源沿现有记录身份清理，未创建常驻服务或对象池。

**PR #138 审查补充。** 初始 head `a909a5898a29ebeb762b7ef892863032dcb365ec` 的 Codex 审查发现两个所有权遗漏，均在同一个修复批次处理：

| 反馈 | 处理与最小证据 |
| --- | --- |
| [关闭后目录可重新填充](https://github.com/dragonbaba/super-pi/pull/138#discussion_r4254386719) | controller 的 setTools 在 closed 时返回；session 的 setActiveToolsByName/registry refresh 在 disposed 时返回。真实扩展 API 原本会拒绝已失效上下文，本次额外关闭 SDK/控制器更新入口；通过下一事件循环回调复现原先恢复 16/1024 条映射，修复后为 0。 |
| [包装对象仍持有声明](https://github.com/dragonbaba/super-pi/pull/138#discussion_r4254386726) | session.dispose 清理注册表和活动 Codemode wrapper 的声明；modelTools 共享相同 wrapper。补充审计 wrapToolDefinition → wrapRegisteredTool → registry → Agent state/modelTools，基准确认三入口分别仍持有的 2380/29845 字符均归零。 |

沿用现有 session 测试文件增加一项真实会话关闭与迟到回调回归；本批累计 3 个新用例、0 个新测试文件。修复后仅运行 10 项受影响 session 用例、8 项既有 AST/source invariants、类型检查及单包构建。扩展后的同一 catalog 夹具在审查前 head/修复候选各运行一次，宿主分配采样 19,221,184 → 17,078,552 字节；仍不据单次样本宣称速度/分配优化。最终 session benchmark 为 242 子调用、22/22 Worker、55 引用 GC 后保留 0，pending evidence 0，宿主采样 26,010,816 字节；catalog 12 引用也保留 0。此次新增的拒绝分支与 wrapper 清理只位于显式工具集更新/销毁入口，不增加普通消息和进度分配。完整补充样本见同一证据 JSON 的 reviewFollowUp。按 §2.3 修复推送后只请求一次 `@codex review`，最终 head/CI/复审结果记录于 PR，避免为收尾状态重复触发 CI。

## 7 固定上游参考

| 主题 | 来源 |
| --- | --- |
| 会话调度与消息接纳 | [运行协调器][O1]、[Session 操作][O2] |
| 完成通知与任务生命周期 | [子代理结果交付][O3]、[Job 持久标记][O4]、[生命周期测试][O5] |
| 恢复与上下文 | [重启恢复][O6]、[摘要策略][O7] |
| 交互与续聊 | [前台转后台][O8]、[子代理工具][O9] |
| 事件与文件变更 | [事件日志][O10]、[步骤快照][O11]、[文件回退][O12] |
| Codemode 执行与边界 | [通用运行时][O13]、[解释执行入口][O14]、[工具桥接/发现][O15]、[数据转换][O16]、[core adapter][O17]、[解释器限制][O20] |
| Codemode 目录与扩展 | [目录预算][O18]、[目录更新指令][O19]、[HTTP 扩展][O21]、[应用工具验证][O22] |
| Claude Code 公开行为 | [子代理说明][C1]、[团队说明][C2] |

[O1]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/run-coordinator.ts
[O2]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/session.ts
[O3]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/subagent-completion.ts
[O4]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/job.ts
[O5]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/test/subagent-lifetime.test.ts
[O6]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/execution/restart.ts
[O7]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/compaction.ts
[O8]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session.ts
[O9]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/tool/plugin/subagent.ts
[O10]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/bus.ts
[O11]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/runner/step.ts
[O12]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/revert.ts
[O13]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/codemode/src/codemode.ts
[O14]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/codemode/src/interpreter/execute.ts
[O15]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/codemode/src/tool-runtime.ts
[O16]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/codemode/src/data.ts
[O17]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/codemode/tool.ts
[O18]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/codemode/catalog.ts
[O19]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/codemode/instructions.ts
[O20]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/codemode/src/interpreter/limits.ts
[O21]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/codemode/web.ts
[O22]: https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/tool/runtime.ts
[C1]: https://code.claude.com/docs/en/sub-agents
[C2]: https://code.claude.com/docs/en/agent-teams
