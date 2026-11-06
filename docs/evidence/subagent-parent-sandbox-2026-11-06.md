# C4.b 父级沙箱子代理验收（2026-11-06）

基线：C4.a PR #242 合并 `6451353d4`，旧远端/本地分支已删除；本批 `codex/subagent-parent-sandbox`。原权限决策及“不得加强命令预检”约束继续有效。未修改 Shell 分析器、`child-security.ts`、`regex.ts` 或 C# 启动器检查。

## 实现与调用链

- 内置 subagent / subagent_tasks 使用跨源码/编译模块的非枚举标记，只有原生沙箱及父执行工厂可用才暴露。同名任意工具不被放行；标记不是进程内扩展代码的安全隔离。
- 父原生委派先验证 cwd 属于原主目录或附加目录，C4.a 的 ChildProcess IPC、权限代次及代理工具继续使用。子 CLI 无本地文件/任务/授权 owner，且不创建 VM。
- 完整生产链：子 CodeMode → IPC 请求 → 父 `SubagentExecution` → Agent 原生 nested dispatch / 授权 hook → `WorkspaceSandboxTools.execute` → 现有 `SubagentScheduler.reserve/run` → backend / worker → 候选校验、宿主发布、图像与产物释放 → reservation 释放 → IPC 回执。父编排等待不持有 VM 槽。
- 队列最多 65 个已接受请求（1 个执行、64 个等待），复用已有 FIFO 与取消监听。`drain` 覆盖完整工具调用，`close` 取消排队与正在执行的调用并等物理完成后关闭后端。父暂停及代次切换使用已有执行边界信号，不能释放旧槽后让实际旧工作继续跑。
- Shell 只映射结构化 literal cwd，命令字符串原样送到 VM；追加目录原生身份与旧目录映射不变。返回 ShellExecutionFacts 使用实际 cwd。来宾 cwd 必须是工作区内实际目录。

## 真实子进程与 VM

使用 `tests/subagent-parent-execution.test.ts` 的生产 CLI 离线 provider、真实 IPC、SDK 与 VM；全局默认 trusted-host，父模式分别显式 read-only/sandbox-write。

| 场景 | 已观察结果 |
| --- | --- |
| 两个只读子进程并发 read/ls | 2 个真实 child、4 次 VM 调用、VM starts=1、执行最大 1、排队最大 1；主文件未变、任务结束 reservation=0 |
| 写入及附加 cwd | read → 基于 snapshot 的 write 经父发布；Bash 在含中文、空格、单引号的附加目录执行；target/vm.txt 可在 VM 搜索且宿主未创建 target；5 次调用共一个 VM |
| 父暂停 | 先确认来宾 Bash 已开始，再排队一个父读请求并暂停；原命令取消，旧 VM 与产物释放，排队 backend calls=0、后续写入=0；新用户指令启动第二个 VM 并正常读取 |

首轮只读通过，写入在 Bash 返回 `SANDBOX_LAUNCH`。回执证明前两次 read/write 已完成，未把它们记成未执行。静态核对发现 supervisor 第二参数只接受主运行时根，新增 worker 错传附加根；实际 cwd 是独立第四参数。修正为 `roots[0]`，保留全部原检查、cwd 与命令；受控 guest 用例及失败的真实读写用例均通过。未以放宽命令检查解决问题。

测试结束经 session_shutdown / boundary dispose 释放子进程、VM、SQLite 与独占目录。live 日志：`c4b-live-children-1`（只读通过、读写首次失败）、`c4b-live-write-diagnostic-1`（准确回执）、`c4b-live-write-fixed-1`、`c4b-live-pause-1`，均位于任务根 `.task-tmp/permission-repair-883e92408b`；不保留真实用户配置或对话。

只读 live 的约 12 秒是两子进程及四次工具调用总耗时，**不是 VM 冷启动测量**。独立性能测量由 F 记录。

## 分配、生命周期与测试维护

`WorkspaceSandboxTools.execute/perform`、scheduler reserve/run 是一次工具调用的低频异步边界，拥有一次取消组合与有限 reservation；不会在 provider delta / tool progress 上创建对象、闭包或 Promise。原流传输、渲染热路径未变，C4.a 相应证据仍有效。

审计已有 scheduler 的 `takeSlot/drain/removeWaiter/releaseCount/releaseReservation` 及新 `settleIdle`：AST 验证这些方法无闭包、无 Promise；唯一新增 deferred 在生命周期 `waitForIdle` 被实际调用且仍有活动工作时创建，完成即清空引用。容量/取消验证同时核对 queued、active、reservation 清零，关闭不会把未停止操作伪装为已完成。

1000 次完整 WorkspaceSandboxTools 受控调用：activeMaximum=1，retainedReservations=0，普通请求 idleDeferreds=0；HeapProfiler 4096 字节采样得到 1,480,232 字节（单次采样，不作为优化幅度结论）。16 个独立 owner 成功执行并关闭后，4 轮让出事件循环与 GC，WeakRef 存活 0。

新增 `sandbox-operation-queue.test.ts` 只覆盖共享队列新边界；复用并扩展已有 cwd、guest source、native policy、真实 CLI 夹具，不复制旧命令矩阵。现有受控 VM/backend 测试仍有独立失败与生命周期覆盖，没有依据删除；live 默认 opt-in，不阻塞普通 CI。

## 可复现入口

先编译 coding-agent，并运行 `node scripts/build-windows-sandbox-runtime.mjs` 打包精确来宾资源。所有子进程 TMP/TEMP/TMPDIR 设为独占任务根，实际 tmpdir 已由 preload 校验；CI 不启动真实 VM。

```text
node --import tsx --expose-gc --test tests/sandbox-operation-queue.test.ts tests/sandbox-workspace-paths.test.ts tests/sandbox-search-scope.test.ts
node --import tsx --test tests/native-execution-policy.test.ts tests/session-permission-modes.test.ts tests/subagent-management.test.ts tests/subagent-hot-paths.test.ts tests/sandbox-workspace-shutdown.test.ts tests/sandbox-image-read.test.ts tests/sandbox-image-hot-paths.test.ts
node --import tsx --test tests/subagent-parent-execution.test.ts
# Windows，SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE=1：
node --import tsx --test --test-name-pattern="live sandbox|live parent pause" tests/subagent-parent-execution.test.ts
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
```

路径/guest/队列第一组 19/19；新增暂停/AST 及调整的 guest 定向组 6/6；policy 2/2；三项 live 按上述失败修复后通过。最终相关回归 108 通过、1 个 POSIX 条件跳过；真实宿主 CLI 9 通过（该普通运行另跳过 3 个已单独执行的 opt-in live）。最终 tsgo 类型检查、coding-agent 编译和 diff check 均通过。没有扩跑全仓测试；审查和 CI 在发生后补记，尚不代表 PR 已合并。
