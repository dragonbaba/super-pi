# H02-B — print 重叠关闭共享完成点

状态：已通过最终 head 审查及跨平台 CI，合并 PR #201，两端任务分支已删除。基线 `a5528db4f55bad298b58df949de80d5d4af98e03`，原分支 `codex/h02-print-shutdown`。print 与 RPC 各自持有模式订阅和退出状态，按 H02 的 owner 边界使用独立 PR。

## 已核对链路及先行决定

`main → runPrintMode → prompt / signal handler / finally → disposeRuntime → AgentSessionRuntime.dispose → teardownCurrent → abort / auxiliary shutdown → session_shutdown → session.dispose / lease release → flush / exit`。runtime 已发布共享 disposeOperation，但 print 的 disposed 布尔值会使第二次调用返回已完成的 async Promise；信号 handler 的 finally 随即 process.exit，可能跳过仍被 session_shutdown 闸门挂起的实际清理。普通 finally 又在 dispose 前移除信号处理器，无法接收清理期间的信号。先固化真实 CLI 失败，再实施。

最小方案拟在 print owner 中保存一个共享关闭 Promise、首次关闭原因和退出码，在调用可重入清理前发布。首次正常完成保持其工作退出码及 stdout flush；首次 SIGTERM/SIGHUP 保持 143/129 与现有不主动 flush 的信号退出路径；后续请求加入同一操作，不能覆盖首次原因。dispose/flush 失败明确报告且为 1，不产生未处理 rejection；信号处理器保留至完成边界。runtime/session 原有清理、会话和工具准入语义不变，不增加另一套生命周期框架。

## 性能和验证范围

已完整阅读 hot-path allocation contract，审计上述调用链及 output-guard 的最终 flush。仅改 shutdown/performShutdown、信号和 finally 等低频边界；普通订阅事件、JSON 序列化、provider 输出链不改，也不宣称其既有分配为零。共享 Promise 的首次 handoff 有实际低频分配，重复请求不创建新的 inline finally 闭包或 Promise tail；不增加正则、对象池、轮询或 deadline。记录 AST 前后计数、真实 dispose 次数及 owner 引用释放，运行相关 source/stream invariants 和类型/构建检查。

真实源 CLI 使用静态离线 provider 和扩展命令，session_shutdown 通过 IPC 闸门等待；父进程仅在第二触发已送达后释放。Windows 通过 IPC 调用真实注册的 process 信号 handler，此证据不冒充 POSIX 信号；Linux 额外发送实际 SIGTERM/SIGHUP。检查正常、重复、正常完成与信号交叠、清理错误，保留 runtime/session 引用观察回调及 idle waiter 释放，记录单次 dispose、零网络/未处理 rejection，以及 fixture 的 gate/IPC/listener 清理。SIGKILL 仅用于自有测试子进程失败 containment。

任务根 `D:\RMProjects\Pi\.task-tmp\h02b-7f52a59c960e`，resources.json 登记资源和进程，任务 runner 的 TMP/TEMP/TMPDIR 指向该根；最终 CLI 夹具隔离边界见 reviewer 修正。H02-A 的等待及修复不混入此项生产改动。

## 有效失败基线

`node --experimental-strip-types --test tests/print-close-overlap.test.ts` 在未修改 print-mode.ts 时得到 **1 通过、4 失败、2 POSIX 跳过**，约 3.8 秒，无 watchdog 超时。正常完成对照通过且所有引用释放；normal-overlap 在清理闸门处移除 production handler 后收到注入信号，未完成清理便退出 1；normal-error 完成实际 dispose 后以 1 退出，但观察到 uncaught=1、unhandledRejections=1。repeat/repeat-error 在第二信号回执后提前退出 143：runtimeCalls=1、sessionCalls=0、completed=false、callbacksReleased=false、IPC/信号监听器保留，故障注入尚未执行。每个子进程 tmpdir 均为本项根，真实网络调用为 0。由此确认共享完成点及错误收尾均有实际需求。

## 实施和候选证据

同步 shutdown 首次发布 `Promise.resolve().then(performShutdown)`，再进入可能重入的 runtime 清理；重复请求直接返回同一操作。保存首次退出码和信号，先正常完成再收到信号仍返回原工作结果，先 SIGTERM/SIGHUP 则保持 143/129。失败将结果改为 1，打印明确错误，正常路径即使 dispose 失败也继续尝试 stdout flush。unsubscribe 引用、signalCleanupHandlers 数组和 shutdownSignal 在完成边界释放。主 try/catch 只记录工作结果，最终 return 移到共享清理之后，避免 finally 修改失败码时早先 return 已求值。

候选 print-mode.ts SHA-256 `cba81f9f3463d578785276ac686e69b5eb3d0091c732699d68d8f6694720bb8a`。`node --experimental-strip-types --test tests/print-close-overlap.test.ts tests/rpc-close-overlap.test.ts tests/rpc-shutdown.test.ts tests/source-invariants.test.ts tests/stream-hot-paths.test.ts`：**33 通过、0 失败、4 POSIX 跳过**。print 五个 Windows 场景全部通过；runtime/session dispose 各 1、completed=true、网络/uncaught/unhandled rejection=0，保留 runtime/session 的回调/idle 引用释放，IPC gate/handler 和新增信号监听器清空。额外补充 Linux native-normal 场景验证正常清理期间真实信号保持首次正常退出；Windows 明确跳过此 POSIX 场景，不计为已验证。

`npm.cmd run check` 与 `npm.cmd --offline run build:offline` 通过。AST 基线→候选：arrow/function expression **16→14**、function declaration **1→3**（稳定 shutdown/performShutdown）、regex **0→0**、string literal **22→24**（两条清理错误）、new Promise **0→0**、async 函数 **10→10**。new Promise 语法计数不包括首次 Promise.resolve/then/async 的隐式成本；仅首次关闭创建共享 handoff，不再逐信号创建 finally 闭包及 tail。普通事件链无改动，不做未测量的整链零分配或性能提升声明。

保留既有输入校验、provider/工具准入、输出协议和 runtime teardown，不增加内部重复校验或新的重试/兜底。新的三个槽位分别代表关闭完成点、首次退出码和首次信号规则，均有当前消费者。完整六分片 CI 和最终 head 审查是合并门禁，本地已知 TMP 路径全套测试限制沿用 H01 记录。

## Reviewer 资源隔离修正

[PR #201 首轮意见](https://github.com/dragonbaba/super-pi/pull/201#discussion_r4463812039) 指出直接运行测试时继承 OS tmpdir，CLI 的 cache 可能写到 fixture 的清理边界之外。原本任务 runner 确实把所有临时变量设到任务根，但这不足以保证 standalone/CI 的夹具自身边界；采纳该意见。

新增 test-only `createOwnedTaskFixture`，固定在仓库 `.task-tmp` 创建独立 `h02b-print-close-*` owner；cleanup 不接受调用方路径，只使用创建时捕获的 root，核对父边界、dev/ino 和 reparse 条目，登记本根文件，child close 后删除并验证不存在。既有 `removeOwnedFixture` 的 OS tmpdir 断言不改，也没有扩展成任意目录删除器。每个 CLI 子进程显式设置 TMP/TEMP/TMPDIR 为自己的 root，退出断言检查这个 root；资源清单保存 PID/启动时间/退出结果。共享父目录仅由本 owner 创建且为空才移除。任务 runner 本身仍使用原任务根，旧受阻资源不转移所有权。

修正后的 Windows 实测 **5 通过、3 POSIX 跳过**，每个 child 的 os.tmpdir 均等于新建仓库内 fixture root，cleanup 后存在性断言全部通过，类型检查通过。生产 hash 和 AST 计数未改变。该修正后推送单独请求 `@codex review`。

最初五个 runner 子进程全部退出，正式证据已保存；117 文件、3 目录的精确清理被自动审批在执行前拒绝，原始原因 `blocked by policy`。[回执](https://github.com/dragonbaba/super-pi/pull/201#issuecomment-6623063328)。原任务根保留日志/cache、resources.json、run.ps1、pr-body.md，manifest 标记 blocked，未重试受阻删除。后续 reviewer 验证日志另行登记，不将 fixture 的成功清理冒充原任务根已清理。

## 最终交付回执

最终 head `8fe270e4cee8ff772348fc072a05d6a56aaece59` 推送后单独 [请求复审](https://github.com/dragonbaba/super-pi/pull/201#issuecomment-6623140343)，[reviewer 无新意见](https://github.com/dragonbaba/super-pi/pull/201#issuecomment-6623161622)，原线程已修复并 resolve。[最终 CI](https://github.com/dragonbaba/super-pi/actions/runs/41777669405) Linux 2 / Windows 4 分片全部 success；Linux print 八例全部通过，真实 native-repeat/native-hup/native-normal 分别以 143/129/0 退出，每例 runtime/session dispose 各一次，引用/监听器/闸门均释放，真实网络/uncaught/unhandled rejection 均为 0，CLI tmpdir 与仓库内本夹具 root 一致。

[PR #201](https://github.com/dragonbaba/super-pi/pull/201) 按最终 head 锁定合并，merge commit `61bdbbac823093b93fe9ac986709c7909680ed69`。已确认 origin/main 包含该提交并 fast-forward main。首次远端删除因 TLS handshake 网络失败未执行；重新核对精确远端 head 后删除成功，本地/远端 `codex/h02-print-shutdown` 均已查询确认不存在。此网络错误与临时资源自动审批 block 分别记录，未绕过后者。
