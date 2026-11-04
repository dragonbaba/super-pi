# H02-A — RPC 重叠关闭共享完成点

状态：已固化失败并完成最小修复及本地定向验收，待 PR 审查和跨平台 CI。基线为 H01 合并提交 `2d92b18b92a070d2bd52afb32aae64a8e2ed5bf4`，分支 `codex/h02-rpc-shutdown`，Node v26.13.0。RPC 与 print 不共享关闭 owner，故按总方案拆为 H02-A/B 独立 PR。

## 已核对链路与设计

`RPC 扩展关闭 / stdin end / process signal → shutdown → runtimeHost.dispose → performDispose → teardownCurrent → session.abort / auxiliary shutdown → session_shutdown → session.dispose / lease release → stdout flush → process.exit`。H01 已使空闲扩展关闭主动启动，但现有 shutdown 第二次调用直接 process.exit，且首次调用在异步清理前移除 signal handler；真实重叠时可能跳过未完成清理。先用真实 CLI 和可控 session_shutdown 钩子复现，不能仅凭源码标为已发生。

runtime 的 disposeOperation 和 teardownOperation 已在调用可重入代码前发布，清理失败仍继续尝试 session/lease 释放并清除 runtime 回调。复用这些 owner，不修改 session/MCP/凭据协议。本项拟仅由 RPC owner 保留一个关闭完成点和首次退出原因；重复请求等待同一操作，保留信号处理直到最终退出边界。cleanup rejection 必须明确报告并非零退出，不留下 unhandled rejection。首次信号和正常关闭的退出码、SIGTERM 既有输出刷新选择均保持；清理失败优先标为失败。

## 性能与验收

已重新完整阅读 hot-path allocation contract，审计 H01 的低频检查及上述 runtime 链。普通 delta/progress、toJsonEvent 和 stdout 队列不改；现有输出链的 Promise/回调成本不等于零。本项只涉及 shutdown/performShutdown 和信号生命周期边界；必要共享完成点须先发布再运行可重入清理，不使用逐请求 Promise tail、轮询或新 deadline。运行现有 source/stream invariants，记录候选 AST 数量和单次 dispose/释放证据；不将不驱动 RPC 的流基准冒充本项分配测量。

真实源 CLI 夹具在 session_shutdown 内暂停，父进程观察进入清理后触发 EOF，只有观察到第二触发已到达才释放闸门；基线若提前退出，必须断言未完成的 dispose 和闸门，而非设置产品超时。POSIX CI 另用实际 SIGTERM；Windows 不用强制 kill 伪造信号处理。故障注入仅在实际 session.dispose 之后抛错，验证错误报告、非零退出及 runtime/session 回调释放。保留 runtime/session 引用到退出观测，所有网络访问禁止。

任务根 `D:\RMProjects\Pi\.task-tmp\h02a-77e0ce9983de`；子进程 TMP/TEMP/TMPDIR 已确认一致，resources.json 登记 runner 和子进程。真实 CLI 子目录由测试自身登记，待 close 后按既有 removeOwnedFixture 清理。H01 旧根因自动审批 `blocked by policy` 保留，未转移其所有权或重试删除。

## 失败基线与实施决定

`node --experimental-strip-types --test tests/rpc-close-overlap.test.ts`：Windows **2 失败、2 POSIX 跳过**。正常 EOF 重叠在 CLOSE_GATE/CLOSE_EOF 后直接退出 0，runtimeCalls=1、sessionCalls=0、completed=false、callbacksReleased=false，RPC data/end listener 仍存在；故障注入也尚未执行便退出 0，未走预期非零失败。没有依赖 watchdog 终止来制造这些失败。

初次夹具缺少离线模型而在 CLI 初始化时失败，补充静态离线 provider 后才取得有效基线；SIGTERM 监听器按 RPC 绑定前的函数身份排除既有全局 handler，避免把它算作本项泄漏。fixture ready 经 setImmediate 在 RPC 绑定完成后发布，POSIX 信号场景不会抢在注册前发送。

实施采用同步 shutdown dispatcher：首次保存退出码/信号并通过稳定 performShutdown 回调发布一个共享 Promise，再进入可重入清理；重复请求直接返回已有 Promise。这个低频 microtask 边界有必要的 Promise 分配，不能写成零分配；常规事件和重复请求不新增闭包或 Promise。runtime disposal 失败明确报告，仍移除 RPC 输入/信号监听器并尝试按首次信号规则完成输出收尾，最终返回非零状态。清理前不移除 signal handler，以便重叠信号继续加入同一 owner。

## 候选证据

候选 rpc-mode.ts SHA-256：`8d0f8cdaff6d01226af845bffca04ac8663c1e8399975e3b254056282c06095b`。`node --experimental-strip-types --test tests/rpc-close-overlap.test.ts tests/rpc-shutdown.test.ts tests/source-invariants.test.ts tests/stream-hot-paths.test.ts` 得到 **28 通过、0 失败、2 POSIX 跳过**。EOF 成功退出 0、故障退出 1；runtime/session dispose 各 1，completed=true、uncaught=0、真实网络请求 0；输入和 RPC 新增信号 listener 清零，保留的 runtime/session 回调和 idle waiter 已释放，闸门/IPC/启动 timer 均清空。H01 九个既有场景全部保留。实际 SIGTERM 两场景仅由 POSIX CI 验收，不把 Windows skip 当通过。

`npm.cmd run check` 和 `npm.cmd --offline run build:offline` 均通过。AST 对比 H01 合并基线：arrow/function expression **45 → 45**、function declaration **8 → 9**、正则 **1 → 1**、字符串字面量 **146 → 148**（仅两条低频错误提示）、new Promise **3 → 3**、async 函数 **14 → 14**。新增 performShutdown 为 owner 的稳定函数；首次关闭的 Promise.resolve/then/async 完成点有实际低频分配，new Promise 计数不覆盖这些隐式成本；重复请求返回同一操作，不另建 tail。没有增加普通事件分配或对象池。

本地全量任务根隔离的已知限制已在 H01 记录，H02-A 不重复运行无相关实现变更的失败矩阵。当前完整源码与集成回归交由最终 head 六分片 CI 运行；在全部通过及 reviewer 无未解决意见前不合并。本项提交同时补记 H01 的合并、两端分支删除及受阻缓存回执，不更改 H01 的冻结基线清单。

首次 [PR #200](https://github.com/dragonbaba/super-pi/pull/200) head `c23c135b3946a0271dba12d6f6f04ac63307d7e1` 的 Codex 审查 completed/no findings；CI 五分片已通过，Linux 1/2 长时间仍处于测试阶段，运行中日志 API 返回 404，尚不能确定其停留用例。检查发现夹具 watchdog/after 使用默认 SIGTERM，而本项恰好让重复 SIGTERM 等待清理，闸门异常时会妨碍测试自身收尾。因此将两个 RPC 夹具的故障 containment 改为只对自己的 ChildProcess 使用 SIGKILL，实际信号场景仍发送 SIGTERM；同时断言 dispose 时信号观测包装仍安装，防止观测失效被静默忽略。本地重新得到 **11 通过、2 POSIX 跳过**，类型检查通过；生产源码/hash 未改变。后续推送单独请求复审，旧 CI 的部分通过不替代最终 head 全绿。

已按精确路径/长度/SHA-256 删除最初 16 份日志。随后缓存清理被自动审批在执行前拒绝，原始原因 `blocked by policy`；原任务根仍保留 jiti/node-compile-cache 共 107 文件、3 目录，以及 resources.json、run.ps1、pr-body.md，manifest 登记 blocked。[清理回执](https://github.com/dragonbaba/super-pi/pull/200#issuecomment-6622677958)。上述后续夹具检查生成的日志另有登记，未重试受阻的缓存删除或转移旧根所有权。
