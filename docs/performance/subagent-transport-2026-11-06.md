# 子代理传输与诊断验收

基线：`347eeef05` 加阶段 B 工作树。环境：Windows、Node v26.13.0，2026-11-06。
遵守 [热路径分配契约](hot-path-allocation-contract.md)。本记录不代表 C4 权限继承或 E 进度显示已完成。

## 生产调用链与分配

发送链：Agent 的 critical event delivery → AgentSession → `runPrintMode` →
`SubagentStream.onEvent/writeLine` → 原生 Writable。`--subagent-stream` 仅由子代理启动参数启用，
`main` 显式传递选项；普通 JSON/RPC 的 `toJsonEvent` 及其协议形状不变。

原输出 helper 每事件建立 Promise 尾链。子代理现在使用独立 owner 和稳定写入、error、drain 回调；
普通事件返回 void，Writable 产生背压时才共享一个 busy-cycle deferred，结束时等待全部写回调。
背压订阅过滤掉 provider delta/tool progress，避免为不发送的 delta 新增 awaited snapshot。
并发生产者共享同一等待，完成消息不丢弃，未创建应用层输出队列。

结果只由 `message_end` 发送一次；工具开始/结束仅带 ID、名称和错误标志，轮次和终止事件仅带状态。
`agent_end` 保留 willRetry/requiresUserInput，`agent_settled` 保留 aborted。message_start、delta 和重复聚合内容不发送。
三个编码记录属于单个 owner，同步序列化时使用；message/tool 引用在 finally 中清空，不跨 await，未引入对象池。
完整消息 JSON.stringify 一次，随后附加换行；保留必要的 JSON 字符串、UTF-8 传输和接收解析分配，
不声称 V8 cons-string flatten 或 Writable 内部字节编码零分配。

接收链：`SubagentProcessRun.onStdoutData → processLine → appendBoundedMessage → boundedMessage`。
继续逐行解析所有实际输入并计入原来的 8 MiB 单行、128 MiB 总量、事件数限制；最多保留三条消息。
没有字段顺序预筛选；移除无生产者的 tool_result_end 分支，不改变其余输入语法。

stderr 链：`onStderrData → StderrTail.push` → close/error 时 `take` →
`failureDisplayText/getResultOutput → executePreparedBatch` 的工具错误/结果。
每个子进程有独占 32 KiB 字节环形缓冲，push 不创建闭包、Promise、数组、字符串或 Buffer 视图；
完成后一次解码并释放缓冲。截断从 UTF-8 边界开始，提示包含在 32 KiB 预算内。
最终摘要在 4096 B 内同时保留显式错误和 stderr 尾部，避免把摘要再写入 errorMessage 后遮蔽诊断。

低频分配边界具体为：SubagentStream 构造/dispose、wait 的一个共享 deferred、
StderrTail 构造/take、进程完成时的失败摘要与既有最终发布。状态/帧渲染链未修改。

## 确定性计数与采样

`node --expose-gc --experimental-strip-types scripts/bench/subagent-stream.mjs` 驱动生产发送器、
Writable、生产 stdout 解码/解析/保留及 stderr 收集，1000 组约 4 KiB 工具结果：

| 计数 | 结果 |
| --- | ---: |
| 输入事件 / 输出行 | 6000 / 4000 |
| 完整工具结果序列化 | 1000（每份一次） |
| 全部序列化（含小元数据） | 3000 |
| 正常输出逐组 deferred / 最终 flush deferred | 0 / 1 |
| 保留消息 / stderr 字节 | 3 / 32766 |
| 总采样 / 每组消息采样 | 19,076,000 B / 19,076 B |
| sender / receiver / stderr 归属采样 | 94,608 / 8,752,192 / 0 B |

前四个采样点为 utf8Write 4,566,952 B、序列化计数入口 4,398,720 B、processLine 4,099,944 B、onStdoutData 4,054,600 B。
总量包含 Writable、UTF-8 编解码、JSON 解析及测试调度；不能把该单次采样当作应用速度或跨机器门槛。
原生 sender 的高频 callback/方法和 stderr push 由 AST 检查禁止内联闭包、await、对象/数组字面量、
Promise 尾链或临时 bind。慢 Writable 验证同一 busy cycle 的并发 backpressure/flush 返回同一个 Promise。

既有 `scripts/bench/subagent-management.ts` 未使用会在源码目录写临时模块的 --baseline 选项。
8/16/64 个 child 代表场景的接收采样分别为 8919.952/8600.320/8567.664 B/update，
每事件完整消息重序列化=0、进度快照=0，保留消息分别为 24/48/192；不以这些采样声称 CPU 提速。

## 释放与真实验收

新基准覆盖正常完成、写错误、中止/dispose：保留四个已 dispose 的 sender owner，
其输出/写函数/等待引用清空，7 个输出流、结果图和缓冲 WeakRef 经 8 次 GC 后存活 0。
写失败后的 error observer 保留到真实 Writable error 事件，避免移除过早造成 uncaught error；
有未完成物理写入时仅保留必要观察者，最后回调结束后释放。
既有管理基准的 344 个结果/任务引用和 768 个前台引用全部回收，四种终止方式的队列/槽位/等待者均清零。

真实子进程由受控事件源驱动生产 runPrintMode，再经生产 SubagentProcessRun 收取：
163 次 50 KiB 读取通过，收到 164 个完成事件，传输 8,396,618 B，保留三条消息及 FINAL_REPORT；
单条有用消息超过 8 MiB 仍被拒绝。通用 JSON 控制仍保留 aggregate messages。
完整 CLI 的私有子流也已运行，正常退出、配置/会话均为夹具，无网络请求。
真实 stderr 子进程覆盖长中文/emoji 分块、显式错误组合及短错误，最终工具错误仍含 FINAL_ERROR_MARKER。
未调用真实模型；此处不是子代理冷启动性能测量。

复现检查：

```text
node --experimental-strip-types --test --test-concurrency=1 tests/subagent-management.test.ts tests/subagent-hot-paths.test.ts tests/subagent-stream.test.ts tests/cli-args-terminator.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/print-result-status.test.ts tests/print-close-overlap.test.ts
node --expose-gc --experimental-strip-types scripts/bench/subagent-stream.mjs
node --expose-gc --experimental-strip-types scripts/bench/subagent-management.ts
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
```

第一组 61 通过、1 个 POSIX 专用检查在 Windows 跳过；第二组 14 通过、3 个 POSIX 信号检查跳过，类型检查通过。
CLI flag 在补充断言后另单独通过。全部测试子进程的 TMP/TEMP/TMPDIR 经预加载检查或夹具退出记录验证；
独占夹具清理遵守各自资源记录，原始日志保留在当前任务根，以上测试与基准是稳定复现入口。

测试维护仅删除已失效事件分支对应的第二处结构计数，保留有效生命周期检查；
新增三个传输测试、一个最终错误链测试和一个真实 CLI 子流正常对照，未复制完整权限/协议组合矩阵。
分配基准独立运行，不增加普通 CI 的采样成本。PR 最新提交审查、CI 和合并状态以修复计划为准。
