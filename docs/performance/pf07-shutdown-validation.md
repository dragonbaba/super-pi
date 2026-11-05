# PF07 关闭阶段与活动资源验证

日期：2026-11-05。基线 `a2263ca9af652234bcc89b6eb9748581d1308403`。[PR #225](https://github.com/dragonbaba/super-pi/pull/225) 已合并为 `a8fc80aa5bd03ce5e33a7ac5def010b9c30f521d`；审查 head `f9c8307b07f18c6991ae0467e51e2c9d418b1744` 为 completed、无发现/无未处理项，CI run `41976974314` 的 Linux 2 + Windows 4 六项全部成功。审查/合并树均为 `293ad784c39d19d315193350c9ee7f73ab6dddd4`。遵循[总方案](../super-pi-performance-followup-plan.md)、[PF00 协议](pf00-baseline-validation.md)与[分配契约](hot-path-allocation-contract.md)。原始失败、计数、采样、进程与构建摘要、复现驱动见 [PF07 证据](../evidence/performance-pf07-shutdown-2026-11-05.json)。

## 已复现的关闭竞态

基线下，两个 WorkspaceSandboxBackend.close() 并发，或 discardSnapshot() 与 close() 并发时，均进入两次 VM cleanup；第一项完成后清空 this.vm，第二项恢复时读取 this.vm.state，报 TypeError。两个用例都得到一个成功、一个失败，文件清理只执行一次。复现使用同一共享 VM 完成门及真实文件身份/删除流程，未启动 VM；基线失败日志保留。

修复添加两个固定 Promise 槽：discardOperation 统一同一快照的 VM 和文件清理；closeOperation 统一关闭调用，成功后保留已完成 Promise。失败时清除相应 Promise 槽以允许显式再次尝试，未释放的实际资源身份和引用继续保留。底层 SandboxLifecycle 的 blocked-cleanup 仍遵循原有封闭策略，不能把外层允许重试解释成自动解锁或强行回收不确定 VM。

discard 进行期间拒绝新 invoke，避免重新使用正在清理的快照。成功 discard 后仍允许下一次 invoke 捕获新工作区；close 一经开始就禁止新工作。close 仍先等待已接纳操作，调用者仍须先撤销执行边界/取消活动请求；没有改成 close 自行取消，也未改变终端 drain、最终输出、扩展 timeout 或 process.exit 时序。

## 调用链、成本和释放

WorkspaceSandboxTools.execute → executionBoundary/AbortSignal 校验 → backend.invoke/run → workspaceInput/source identity → VM CapturedProcess.wait/output callbacks → reply 校验 → host publication；运行或发布失败进入 discard，runtime/权限 owner 关闭进入 close。VM cleanup 先停止本 owner UUID、确认列表中消失，再等待仍在执行的 CLI 物理结束；文件删除继续验证 dev/ino、真实路径、预期 guest 文件和无链接边界。失败不丢清单、不改用猜测 PID 或宽范围删除。

普通 invoke 仅新增一个固定槽条件判断，仍使用原有实例稳定 releasePending 回调；没有增加 per-chunk/event/frame 的 closure、Promise、controller、wrapper、数组、regex 或完整字符串复制。关闭 helper 的 async Promise 属于低频生命周期：一个关闭完成点、至多一个活动 discard 完成点；重复完成后的 close 返回同一 Promise。现有 execute 每次工具调用的 check 闭包、publish 每次文件发布的 record 回调、run/start 的请求对象、JSON/缓冲区、cold-start 回调和 releaseArtifacts 的排序数组/比较器仍计入完整链成本，未宣称全链零分配。它们是工具命令/发布/关闭边界，不是输出 chunk 回调。CapturedProcess 的输出回调保持每 owner 稳定，两个固定 16 KiB 缓冲区在物理 close 时清空引用。没有对象池或新全局缓存。

## 真实 Windows Sandbox

同一 Windows 宿主基线的只读/断网与可写/联网两组已通过：guest PowerShell 7.6.9，项目内容和 cwd 正确，DNS/HTTPS 跟随显式网络模式；联网组使用禁用 scripts 的固定公共 is-number@7.0.0 安装，宿主文件不变且 node_modules 不回写。两次单次关闭均确认 VM 和工作区引用为零。

候选离线构建的活动用例先正常执行 ls，再等待新的执行 CLI 确认有本任务 PID 且未结束，取消后调用两次 close 并断言同一 Promise。观测取消至关闭 935.09 ms，VM 状态 closed，8 个自有 CLI 均有物理结束时间，活动执行为 cancelled/settled；backend pending/vm/sourceFiles/ownedArtifacts 全为零，宿主 fixture 不变。此用例证明已预热 VM 的物理执行客户端在途，未把它当成 guest Start-Sleep 已进入或所有平台的延迟保证。

## 退出前 watcher 未决项

独立诊断 preload 包装 fs.watch/close，按编号记录关闭请求与 close 事件，并仅在诊断子进程中把最终 process.exit 替为 exitCode，让事件循环自然结束。bundled regular/fullscreen 各两次：每个 watcher 都收到一次关闭请求、一次 close 事件；exit-request 快照仍有 FSEventWrap，natural-before-exit 已无该项，所有子进程自然退出且 raw/bracketed paste/alternate-screen 恢复检查通过。该观察支持底层句柄异步收尾，未发现此路径的活跃 watcher owner 泄漏。没有据此修改产品强制退出行为。

分段探针与普通计时分开；五个独立窗口，每侧 2 次预热与 30 次正式观测，共 320 个子进程，另有上面 4 个自然退出诊断。普通 bundled/fullscreen 退出 p95 为 100.5963、98.0211、97.4277、100.8263、97.4308 ms，中位数 98.0211 ms，跨窗口最大绝对偏差带 2.86%；probe 总退出 p95 中位数 98.8621 ms、带 1.51%。当前样本总退出稳定，PF02 的历史不稳定样本继续保留，未用当前结果覆盖历史失败或宣称本次改动提速了普通退出。

探针阶段 p95 中位数分别为 drain 64.5594 ms（带 0.66%）、UI stop 5.0953 ms（7.77%）、runtime dispose 5.0114 ms（10.48%）。runtime 的五个 p95 范围 4.4861–5.1687 ms，相对带仍超 10%，不宣称该短子阶段绝对延迟稳定，也没有据此调整清理顺序。各阶段 p95 不能直接相加；普通计时另含输入传递、进程物理关闭等边界。50 ms 输入安静等待保护终端协议收尾，1000 ms 是上限，不是固定等待。

## 分配、对照和受控 GC

普通接纳边界以预完成的 fixture run Promise 隔离 invoke/原有 finally，不将这组纳秒级测量当 VM 执行延迟。五组交替进程、10 预热/30 正式批次、每批 2 万次：p95 中位数 0.000174660 → 0.000175035 ms（+0.21%），基线带 1.08%；候选首组离群使带达到 19.47%，仅该配对超门槛，其余没有重复超门槛回退，绝对纳秒延迟不作稳定承诺。三组 HeapProfiler（4096 字节间隔、包含回收对象）接纳分配中位数 708.13 → 715.83 B/次（+1.09%）。这里包含驱动的空 input、await 和 profiler 成本，不能当精确产品分配。

完成后的 2 万次重复 close，基线返回 Promise 身份变化 19999 次，候选为 0；采样分配中位数 1465.56 → 50.68 B/次（−96.54%），剩余主要是驱动 await 等成本。此收益发生在重复生命周期调用，不外推到 streaming/frame。三个独立 GC 进程在成功和受控失败后重试两条路径各进行六次跨事件循环 GC，旧 VM/source 弱引用、owned/sourceFiles/pending/discardPending 全为零。失败尚未重试时，owner 与源条目按预期保留。

生产 CapturedProcess/权限门禁处理 17 MiB 输出，保留两个固定缓冲区共 32 KiB，272 个 chunk 的 hot Promise/controller 为零，9 个弱引用目标四轮 GC 后均释放。input lifecycle 的 10 万事件仍仅一个共享 Promise、最多一个计时器和监听器，结束后引用全部归零。帧队列 2 万个预构建帧，Promise/controller/wrapper/完整复制均为零，flush 后活动/待写引用和字节为零；interactive reference 的 renderer 切换与稳定方法访问门禁通过。这些原有热路径未修改，不把单次非目标采样解释为新的性能改善。

## 验收与边界

12 项定向测试（含新增 7 个行为用例、AST 门禁及既有路径测试）通过。新增 AST 测试一处嵌套函数的 TypeScript narrowing 错误已修正，check 通过；初次临时基准把 Windows 绝对路径直接传给 --import 的错误也保留，改为 file URL 后测量通过。未降低测试断言或噪声门槛。`npm run build:offline` 构建 12/12 包，7288 ms、并发峰值 2；`npm test` 全量 450 个测试单元均退出 0。

| 场景 | 已执行的现有验收 |
| --- | --- |
| regular/fullscreen，活动 stream/tool、慢/失败 hook、启动时退出 | alpha-active-quit、alpha-shutdown-deferred、alpha-startup-quit、alpha-runtime-dispose |
| compaction、树摘要、Bash、任务退出确认/取消 | alpha-compaction-quit、alpha-task-quit、background-shell-tasks |
| 真 CLI 的 quit/EOF/扩展 shutdown/输出断开/进度 | alpha-cli 的两种 renderer；Windows 不支持的原生 POSIX signal 用例依原规则跳过，由 Linux CI 验证 |
| print/RPC 重叠关闭、MCP refresh 与文件锁 | print-close-overlap、rpc-shutdown、mcp-refresh-shutdown |
| 背压、异步物理写入、恢复与引用释放 | tui-frame-queue、tui-terminal-state 及上述 allocation/lifecycle 门禁 |
| 实际活动 VM | opt-in workspace live 的离线取消、共享关闭、物理进程结束与资源归零 |

真实 provider、原生终端延迟不由模拟 provider 或管道终端推断；PF05 纳秒计时限制仍传递 PF08。本阶段没有证据支持提前取消/调整 UI 与 runtime 次序，因此保留既有语义。已同步 main，精确删除远端/本地 `codex/perf-pf07-shutdown`。任务根 `.task-tmp/pf07-shutdown-b5fc8ce401` 在核验 45 个直接子进程 settled、4017 个资源身份及链接边界后清理（126 个直接子项，cleanup PID 39772）；共享父目录和 dist 保留，见[收尾回执](https://github.com/dragonbaba/super-pi/pull/225#issuecomment-6651049881)。
