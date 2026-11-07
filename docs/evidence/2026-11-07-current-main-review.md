# 当前主线复核：2026-11-07

## 首轮审查范围与结论

- 被审版本：`6d0e753449504ed6f837fbe45e5a9dceb8bcb1c6`（main，PR #266）。
- 比较基线：`116e044465538f9226c5d63fde8e9a1f3fa8b6e9`；其后 21 个 PR，176 个文件。
- 本次为审查，没有修改生产代码、提交、推送或创建 PR。
- 按第二轮计划已记录的 R1–R7 授权评估现状；不把已接受的识别边界当成新漏洞，也不建议继续扩大通用命令预检。
- 确认三项 P2 问题，均有定向复现。下面分别区分实际观察与推断影响。

## F1：沙箱把搜索文本误判为外部路径，暂停整轮任务

位置：`packages/coding-agent/src/core/shell-policy/sandbox-command.ts:134`；停止入口为 `core/sandbox/workspace-backend.ts:273` 和 `workspace-tools.ts:167`。

触发条件：工作区内的文件包含一个真实存在、但不属于工作区的目录路径文本。用户希望搜索这段文本，例如：

```bash
rg -F -e 'D:/outside' .
```

这里 `-e` 后是搜索模式，实际读取目标是当前工作区。现有分析遍历各个词，只要符合盘符绝对路径格式就加入 `facts.paths`，除了少数 echo 类命令没有区分数据参数和文件操作数。后端发现这个目录仅在宿主机存在，抛出 `WorkspacePathStop`；工具层继而暂停整轮任务。

复现用本次临时目录中的 `probe-workspace` / `probe-outside`，没有访问真实外部用户数据：

1. 在前者创建 `reference.txt`，写入后者的绝对路径。
2. 真正运行 `rg -F -e <后者路径> .`：退出码 0，匹配成功。
3. 运行生产 `inspectSandboxCommand` 和 `hostPathKind`：`paths.length = 1`，类型为 `HOST_PATH_HOST_ONLY = 4`。
4. 再经 `WorkspaceSandboxTools` → 真实 `WorkspaceSandboxBackend.invoke/run` 复现：得到 `SANDBOX_PATH_UNMAPPED`，执行边界随后抛出 `EXECUTION_REQUIRES_USER_INPUT`，VM 命令调用次数为 0。仅物理 VM owner 被模拟，真实工作区身份检查、路径分类和暂停流程未替换；未启动真实 VM。

建议：收窄这条误停规则，不能把“文本长得像路径”当成“访问了该路径”的充分证据。保留已确定的文件路径处理；不通过增加通用命令语法或更严格的命令筛选来修复。补一条搜索文本与真实文件操作数的对照验收即可。

## F2：Auto 审核的上下文截断会丢掉用户要求

位置：`packages/coding-agent/src/core/auto-review.ts:114`。

`autoReviewTranscript()` 从叶节点倒序收集最近 16 条可用消息，用户文本和助手工具调用共享这个上限；达到字符上限也会直接停止。没有为用户指令保留位置。

复现：用真实 `SessionManager.inMemory()` 写入一条用户要求“检查项目，然后运行 npm test”，随后写入 16 条助手 read 工具调用消息，再调用生产 `autoReviewTranscript()`。

```text
assistantToolMessages = 16
userMessagesInReview = 0
toolCallsInReview = 16
characters = 724
```

已确认的是审核请求缺少用户原话。审核系统提示却要求以用户明确授权为依据；因此长任务中的正常构建、测试或已授权 Git 操作可能被误拒，并进一步累积熔断计数。这一影响是基于请求内容和审核提示的推断，没有调用真实模型，也不声称某个模型必然拒绝。

建议：在既有有界预算内优先保留当前有效的用户要求和必要限制，剩余额度再放工具调用。不要只扩大历史条数，也不要取消审核或改成默认放行。

## F3：滚动条改变内容宽度后，行缓存仍可能复用旧宽度结果

位置：`packages/tui/src/layout.ts:1153`；外层缓存启用条件在同文件约第 308 行。

新增的保留滚动条列快路径与普通全宽行共享缓存。复用条件只比较屏幕尺寸、行模式和原始字符串，没有记录实际内容宽度；命中缓存后又跳过了后面的 `lineWidth <= box.rect.width` 检查。

复现使用公开的 `ScrollView.setScrollbar()` / `renderLayoutFrame()` / `LayoutFrameScratch`：

1. 屏幕宽 8、高 3，内容组件固定返回 `ABCDEFGH`，滚动条为 `hidden`，渲染一帧。
2. 同一 ScrollView 改为 `auto`，保留同一 scratch，屏幕尺寸不变；内容可用宽度变为 7。
3. 比较复用 scratch 和全新 scratch 的结果，去除 ANSI 后：

```text
复用缓存： ["ABCDEFGH", "ABCDEFGH", "ABCDEFGH"]
全新渲染： ["ABCDEFG ", "ABCDEFG ", "ABCDEFG "]
缓存命中： 3
```

这会使需要裁剪的行在保留列里留下旧字符。固定返回未裁剪内容的组件属于现有合成器支持的输入，现有 scrollbar 测试也使用这种 Lines 组件。设置界面的 `onFullscreenScrollbarChange` 直接调用 `setScrollbar`，没有在此处补充缓存失效。

建议：把实际内容宽度/保留列状态纳入缓存有效性，或在该状态变化时精确失效。保持热路径常量、无逐帧闭包和有界缓存要求，避免整段历史重建。

## 验证与边界

Windows，Node `v26.13.0`。测试子进程的 `TMP`、`TEMP`、`TMPDIR` 均设为本次 task root，并通过 preload 核对实际 `os.tmpdir()`。

| 检查 | 结果 |
| --- | --- |
| auto-review、project-permissions、sandbox-stop-network 三个现有测试文件 | 15/15 通过 |
| tui-layout-frame-scope、tui-scrollbar、tui-retained-source-invariants 三个现有测试文件 | 33/33 通过 |
| memory 当前源码独立 TypeScript 编译到 task root | 通过 |
| 现有 memory-digest 测试，改为引用上述临时编译产物 | 3/3 通过 |
| 三项定向复现 | 均确认；F1 还验证了真实工具/后端停止链路 |

合计 51 个现有测试通过。TUI 测试包含连续 100 帧的活动项渲染计数（每帧一次）、异常帧及测量失败后的引用释放、宽度变化，以及相关源码分配约束；不是对全部热路径性能的重新认证。

第一次用 tsx 直接加载 memory 源码时，三项功能断言通过，但测试 after hook 删除临时 `digest-project` 遇到 Windows `EBUSY`，进程退出码为 1。没有将其算作通过，也没有据此归因生产代码。随后使用临时编译产物、原生 Node 运行同组测试，测试与清理均通过。该夹具问题与上面三项发现分开记录。

没有运行全量 CI、联网模型审核、真实 VM 或真实子代理进程验收；本次不涉及生产代码变更，也没有重新执行整仓离线发行构建。未确认这次范围内还有新的工作区大小写/短路径、子代理权限继承或记忆生命周期回归，不代表这些模块已经穷尽验证。

## 资源清理

本次 task root：`.task-tmp/current-review-20261107-6d0e7534-a91c`。夹具、日志、编译结果及缓存只写在该根内；运行进程身份及实际临时目录记录在该根的资源清单。

清理前核对：469 个文件、11 个子目录；根及其祖先、子项均无 reparse/link 边界；19 个已记录进程身份及其直接子进程均未发现仍在运行。资源清单已补齐本次 Node/tsx 自动产生的临时缓存。此前 EBUSY 的 memory 夹具剩余目录也已记录。

删除只针对清单中的精确路径，拟按文件、空子目录、清单、空 task root 的顺序执行，没有递归删除共享 `.task-tmp`。该命令在启动前被自动审批审查拒绝，工具仅返回 `rejected: blocked by policy`，没有更具体原因。未切换工具或机制绕过；本次目录及 `resources.json` 保留，不能声称清理完成。共享 `.task-tmp` 和其他任务根未动。

## 后续修复：先复现，后改生产代码

用户追加要求：必须核对三项确实存在并复现，才能修复。本轮在同一个 `6d0e75344` 基线上先向现有三个测试文件各增加一项回归用例，未改生产代码时运行，结果为 **0/3 通过、3/3 失败**：

- F1：`WorkspaceSandboxTools` 实际传给后端的路径列表错误地含有 `rg -F -e 'D:/outside' .` 的搜索文本。
- F2：经 `SessionExecutionPolicy.authorize` 到 Auto 审核请求，16 条助手工具调用之后不含用户的“运行测试、不要 push”要求。
- F3：同一布局在滚动条 `hidden → auto` 后，复用缓存的行与全新渲染的行不同，保留列残留 `H`。

只在这三项失败确认后修改生产实现：

1. **F1**：复用已经分词的词缓冲，区分 rg/grep 的搜索模式与文件操作数。首个位置模式、`-e`/`--regexp` 及已知文本参数不再当作宿主路径；程序自身的绝对路径、真实搜索文件、`-f` 模式文件、重定向继续进入原路径检查。没有增加命令拒绝规则、权限档或新的通用预检，也没有展开变量或放宽工作区。命令识别仍是既有的有限误操作防护。
2. **F2**：工具历史占满预算后，继续沿当前会话分支找到最近有效用户文本，必要时移除最旧的已选工具调用，为用户要求留出位置。保持最多 16 条、12,000 字符，计入消息间分隔符。已保存用户要求后按原预算停止；不增加默认允许规则，不改审核结论与熔断策略。
3. **F3**：在已有 `Uint8Array` 行状态里区分普通全宽缓存和保留滚动条列的缓存。复用条件要求状态相同，状态切换时精确失效；无新增缓存数组、对象池或整段历史重建。

验收缺口是文本参数与文件参数的对照、长任务下的用户授权保留，以及同屏幕尺寸下的内容宽度切换。各补一项回归测试，复用现有夹具；源码约束仅将两个新辅助函数加入原扫描，没有增加独立测试框架或大规模命令矩阵。

### 修复后验证

- 三项原先失败的回归用例：**3/3 通过**。
- 9 个相关文件合计 **75/75 通过**：Auto、项目规则、沙箱停止/网络、shell 源码约束、滚动条、布局帧生命周期、retained 源码约束、终端帧热路径、retained 生命周期基准。
- 对搜索回归补充短选项组合、模式前的文件路径及 PowerShell 绝对程序路径后，单独重跑该项通过。
- `tsgo --noEmit`：通过。
- `npm run build:offline`：**12/12 包通过，12,379 ms**，打包沙箱运行时 41 个文件。构建产物保留在正常 dist 目录；构建临时文件和 npm 日志/缓存放在本轮 task root。
- `node packages/coding-agent/dist/cli.js --version`：输出 `1.0.0`。
- `git diff --check`：通过。本节记录本地验证结果；提交、推送及后续 PR 的远端 CI / reviewer 状态以仓库记录为准，不将本地验证当作远端审核通过。
- 未启动真实 VM 或调用联网审核模型。F2 确认并修复的是审核输入缺失，未声称实测某个模型一定误拒。

### 热路径证据

审计调用链：`ScrollView.setScrollbar` / TUI 更新 → `requestRender` / `scheduleRender` / `performRender` → `TuiAltScreen.doRender` → `renderLayoutFrame` → `LayoutFrameScratch.begin`、布局测量、`paintBox` / `cacheFullWidthRow` → `complete` / `abort` 与帧作用域释放 → 终端帧生成 → `TerminalFrameQueue.submit/start/finish` → `ProcessTerminal.writeFrame/startFrameWrite` 及完成/取消释放。缓存失效只增加原有状态字节的比较，不把分配移入其他辅助函数。

同机 Windows / Node v26.13.0，现有 `tui-frame-allocations.ts --fixture production-alt --items 500 --frames 2000 --warmup 200 --lifecycle-cycles 2`，修改前后各一次：

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| HeapProfiler 采样字节/帧 | 11,319.356 | 11,326.688 |
| CPU p95 ms/帧 | 0.0451 | 0.0507 |
| 活动项渲染/帧 | 1 | 1 |
| 已完成项渲染/帧 | 0 | 0 |
| 全宽缓存命中/帧 | 39 | 39 |
| 帧 Promise / AbortController / wrapper 计数 | 0 / 0 / 0 | 0 / 0 / 0 |
| 完整帧字符串副本 | 0 | 0 |
| 完整帧字符串生成/帧 | 1 | 1 |
| screen 数组创建/帧 | 0 | 0 |
| dispose 后所有布局引用计数 | 0 | 0 |

修改后采样主要分配点仍为 `layoutComponent`、`renderComponentsViewport`、`renderContainerInto`，属于原有布局/视口输出。新增逐帧闭包、Promise、AbortController、包装对象和数组均为 0；使用现有两组有界行缓存（最多 4096 行，原字符串预算不变），`abort`、`clear`、卸载和销毁沿用原释放路径，未增加长期引用。两次额外生命周期结束的最大引用计数也为 0。

上述短采样的分配量相差约 0.065%，p95 有约 0.0056 ms 的上升；如实记录，不据一次短采样声称 CPU 改善或严格等价。未引入对象池，不适用对象池收益准入门槛。功能与确定性计数由回归测试约束；本轮没有做长时间 soak 或以两轮堆样本声称消除了全部泄漏。

另跑原 `tui-frame-queue-allocations.ts --frames 2000 --warmup 200`：采样 215.436 字节/帧；flush 后 active/pending 写入与字节均为 0；闭包、帧 Promise、AbortController、wrapper、完整帧复制计数均为 0。相关源码约束和异常帧引用释放测试已通过。

### 本轮资源

本轮 task root：`.task-tmp/review-fixes-20261107-a7f3`。与首轮被拦截而保留的目录分开，首轮目录没有重试清理。

清理前核对：670 个文件、5 个子目录，资源清单完整；根、祖先及所有子项没有 reparse/link 边界；72 个已记录进程身份及其直接子进程均未发现仍在运行。精确按本轮清单删除文件和空目录的命令在启动前被自动审批审查拒绝，仅返回 `rejected: blocked by policy`。未改用其他工具或机制绕过，本轮 task root 与 `resources.json` 保留。代码修复和验证已完成，临时资源清理未完成。
