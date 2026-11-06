# 子代理原生界面进度验收（2026-11-06）

基线：`11db072a4d0d4f4474a08053341a159cbccf6a32`，阶段 E / S3 / E-1。Windows、Node v26.13.0。临时日志、受控子进程及 TMP/TEMP/TMPDIR 使用本任务 `.task-tmp/permission-repair-883e92408b`；测试夹具独占目录另有精确资源记录。

## 行为与调用链

运行中的原生 TUI 每秒显示最新已完成轮数、token、费用、最近工具和已用时间。每个已准入前台批次一次分配精简状态行，行数受现有任务 reservation 上限（最多 256）约束；不保留任务文本、消息或 stderr。后台调用不创建这些状态行。协议/API 仍只发送原来的开始/结束隔离快照。

已审计两条生产链：

- `SubagentStream → Writable → SubagentProcessRun.onStdoutData/processLine → copyNativeProgress → NativeSubagentProgress`：完成消息只更新固定原始值字段；最近工具名上限 80 字符；没有逐消息状态事件、回调、Promise、AbortController 或结果数组。
- `SubagentStatusText.tick → ToolExecutionComponent.refreshResult/updateDisplay → extension renderResult → resultStateCounts/refreshStatus → TuiMainScreen → terminal frame queue`：每组件一个稳定 1 秒 tick，复用统计对象和 Text。格式化字符串、显示行及通用扩展 renderer context 沿用既有渲染边界。原 `emitSingleResultUpdate → executePreparedBatch → ForegroundTask → Agent ToolProgressDelivery` 的隔离快照及异步交付维持生命周期频率，没有迁入逐消息或定时路径。

普通完成、失败、取消、前台转后台停止定时器；组件 cache release 清除组件及 renderer state 的派生引用，恢复时从当前活跃 owner 重新绑定。任务结束关闭 owner、从 map 删除并清空异步闭包绑定；最终历史结果只保留有界统计。没有对象池，没有命令解析、筛选或工作区权限变化。

无 details 的最终错误在该历史组件的 renderer state 保留精简最终统计（与原任务 reservation 同界限），用于 cache release 后重绘；它是错误回执缺少的最终事实，不是活动 owner 或显示缓存。不含 task/messages/stderr、没有对 owner 的反向引用，也不增加第二份行数组。组件被丢弃时随组件释放；常规成功回执直接使用其 details，不额外保存。

## 实际验证

相关五个文件共 **70 通过、1 个 POSIX 平台跳过**：`subagent-management.test.ts`、`subagent-hot-paths.test.ts`、`subagent-stream.test.ts`、`tool-renderer-source-invariants.test.ts`、`tui-tool-leaf-closeout.test.ts`。`tsgo --noEmit` 通过。

其中三个新增用例启动真实受控 Node 子进程，使用实际 `ToolExecutionComponent`、`TuiMainScreen` 和记录终端帧的 FakeTerminal，分别完成、失败、取消。不是人工终端验收，也未调用外部模型服务：

- 第一轮界面为 `1 turn ↑1 ↓2 $0.0100 … read`，第二轮为 `2 turns ↑2 ↓4 $0.0200 … ls`。
- 子进程等待文件门闩、不发送消息时，1100 ms 后耗时文字及终端帧仍更新；中间协议更新始终只有开始一次，结束后合计两次。
- 三例 tick 各 3 次，终端帧分别 6/5/5；结束 timer/live-owner/invalidator 均为 0，cache release 后行和文本引用归零，4 轮受控 GC 后 WeakRef 均释放。
- 成功例额外覆盖 cache release 停止与恢复重绑定。既有前台转后台测试继续通过。

首次失败/取消用例发现：保留原始异常对象时，异步执行闭包仍保留已关闭 owner。清空结束时的 `progress` 绑定后，定向两例及最终回归通过；没有丢弃异常、放宽 GC 断言或掩盖失败。

PR #244 首轮审查指出最终结果被已关闭的 owner 覆盖。复用原 checkpoint 交接测试接入生产组件后，在修改前确实显示 `1/2 completed · 1 failed`，而最终回执只有一个成功步骤。改为最终 details 优先、仅无 details 的错误回执使用保留事实，计划同步补充这一遗漏。修复后交接、三项真实进度/GC、投影 AST 共 5/5 通过，类型检查通过；复用已有效的基准，因为只有状态选择顺序变化，没有新增状态复制、回调或框架。

第二轮审查指出无 details 错误在 cache release 后丢失统计。扩展现有失败例后，修改前重绘确实仅有 `subagent failed`。保留上述有界最终事实，同时继续清除活动 owner、timer、文本及 latestDetails；成功/失败/取消均验证 GC 后重绘，不靠保留活动 owner 恢复界面。

## 分配与生命周期证据

可复现入口（使用任务 runner 设置并验证子进程临时目录）：

```text
node --expose-gc --import tsx scripts/bench/subagent-stream.mjs
node --expose-gc --import tsx scripts/bench/tui-tool-leaf-allocations.ts --updates 2000 --warmup 200 --history-items 500
node --expose-gc --import tsx scripts/bench/interactive-progress.ts . burst --sample
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
```

`subagent-stream`：1000 次迭代、6000 源事件、4000 行；payload 序列化 1000、总序列化 3000；每更新 deferred 0、状态事件 0、最终 flush deferred 1。精简状态行 1、消息引用 0；既有历史上限在本次运行保留 3 条、stderr 32766 bytes。采样总计 18,700,880 bytes（18,700.88/迭代），sender 107040、receiver 8684880、stderr 0；主要站点为序列化、UTF-8 写入、stdout 解码及 JSON 接收。保留 4 个已 dispose sender owner，9 个 WeakRef 在受控 GC 后全部释放。该结果包含既有传输与 JSON 开销，不等同新增状态复制的分配量。

通用工具叶子基准（每组 2000 次交付）：

| 场景 | 采样 bytes/交付 | CPU p95 ms/交付 |
| --- | ---: | ---: |
| generic | 1159.436 | 0.0029 |
| built-in | 934.808 | 0.0021 |
| custom | 1239.724 | 0.0025 |
| image | 1043.9 | 0.0026 |

各组新增组件、内置 Promise、snapshot、参数序列化均 0；2000 次 requestRender 合并成 1 次 doRender / frame write，最终 sentinel 正确、scheduler pending 0。既有 built-in/custom 渲染上下文和包装仍按基准记录（分别 2000/4000 contexts、各 4000 wrappers），没有将整条通用渲染链误记为零分配。主要分配来自基准采样、既有 `formatToolExecution`、`getRenderContext`。源码门禁的逐更新内联闭包、Promise tail/array、事件 wrapper 均 0。

交互 burst：20000 次更新合并为 1 次 drain、2 次交付/请求，high-water 1；结束 active/pendingTools 均 0，采样 191.7872 bytes/源更新，GC 后 heap delta 300816 bytes。原生状态复制与稳定 tick 的 AST 检查额外禁止对象、数组、new、内联回调。以上是本机单次可重复入口及结构计数，不据此声称普适性能提升；未引入缓存优化或对象池。
