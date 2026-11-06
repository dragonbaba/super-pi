# 外部已有文件写入：整轮暂停验收

日期：2026-11-06。基线：`47426203032b5328d919cefa1c759fc7d9300219`，C3。仅落实 D5/N4、T16/T20；C4 的真实子代理跨进程权限仍单独交付。禁止加强命令预检，Shell 分析器和路径识别未修改。

## 行为与生命周期

既有原生授权确定 D5 后，同步关闭 `SessionExecutionBoundary` 准入、撤销 generation 并取消原信号。既有 owner 撤销 Agent/provider、CodeMode、文件调用和后台任务，按已有 10 秒清理期限排空。调用方不等待包含自身的 prompt/tool，因此没有自等待死锁；已完成结果不回滚、不丢弃。原始拒绝优先于通用取消错误，模型和可用 UI 均收到目标和暂停原因。

边界持有一个暂停 boolean 和至多一个最新清理 Promise。暂停期间后续 transition/dispose 更新该 Promise，恢复不能以最初成功覆盖新清理失败。Agent 每轮读取该稳定视图，结束时携带 `requiresUserInput`，不再请求下一轮模型。已准备但未执行的工具返回未执行结果。下一条新用户 prompt 在取得自己的准入前等待最新清理；成功后释放 Promise、建立一个新取消 owner。并发恢复不能替换第一个恢复产生的信号。后台通知、扩展输入和原排队输入均不能自动恢复。相同 SessionManager 的权限/目录运行时替换、扩展 reload 在绑定启动事件前重新持有暂停，并先完成新 owner 排空，避免与初始化的合法 transition 互相冲突；新会话不继承旧暂停。失败或超时不猜测旧工作已完成，恢复报原错误，最终 dispose 继续负责清理。

独占夹具的实际结果：

- CodeMode 的 `write(before.txt)` 已落盘并保留回执，随后含外部已有文件的 `file_batch` 整批未执行，`after.txt` 未创建；`allowFailure` 不能解除暂停。
- 运行中的真实 Node 后台子进程已输出 `before handoff`，Shell 覆盖拒绝后任务为 cancelled、scheduler outstanding=0，输出回执保留；未执行外部覆盖或后续写入。
- LSP 原生授权拒绝发生在实际 LSP 执行前，三个并行工具执行计数为 0，每个调用都有终态回执。无须启动语言服务器来验证执行前否决。
- 三种真实 SDK 场景的模型请求数均为 1。排队/扩展输入被拒，后台通知只保留为上下文；新的用户 prompt 可恢复，preparationCount=0、deadline=false。
- 空闲 `executeBash` 触发 D5 时没有 agent_end，仍按稳定暂停视图保留并持久化后台通知，模型请求数为 0。相同会话先切换为原 host-write、更新 /add-dir、再重载扩展，均保持暂停；初始化 transition 成功且不解锁，最后仅新的用户 prompt 恢复。
- 真实 Bash/PowerShell 普通外部删除仍询问；既有 `/tmp`、失败 cd 恢复分支、npm 父目录查找及 /add-dir 对照通过。未扩展识别矩阵。

## 热路径审计

审计调用链：`AgentSession.prompt → _runAgentPrompt → Agent.createLoopConfig → runLoop → prepareToolCall/executePreparedToolCall → ExtensionRunner → SessionExecutionPolicy → SessionExecutionBoundary → owner.revoke/drain`；嵌套调用经过已有 `NestedToolDispatch`/CodeMode，再回到同一授权。结果经 `ToolProgressDelivery / Agent event delivery → AgentSession._handleAgentObserverEvent / _emit → InteractiveMode.handleEvent`；暂停后走现有 settlement、进程清理和显式恢复。

正常准入及暂停状态读取只做字段比较；新增逐事件/逐进度闭包、Promise、AbortController、数组、包装对象和字符串完整复制均为 0。`runControl` 在 runtime 安装时绑定一次，每次模型 run 的既有 config 多引用一个 owner。已有调用级工具回调、每轮上下文/事件对象和结果数组仍存在，未伪称全链零分配。拒绝原因是模块常量与低频错误路径格式化；不新增正则或对象池。

低频豁免精确为 `pauseForUser`、`resumeForUser`、`SessionExecutionBoundary.start/run/dispose`：一次暂停持有一个清理 Promise，沿用原撤销/排空及期限资源，恢复产生一个 AbortController；失败观察使用模块函数。原边界 owner 上限 16、prompt preparation 上限 128，未增加无界队列。成功恢复、取消清理、失败后 dispose 均释放 deadline 和临时引用。失败清理保留确切 owner，不能虚报释放。

同机 Node v26.13.0 / Windows x64 测量：

| 验证 | 结果 |
| --- | --- |
| AST：准入、暂停 getter、恢复谓词 | 常态闭包/Promise/数组/包装分配 0 |
| 生命周期采样 | 100,000 次准入；33 次 revoke/drain；66 个 WeakRef 在受控 GC 后全部释放；审查修复后采样 471,256 B，主要为测试异步上下文、inspector 和生命周期清理；不把随机采样阈值加入 CI |
| tool-progress，100,000 更新 | 最多 1 个 pending slot/key，实际交付 1 次；5 次测量 p50 1.93 ms，p95 2.42 ms |
| session → interactive message/tool 更新，各 100,000 次 | 内建 listener Promise、rejection observer、inline closure、wrapper、Promise tail/array 均 0；采样分别 0.7044 / 0.64248 B/update |
| 完整 observer 合并链 | 100,000 原更新合并为 1 次 delivery/快照；每原更新及每交付新增 Promise=0；采样 153.05 B/raw update，主要为既有 scheduleFlush/Map 迭代；GC 后 heap 差 864,000 B，不能据此声称整链无保留 |

后两项基准使用真实事件分发及内建会话桥，但 UI 组件替身不做 markdown、布局或 frame queue；本改动未触及这些链路，不以该数据证明帧渲染性能。66 个对象的明确释放证据来自边界生命周期测试。没有以耗时变化宣称性能优化。

## 最小复现与验收

实际通过：

```powershell
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
node node_modules/@typescript/native-preview/bin/tsgo.js -p packages/agent/tsconfig.build.json
node node_modules/@typescript/native-preview/bin/tsgo.js -p packages/coding-agent/tsconfig.build.json
node --import tsx --test tests/permission-turn-pause.test.ts
node --import tsx --test tests/host-file-permissions.test.ts
node --import tsx --test tests/host-shell-permissions.test.ts
node --import tsx --test --test-name-pattern 'permission pause' tests/permission-interaction.test.ts
node --import tsx --test tests/agent-settled-aborted.test.ts tests/nested-tool-dispatch.test.ts tests/tool-progress-backpressure.test.ts tests/source-invariants.test.ts tests/codemode-hot-paths.test.ts tests/stream-hot-paths.test.ts
node --import tsx --test tests/alpha-runtime-dispose.test.ts tests/agent-settled-aborted.test.ts
node --experimental-strip-types scripts/bench/tool-progress.ts --updates 100000 --warmup 2 --runs 5
node --expose-gc --experimental-strip-types scripts/bench/tui-session-event-allocations.ts --updates 100000 --warmup 10000
```

最终 SDK 5、文件 8、Shell 7、暂停生命周期 3 全通过；相关调度/源码回归 79 通过、1 项既有显式 GC 条件跳过，另两项原 transition 生命周期测试通过。先观察到普通 abort 丢失 D5 原因且多请求一次模型，再修正优先顺序及稳定暂停状态；不是凭推测另建取消框架。

PR #241 首轮审查三项均先核对为范围内生命周期问题，再复现失败：最新 transition 的 drain 拒绝后恢复缺少预期拒绝；真实权限切换后 paused=false；空闲 Shell 拒绝后后台通知误尝试启动模型而抛错、丢失内容。修复后暂停/AST 4/4、SDK 5/5，扩展初始化 transition 对照通过；相关 runtime/settlement 43 通过、1 项既有显式 GC 条件跳过，类型检查与 coding-agent 编译通过。计划 0.6 补充这些入口。事件/进度实现未再次变更，复用首轮相应分配数据；更新后的暂停 getter 纳入 AST，生命周期分配/66 个引用释放重新测量。

测试/构建/基准由任务 owned runner 启动，子进程 TMP/TEMP/TMPDIR 指向记录的 `.task-tmp` 根并实际校验。新 SDK 夹具自建精确 owned root，真实后台 PID 和生命周期由任务进程账本及生产任务管理器记录；夹具结束关闭资源后清理。原 C1/C2 多请求夹具增加显式用户恢复，没有另建重复策略矩阵。全任务结束后的本地离线构建仍待 C4/E/F 完成后执行。
