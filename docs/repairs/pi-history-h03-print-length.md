# H03 — print 截断结果明确返回失败

状态：真实 CLI 失败基线已固化，最小修复与本地验收完成，等待独立 PR 审查和 CI。基线为 H02-B 合并提交 `61bdbbac823093b93fe9ac986709c7909680ed69`，分支 `codex/h03-print-length`。

## 调用链与兼容性决定

`离线 provider stream → Agent/AgentSession.prompt → 最终 assistant stopReason → runPrintMode text 输出 → H02-B 共享 shutdown → main process.exitCode`。现有 text 仅将 error/aborted 设为 1，length 与 stop 一样输出文本后返回 0。JSON 由 session 订阅发送结构化事件，不走 text 最终态分支。

核对 [上游 #10799](https://github.com/earendil-works/pi/issues/10799) 和 [固定快照 print-mode.ts](https://github.com/earendil-works/pi/blob/676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d/packages/coding-agent/src/modes/print-mode.ts#L136-L155)，其修复也限定 text。决定仅修改 text：完整保留已经生成的文本块，stderr 提示 output token limit 导致截断，退出 1；stop/error/aborted 保持现状。JSON 的四种最终 stopReason 继续由 message_end 等事件表达，正常执行事件流的进程退出码保持 0，不往 JSON stdout 加入文字警告。此次不扩展 JSON 退出码协议，不增加自动续写、压缩或重试。

已沿用 H02 的完整 hot-path contract 审计：本项是最终态低频分支，不修改普通 delta/event/序列化或 output-guard，不拼接或重扫整个回答、不新增闭包/Promise/正则/容器。既有 stdout 队列的 Promise/回调成本保留且不声称零分配。验证 AST 增量、既有 source/stream invariants、H02 关闭回归、类型/构建；低频分支不冒充热流 benchmark。

## 失败输入和验收

真实源 CLI，静态离线 provider 经过生产 AgentSession 路径生成两个文本块，分别最终 stop/length/error/aborted。length 使用模型完整 output token limit，compaction/retry 在独立 fixture settings 中关闭；所有真实网络禁止，断言 provider 仅调用一次，避免把自动恢复后的结果误当原始截断。text/JSON 共八个用例检查实际退出码、stdout 文本或 JSON 最终事件、stderr、恰好一次 runtime/session dispose，以及保留 owner 的回调/idle waiter 释放。

任务根 `D:\RMProjects\Pi\.task-tmp\h03-ca0b12728305`，runner 资源和进程登记在 resources.json。沿用 H02-B reviewer 修正后的 createOwnedTaskFixture，每个 CLI 独立创建仓库 `.task-tmp/h03-print-result-*`，显式设置 TMP/TEMP/TMPDIR 为该 root 并断言 child os.tmpdir；close 后核对身份/reparse 边界、登记文件并清理该 owner。旧受阻任务根不转移或重试删除。

## 有效失败基线

`node --experimental-strip-types --test tests/print-result-status.test.ts` 在未修改最终态判断时得到 **7 通过、1 失败**，约 6.1 秒；只有 text/length 实际退出 0，与所需非零结果不符。其 provider 调用、session_shutdown、runtime/session dispose 均一次，completed=true，真实网络/uncaught/unhandled rejection=0，故不是清理中断或自动续写掩盖的假阳性。text 的 stop/error/aborted 与 JSON 四种结果全部通过。采用仓库内 fixture root 后重新运行仍为 **7 通过、1 失败**，每个 CLI 临时目录与本 owner root 一致，结束后清理存在性断言通过。

## 候选验收

生产改动仅在 text 现有输出循环之后添加 length 判定、stderr 警告和 exitCode=1；不新增状态、输入校验、重试或流式处理逻辑，既有错误/取消和 JSON 语义保持。H02-B 的关闭完成点仍负责最终返回结果和释放。

print-mode.ts SHA-256 `67e173ea3fe3f9f72027b46f167700a0d3e060d97fdcf3269522b1a3bd06e338`。`node --experimental-strip-types --test tests/print-result-status.test.ts tests/print-close-overlap.test.ts tests/source-invariants.test.ts tests/stream-hot-paths.test.ts` 得到 **30 通过、0 失败、3 POSIX 跳过**。H03 八项全部通过：text/length 保留两个文本块及顺序、输出明确警告、实际退出 1；其他 text 和 JSON 对照保持既有行为。每例 provider 请求/shutdown/runtime dispose/session dispose 均 1，真实网络/uncaught/unhandled rejection 为 0，保留 runtime/session 回调与 idle 引用、新增信号监听器已释放，独立 fixture root 退出后清理成功。

`npm.cmd run check`、`npm.cmd --offline run build:offline` 通过。AST 基线→候选 arrow/function expression **14→14**、function declaration **3→3**、regex **0→0**、strings **24→26**（length 判定和一条固定警告）、new Promise **0→0**、async **10→10**。无新增整回答复制、扫描、容器或对象池；这仅是低频最终态分支的证据，不表示既有输出链零分配。最终 head reviewer 和完整六分片 CI 尚待完成。
