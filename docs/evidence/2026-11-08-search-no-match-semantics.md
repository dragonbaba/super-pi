# 搜索无匹配与 Shell 查询状态修正

日期：2026-11-08。基线：`b598adc4e397498ba0a29405b8040c4be70531b4`（PR #268 已合并）。该 PR 的远端、本地分支均已删除，随后从最新主分支创建本次修复分支。

## 已复现的区别

使用独占合成文件调用真实工具，没有重放私人会话或调用模型服务：

| 调用 | 观察结果 | 含义 |
| --- | --- | --- |
| 内置 grep，无匹配 | 正常返回 `No matches found` | 专用搜索工具已经正确处理空结果 |
| 内置 grep，非法正则 | 抛出正则解析错误 | 真实错误应保留 |
| Bash 中 grep，无匹配 | 命令退出 1，现有 Shell 工具报告非零结果 | 未明确处理查询结果，不是 Shell 启动失败 |
| Bash 中 grep，非法正则 | 命令退出 2，保留 stderr | 真实错误应保留 |
| Bash 中显式处理 grep 的退出 1 | 正常返回 `No matches found` | 调用方可以明确表达预期的空结果 |
| 同一处理方式遇到非法正则 | 仍退出 2 | 不能用 `\|\| true` 把所有失败吞掉 |
| Bash 中 diff，对比不同文件 | 退出 1，输出差异 | “有差异”是查询结果 |
| Bash 中 test，条件为假 | 退出 1，无输出 | “条件不成立”是查询结果 |

本次原始症状来自 Bash 内的 grep；内置 grep 没有误判空结果。该区别已在 #268 审计记录中说明，本轮继续定位通用 Shell 结果协议与后续消费。

## 范围与方案状态

用户明确否决方案 1：不通过增加模型指令、要求特定调用方式来解决，不增加命令匹配或限制。已撤回刚才对 Bash、PowerShell 指引和 grep 说明的全部修改，未提交该方案。

用户已确认统一结果语义：正常结束的进程返回原始退出码、输出和现有执行事实，区别于工具启动/传输/执行中断故障；不按命令文本猜测含义、不设命令白名单，也不把非零退出码改写成 0。

## 已确认方案与实现范围

- 生产根因位于 `createShellToolDefinition` 的最终结果分支：`exitCode !== 0` 无条件生成 `SHELL_RUNTIME_FAILED`，随后抛出 `ToolResultError`。Bash、PowerShell、前台和托管后台共用该入口。
- 替代方案保留原始 `shellExecution` 事实及非零状态说明，正常结束不抛工具异常。启动失败、超时、取消、信号中断、输入/输出不完整、日志或观察故障继续报告工具异常，不能因进程恰有退出码而被掩盖。
- CodeMode 的失败聚合、重复失败计数依赖工具异常状态；统一结果语义后，不会仅因正常退出非零就走工具故障恢复。原始退出码仍必须出现在模型可见输出和工具结果中。
- `false-success-guard` 已独立读取结构化执行事实，并通过 `shellExecutionSucceeded` 要求退出 0；不改动现有验证识别范围，编译/测试非零仍不能解除未通过的验证记录。
- 托管后台的 completed 表示命令运行结束，不等于命令业务成功；须验证后台输出、任务查询和 CodeMode 仍清楚显示原始非零状态。
- 兼容性变化对所有正常结束的命令统一生效，包括编译器报错。调用方判断命令是否成功须读取退出码；工具的非错误状态仅表示执行完整结束。工具说明只解释返回协议，不规定调用方式或限制命令。
- 实现集中在共享 Shell 完成分支：独立追加非零退出码，移除该状态单独触发工具异常的行为，保留输出完整性与中断检查。既有 `SHELL_RUNTIME_FAILED` 的历史结果展示支持保留。

## 性能与验证

已阅读性能契约，核对完整链路：`createLocalShellOperations` / PowerShell 后端 → `OutputAccumulator` → 共享工具完成分支 → Agent 结果/扩展事件 → CodeMode 子结果与后台任务 → Bash 结果渲染 → 派生状态释放。生产改动只有完成边界的状态处理和工具返回协议说明；进度、渲染、调度、权限与命令解析均未修改，未引入对象池。

每次进度/渲染更新新增闭包、Promise、AbortController、包装对象、数组、完整结果副本均为 0。非零完成沿用一次退出状态文本追加，去掉原有错误包装；不是性能优化声明。

验证结果（Windows，Node 26.13.0）：

- 本次离线构建：12/12 包，7,363 ms；`npm run check` 通过。PR #268 合并后的独立构建此前为 12/12 包，7,444 ms。
- 10 个相关测试文件共 380 项：378 通过、2 个平台条件跳过。首次兼容性回归暴露一处旧的“运行时恢复提示”断言，已改为检查原始诊断/退出码且无工具恢复提示；该文件重跑全过。仅重跑发生变化的文件，其余沿用本次已通过结果。没有在本地重复完整 CI。
- 覆盖 Bash/PowerShell 退出 0/1/2/23，非零且未排空输出、输入传输错误、超时/取消、观察错误、真实日志失败；验证保护仍拒绝将非零构建/测试当作通过。
- 真实 Bash `grep` 空结果返回 1、非法正则返回 2、`diff` 差异和 `test` 条件为假返回 1；均保留原始输出。PowerShell `Select-String` 空结果为 0、非法正则为 1，诊断保留。内置 grep 空结果仍正常，非法正则仍报该工具的解析错误。
- 真实 CodeMode 经模型请求消费，正常非零子调用仅执行一次、结果引用可展示原始 stderr、摘要保留 `exit=2`、脚本状态可继续保存；后台任务完成通知和查询保留 `exit=7`。工作区路径、授权、输入传输相关原有测试通过。
- Shell 回调、Bash 热辅助函数和 ANSI 流式处理的 AST/source invariants 通过；已有生命周期测试覆盖正常、失败、取消、释放与重挂载。

`scripts/bench/bash-render-allocations.ts`：当前工作树（构建基线提交为 `b598adc4e`，含本次未提交修复），120×40，100 次预热、每场景 1,000 次更新、8,192 字节采样间隔：

| 场景 | 采样字节/更新（完整渲染夹具） | 输出/行重算 | 新预览组件 | 释放后残留引用/定时器 |
| --- | ---: | ---: | ---: | ---: |
| quiet | 87,043 | 0 / 0 | 0 | 0 / 0 |
| collapsed | 97,946 | 0 / 0 | 0 | 0 / 0 |
| changing | 255,545 | 1,000 / 1,000 | 0 | 0 / 0 |
| expanded | 197,090 | 0 / 0 | 0 | 0 / 0 |

主要分配点为现有 `visibleWidth` 和 Box 渲染；上述完整夹具分配量不表示改动新增量。独立 `--lifecycle`（无采样器）做 5 次预热、20 次生命周期×100 更新，受控 GC 后存活组件 0，20 次均释放；堆差 +109,600 字节仅作观察，不能单独证明泄漏或速度改善。

复现入口：`node --experimental-strip-types --test --test-concurrency=1` 加上述文件：`shell-result-contract`、`background-shell-tasks`、`codemode-recovery/execution.regression`、`shell-observation-hot-paths`、`shell-common-compatibility`、`shell-explicit-cwd`、`shell-input-default-sdk`、`mutation-contract-recovery`、`bash-render-reuse`、`bash-streaming-ansi-hot-paths`（均位于 `tests/`，后缀 `.test.ts`，CodeMode 文件后缀 `.ts`）。性能入口使用 `node --expose-gc --experimental-strip-types scripts/bench/bash-render-allocations.ts`，另以 `--lifecycle` 验证释放。

PR 首次提交后手动 `@codex review`，后续修复提交也重新触发；须确认最新提交审核与全部 CI 通过。本 PR 不自动合并。

临时根：`.task-tmp/grep-no-match-20261108-b598/`。文件与进程身份记录在该目录；子进程临时环境仅影响当前任务，并验证实际临时路径位于此根。前轮被策略拦截的清理不在本轮重试。
