# 宿主机子代理：父级执行通道验收

日期：2026-11-06。基线：`5f105e0e270593c60277e212c6b2d93672d21512`，C4.a 工作树。C4.b 的真实沙箱子代理、阶段 E 的运行进度和阶段 F 的集中验收另行交付，本记录不冒充这些阶段完成。

## 范围与实现

子 CLI 在运行时创建前，通过父进程拥有的 ChildProcess IPC 获取模式、原工作区、附加目录、代次和受限工具描述。显式父模式覆盖三种全局 executionEnvironment 默认；子进程只装代理工具和本地 CodeMode，不创建 nativeFiles/nativeTasks/nativePermissions 或自己的 VM。父进程通过原生工具 wrapper → beforeToolCall → native policy/文件准备 → 最终授权 → execute → result hook 完成实际操作。分配 cwd 只是相对路径的基准，不是新增工作区。

`Agent.createDelegatedToolDispatch` 复用已有嵌套调度，不占用父模型轮次，不发送额外 agent_start/agent_end，不追加孤立的父工具协议消息。每个工具请求新建并关闭一个 scope，子任务没有额外累计调用限额；每个任务 IPC 最多一个未完成请求。授权与执行上下文使用实际子任务信号，委派权限绑定父执行边界而非已经结束的前台轮次。Native 目录身份沿用 `canonicalSessionDirectory` 的 native case/8.3 规范化。

父侧仍执行 C1/C2/C3：外部删除询问、受保护删除拒绝并通知、D6 修改询问、D5 覆盖不执行并暂停父轮次；缺少询问 UI 的子任务停止，不继续后续工作。取消返回保留已有子结果及原始暂停原因，任务状态保持 cancelled。超过现有嵌套取消宽限期的调用报告未确认停止，并交给既有清理失败锁定机制，不能声称已停止底层副作用。

禁止加强命令预检。本次没有修改 `child-security.ts`、`regex.ts`、Shell 分析器或 `shell-cwd.ts`；结构化路径分别使用原文件工具 resolver 和 literal shell cwd 规则，Shell 文本原样传递。接入父级执行时忽略既有子侧“外部路径直接拒绝”的重复结果，保留现有凭据检查，并将相同结构化路径规则应用于新增可选 delete/move/file_batch。未增加命令语法、控制流、参数、通配符或防绕过测试。子代理仍无 tasks 管理入口，因此不新增脱离子任务的后台 shell；整个子代理的后台能力保持。

## 真实验证

`tests/subagent-parent-execution.test.ts` 通过生产子代理启动代码启动真正的 Node 子进程，`tests/fixtures/subagent-parent-cli.mjs` 进入生产 main/服务/SDK/CodeMode/工具链，只替换为无网络的合成 provider。配置、假密钥和文件均属独占夹具；启动前设置 TMP/TEMP/TMPDIR，子进程断言实际 tmpdir 一致。

- 全局默认未设置、trusted-host、sandbox 三组，父模式均显式 host-write；默认 read/grep/find/ls 全部成功。子运行时 parent=true，native files/tasks/permissions=false。中文和空格路径有效。
- 普通外部 delete 真正删除夹具文件，父询问一次；项目根删除未执行，父 UI 有通知；agent 普通文件先读再修改成功，再询问一次。批量写认证文件仍被既有凭据规则阻止。普通 Bash `printf`/`pwd` 成功，cwd 正确。
- 无审批 UI 时外部删除未发生，后续写入未发生；子进程只请求模型一次，父结果明确保留 APPROVAL_REQUIRED。
- 分配到工作区外普通目录后，新建文件成功；覆盖已有文件触发 D5，原文件不变、后续文件不存在，父仅请求模型一次并进入 requiresUserInput；原始 EXTERNAL_FILE_WRITE_BLOCKED 原因和暂停前结果保留。

最终真实验证 7/7；最后一次凭据批量/普通 Bash 补充对照 1/1。初次测试清理漏掉扩展 session_shutdown，SQLite 句柄导致 EPERM；夹具已使用生产关闭事件并等待 lease 释放，后续运行清理正常。首次失败的独占临时目录已登记，未把失败清理记成成功。

PR #242 首轮 CI 的 Linux 1/2 与 Windows 2/4 暴露测试前置遗漏：CI 离线环境没有 rg/fd，grep 返回真实依赖缺失，原脚本随即停止，未调用 find/ls。测试现以 allowFailure 收取四个完整结果，按父进程实际依赖存在情况严格断言成功或精确的依赖缺失错误，不接受权限拒绝或其他错误；不下载工具、不跳过用例、不修改生产权限。正常 PATH 与仅系统目录 PATH 的独立配置两组各 4/4 通过，四个父级工具均实际被调用；本机依赖齐备时仍验证全部成功。计划补充离线依赖前置，最新提交另行复审及运行 CI。

相关回归首次 85 通过、3 失败、1 个 Windows 上既有 POSIX 条件跳过。两项授权夹具补入所需父执行入口，并验证缺入口必须拒绝；取消结果保留后恢复 cancelled 状态。针对这些变化、JSON 预算和源码不变式的最终回归 7/7；未无条件重跑整个组合。类型检查和 agent/coding-agent 编译通过。未删除仍覆盖独立行为的既有用例。

## 分配与释放

审计链：生产 main → resource loader → child CodeMode → proxy → IPC → task owner → 原生嵌套 dispatcher → native policy/file/shell → 完成结果 IPC；取消从父 boundary/子任务 signal → scope close → ChildProcess 关闭 → task result。同时检查原 sender → stdout decoder → bounded retention/stderr → 状态展示链。现有 message/update/render/frame 链未增加订阅或调用。

- IPC 不携带 provider delta/tool progress。两个旧 checkpoint listener 只增加固定前缀早返回，未增加每事件闭包、Promise、数组或序列化。新事件 sink 为空，源码不变式禁止该模块读取/改写 command 文本或订阅流式事件。
- 初始化、单次工具拦截、完成、退出是具名低频边界。每任务一个 AbortController、一个请求槽；每请求一个原有 NestedToolDispatch，结束释放 scope、pending、调用 closure、工具数组；dispose 移除信号及进程 listener。代理定义的闭包仅在安装时创建。正常 delta/progress 新增闭包、Promise、controller、wrapper、数组、IPC 均为零；不声称整个工具请求零分配。
- 复用现有 `assertCheckpointJson`，只为 IPC 支持 JSON 本来会省略的 undefined 对象属性；checkpoint 默认仍拒绝它们。预算先于序列化，限制 2 MiB、深度 32、20,000 节点。3 MiB 已完成结果对照中，大结果 JSON.stringify 调用为 0，实际工具执行 1 次，回执明确可能已有副作用；不复制完整结果来测量，也不自动重放。
- 生产 owner/dispatcher 1,000 次请求采样 2,637,248 B（约 2,637 B/请求，含原生异步调度开销）；provider 请求为 0。成功及 dispose 后 retainedScopes=0；16 个任务 WeakRef 经 4 次 GC 存活 0。单请求互斥、取消 listener 释放、拒绝取消的诊断均通过。测试确认生产宽限期 5,000 ms，仅将该对照夹具缩到 10 ms。
- 既有生产发送/接收基准：6,000 源事件、4,000 行、1,000 次 payload serialization、perUpdateDeferreds=0、finalFlushDeferreds=1；采样总计 18,829,216 B，发送器 94,592 B、接收器 8,679,432 B、stderr 0。主要为原有序列化、UTF-8 写入、stdout 解码和 processLine；7 个 WeakRef 经释放后存活 0。没有用计时替代生命周期证据，也没有引入对象池。

## 稳定复现入口

测试自身建立并登记 `.task-tmp` 独占根。调用者也应按 AGENTS.md 将测试/基准父进程的 TMP/TEMP/TMPDIR 指向任务根；勿使用真实配置或凭据。

```text
node --import tsx --test tests/subagent-parent-execution.test.ts
node --expose-gc --import tsx --test tests/subagent-parent-channel.test.ts
node --import tsx --test tests/subagent-management.test.ts tests/subagent-hot-paths.test.ts tests/native-execution-policy.test.ts tests/nested-tool-dispatch.test.ts
node --import tsx --test --test-name-pattern="native delegated|native delegation enforces|permission changes cancel|context bounds|parent workspace|post-authorization|nested dispatch lookup" tests/native-execution-policy.test.ts tests/subagent-management.test.ts tests/task-checkpoints.test.ts tests/subagent-hot-paths.test.ts tests/codemode-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/subagent-stream.mjs
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
```

源码/扩展混合运行前须编译 agent 与 coding-agent；Node 内部模块别名和 Bun virtual module 都已注册新通道。评审、最新提交 CI 与合并事实以修复计划的完成记录为准。
