# H01 — RPC 空闲扩展关闭

状态：[PR #199](https://github.com/dragonbaba/super-pi/pull/199) 首次审查意见已修复，待最终 head 复审和 CI。基线 `3174bf87c87750213e0ccf437f23ffaa17d5bcbc`；分支 `codex/history-h01-rpc-idle-shutdown`；Node v26.13.0。上游依据为固定未发布快照中的 [#11599](https://github.com/earendil-works/pi/issues/11599)，不混入 H02 的 EOF/信号重复关闭问题。

## 根因、调用链和最小设计

真实 CLI `main → runRpcMode → session.bindExtensions → ExtensionRunner.createContext().shutdown → AgentSession._extensionShutdownHandler` 目前只置 shutdownRequested。检查只发生在后续 RPC 命令或公开 agent_settled，故 stdin 保持打开且不再发命令时无法主动退出。

不能在回调中无条件立即关闭：session_start 的扩展绑定尚未结束；异步扩展命令通过 prompt 执行，其 preflightResult 成功回调稍后才写出 RPC prompt 响应。普通 handleCommand 已返回时，这个 prompt 仍可能没有响应。需要由 RPC owner 持有两个固定数字计数：正在处理的普通命令，以及尚未发出响应的 prompt。复用 detachInput 的 undefined 状态表示初始化未完成，不增加第二套初始化状态机。

在扩展关闭入口、初始化完成、命令完成和 prompt 响应发布后调用同一个同步检查函数。只在已请求关闭、输入已初始化、没有未完成响应、session.isIdle 且尚未关闭时进入现有 shutdown。isIdle 同时涵盖活动 run、settlement hook 和 custom-message persistence，避免在扩展 agent_settled hook 内取消订阅而丢失最终公开事件。重复扩展请求被现有 shuttingDown 状态挡住；不改 EOF/信号直接调用 shutdown 的行为，H02 仍须独立复现。

关闭链保持 `shutdown → runtimeHost.dispose → performDispose → teardownCurrent → session.abort/辅助活动收尾 → session_shutdown → session.dispose/会话 lease 释放 → detachInput/stdin.pause → flushRawStdout → process.exit`。runtime 已有共享 disposeOperation、清理错误传播和辅助活动期限，均复用。关闭期间的 MCP refresh 由现有 session_shutdown/MCP owner 等待，不新增凭据逻辑、退出重试或第二个 dispose Promise。

输入 JSON 解析、命令分派、preflight 成功/失败以及扩展命令错误事件仍在原有边界处理；不新增 schema 校验。计数在原有回调和 finally 中归还；响应先写入既有 stdout 队列，再允许关闭。清理失败保持既有非成功传播，不吞错返回成功。

## 性能与释放边界

本项修改显式命令、启动、停止和 agent_settled 生命周期边界；普通 provider delta、工具 progress、toJsonEvent、stdout 写队列和 TUI 均不修改。两个计数为原始字段，没有新增容器、正则、逐事件闭包、Promise、controller 或 timer；把原有无条件 async 关闭检查改成同步条件检查，只有真正关闭才返回已有 shutdown Promise。

审计已看到 RPC 既有 `output → serializeJsonLine → writeRawStdout → rawStdoutWriteTail → writeRawStdoutChunk` 的逐输出 Promise tail/回调成本，以及 session.agent 既有 async 背压订阅。它们不是零分配，不能将本次新增分配为零写成整条 RPC 输出链零分配；本次低频关闭修复不改写该输出链。运行 source invariants 和 stream hot-path 回归；不把不驱动 RPC 的 bench:stream 冒充 RPC 分配测量。没有热路径实现改动，不引入专门分配 benchmark 或对象池。

隔离 CLI 夹具保留真实 parser、扩展绑定、session/runtime disposal 和输出刷新，只替换 provider 网络边界并观察生命周期。退出前保持 runtime 引用存活，检查 dispose/会话关闭各一次、runtime 回调引用释放、RPC stdin listener 移除、fixture timer/IPC listener/stream signal 释放。父进程只对自己的 ChildProcess 设置故障看门狗并等待 close；看门狗不是产品关闭期限，也不代表 Windows POSIX 信号验收。

## 验收计划

- stdin 保持打开、空闲 timer 调用 shutdown（重复请求）、session_start 直接关闭。
- 异步扩展命令请求关闭后仍写出对应 prompt 响应；扩展命令抛错仍保留原 extension_error 事件。
- 活动离线 provider stream 发出关闭请求后按已有回合收尾完成，终态输出不丢失，dispose/关闭事件不重复。
- preflight 失败注入保留原错误响应，再完成关闭；EOF 正常关闭对照；没有真实 provider 请求。
- 先在基线固化失败，再运行定向回归、source/stream invariants、`npm.cmd run check`、`npm.cmd --offline run build:offline`、`npm.cmd test`。最终 head 的 PR 审查及六分片 CI 独立记录。

任务根：`D:\RMProjects\Pi\.task-tmp\history-h01-c5b8685d5802407c80fb2109d21fa576`。TMP/TEMP/TMPDIR 在子进程环境设置并核验；测试各自的 mkdtemp 根由创建者登记、等待子进程 close 后使用现有 removeOwnedFixture 清理。当前没有合并结论；任务级 scratch 尚待验证完成后清理。

基线回归：`node --experimental-strip-types --test --test-name-pattern "RPC shutdown (idle|eof):" tests/rpc-shutdown.test.ts` 得到 **1 失败 / 1 通过**。idle 已收到真实 RPC ready 输出，但保持 stdin 打开后未关闭，只能由夹具故障看门狗终止；EOF 对照退出 0，runtime/session dispose 各一次，无网络调用，RPC listener 和 runtime 回调已释放。初次夹具曾把 Node stdin 自带的 end listener 算成 RPC 泄漏；已改为记录启动时 listener 身份，只检查 RPC 新增监听器，随后重新取得上述有效失败基线，没有将夹具错误当成生产缺陷。

## 候选验证记录

最终候选 `rpc-mode.ts` SHA-256：`19983cb4f9c79fee218f5bd939246f3b7ce575d23071a93221c084926b92802f`。首次候选为 `eab58be688479ecaf08ad67f9bd39c6bae9d0da3c99edf16861a4995420bf340`；两者生产差异仅为 isStreaming 改用 isIdle。

- 首次 `node --experimental-strip-types --test tests/rpc-shutdown.test.ts` 7/7 通过；复审修正增加 settled 场景后为 **8/8 通过**。每个场景均断言退出 0、runtime/session dispose 各 1 次、session_shutdown 1 次、真实网络调用 0 次；活动流正常完成，没有被 abort。启动时已有 stdin listener 以身份排除，RPC 新增 data/end listener 均为 0；长寿命 runtime 的 resolve/reject/rebind 回调已释放，fixture 的 timer、IPC listener 和 signal 引用已清空。
- `node --experimental-strip-types --test tests/source-invariants.test.ts tests/stream-hot-paths.test.ts`：17/17 通过。
- `npm.cmd run check` 与 `npm.cmd --offline run build:offline` 均通过。初次 check 仅发现测试 child 管道可空类型未收窄，修正后通过；生产实现未因此改变。
- TypeScript AST 对比整个 rpc-mode 文件：arrow/function expression **46 → 45**，正则字面量 **1 → 1**，字符串字面量 **146 → 146**，new Promise **3 → 3**，async 函数 **15 → 14**。这是源码结构计数，不能代替逐事件 allocation profile；此次低频修改未新增闭包或正则/字符串字面量。
- 首次 `npm.cmd test` 在 `alpha-footer-scans.test.ts` 两个断言失败后按既有 fail-fast 停止：长任务路径与分支名占满 120 列，footer 截断会话名。生产 footer、alpha helper 和测试均未修改，也不调用 RPC；同一会话在 240 列显示完整名称，在 120 列只显示截断路径/分支，遍历计数仍为 iteratorResults=0、entryCopies=1。保留这个独立环境限制，不把它标为通过，随后使用 `npm.cmd test -- --keep-going` 收集全套结果。远端最终 head 的六分片 CI 仍须全部通过才能合并。

全量 keep-going 在首次候选上执行 **417 个单元，412 个退出 0，5 个非成功**；RPC 七场景通过。除上述 footer 外，mutation-contract-recovery 的 detached parser 和 native-file-metadata 的缺失 platform package 夹具仍位于仓库依赖树内，向上解析到了 node_modules，因此缺失依赖断言失败；源码注释所要求的“outside host dependency tree”在本地任务临时根下不成立。interactive-control-images 的 21 用例通过、1 平台跳过，tui-retained-session-rebuild 的 47 用例通过，但进程未退出；记录并复核 PID/启动时间/父进程后，仅终止这两个自有 worker（分别运行 289/243 秒），runner 收齐日志并清理自己的根。这些单元不调用 RPC，未在 H01 混入独立修复，也未称全量通过。[完整结果回执](https://github.com/dragonbaba/super-pi/pull/199#issuecomment-6622134702)。

首次 [review finding](https://github.com/dragonbaba/super-pi/pull/199#discussion_r4463408397) 指出 settlement hook 内请求关闭会丢失公开 agent_settled。新增真实 CLI settled 场景先在首次候选固化 **1 失败**（缺少公开事件），改用 isIdle 后 RPC 8 + source/stream 17 共 **25/25 通过**；最终类型检查和离线构建再次通过。fixture 的异步 settled hook 完成标记、公开事件、dispose 次数和引用释放均被断言。生产 AST 计数不因这次布尔条件修正变化。后续推送需单独 `@codex review`；本记录不预写复审或 CI 通过。
