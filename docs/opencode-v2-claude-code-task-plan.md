# OpenCode v2 与 Claude Code 借鉴任务计划

先巩固 Super Pi 已有的后台完成通知与主会话续跑，再改进结果交付、子代理续跑和上下文压缩；Codemode 的工具发现与执行成本独立评估。需要改变会话持久化、远程协议或文件恢复语义的功能单独评估，不将上游实现整体移植进当前运行时。

状态：2026-10-13（Asia/Tokyo）第一批本地实现与验证完成，进入 PR 交付审查：OC01、OC02 已实现；OC06 提示策略已实现，真实模型效果待评估；OC11 已取得本地编译产物基线，内部阶段拆分和后续优化未开展。其余任务未开始。用户已授权提交、推送和创建 PR，以及按 §2.3 修复反馈并手动请求复审；合并仍需另行授权。

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

- [ ] 先确定需要解决的故障窗口：终态已保存而通知未接纳、已接纳而确认未保存、已进入模型上下文后进程退出。分开定义“结果已保存”“通知已接纳”“模型已看到”“结果已处理”，不以一个 sent 标记宣称端到端 exactly-once。
- [ ] 如采用持久通知，优先复用现有有界历史/会话存储，设计稳定通知 ID、schema 迁移、接纳去重与确认边界。只保存足够恢复通知的有限字段，规定磁盘失败、容量满、任务历史淘汰及孤立引用策略。
- [ ] 明确恢复策略：现有默认不重发历史通知、不自动运行；新策略若采用，须显式定义启用范围、用户暂停的保留、分支/权限代次校验和不再有效通知的处理。不恢复旧权限，不重放 shell 或工具副作用，不因投递结果就自动认可历史验证成功。
- [ ] 无跨重启通知需求时，可只关闭已证实的进程内交付窗口并记录结论；不要因此重建全部事件存储或提前实现 OC09。

**性能与最小验证：** 强制执行 §2。复用 [task-history](../tests/task-history.test.ts) 及其已有退出 writer fixture、[task-history-hot-paths](../tests/task-history-hot-paths.test.ts)；仅在各持久边界注入必要失败。复用 [task-history benchmark](../scripts/bench/task-history.ts)，记录生命周期写入数、通知条目/字节上限、打开句柄和释放计数；逐 chunk/progress/frame 新增写入必须为零。投递语义变更追加 OC01 的相关用例，不重跑不受影响的完整渲染基准。

### OC04 前台任务转后台

入口：[managed-tasks](../packages/extensions/managed-tasks.ts)、[subagent](../packages/extensions/subagent/index.ts)、[shell 后台接口](../packages/coding-agent/src/core/tools/shell-background.ts)、[后台 shell 所有者](../packages/extensions/resource-lifecycle-guard/background-shell.ts)。参考 [O8]。

- [ ] 分别核查 shell 与子代理能否将正在执行的工作移交给会话级所有者；支持者保留同一进程/执行身份、任务 ID、输出与授权，解除前台等待但不取消、重启或重复占用调度槽。
- [ ] 处理移交与完成、取消、队列容量耗尽同时发生的情况；确保完成结果只交付到正确路径，等待者解除后执行资源仍有明确所有者。
- [ ] 通过 `/tasks` 或现有交互入口暴露操作；快捷键遵守当前绑定。只在有持续运行时和有效管理工具时允许转后台；Print/JSON、替换执行后端及不能安全移交的情形明确拒绝，不隐式启动守护进程。

**性能与最小验证：** 强制执行 §2。复用 shell/subagent 管理测试及现有 child fixture，选择支持的执行器验证身份不变与单次完成；按受影响消费者运行已有 shell/subagent benchmark。移交仅允许生命周期分配，不新增输出复制、逐进度状态发布或计时器；平台特有进程树行为在相应 CI 验证。

### OC05 子代理续跑与定向消息

入口：[subagent](../packages/extensions/subagent/index.ts)、[统一任务入口](../packages/extensions/managed-tasks.ts)、[任务历史与检查点](../packages/extensions/task-history.ts)。现有边界见 [后台任务说明](background-tasks.md)；参考 [O9]、[C1]。

- [ ] 优先改善已有 `checkpoint: true`、`resumeTaskId` 的发现和使用体验，保留每次续跑的新任务 ID。若需要稳定子代理身份，将其与本次运行 ID 区分；重名、旧代次和跨父会话目标明确拒绝或要求重新定位。
- [ ] 保留新任务的 scope/deliverable/stopCondition、当前角色/模型/权限核查、精确工作区身份及写入冲突检查。没有检查点、检查点损坏或达到交接线时给出可执行交接，不虚构完整上下文或绕过容量上限。
- [ ] 将“已结束子代理的续跑”与“运行中定向纠偏”分阶段验收；后者只有在子进程已有安全输入边界或明确新增协议后采用，保证顺序、取消与消息源身份。代理消息不授予用户权限，不让已明确取消的任务被普通消息自动复活。
- [ ] 保留一次性任务的轻量路径；不默认长期保存全部子代理对话，不同时引入任意互发消息、代理团队和嵌套委派。

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

- [ ] 先验证现有 revision snapshot、重连/重新附着和 lease 行为是否会遗漏业务事实。progress 本来是临时 UI 提示，不因它不可回放就判为故障；当前 server 仍是实验性 core，不扩大为完整 daemon 产品。
- [ ] 仅在存在已确认需求时添加有界、按会话序号补读的任务事实；规定快照与增量的衔接、重复/乱序、游标过期、慢客户端及版本兼容。历史回放与实时订阅之间不能丢失或重复接纳事实。
- [ ] 重连不恢复旧的执行授权；租约、订阅、事件窗口与用户看见的状态来源明确。避免持久化每个 token/progress 或整体重写成 event-sourcing 架构。

**性能与最小验证：** 强制执行 §2。优先复用 [rpc-client-dispatch](../tests/rpc-client-dispatch.test.ts) 和现有协议/状态夹具；以可控断连和单个有界窗口验证。扩展最接近的事件交付 benchmark，记录每事件分配、积压字节、回放分页和断连/dispose 后订阅释放；现有基准不覆盖时增加最小场景并说明原因，不先建设独立压测框架。

### OC08 变更归属与用户回退

入口：[原生文件操作](../packages/extensions/mutation-guard-write/index.ts)、[会话证据](../packages/extensions/mutation-guard-write/session-evidence.ts)、[session-manager](../packages/coding-agent/src/core/session-manager.ts)。参考 [O11]、[O12]。

- [ ] 先复用现有操作收据与证据记录，将会话/任务/回合关联到实际文件变更；支持用户查看归属及 diff，不凭 shell 文本推断所有副作用均可撤销。
- [ ] 回退作为单独的用户显式操作，确定记录容量、保留时间和精确文件身份；检查用户或其他代理的后续修改，冲突不得覆盖。快照/恢复范围须说明未跟踪文件、删除/重命名、元数据、二进制及平台差异。
- [ ] 对未覆盖的 shell、网络、数据库等副作用明确不可恢复；记录被淘汰时不承诺可回退，不将 Git reset/clean 或全工作区恢复用作隐式实现。

**性能与最小验证：** 强制执行 §2。先复用 [native-file-operations](../tests/native-file-operations.test.ts)、[native-file-metadata](../tests/native-file-metadata.test.ts) 的相关 fixture；只有采用恢复功能才增加对应冲突用例。复用 [native-files lifecycle benchmark](../scripts/bench/native-files-lifecycle.ts) 中适用部分，审计大文件读取/复制、存储上限与句柄释放；禁止逐 delta 扫描工作区、拍整仓快照或把常规验证升级成默认多进程成本采样。

### OC09 进程重启后的执行恢复

本项为有条件的后续设计，不能与 OC03 的“通知可恢复”混为一项能力。Pi 当前退出会清理任务，历史恢复不授予执行权；参考 [O6] 的执行 claim、恢复次数限制与 shell 差异。

- [ ] 明确需求是 UI 重连、同进程会话重新附着、崩溃后的显式继续，还是服务重启自动继续；优先使用已有历史和显式检查点解决前两类，不隐式引入后台常驻服务。
- [ ] 如采用执行恢复，定义写前执行标记、单运行时所有权、用户停止的持久语义、恢复失败次数上限、当前权限重查及子父会话恢复次序。次数限制用于防崩溃循环，不增加模型 token/回合配额。
- [ ] 对可能已执行而未确认的工具要求先核对副作用，不自动重放非幂等命令；shell 与可恢复代理分别定义。恢复通知不反向唤醒已取消/暂停的会话，跨主机和旧 PID 不作授权依据。
- [ ] 输出采用/延期决定及兼容迁移方案。实际实现另开独立 PR，不能借修复通知交付扩大当前运行模式。

**性能与最小验证：** 强制执行 §2。采用后复用 task-history/checkpoint 的真实退出与恢复 fixture 及现有生命周期 benchmark；只对新增持久边界加入确定性崩溃点，计数恢复尝试、打开句柄和持有引用。不用反复杀真实应用、真实模型长跑或全仓恢复试验作为默认测试。

### OC10 Codemode 工具发现与目录更新

入口：[CodemodeController](../packages/coding-agent/src/core/codemode.ts)、[工具分类](../packages/tool-classification/README.md)、[动态指令](../packages/dynamic-instructions/README.md)、[声明渲染](../packages/codemode/src/declarations.ts)。对照 §6 及 [O15]、[O18]、[O19]。

- [ ] 先验证当前 `ALL_TOOLS`、`describeTools`、`tool_search` 与 MCP deferred 的真实可见性、激活和权限关系；已有能力不重复建设。用小目录与一个代表性大目录比较发现所需调用数、声明字节和 schema 渲染次数，不能凭上游 API 更短就判定需要替换。
- [ ] 若证实发现成本过高，在现有入口增加有界名称/描述搜索、namespace 筛选、分页和准确签名；明确最大页大小、结果字节、目录代次和失效规则。搜索不能激活被策略禁止的工具，过期名称/缓存不能绕过当前调用授权。
- [ ] 核查工具增删或 schema 变化是否重写 Codemode 描述及 provider 工具前缀；必要时借鉴“稳定执行说明 + 按变化发布目录”。复用现有动态指令/分支恢复设施，不为 Codemode 新建另一套日志。目录删除必须失效；差量不比完整替换更短时使用有界替换。
- [ ] 缓存只保存有明确所有者和容量的不可变元数据。相同工具数组已有短路，不再重复实现；同时核对原地修改、wrapper 更新、权限撤销与分支切换，不能把数组身份当成授权证据。保留未实际测量模型 token/缓存命中收益的说明。

**性能与最小验证：** 强制执行 §2。复用 [codemode-session](../tests/codemode-session.test.ts)、[codemode-guardrails](../tests/codemode-guardrails.test.ts)、[codemode-hot-paths](../tests/codemode-hot-paths.test.ts) 和相关工具发现已有 fixture；按改动选择 [codemode-preexecution](../scripts/bench/codemode-preexecution.ts) 或 [codemode-session benchmark](../scripts/bench/codemode-session.ts)。记录不变回合的目录构建/签名渲染/序列化次数、返回字节、缓存峰值和切换/dispose 释放。默认不新增测试文件、不逐回合全量扫描或排序目录、不全量序列化后再计算 hash 来假装复用。

### OC11 Codemode 执行成本与数据边界

入口：[host](../packages/codemode/src/runtime/host.ts)、[worker](../packages/codemode/src/runtime/worker.ts)、[prelude](../packages/codemode/src/runtime/prelude-source.ts)、[WASM 缓存](../packages/codemode/src/wasm.ts)、[controller](../packages/coding-agent/src/core/codemode.ts)、[嵌套调度](../packages/agent/src/nested-tool-dispatch.ts)、[结果处理](../packages/coding-agent/src/core/codemode-result.ts)。对照 §6，不直接照搬上游宿主内解释器。

- [ ] 在实际使用的编译/打包运行模式中拆分首次模块加载、WASM 编译、Worker 创建、VM/prelude 初始化、执行/bridge 和退出成本。复用 §6 的短调用、批次和 CPU fixture；源码模式约 40 ms 不能直接当作发布版 SLA，也不能仅凭一次 no-op 决定重写。
- [ ] 先改善既有批量使用方式、复用不变元数据及被 profiler 证明重复的准备工作。区分每段脚本固定成本、每次工具调用成本、工具自身 I/O 和模型回合；不把 N 次脚本启停与一次 N 工具批处理混为同一负载。不为减少计时数字绕过权限、guard 或模型读取证据。
- [ ] 审计实际调用全链：脚本序列化 → Worker 消息 → host 参数解析 → controller/nested dispatch → 工具与 guard → 结果约束/收据 → bridge 序列化 → VM 解析 → 展示与释放。分别计数必要的信任边界复制与可消除的同一边界重复处理；不能因为 OpenCode 同进程就宣称零复制，或直接删除 Pi 的验证/持久化视图。
- [ ] 优化必须保留脚本级取消、VM 内存/输出/bridge/调用上限、可信读最多 4 并发、修改串行、工具当前授权和明确副作用状态。区分 VM 已停与宿主工具已停；对忽略取消的宿主调用、未 await 调用、失败及迟到结果复用现有行为断言。可借鉴结构化错误位置和建议，但先验证 Pi 已有错误/取消事实，不把所有异步行为当成能力缺失。
- [ ] 默认保留独立 Worker + QuickJS。仅当发布模式 profiler 和真实负载证实收益、且隔离/释放/取消验收完整时，才另行评估预热或复用；不能将对象池契约当成 Worker 池自动许可。没有足够收益时以证据关闭优化项，不新增双引擎、专用 DSL、直接执行旁路或常驻池。

**性能与最小验证：** 强制执行 §2。复用 [codemode-runtime](../tests/codemode-runtime.test.ts)、[worker-recovery](../tests/codemode-worker-recovery.test.ts)、[codemode-guardrails](../tests/codemode-guardrails.test.ts) 中实际受影响者；运行对应 [hot-path invariants](../tests/codemode-hot-paths.test.ts) 和 [runtime benchmark](../scripts/bench/codemode-runtime.ts)，涉及策略/展示时才扩大到已有 dispatch/session/tree 基准。提供每脚本 Worker/VM 次数、每调用复制与序列化字节、并发/队列峰值、allocation 和 GC/引用释放证据；若改到 Worker 内部分配，宿主 inspector 样本不够，须补该线程/VM 的相应证据。§6 是诊断基线，不是未来优化的验收结果。

## 5 完成与证据记录

### 第一批实施记录（本地验证完成）

交付记录：[PR #136](https://github.com/dragonbaba/super-pi/pull/136)，首个提交 `9c56756cda44178cd6780266ebdca40861db0f6f` 的 Linux/Windows 六个 CI 分片全部通过。首轮自动 Codex 审查指出三项有效问题，修复与补充验证记录如下。另一任务的 `upstream-pi-1.1.0-task-plan.md` 及其导航条目不纳入本 PR；不重复本地全量测试。修复 head、手动 `@codex review` 请求及最终审查/CI 结果在 PR 中记录，合并仍需另行授权。

**首轮审查修复（OC01/OC02）。** [旧公共 settled 事件](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253833062)在扩展回调后再次检查接纳代次，后继回合已开始时不向 RPC/UI 发送旧空闲事件。[暂停报告顺序](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253833068)复用 custom 队列按顺序完成 hook、保存和投递，prompt 在异步预检后、接纳前加入当前排空周期；并发唤醒等待排空后重新判断状态，避免丢掉第二份报告。[兼容查询入口](https://github.com/dragonbaba/super-pi/pull/136#discussion_r4253833070)同时指向 `tasks` / `subagent_tasks`，由已存在的仅 legacy 工具 fixture 验证。

重新审计完成通知 → 排空 → 扩展 hook → session 保存 → prompt 接纳 → Agent/事件分发 → RPC/UI/idle waiter → 释放的调用链。`AgentSession._drainPendingCustomMessages` 是低频生命周期边界：每个非空排空周期保留一个共享执行 Promise，并在发布 owner 前让出一次微任务；不建立逐报告 Promise tail 或计时器。空队列 flush 不再产生 async 返回 Promise。既有 append/hook 的异步调用仍存在，不声称终态处理零分配。并发测试检查共享 owner 身份及结束后的清零；正常、错误、取消后的 dispose 共跟踪 12 个 session/agent/signal/drain 引用，受控 GC 后保留 0。精确函数豁免记录在现有 AST 契约测试中，消息/进度的同步路径未改变。

修复验证复用已有测试文件：首轮定向 72 通过、1 项 POSIX 条件跳过；补充并发唤醒后相关顺序/收尾、后台 shell、状态及 AST/source 门禁 70 项通过。`npm run check` 与 coding-agent 构建通过，未再次运行 `npm test`。会话/子代理/shell 基准依次重测：消息/工具采样 41.18/39.99 B/事件，合并投递 9999/1；子代理 8881/8674/8604 B/更新，344 个引用保留 0；后台 shell 5322.62 B/chunk，通知 1 次、1165 字符，118 个引用保留 0，原生句柄归零。规定的逐进度 Promise/闭包/wrapper 等计数维持 0；噪声采样不作为性能提升结论。最新原始结果和指纹在证据 JSON 的 `reviewFix`，原有数据保留对应首个候选，未重测未改动的 Codemode 引擎。

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

优先借鉴：有界、精确的工具发现；稳定执行说明与目录更新分离；结构化诊断；用分阶段成本解释短脚本与批次差异。对应 OC10/OC11，先核实本地已具备的部分，再优化已测出的成本。保留 Pi 的可终止 Worker、JS 引擎、证据/权限链和容量边界；不照搬逐进度整数组复制，不因微基准引入 Worker 池或双引擎。真实模型的 token/回合节省仍属待验证项。

本次只增加本节与一份可复现测量记录；没有新增测试文件、安装仓库依赖或运行全量测试。上游下载、依赖和 harness 使用任务专属临时目录；按已记录身份提交的清理请求被工具自动审批拒绝（仅返回 `blocked by policy`），该目录暂时保留，身份记录在测量 JSON。文档和复现材料不依赖其继续存在。

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
