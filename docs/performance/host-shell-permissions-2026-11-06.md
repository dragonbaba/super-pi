# 宿主机 shell 权限分析：C2 验收与分配证据

日期：2026-11-06。实现基线：`426b15e56`。Node v26.13.0 / V8 14.6.202.34-node.40 / Windows。以下为本机观测，不宣称跨机器时延保证或相对旧版本的性能提升。

## 审计调用链与所有权

`ExtensionRunner.emitToolCall → SessionExecutionPolicy.authorize → prepareShellCwd → analyzeNativeShell → Bash permission/high-risk 或 Windows grammar → assessHostShellEffects → 原生 selector → NativePolicyInvocation.consume → PendingToolAuthorization.consume → 原有 shell/task 后端 beforeSpawn → release`。

分析与文件系统分类每次工具调用运行一次，不进入 stdout/progress/render 的事件处理路径。没有恢复旧扩展审批。Bash 复用同一个 ShellAnalysisOwner 的预处理结果；PowerShell/cmd 不套用 Bash 的反斜线语义。现有事件、输出、渲染链没有新增闭包、Promise、AbortController、wrapper 或数组，新增数量为每次事件 0；授权边界原有异步文件系统和 UI Promise 不计作每事件工作，也不声称为零。

新增解析函数为同步模块函数，无逐 token/段回调或 Promise；命令名集合、正则、容量常量在模块级。扩展原模块保留导出桥，分析实现只有一份。source/AST 门槛审计新旧完整解析函数名单；生产源码路径已更新，避免测试只扫描两行导出而虚假通过。

| 数据 | 上限与所有者 | 释放 |
| --- | --- | --- |
| 预处理缓存 | 单次分析 owner，128 项、512 KiB UTF-16 引用预算 | analyzeNativeShell 的 finally；失败同样释放 |
| 原始 source / 段 / 嵌套 | 128 Ki 字符、64 段、4 层；单次调用 | 分析返回后无 source 缓存留给会话 |
| Windows tokenizer | 每个有界 source 的字符串与 primitive expansion 数组，最多 256 词 | 每段清空，返回即失去引用 |
| 操作事实 | 最多 16 条，转移记录含源与目标，后续规范化路径最多 32 条 | 单次授权持有，返回或拒绝后回收 |
| cwd identity | 单次调用，显式/默认 cwd 与会话根的真实身份 | 未交接时原生 invocation 释放；交接后 shell/task owner 释放；后续 hook 失败也释放 |
| 审批 UI | 复用现有 selector 和倒计时 | 允许、拒绝、Esc 后释放；引用不交给解析缓存 |

没有引入对象池。主要分配在已有 Bash token/segment 字符串和容器；这一阶段是补齐缺失的权限功能，没有进行无测量收益的缓存/池优化。没有额外整帧或完整工具输出复制；完整命令只在冷审批详情中展示，不按输出块重复处理。

## 可复现检查

在任务自有 `.task-tmp` 根设置子进程 TMP/TEMP/TMPDIR 后运行，测试自行校验并清理独占夹具；真实 PowerShell 子进程也检查 GetTempPath。旧扩展桥使用内部包产物，因此改动后先构建 coding-agent，再执行旧导入路径的行为测试。

```text
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
node node_modules/@typescript/native-preview/bin/tsgo.js -p packages/coding-agent/tsconfig.build.json
node --experimental-strip-types --test tests/host-shell-permissions.test.ts tests/shell-analysis-source-invariants.test.ts
node --experimental-strip-types --test tests/shell-analysis-authorization.test.ts tests/shell-analysis-review-boundaries.test.ts tests/shell-analysis-hook-lifecycle.test.ts tests/shell-observation-hot-paths.test.ts tests/native-execution-policy.test.ts tests/shell-explicit-cwd.test.ts tests/native-batch-cwd-integration.test.ts
node --experimental-strip-types --test tests/tui-hot-paths.test.ts
node --experimental-strip-types --expose-gc scripts/bench/shell-authorization-analysis.ts --native
node --experimental-strip-types --expose-gc scripts/bench/shell-authorization-analysis.ts
```

每个性能样本 warmup 64、测量 512 次，HeapProfiler samplingInterval=4096。计数是扫描入口实际累计值；字节预算不是 V8 实际堆占用。

| 原生入口样本 | 预处理次数 / 512 次调用 | 采样 B/调用 | p95 ms |
| --- | ---: | ---: | ---: |
| Bash printf 读取对照 | 512 | 7,410 | 0.0215 |
| Bash 外部 rm | 512 | 10,843 | 0.0240 |
| Bash -lc 嵌套 rm | 1,024 | 17,340 | 0.0460 |
| Bash 动态删除目标 | 512 | 8,911 | 0.0210 |
| Bash 内联 Node 删除 | 512 | 19,482 | 0.0378 |
| PowerShell Remove-Item | 0（不使用 Bash 预处理） | 3,619 | 0.0118 |
| PowerShell → cmd /c del | 0 | 2,716 | 0.0060 |

原生测量中 owner created=released=4,036，liveOwners/liveEntries/liveBytes 全为 0；结果及操作数组 8 个 WeakRef 经两次 GC 后全部消失。普通 Bash 源每次仅预处理一次并缓存命中一次，嵌套样本两个不同 source 各一次；没有把相同 source 多次预处理计为“复用”。主要采样点为 parseShellSegments、inspectScript、resolve；Windows 为 inspectWindowsMutations、resolve、addShellEffect。

旧组合入口对照仍验证原来的生命周期扫描+high-risk+permission 三层共享：owner created=released=2,308，liveOwners/liveEntries/liveBytes=0，正常/异常/取消/代次失效的 16 个 WeakRef 两次 GC 后全部消失。四个样本采样 7,478 / 193,077 / 194,611 / 545,222 B/调用；heredoc 大样本仍主要分配于已有 join/split/parseShellSegments，此结果不能当作已优化承诺。

## 行为与适用边界

8 个新增行为测试使用自己的工作区、外部兄弟目录和追加工作区。真实生产 selector 6 个审批帧；Bash/PowerShell 均验证取消后可重新批准、批准才删除、明确拒绝保留目标。Windows 未加引号盘符路径、Set-Location+ri、cmd /c 完整参数的实际目标与展示一致。真实 rm 仅解除目录链接，其指向的文件保留；cwd 链接在审批后变更时不启动命令。敏感拒绝只到授权边界，未删除真实关键目录。

额外覆盖 git 工作树范围与 dry-run、Python/Node 内联、find-exec、`bash -lc`、透明删除与不透明程序的区分、复制源和真实覆盖目标、变量/超限请求的审批，以及元数据逻辑根与链接指向根。命令识别用于防误操作，不是恶意脚本或并发文件系统修改的隔离边界。任意程序内部、复杂递归复制的逐文件效果不承诺全面识别。对可识别的 D5 覆盖，本阶段阻止工具执行并通知；整轮调度暂停在 C3 实施。
