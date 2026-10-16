# CodeMode 执行、预算与恢复修复计划

状态：2026-10-16，D1–D4 已由用户确认；R0 功能与性能基线材料已获复审认可，构建身份、采样比较及 F-S7 计数范围已补齐。后续断言补强中发现的 F-B8 数组别名错误已修正，并追加模型侧多段续读、成功父调用下的子失败计数与 artifact 恢复验收；Claude 复审认可最新测试并修正 F-S7 对照的失败描述及 R2.2/R3 交付边界，R0.1–R0.3 完成。PR #154 已于 2026-10-16 squash 合并（`ed892cb15`）。R1–R5 尚未开始，已知产品缺陷仍待修复；用户已确认按 §5.0 分三波、8 个 PR 实施，并采用 §4.1、§4.2 的分批、R0 断言冻结、并行与波末集中采样规则。四轮交叉审查（Claude ×2、Codex ×2）后形成本清单；Codex 负责实施，Claude 负责逐任务复审。勾选框表示实施、验收和复审全部完成，不能用“已查过源码”或“现有测试通过”代替。

**核心要求：已授权的正常任务，应能在局部、可恢复的错误之后继续完成。** 不得因为解析器不认识某种写法、某次结果需要缩减、展示额度不足或内部缓存淘汰，就把整轮任务堵死；也不得用吞掉退出码、统一改成成功、关闭预算检查或单纯调大数字来“修复”。

## 1. 固定基线

| 项目 | 值 |
| --- | --- |
| 仓库 | `dragonbaba/super-pi`，`main` = `b44dc0962684a937835064fde130580ebc7a520c`（PR #153 已合并） |
| 现场业务项目 | 用户的独立 Remotion 项目（只作现场背景，不重跑其中有副作用的命令） |
| 现场权限 | `full-access + never-ask` |
| 现场配置 | `toolResultPresentation.budgetTokens = 1024`（该功能默认关闭，属用户显式配置） |
| 现场模型 API | `openai-codex-responses` |
| 原有工作区变动 | `docs/README.md`（已修改）、`docs/upstream-pi-1.1.0-task-plan.md`（未跟踪），实施中不得覆盖 |

证据文件（Codex 审查交接材料中的文件名，未纳入仓库；离线探针，不含真实提供方请求）：

- `super-pi-third-review-evidence.json`
- `super-pi-fourth-review-evidence.json`

## 2. 已确认事实（实施依据）

位置为基线提交的行号，实施时以符号为准重新定位。

### 2.1 预算与恢复

| ID | 事实 | 位置 |
| --- | --- | --- |
| F-B1 | 非自适应 API 的结果投影把整份 `model.maxTokens` 作为输出预留；仅 `openai-completions` 走动态算法 | `ai/src/api/simple-options.ts:18-20`；`coding-agent/src/core/sdk.ts:390-399`；`tool-result-presentation.ts:2436-2441` |
| F-B2 | `openai-codex-responses` 请求体不发送任何输出上限（字段：model/store/stream/instructions/input/text/prompt_cache_key/tool_choice/parallel_tool_calls），128k 预留没有对应的提供方约束 | `ai/src/api/openai-codex-responses.ts:586-600` |
| F-B3 | `gpt-5.3-codex-spark` 目录值 context = maxTokens = 128000，开启结果预算后第一条工具结果即阻断，与历史长度无关；动态算法下通过 | `ai/src/providers/data/openai-codex.json` |
| F-B4 | 272k / 128k 条件下历史约 144k 即阻断；结果预算 1024→8192 无效；动态算法通过 | 离线探针 |
| F-B5 | 上下文份额 ≤0 时直接抛错且不带 `minimumTokens`，外层显示 `minimumNotice=unavailable` | `tool-result-presentation.ts:2245-2251` |
| F-B6 | 非规划路径下 `sdk.ts` 把上下文不足统一改写成“configured result budget cannot fit”，引导用户调错方向 | `sdk.ts:404-405`；准确分类只在 `tool-result-presentation.ts:2466-2469`（仅规划路径） |
| F-B7 | 自动压缩阈值 = `contextWindow − 16384`（约 255,616），投影约 144k 即阻断，存在约 11 万 token 盲区；预算阻断又跳过压缩和普通重试 | `compaction/compaction.ts:250-252`；`agent-session.ts:3855, 5004` |
| F-B8 | 批内分配为“剩余预算 ÷ 剩余结果数”，前面的结果不知道后面结果实际很小；只调换顺序即可从阻断变为成功（8 个顶层结果，1 长 7 短：长结果在前阻断，在后合计仅用 159） | `tool-result-presentation.ts:2445-2480` |
| F-B9 | 当前批次共享 1024；进入历史后按每条 1024 重新投影，模型可见内容变大（离线：808→8064），而基于上次 usage 的上下文估算不变（10001→10001）。推论（未实测）：历史前缀每轮变化，破坏提示缓存 | `tool-result-presentation.ts:2426-2431`；`ai/src/utils/estimate.ts:91-100` |
| F-B10 | 截断提示要求 “Continue with cursor `tr1.…`”，但没有模型可调用工具接受该游标；`readToolResultContinuation` 的调用者是测试和基准脚本，没有模型工具入口；交给原生 `read` 得到 `invalid-cursor`（`read` 只接受 `read-v1.`）。原文仍在会话记录中，部分有文件备份 | `tool-result-presentation.ts:26, 1055, 1112`；`agent-session.ts:2367`；`tools/read-window.ts:222` |
| F-B11 | 恢复接口遵守原生读取“不拆行”约束：单行约 12000 字符的读取在预算 128/512/1024 下 `cannot make forward progress`，4096 起成功 | `tool-result-presentation.ts:716, 2668-2673` |
| F-B12 | 恢复接口只在 `agent.state.messages` 中查找来源；压缩后原文仍在会话条目中，但游标 `stale-cursor`、artifact `stale-artifact` | `agent-session.ts:2376, 3757`；`tool-result-presentation.ts:1763` |
| F-B13 | CodeMode 开启时普通工具只能嵌套调用，所以结果预算实际作用于整个脚本：15,828 字符父结果被投影为 3,803 字符（首 + 游标 + 尾），中间子调用错误与 `show` 的读取被丢；CodeMode 自身 `max_output_tokens`（默认 8000）在内层生效后再被外层压缩 | `agent-session.ts:4786-4790`；投影同上 |

### 2.2 CodeMode 错误与失败语义

| ID | 事实 | 位置 |
| --- | --- | --- |
| F-C1 | Bash 保留输出末尾、状态行在最后；CodeMode 却取开头：异常取首段文本前 512 字符，模型摘要只扫描前 2048 字符。FFmpeg 样例中错误行在第 1971 字符后，模型只得到版本横幅和 `exit=1` | `codemode.ts:66-69, 388`；`codemode-display.ts:58`；`tools/bash.ts:1130, 1138` |
| F-C2 | 子调用失败即令父调用失败，即使脚本已捕获并成功执行替代方案；store 不提交；附加“不要自动重试变更” | `codemode.ts:318, 530, 547-548, 560-562`；`agent/src/nested-tool-dispatch.ts:158, 182` |
| F-C3 | 失败记录在抛出前已存入，异常文本带 `[ref]`，同一脚本内可解析后 `show`；但未写入说明，且 ref 不跨脚本，不能作为持久恢复地址 | `codemode.ts:366, 388` |
| F-C4 | 三个子调用全部成功，仅因 `show` 累计超过 256 个展示块即抛异常，父调用 `CODEMODE_FAILED` | `codemode.ts:393-402` |
| F-C5 | 保留额度把输入参数计入并按插入顺序淘汰，同一脚本内拿到的 ref 可能在脚本结束前失效 | `codemode.ts:353-366` |
| F-C6 | 脚本总时限默认 60s、上限 300s，包含子工具执行、串行累计与审批等待；超时后关闭调度并中止仍在运行的子工具；审批组件暂停自己的计时，但外层计时器不暂停 | `codemode/src/limits.ts:15-16`；`codemode/src/runtime/host.ts:168-171`；`nested-tool-dispatch.ts:193-201` |
| F-C7 | `background: true` 要求 TUI/RPC 与可用的 tasks 工具，无交互环境不可用；“前台转后台”只对顶层调用生效，CodeMode 下实际不可达 | `resource-lifecycle-guard/background-shell.ts:80-87`；`resource-lifecycle-guard/index.ts:56-58` |
| F-C8 | 同一脚本内“读取 → show → 编辑”被 `READ_REQUIRED` 拒绝（明确契约，有测试覆盖）；读取被投影截断后也失去编辑资格 | `mutation-guard-write/index.ts:96`；`codemode.ts:100-108` |

### 2.3 Shell 预检、权限与重复调用

| ID | 事实 | 位置 |
| --- | --- | --- |
| F-S1 | 生命周期预检先于统一权限决策运行并可直接拒绝 | `resource-lifecycle-guard/index.ts:194-206` |
| F-S2 | 预检对任何 `<<`（除单独的 `cat <<'X'` / `node <<'X'`）判定无法分析；同文件已有正确的 `prepareShellAnalysis`，权限层和高风险分析在用，唯独预检没用 | `shell-substitution.ts:129-149, 243`；`tools/bounded-shell-input.ts:8-21`；`core.ts:124-127` |
| F-S3 | 预检拒绝且与进程生命周期无关的写法：`python - <<'EOF'`、`cat > f <<'EOF'`、`git commit -F - <<'EOF'`、`"$FFMPEG" -version`、`x=$(git rev-parse HEAD)`、`export PATH=…; node -v`、`source .venv/bin/activate && …`、`( cd sub && make )`；PowerShell 等价写法（`& $ff`、here-string 管道、`Invoke-Expression`）全部放行 | `core.ts:105-109, 131-200` |
| F-S4 | 绕过预检后，高风险分析把“Shell 状态无法分析 / heredoc”标为 `unverifiable`，权限控制器在判断权限模式前硬拒：R0 的 10 种写法中 Python heredoc、重定向 heredoc、`git commit -F -` heredoc、修改 PATH、激活虚拟环境、子 Shell 切换目录 6 种在 `full-access` 下仍被拒。对照：`python -c "import os; os.remove('a')"` 放行，同样代码写成 heredoc 被拒 | `core.ts:385-395`；`permission-controller.ts:416-423, 932-972` |
| F-S5 | 权限范围分析已把上述写法都归为 `opaque-script`（`full-access` 放行，其他模式询问） | `permission-bash.ts:643`；`permission-controller.ts:1040-1046` |
| F-S6 | 重复调用标识对超过 4096 字符的字符串只取前 2048 + 后 2048 字符；等长、仅中间修正的命令或 CodeMode 脚本得到相同标识，修正版被 `REPEATED_CALL_BLOCKED`，同批内被 `DUPLICATE_CALL` | `tool-loop-guardrails/core.ts:116-127, 589-613`；`index.ts:225-255` |
| F-S7 | 失败计数只有一个槽位；父、子结果交替写入互相重置，CodeMode 内连续失败计数反复停在 1 | `tool-loop-guardrails/core.ts:618-655` |
| F-S8 | 连续两次相同的暂时性失败（如 HTTP 503）后第三次被判不可重试；新一轮用户请求会重置 | 同上 |
| F-S9 | 提示文字把解析器限制后的换写法描述为“规避防护”；后台拒绝提示未提 `background: true` | `resource-lifecycle-guard/index.ts:173`；`tool-loop-guardrails/core.ts:478-484`；`core.ts:41-42` |

### 2.4 显示与模型参数

| ID | 事实 | 位置 |
| --- | --- | --- |
| F-T1 | Ctrl+O 对所有可展开组件统一切换，只调用 `invalidateViewportHeights()`，不锚定记录；数值滚动位置不变，原位置可能变成更早的失败卡片 | `modes/interactive/interactive-mode.ts:5994-6010` |
| F-T2 | 长输出预览固定保留开头 2048 字符，末尾进度变化时显示不变；失败行普通输出整段使用错误色 | `codemode-display.ts`；`components/codemode-tree.ts` |
| F-T3 | CodeMode 树不调用子工具的 `renderCall` / `renderResult` | `components/codemode-tree.ts` |
| F-M1 | 启动目录刷新不替换会话中选中的模型对象；`_refreshCurrentModelFromRegistry` 只在扩展注册/注销提供方时调用。故障进程当时实际使用的上下文值**无现场证据** | `interactive-mode.ts:3304-3320`；`agent-session.ts:4339-4352, 4475-4483` |

### 2.5 必须保留的事实边界

- 现场 Remotion 附带的 FFmpeg 缺少 `wrapped_avframe` 编码器、`volumedetect` 滤镜和 `s16le` 输出格式；改用 PCM/WAV 送入 Python 计算已成功（约 120.02 秒）。这些是程序能力问题，放宽权限不会消失；修复目标是让模型第一次就看到真实原因。
- 历史失败记录在升级后仍显示失败，本身不是新故障。
- 离线投影通过不等于真实提供方请求成功；R1 结束必须做真实会话端到端验收。

## 3. 用户已确认的决定

以下四项已确认；若实施需要偏离已确认范围，须重新询问用户，不自行选择。

确认来源为 **2026-10-16 用户与 Codex 的本任务会话**中四项选择题的逐项答复，不是 Claude 复审会话。Codex 已根据会话中的用户消息核实，原文如下：

- D1：“按子调用计算，父结果另设总上限（计划建议）”。
- D2：“暂不放开，明确说明须在更早轮次读取（计划建议）”。
- D3：“交给权限模式，full-access 放行（计划建议）”；原问题明确已识别到变更且目标不确定的命令仍拒绝。
- D4：“采用上述拆分方式（计划建议）”；原问题明确拆分脚本计算、子工具执行、排队与审批等待，审批等待不消耗脚本时限。

| ID | 决定 | 建议 | 阻塞任务 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | 结果预算在 CodeMode 下按每个脚本计算，还是按子调用计算 | 按子调用计算，父结果另设上限 | R1.7 | 2026-10-16 用户确认建议 |
| D2 | 是否支持同一脚本内“读取 → 修改”（基于宿主真实快照、提交前再校验） | 本轮不改契约，只把限制写清；另行评审 | R5.5 | 2026-10-16 用户确认建议 |
| D3 | `full-access` 下“Shell 状态无法分析、但未发现变更动作”是否放行 | 放行；“有变更动作且目标不确定”继续硬拒 | R3.2 | 2026-10-16 用户确认建议 |
| D4 | CodeMode 总时限计量模型 | 拆为脚本计算时间 / 子工具执行（遵守各自 timeout）/ 排队 / 人工等待（暂停计时） | R4 | 2026-10-16 用户确认建议 |

## 4. 交付规则

### 4.1 分工与流程

1. 按区域分批（2026-10-16 用户确认）：同一区域、改动同一组文件的任务合并为一个 PR，批次以 §5.0 为准；每个子任务独立 commit，标题标明任务号（如 `R3.1`），便于逐项复审。不同区域不得混入同一 PR。
2. 提交、推送、开 PR、合并均须用户对当前任务的明确授权。开 PR 后评论 `@codex review`；推送审查修复后再次评论。
3. 每个任务完成后交 Claude 复审，复审材料必须包含：
   - 改动摘要与 diff 范围（含 `git status`，确认未动 §1 的原有变动）；
   - 该任务对应 R0 回归测试的**修复前失败输出**与**修复后通过输出**；
   - 运行过的测试与基准命令及结果（失败如实贴出）；
   - 是否触及热路径及对应证据（见 4.2）；
   - 未解决风险与证据边界。
4. 不重跑业务项目里有副作用的命令（写入、渲染、安装）。
5. R0 断言冻结：修复 PR 只允许把 R0 用例改名或迁入常规测试套件，不得放宽、删除或改写其断言。确需修改断言时单独 commit，交接材料说明理由，并附断言对照，证明新断言仍拒绝原错误实现、可接受正确实现；该 commit 由 Claude 单独复审。
6. 并行开发（2026-10-16 用户确认）：同一波次内、文件互不相交的 PR 在各自的 worktree 和分支上并行开发，按记录的路径与分支名创建和清理，不批量扫描删除。各 PR 不修改本文 §5 勾选框和 §7 执行记录；每波合并后由 Claude 提交一个只改文档的 PR，统一更新勾选、状态和记录，避免并行 PR 在本文冲突。

### 4.2 热路径门禁

以 [hot-path-allocation-contract.md](performance/hot-path-allocation-contract.md) 为准，审计从生产者到释放边界的完整调用链，包括现有 helper。R0 未修改生产热路径；R0.3 采集修复前数据，为后续任务提供比较起点，不把采集本身当成生产修复。

本地运行 R0 回归测试或本节基准前，必须先在对应检出版本执行并确认以下构建成功；修复前、修复后两侧都须执行，不能依赖工作区已有 dist 或以 CI 会构建为由省略：

```text
npm run build:offline
```

源码入口不等于依赖也从源码加载。coding-agent 源码按包名导入 `@super-pi/ai`、`@super-pi/agent-core`、`@super-pi/codemode` 时，package exports 解析到各包的 dist；两个 tool-result 基准、session 基准和 R0 回归测试均依赖这些编译产物。修改 `packages/ai/src`、`packages/agent/src` 或 `packages/codemode/src` 后未重建，会测到旧实现。

修复前后两侧的交接清单均须记录 commit、构建命令及退出码、实际包解析路径，以及 `packages/ai/dist`、`packages/agent/dist`、`packages/codemode/dist` 的逐文件相对路径与 SHA256（覆盖实际加载的 JS）。`codemode-dispatch` 直接导入 agent 的 `src/nested-tool-dispatch.ts`，session 则通过工作区包使用 agent 的 dist；两种加载模式分别记录、分别比较，不混用其结果，也不以 dispatch 通过推断 session 已运行新代码。

| 任务 | 必须纳入审计的路径 | 必须显式核对的源码约束文件（位于 `tests/`） |
| --- | --- | --- |
| R1 | 提供方转换 → 预算估算/结果投影 → continuation/artifact 查找 → 会话持久条目/Evidence Ledger → clear/dispose | `tool-result-presentation-source-invariants.test.ts`、`tool-result-contextual-budget-source-invariants.test.ts`、`tool-token-estimator-source-invariants.test.ts`、`evidence-ledger-source-invariants.test.ts`；涉及 CodeMode 父子投影时加 `codemode-hot-paths.test.ts` |
| R2 | 子调用完成 → `codemode.ts` 状态/输出/ref → `codemode-display.ts` 的 `codemodeFailureReason` → 树形展示/释放 | `codemode-hot-paths.test.ts`；涉及结果投影时加 R1 四个文件；涉及渲染时加 `tool-renderer-source-invariants.test.ts` |
| R3 | 生命周期预检 → `prepareShellAnalysis`/替换分析 → 高风险/权限判断 → 完整内容标识 → 准入/结果/`agent_end` 清理 | `shell-observation-hot-paths.test.ts`（覆盖 `core.ts`、`permission-bash.ts`、`shell-substitution.ts` 的指定函数）；循环防护新增热方法仍须按契约补对应精确 AST/计数门禁，现有检查不代表覆盖整文件 |
| R4 | `host.ts` 的 `Execution` 计时/`post`/`handleMessage` → `nested-tool-dispatch.ts` 的 `pump` → 子工具/审批等待 → 完成/取消/关闭 | `codemode-hot-paths.test.ts`；若同时调整会话耗时事件则加 `duration-source-invariants.test.ts` |
| R5 | CodeMode 树 → 工具进度 → `scroll-view.ts`/交互更新 → 布局/终端帧 → 释放 | `codemode-hot-paths.test.ts`、`tool-renderer-source-invariants.test.ts`、`tui-retained-source-invariants.test.ts`，以及 `test:hot` 中对应 TUI 检查 |

`npm run test:hot` 是共同门禁，不能代替表中的文件清单。`scripts/test.mjs` 的命名规则不会把带前缀的 `*-source-invariants.test.ts` 全部归入 hot 组；上表 R1 四个文件当前属于 **unit**，须另行执行（不能因 CI 最终会跑到就省略本地验收）：

```text
npm run test:hot
node --experimental-strip-types --test --test-reporter=tap --test-concurrency=1 tests/tool-result-presentation-source-invariants.test.ts tests/tool-result-contextual-budget-source-invariants.test.ts tests/tool-token-estimator-source-invariants.test.ts tests/evidence-ledger-source-invariants.test.ts
```

按任务实际修改范围追加表中其他文件，命令为 `node --experimental-strip-types --test --test-concurrency=1 <明确列出的测试文件>`；不得用泛匹配或省略号代替交付记录里的实际命令。

| 适用任务 | 基准命令 | 主要证据 |
| --- | --- | --- |
| R1 | `npm run bench:tool-token-estimator` | 10 MiB 单行、1 MiB 日志的 CPU/分配、无整份复制/巨型行数组、受控 GC |
| R1；R2 涉及结果展示/保留时 | `npm run bench:tool-result-budgeted-model-view`；`npm run bench:tool-result-contextual-budget` | `fullSourceEstimatorScans`、查找探测次数、历史稳态计数、投影字节容量、clear/dispose 后条目与引用 |
| R1.7、R2、R4 | `node --expose-gc --experimental-strip-types scripts/bench/codemode-dispatch.ts` | 调度调用次数、并发上限、每调用分配、`retainedAfterGc` |
| R2、R4 | `node --expose-gc --experimental-strip-types scripts/bench/codemode-runtime.ts` | Worker/VM 执行、批量桥接、计时、Worker 启停与宿主引用释放 |
| R1.7、R2、R4 | `node --expose-gc --experimental-strip-types scripts/bench/codemode-session.ts` | 真实 SDK/控制器/读取/store 的离线会话链路、pending evidence 与会话释放 |
| R3 | `node --expose-gc --experimental-strip-types scripts/bench/shell-substitution-inspection.ts`；`npm run bench:shell-common-compatibility` | Shell 分析分配/引用释放、输出 append/snapshot、spill 与释放计数 |
| R2/R5 改树形展示或进度时 | `npm run bench:tool-progress`；`npm run bench:tui-tool-leaf-allocations` | 进度交付、叶子更新/布局分配与释放 |
| R5 改帧/布局时 | `npm run bench:tui-frame-allocations`，并按 Main/Alt 路径追加对应生产基准 | 帧物化/复制、活动与待处理字节、flush/abort/dispose |

确定性结构计数作为硬门槛，按契约及对应任务的计数约束验收；采样分配字节、heap 数值和 CPU 时间不能用单次运行结果判定改善或回归。R0.3 的这类数据均为“单次采样，仅供参考”，基准内部已有预热或多个样本也不能代替独立重复运行。fixture 很小的场景（例如历史 1 条）的采样值只作参考，不作为比较门槛。

比较采样字节和 CPU 时间时，在同一台机器、同一次测量会话内，旧侧独立检出 `b44dc0962684a937835064fde130580ebc7a520c`，新侧检出待验收的修复 commit；按上述要求分别构建并记录三个包的 dist 身份。两侧分别串行运行 N 次（N≥5），使用相同的 Node/V8、输入、加载模式、预热和采样参数，保存每次原始结果，报告中位数、最小值和最大值。源代码模式与编译产物模式分开比较。对象池“分配至少降低 20%、堆增长不超过 10%”等准入条件须基于这种重复比较及契约要求的完整证据判断，不能拿 R0.3 单次采样值作阈值；波动不足以支持结论时不得宣称已达标。

**证据分级与采样节奏（2026-10-16 用户确认）：**

- 触及上表任一路径的 PR：按契约“Required review and reporting”，合并前须在本 PR 内运行对应 AST/源码约束检查和上表相关的生产分配基准，报告审计调用链、确定性结构计数、采样字节及主要分配位置、生命周期与引用释放证据，作为合并硬门槛，不得延后。逐 PR 的采样值只需单次运行，与 R0.3 参考值并列报告，不据此宣称改善或回归；若单次结果出现明显增长或新的主要分配位置，须在该 PR 内补做重复采样比较后再合并。
- 未触及上表路径的 PR（仅改提示文字、说明或文档）：CI、R0 修复前后输出、Codex 复审与 Claude 复审即可；交接材料须列出改动的函数，说明为何不在上表路径内。
- 重复采样比较集中到波末：每波全部合并后，在合并后的 `main` head 上按上文重复采样规则（旧侧 `b44dc096`，两侧各 N≥5）集中采集该波涉及的全部基准，交 Claude 复审。它替代的只是逐 PR 的 N≥5 统计比较，不替代上一条的逐 PR 基准运行与报告。下一波可同时开工；若发现回归，追溯到该波具体 PR，修复须先于同一区域后续 PR 合并。
- 例外：引入对象池，或以采样数值作为准入条件、宣称改善的 PR，须在该 PR 内完成重复采样比较，不能延到波末。

改变场景或计数口径时，在相同旧生产代码上补旧侧测量并保留原始基线，不能因迁移而重置基线。每次交付均须有确定性结构计数、分配剖析/精确计数、受控 GC 和正常完成/异常/取消/关闭的生命周期证据；对象池仍须满足契约全部准入条件。本次文档补充不要求重新采集 R0.3。

现有基准的证据范围必须如实说明：Shell 基准的 `analysisCalls` 当前由外层迭代数计算，不是 `prepareShellAnalysis` 的内部调用探针；R3 须补实际分析调用/扫描字节计数。`codemode-dispatch` 的弱引用只覆盖调度器、目录和输入参数；R1/R2 的结果、展示块和 ref 释放还须在 session/专用场景中追踪，不能仅凭该项 `retainedAfterGc=0` 宣称结果存储也已释放。runtime/session 的宿主采样不覆盖 Worker heap，触及 Worker 内存时须另交对应证据。

### 4.3 禁止的“修复”

- 关闭预算检查，或只把结果预算/时限数字调大。
- 吞掉退出码、把失败统一改成成功、隐藏原始失败事实。
- 恢复路径重新执行已完成的工具（尤其是变更）。
- 为单个写法继续追加零散白名单。
- 用模糊“语义相似”新增硬拒规则。
- 让“所有脚本先写临时文件”“每条命令先做能力检查”成为新的普遍负担。

## 5. 任务清单

### 5.0 分批与并行（2026-10-16 用户确认）

R0 基线 130 项中 81 项为已知失败。按区域与文件归属合并为 8 个 PR、分三波；同一波内各 PR 改动的文件互不相交，可并行开发（规则见 §4.1 第 1、5、6 条和 §4.2 证据分级）。

| 波次 | PR | 任务 | 主要改动范围 | 前置 | 目标转绿的 R0 用例 |
| --- | --- | --- | --- | --- | --- |
| 1 | A | R3.1、R3.2、R3.3a | `extensions/resource-lifecycle-guard/`（R3.3a：该模块产生的拦截正文，含后台拒绝提示 `core.ts:42` 的 `background: true` 说明） | — | F-S1/S4 Shell 矩阵（含权限层与完整钩子子用例） |
| 1 | B | R2.1–R2.5 | `codemode.ts`、`codemode-display.ts`、调度层失败状态 | — | F-C1、F-C2、F-C4、F-C5；F-S7 “third-admission block control” |
| 1 | C | R1.1–R1.3 | 提供方输出预留、`sdk.ts` 错误分类、`tool-result-presentation.ts` 批内分配 | — | F-B3/B4（4 项）、F-B8 20 条组（8 条组还需 E 的 F-B11） |
| 1 | D | R3.4、R3.3b | `extensions/tool-loop-guardrails/`（R3.3b：`core.ts` 恢复提示中把解析器限制后的换写法称为 “evade” 等措辞） | 合并在 B 之后 | F-S6、F-S7 两项钩子级、F-S8；“real guard” 集成须 B 合并后转绿 |
| 2 | E | R1.4、R1.6、R1.5 | `tool-result-presentation.ts` 历史/续读/持久查找、压缩协同、续读工具 | C | F-B9、F-B10、F-B11、F-B12（2 项）、F-B8 8 条组；R1.5 新增自动压缩会话验收 |
| 2 | F | R4.1–R4.2 | CodeMode `host.ts` 计时、`nested-tool-dispatch.ts` 的 `pump` | B | F-C6（2 项） |
| 3 | G | R1.7 | CodeMode 下结果预算的作用单位（D1） | B、E | F-B13 |
| 3 | H | R5.1–R5.5 | TUI 树/进度、模型目录重绑定、CodeMode 说明 | B | R5 以新增用例与人工验收为主；R5.3 先交评估结论 |

- A/D 边界：`tool-loop-guardrails` 按拦截正文前缀识别和分类失败（`failure-classification-regex.ts` 的 `POLICY_BLOCKED_RE`，`core.ts` 中匹配 “Blocked an unmanaged long-lived process”“Blocked an uncertain/uninspectable shell lifecycle” 的恢复分支），`[SHELL_*]` 代码同理。A 修改拦截正文时须保持这些前缀和代码不变；确需改动时，将匹配侧修改并入 D 并在 A 合并后再合并 D，不得在 A 内跨模块修改。
- 前置列的“合并在 X 之后”只约束合并顺序，开发可提前开始；同一文件上的后续 PR（E 在 C 后、F 在 B 后）须基于前置 PR 合并后的 `main` 开发，不在未合并分支上叠加。
- 每个 PR 的交接材料须列出实际转绿的 R0 用例和仍失败的用例，以及其余 R0 用例是否有退化；表中“目标转绿”是验收目标，不代表必然一次转绿。
- 波次划分不改变各任务的验收标准与 §4.3 禁止事项；需要用户决定的事项（如 D1–D4 之外的新取舍）仍先报告再实施。

### R0 回归基线（先做，所有后续任务依赖）

- [x] R0.1 把以下离线场景固化为测试；断言目标是**任务能完成**，而不只是“按设计拒绝”。原基线及 `617fcf0f6` 的断言修正与新增覆盖均已获 Claude 复审认可。修复前这些测试应以已知方式失败，记录失败输出作为基线：
  - 预算：spark 首条结果（F-B3）、272k/128k + 约 144k 历史（F-B4），两者各覆盖小结果准备和超额结果限额/完整续读；结果顺序（F-B8，8 条与 20 条两组，投影使用原始数组的浅副本）、历史重新投影的估算增量及内容完整性（F-B9）、模型侧真实工具链逐游标完整续读且不重放源工具（F-B10）、长单行续读（F-B11）、压缩前后对原始文本的完整续读与 artifact 内容/身份恢复（F-B12）、CodeMode 父结果投影（F-B13）；
  - 错误：FFmpeg 风格输出（横幅约 1.9k 字符，末尾 `No such filter: 'volumedetect'` + `Command exited with code 1`）的模型正文（F-C1）；
  - 失败语义：捕获失败 → 替代成功 → store 写入（F-C2）、三个成功子调用各返回 100 块后 `show` 超限（F-C4）、6 次约 220,000 字符输入后 `show(first.ref)`（F-C5）、缩短时限下的串行累计与审批等待（F-C6）；
  - Shell：F-S3 列出的 8 种写法 + `python -c` + `node <<'EOF'`，分别断言预检、高风险分析、权限控制器；另通过真实扩展 `tool_call` 钩子验证 `full-access` 与 `workspace-write` 下的最终决策，得到并消费 `finalAuthorization`、检查 cwd 绑定，但不执行命令；生命周期违规（`npm run dev &`、`nohup`、`docker run -d`、`Start-Process` 无 `-Wait`）与目标不明的删除还必须在完整钩子下返回 `block`，不能拿到最终授权；
  - 重复调用：等长 5,024/5,564 字符、仅中间不同的 Bash 命令与 CodeMode 脚本（F-S6），父失败/成功两种结果均不清空子失败计数，同一次 agent 运行内第三次子调用被拦后仍通过 `allowFailure` 返回脚本、继续替代操作并提交 store（F-S7），503 暂时性失败（F-S8）。
- [x] R0.2 测试不得依赖网络、真实提供方或业务项目。
- [x] R0.3 性能基线交接：在修改生产代码前，同一机器串行采集 §4.2 的 R1–R4 八项现有基准，保存原始 stdout/stderr、完整 JSON、确切命令、退出码、commit、Node/V8/平台/CPU、预热/采样参数和 SHA256。没有自带 commit 的输出由独立采集清单关联，不改写原始输出。交接包采用可携带文件名和校验值，不在仓库文档嵌入本机路径。现有场景与 R1–R4 尚须新增的验收场景已分开记录；复审确认数据完整、确定性计数可复现，并独立核实三个包的 dist 与源码一致。已补齐 §4.2 的构建和重复采样要求：本次确定性计数可作为基线，采样字节和 CPU 时间为单次采样、仅供参考；未重新采集数据。复审交接与身份校验范围见 §7。

### R1 预算与恢复（P0）

- [ ] R1.1 输出预留：不发送输出上限的 API（`openai-codex-responses`）改走动态算法；其他非自适应 API 只预留“最低回答额度 + 安全余量”，由发送端按剩余上下文裁剪输出上限。逐个核对会发送 `max_output_tokens` 的 API 的裁剪逻辑；保留 `anthropic-messages.ts:1193` 的思考预算检查。（F-B1–B4）
- [ ] R1.2 错误分类：修正 `sdk.ts` 的改写；所有 `budget-too-small` 路径填写 `minimumTokens`；错误区分结果预算不足 / 上下文不足 / 输出预留不合理 / 模型参数异常，并记录实际窗口、历史占用、输出预留、各份额与最低需求。（F-B5、F-B6）
- [ ] R1.3 批内分配改为两遍：先保证每条结果的最低必要信息（含恢复提示），再按实际需要分配正文，未用完的额度回流。只有最低需求之和确实放不下时才阻断。（F-B8）
- [ ] R1.4 历史稳定：结果作为当前批次被投影成什么样，进入历史后保持一致；在预算及配置不变时不缩小原有模型内容，也不按单条预算重新展开。若无法避免展开，则在重新投影后修正基于 usage 的估算，并保持内容完整可恢复。（F-B9）
- [ ] R1.5 压缩协同：压缩阈值与投影使用同一预留口径；预算阻断后允许“压缩一次 → 重新准备请求一次”，不重放工具；仍放不下时给出具体数字和可执行的恢复方式。（F-B7）
- [ ] R1.6 续读能力：
  - 注册模型可调用、CodeMode 内可用的续读工具，包装 `readToolResultContinuation` / `readToolResultArtifact`；
  - 普通文本允许按字符分片前进，并声明分片不提供编辑凭证；
  - 带快照的读取遇到不可拆分行时给出可执行出路，不只重复“缩小 offset/limit”；
  - 来源查找扩展到同一会话的持久化条目，保留来源摘要校验；
  - 续读结果送回模型时不能被外层预算再次裁成无法使用的提示；续读工具接受可选的 `budgetTokens`，或默认分片为 CodeMode 输出的 JSON envelope 留出余量（F-B10 经 `text({recovery})` 送回模型，并要求可见结果不超过 1024 token）；
  - 在该工具上线前，截断提示不得输出不可用的 `tr1.` 游标，应改为给出完整输出的文件路径或明确的现有恢复方式。（F-B10–B12）
- [ ] R1.7 按 D1 调整 CodeMode 下结果预算的作用单位。（F-B13）

R1 验收：

- R0 预算组全部通过；同一批结果换顺序不会从成功变为阻断。
- 历史重新展开的内容进入上下文计算。
- 通过真实工具调用链（含 CodeMode 内）完成续读；长单行可前进；压缩后仍可续读。
- 每次请求最多自动恢复一次，计数器证明无循环。
- 投影、实际请求、提供方接受三层都要验证；R1 末尾用真实会话做一次端到端验收（需用户授权）。

R1 性能验收（须在实施对应修复时补场景，R0 本轮不改测试或基准）：

- F-B11：在 `tool-result-budgeted-model-view` 加入 **10 MiB、`readBoundary: "lines"`** 的长单行续读。初始化/建立索引成本单列；之后每段 `fullSourceEstimatorScans = 0`，每段扫描字节有界、游标持续前进，不从源头重复扫描或产生无界行数组。报告整链总扫描量，防止 O(n²)。现有普通 10 MiB 文本场景不等价于此读取边界场景。
- F-B12：增加“源结果已移出活动上下文、仍在持久会话条目中”的续读场景。允许按生命周期单独记录一次有界索引构建；后续每段查找探测次数有固定上界，不随历史条目数线性增长。索引只保留必要定位/校验元数据，不复制或另存源正文；容量、clear/dispose 后条目数和新增引用计数均须证明有界并归零。
- F-B9：容量内历史稳态的 `steadyCountersPerRequest.fullSourceEstimatorScans = 0`、`fullResultCopies = 0`；正确计入变化不等于每轮重新估算整段历史。增量更新成本与首次投影成本分别计数。另测超过容量的工作集，单列未命中/降级成本和重扫次数，保持有界并与旧侧比较，不能隐藏为“稳态零扫描”。
- F-B13：按子调用投影仍须明确父结果总字节上限、每脚本驻留字节/条目上限、计量编码与所有者；额度耗尽走可恢复截断/取回，不能无限累积。对照 dispatch 和 session 的计数，并新增结果/ref 的弱引用覆盖；完成、失败、取消、dispose 后全部非持久拥有的引用归零，`retainedAfterGc = 0`。

### R2 错误正文与失败状态（P0）

- [ ] R2.1 失败摘要：异常文本与模型摘要改为“首个诊断行 + 输出末尾若干行 + 状态行 + ref/完整输出路径”，复用 Bash 已有的末尾截断；显示端同步。（F-C1）
- [ ] R2.2 统一状态：分别记录是否执行、结果是否完整、展示是否受限、失败是否已处理、脚本是否完成。提供显式的失败返回方式（如 `callTool(name, args, { allowFailure: true })` 返回 `isError` 结果而不抛出）；子调用在执行前被扩展 `tool_call` 拦截（含重复调用拦截）时，开启该选项同样返回带拦截原因的 `isError` 结果、不中止脚本，不能只处理执行失败这一条路径；父调用 `isError` 与 store 提交按“是否存在未处理失败 / 脚本是否完成”决定；打通调度层 `hasErrors`、`invocation.failed`、`result.calls` 与 store 提交。摘要中保留每个子调用的真实状态、退出码与原因，并注明“已处理的失败 N 个”。未开启该选项时保持现有行为。（F-C2、F-C3）
- [ ] R2.3 展示超限降级：`show` 超出块数/字符额度时合并块、截断并附说明，单独报告“展示受限”，不把成功的脚本判为失败。（F-C4）
- [ ] R2.4 引用生命周期：保留额度不计输入参数；被淘汰的 ref 返回“已淘汰”并附可持久访问的位置；在 CodeMode 说明中写明 ref 只在当前脚本有效。（F-C5）
- [ ] R2.5 更新 `CODEMODE_DESCRIPTION`，说明上述失败处理、展示与引用规则。

R2 验收：FFmpeg 样例的模型正文包含 `No such filter`；“捕获失败 → 替代成功 → store”最终成功且 store 已提交，摘要仍列出原始失败；全部成功的子调用不会因展示超限变成父失败；未处理的失败仍使父调用失败；R0 的 F-S7 “third-admission block control” 对照转绿（准入拦截经 `allowFailure` 返回脚本，三个父脚本均继续替代操作并提交 store）。

R2 性能验收：`codemodeFailureReason` 及其 helper 按 `codemode-hot-paths.test.ts` 约束，不新增热调用内的闭包、对象/数组字面量、`new` 或 map/filter。F-C1 用有界的诊断定位和尾部扫描，不拼接全部子结果再截尾。F-C4/F-C5 明确展示、结果和 ref 的条目及字节上限、所有者、淘汰后的可取回方式；超大输入不能无界保留在 ref 存储中。补充 show/ref 压力场景与正常、失败、取消、close/dispose 的引用释放测量；dispatch 的 `retainedAfterGc = 0` 和 session 内结果/ref 引用归零须同时成立。持久 store 与当前调用的临时状态分别计量，不能以延长 ref 寿命为由长期保留结果正文。

### R3 Shell 预检、权限与重复调用（P1）

- [ ] R3.1 生命周期预检：heredoc 改用 `prepareShellAnalysis`；与进程生命周期无关的“无法分析”不再在预检拒绝，交给权限层（已归类为 opaque）。真正的生命周期违规保持拒绝。（F-S1–S3）
- [ ] R3.2 高风险分析（依赖 D3）：区分“存在变更动作且目标无法验证”（继续硬拒，如 `rm -rf "$X"`、`Remove-Item -Recurse $x`）与“Shell 状态无法分析但未发现变更动作”（交给权限模式：`full-access` 放行，其他模式询问）。（F-S4）
- [ ] R3.3 提示措辞：解析器限制后改用其他写法不得称为“规避”；后台拒绝提示写明 `background: true` 及其适用条件（TUI/RPC + tasks 工具）。按 §5.0 拆分交付：3a 为 `resource-lifecycle-guard` 的拦截正文（PR A），3b 为 `tool-loop-guardrails` 的恢复提示（PR D）。（F-S9）
- [ ] R3.4 重复调用：硬拒改用完整内容哈希（输入上限已有界），首尾采样只用于提醒；暂时性失败类别（5xx、超时、网络）不进入永久的重复失败硬拒，但使用独立、有界的重试预算（总尝试次数与累计等待时间），支持退避和取消。预算耗尽必须结束本轮自动重试并报告可恢复原因，不能靠切换父调用作用域重置同一操作的额度。确定性失败按调用自身的工具名、完整参数标识及失败类别计数；父调用与子调用的计数互不覆盖，同一子调用在同一个 agent 运行内跨不同父调用及包装脚本累计。`parentToolCallId` 隔离仅用于在途兄弟调用去重，不作为确定性失败计数的分区或清零条件。R3 实施时明确默认额度及配置口径，并增加连续 503 的离线对照：两次失败后仍可成功，持续失败在指定额度内停止，记录实际调用次数及等待上限；R0 不先行修改重试策略。（F-S6–S8）

R3 验收：R0 的 Shell 组在 `full-access` 下全部可执行、在 `workspace-write` 下全部询问；生命周期违规与动态递归删除仍拒绝；修正中间内容的长命令与长脚本不再被拦；同一个 agent 运行内，同一子调用两次同类确定性失败后，第三次调用在执行前被拦，即使每次使用不同的父调用及包装脚本也不重置计数，与 F-S7 一致；F-S7 两项钩子级测试由 R3.4 单独转绿，“real guard” 集成测试须 R2.2 与 R3.4 均完成后转绿。**风险重点：**`#scopeAllows` 对“无原语、非 opaque”的 Bash 直接放行（`permission-controller.ts:1042`），必须证明放开预检后没有命令被误判为只读。

R3 性能验收：

- R3.1/R3.2：同一次授权里的预检、高风险和权限层共享同一份受限分析；分析只对同一命令/cwd/权限世代有效，变更后必须失效并复检。实际底层分析调用次数和扫描字节数不得因接入预检而翻倍；外层循环推导的 `analysisCalls` 不能替代该证据。分析缓存有容量上限，调用完成/失败/取消后释放源字符串与扫描结果。
- F-S6：对完整内容增量哈希，逐段 `hash.update`，不先构造完整 canonical 字符串、首尾拼接字符串或整份临时 Buffer。准入时计算一次标识，结果阶段按 `toolCallId` 复用；统计完整输入扫描/序列化次数，证明结果阶段没有第二次完整序列化。绑定准入时的确切输入，不能把被修改输入的旧标识误用为授权依据。
- F-S7：agent 运行内的确定性失败计数表、待处理标识表与暂时重试状态均有明确条目/字节上限，不保留源参数/结果。父调用完成或取消时释放其待处理标识和在途去重状态，保留子调用的确定性失败计数以供后续父调用累计；相应操作成功时清除对应失败计数，`agent_end` 清空整个运行的状态，新运行不继承旧计数。达到容量上限时按明确规则淘汰计数并记录淘汰次数，不能无声重置重试预算而变成无限重试。增加跨父调用累计、成功清理、容量压力及受控 GC 验证：父调用结束后仅保留有界的计数元数据，运行结束后条目与引用归零。

### R4 总时限（P1，依赖 D4）

- [ ] R4.1 按 D4 拆分计量；审批等待期间暂停脚本计时；子工具遵守各自 `timeout`。
- [ ] R4.2 超时报错区分耗时所在（脚本计算 / 子工具 / 排队 / 等待审批），并按运行环境给出可用退路（无交互环境明确说明后台不可用）。

R4 验收：2 分钟前台子任务不写 `@options` 可完成；多个子调用串行、等待审批均不被误判超时；用户取消仍能传到子进程；脚本自身死循环仍受时限约束。

R4 性能验收：`Execution.post`、`Execution.handleMessage`、`NestedToolDispatch.pump` 及相关 helper 继续通过精确 AST 门禁。计时暂停/恢复使用每实例一次创建的稳定回调和数值字段，记录剩余计算时间/等待时间；不得每次子调用新增计时闭包、Promise executor、Promise tail 或 AbortController。允许的生命周期截止分配须在测试中逐个点名真实所属函数（如现有 `Execution.constructor` 的脚本级截止边界）；新增截止处理函数同样须精确列名，不能豁免整文件/整类。用串行、并发、审批取消、超时、abort/close 场景测量活动定时器/监听器上界；结束后引用与定时器归零，Worker 启停匹配、`retainedAfterGc = 0`。dispatch/runtime/session 三项基准均须与 R0.3 的同机基线比较。

### R5 显示、模型参数与读写契约（P2）

- [ ] R5.1 Ctrl+O 前后锚定同一条记录及其内部位置。（F-T1）
- [ ] R5.2 增量输出能看到最新进度；错误标记与普通诊断信息分色。（F-T2）
- [ ] R5.3 评估 CodeMode 树是否需要子工具渲染器（图片、结构化结果、进度、错误详情包装前后是否等价可见），先给评估结论再决定是否实施。（F-T3）
- [ ] R5.4 目录刷新后重新绑定会话中选中的模型对象；用“旧目录 → 新目录”的可控场景复现，验证目录、界面、会话对象与请求准备使用的参数一致。（F-M1）
- [ ] R5.5 按 D2 更新 CodeMode 说明与 `READ_REQUIRED` 报错，让“读取须在更早完成的轮次”在规划阶段就清楚可见。（F-C8）

R5 验收：覆盖 Windows 实际终端、长输出、窗口缩放与历史恢复；成功与失败状态不混淆。

## 6. 统一验收

- [ ] 明确授权模式下，代表性合法命令不会仅因解析器不支持某种语法而被堵死。
- [ ] 工具出错后，模型正文包含关键原因及取回完整结果的可用方式。
- [ ] 可处理的局部失败可以转向替代方案；已完成操作保持真实记录且不被重复执行。
- [ ] 同一份真实会话能完成请求准备，投影、实际请求、提供方接受三层均已验证。
- [ ] 真正预算不足时能说明具体原因，并有可行的恢复出口。
- [ ] 模型目录更新与当前会话参数一致。
- [ ] Ctrl+O 前后定位稳定，新增进度可见，成功与失败状态不混淆。
- [ ] 回归测试证明任务能完成，而不只证明“按设计拒绝了”。

## 7. 执行记录

| 任务 | 分支 / PR | 状态 | Claude 复审 | 备注 |
| --- | --- | --- | --- | --- |
| R0 | [PR #154](https://github.com/dragonbaba/super-pi/pull/154)，`test/codemode-recovery-r0` | R0.1–R0.3 完成；PR 已 squash 合并（`ed892cb15`） | 功能与性能基线已获认可；`617fcf0f6` 测试修订复审通过，F-S7 对照描述与 R2.2/R3 交付边界由复审修正 | 最新 130 项：49 通过、81 预期失败；普通对照 19 项全过；八项既有性能基准与两组源码门禁全过，未重采；生产逻辑未修改 |
| R1 | | 未开始 | | |
| R2 | | 未开始 | | |
| R3 | | 未开始 | | |
| R4 | | 未开始 | | |
| R5 | | 未开始 | | |

### R0 初版复审记录（2026-10-16，head `98f5c174`）

- 用户已在与 Codex 的本任务会话中逐项确认 D1–D4；确认原文及上下文见 §3。
- 新增 `tests/codemode-recovery/`：预算与恢复、执行与失败语义、Shell 权限与重复调用三组回归，以及共享的离线会话夹具。命令字符串仅交给分析器和权限控制器，不执行 Shell 命令；执行组使用真实 CodeMode 调度器、模拟子工具和模拟模型流。
- 运行 `npm run test:codemode-recovery`，退出码 **1** 是修复前的失败基线；断言要求恢复和授权后的任务完成，没有用 `skip`、`todo` 或“预期拒绝”掩盖待修问题。98 项包含 10 个命令分组及其 50 个子用例；其中 59 个失败包含 8 个因子用例失败而失败的分组。
- `.regression.ts` 通过独立入口运行，暂不由普通测试发现器纳入。后续每项修复应使用同一用例记录转绿输出，并将已修复用例纳入常规回归；不得把这次基线失败报告为产品修复通过。
- `npm run check` 通过；相关现有测试 5 项通过（`codemode-guardrails.test.ts` 中两项、`tool-result-read-recovery.test.ts` 中三项）。预算不足、普通文本续读、取消传递、死循环时限、生命周期违规及目标不明的递归删除均有对照用例。
- 未改生产热路径，热路径基准不适用于本次仅新增测试的差异。没有提供方请求，也没有对现场业务项目执行任何命令；真实提供方与 Windows 实际终端验收仍留在 R1/R5。
- 接口约定：F-B10 要求可发现的续读工具接受 `cursor` 并说明 `tr1.`，随后实际从 CodeMode 调用且检查模型收到遗漏文本、原工具仅执行一次；R2 的显式失败处理用例采用计划示例 `callTool(name, args, { allowFailure: true })`。若实现阶段改 API 形状，可适配调用方式，不能削弱完成任务和不重放的断言。
- 原有 `docs/README.md` 与 `docs/upstream-pi-1.1.0-task-plan.md` 的 SHA256 与开工前一致。R0 勾选框待复审后再更新。
- 初版复审材料由任务交接提供：`super-pi-r0-baseline.txt`、`super-pi-r0-existing-tests.txt`、`super-pi-r0-typecheck.txt`、`super-pi-r0-review.json`、`super-pi-r0-changes.patch`。仓库文档仅记录文件名，不依赖审查机器的绝对路径。

### R0 首轮复审修订（2026-10-16）

- 补齐 Shell 最终授权测试：10 条命令 × 2 种权限模式通过真实 `ExtensionRunner.emitToolCall`，覆盖生产的生命周期预检、cwd 准备、权限决策、参数复检与最终授权；成功时消费授权并验证 cwd 绑定。使用临时工作区和真实权限命令设置模式，不提供 Shell 执行器。另有 Windows 原生 PowerShell 的 active / discoverable / unavailable 回调分支对照；未宣称已在 Linux 实测。
- 生命周期违规和目标不明的删除同时要求完整钩子返回 `block`、无 `finalAuthorization`、无审批弹窗。已支持的前台命令有完整授权交付的普通回归对照，防止“所有命令一律拒绝”误通过。
- F-C2 必须输出 `{"handled":true}`，且不得走 `caught failure`。新增仅用 `try/catch`、不开 `allowFailure` 的对照：替代子调用确实成功且脚本完成，但父调用仍失败，store 不提交。
- D1–D4 已根据用户与 Codex 会话的逐项回答核实，原文见 §3。修正 F-S4 为 10 种写法中 6 种被权限层拒绝，补上 git stdin heredoc。移除本文全部本机绝对路径。
- 在 R3.4 补充独立有界重试预算及持续 503 的停止验收；具体策略属于 R3，未在 R0 实施。
- 原 39 个通过项包含混合分组内的诊断断言，并非全是独立对照。将全部 13 个原有核心对照移入 `tests/codemode-recovery/controls.test.ts`，加上 6 个新对照，共 19 项，普通测试发现器和 Windows/Linux CI 均会纳入；显式 R0 命令也包含它们。混合分组的分层诊断仍随基线执行，修复后再升格，不隐藏其失败。
- 本地验证：`npm run test:codemode-recovery` 为 124 项（54 顶层 + 70 子用例），49 通过、75 已知失败、0 skip/todo/cancelled。相对初版增加 20 项完整钩子验收和 6 项对照；16 项新增失败来自已记录的预检拒绝，另外 4 项钩子验收通过。75 个失败含 8 个失败分组，实际失败叶子为 67 项。
- 普通入口验证：`node scripts/test.mjs --suite unit --root tests/codemode-recovery --skip-memory --jobs 1` 发现并执行 `controls.test.ts`，19 项全部通过；类型检查通过。修订输出使用 `super-pi-r0-review-fixes-` 前缀交接，初版输出保留用于比较。没有生产修复后的全绿输出，R0 勾选仍待 Claude 再次复审。

### R0 第二轮复审修订与性能交接（2026-10-16）

- 第二轮复审确认首轮七项已修好、功能基线通过；据此勾选 R0.1/R0.2。复核 GitHub 后确认 `8cc40b613` 的六个 CI 分片全部成功。本轮只修改本文，没有修改测试、基准脚本、生产代码或依赖；R0.3 尚待新增材料复核，不宣称 Claude 已审过这些新数据。
- 修复前采集 commit：`8cc40b6134300c1426f5e6e858956eeb612ff045`；跟踪的生产代码和基准脚本相对 `b44dc096` 无差异。环境：Node `v26.4.0`、V8 `14.6.202.34-node.21`、Windows x64、Intel Core i7-14700KF。由 Codex 在本机独立串行重测，不冒充 Claude scratchpad 的原始输出，也不把两次采样数值的差异视为代码回归。
- 检查：hot 组 **13 个文件**全过；单独执行 R1 四个 source-invariant 文件，**13 项**全过。性能采样期间未由采集器并行启动其他测试或基准；系统/桌面后台负载未被控制。
- 交接文件：`super-pi-r0-performance-baseline.zip`，SHA256：`a9048a02f57c265d5420631d871b74397553e4ec5236ada42c94672874086539`。压缩包随任务交接，不是仓库内路径。内含 `manifest.json`、`summary.json`、八份带采集元数据的完整 JSON、未改写的 stdout/stderr 与源码检查日志；每项记录确切命令、退出码、采样时间与文件校验值。部分基准没有内置 commit，已由外层清单关联，不能称它们原本自带 commit。
- 模式与产物：runtime 基准使用源码 host/worker，dispatch 直接使用 agent 源码；session 通过工作区包加载 agent 的 dist。两个 tool-result 基准及 R0 回归测试也会经包名依赖加载 dist，不能按入口为 `.ts` 就认定全部运行源码。原始清单记录了八份基准源码及 codemode 的 14 个 dist JS 哈希，未记录 ai/agent 的 dist 哈希。后续复审中，Claude 独立将当前源码编译到临时目录，确认 ai 194 个、agent 49 个、codemode 14 个 JS 文件与现有 dist 逐字节一致；该验证由复审方完成，支持此次基线对应 `b44dc096` 的生产代码。原始交接包不改写，后续两侧的构建与三个包的完整身份记录按 §4.2 执行。

下表的分配字节、heap 和 CPU/耗时值均为**单次采样，仅供参考**，不是 §4.2 要求的 N≥5 独立运行比较；基准内部的 p50/p95 不改变这一边界。小 fixture（如历史 1 条）的采样值不作门槛；确定性计数与生命周期结果按其各自契约使用。

| 基准 | 本次关键数据（完整字段见 JSON） |
| --- | --- |
| `codemode-dispatch` | 800 次调用，最大并发 4；采样 4,639.38 B/调用；`retainedAfterGc = 0` |
| `codemode-runtime` | source 模式，warm p50 43.69 ms、p95 46.54 ms；Worker 启停 32/32；`retainedAfterGc = 0` |
| `codemode-session` | 242 次子调用；Worker 启停 11/11；`retainedAfterGc = 0`、`pendingEvidenceAfterTurn = 0` |
| `shell-substitution-inspection` | ordinary 6,562 B/轮（上限 65,536）；quoted-16 235,741 B/轮（上限 393,216）；`liveReferences = 0`；外层 `analysisCalls = 2308` |
| `shell-common-compatibility` | append/snapshot 各 96；采样 5,678 B/append；spill 5 MiB 且有界；20 次生命周期释放，`liveOwnersAfterGc = 0` |
| `tool-token-estimator` | 10 MiB 单行 p50 60.12 ms、p95 61.00 ms；1 MiB 日志 p50 14.82 ms、p95 15.11 ms |
| `tool-result-contextual-budget` | clear 后条目/驻留 code units 为 0；dispose 后协调器/弱引用为 0；全部场景计数已保存 |
| `tool-result-budgeted-model-view` | continuationChain 100 段；首次扫描 1、查找探测 50,000，后续每段两项均为 0；dispose 后条目为 0；历史、恢复查找、artifact 与生命周期完整计数已保存 |

- 基线边界：历史结果数 1/10/100 时每请求整源扫描为 0，129/256 的容量压力场景分别为 **1/128**，不能把全部历史场景报告为零；各场景 dispose 后条目与驻留 code units 均为 0。`resumedHistoryLookup` 的首次查找仍为 50,000 次探测/1 次扫描，不能替代“压缩后从持久条目恢复”的未来验收。10 MiB `readBoundary: "lines"`、新增结果/ref 生命周期、真实内部 Shell 分析次数、完整输入哈希复用和新计时路径仍须在 R1–R4 实施时补测，本轮没有改基准来假装已有这些证据。

### R0 性能交接复审与关闭（2026-10-16）

- 复审方确认交接包 SHA256 一致、八项基准及两组检查退出码均为 0；与其在 `8cc40b613` 独立采集的 model-view 结果比较，1,682 个确定性计数字段完全一致，受控 GC 的 heap 采样值有波动。复审认可这些数据作为确定性计数基线，不将独立采样值不同视为代码回归。
- 校验范围澄清：压缩包共 31 个文件，`manifest.json` 逐文件记录并校验其中 28 个；`manifest.json`、`README.txt`、`summary.json` 由 zip 整体 SHA256 保护。“31 个文件”是包内文件总数，不是 manifest 内逐项校验的数量。
- 按复审要求补齐 §4.2：运行本地回归/基准前先构建，两侧记录 ai/agent/codemode 的 dist 哈希，分开比较 dispatch 源码与 session dist 模式；确定性计数作硬门槛，采样比较须同机同会话两侧各 N≥5，报告中位数与范围。R0.3 的单次采样和小 fixture 只作参考。本轮只改本文，不重跑测试、构建或性能采集，不修改原始交接包。
- 两处文档补充完成后，依照本轮复审结论勾选 R0.3、关闭 R0。历史记录中的“待复核”描述保留为当时状态，以本节为准；R1–R5 仍未开始。PR 的最终 head 仍须完成 CI 与审查，合并另需用户授权。

### R0 F-S7 审查补充（2026-10-16）

- 文档提交 `3cba34d72` 后，核查 PR 发现一条未解决的 F-S7 审查意见：原测试允许父调用或子调用任一被拦截就通过，可能掩盖子调用失败计数仍丢失的问题。用户随后明确授权追加独立提交修正测试。
- 每轮使用不同的父脚本包装，子调用参数保持一致；断言父调用始终获准、被拦截者确为当前父调用下的 `fixture_operation`，且拦截发生在两个子调用失败之后的第三次准入。未修改生产防护逻辑。
- 先执行 `npm run build:offline`，退出码 0；修订前后测试使用同一份新构建，逐文件记录 ai 194 个、agent 49 个、codemode 14 个 dist JS 的 SHA256。修订前 F-S7 单项为已知失败；修订后的完整基线仍为 124 项、49 通过、75 已知失败、0 skip/todo/cancelled，包含 19 项通过的普通对照；类型检查通过。F-S7 仍复现待 R3 修复的真实计数缺陷，不能称为产品修复转绿。
- 临时断言敏感性探针证明：只保留父计数、清掉子计数的错误模型会让旧测试假通过，新测试会拒绝；第三轮仅拦父调用也会被新测试拒绝；正确保留子计数并拦第三次子调用的对照会被接受。这些模型仅验证测试断言，不能替代生产回归。输出按 `super-pi-r0-fs7-` 前缀交接。
- 本次追加只修改该测试和本文，未修改基准或重新采集性能数据；原性能交接包校验值不变。最终提交仍须通过 CI 与审查，PR 未获合并授权。

### R0 F-S7 计数范围文档复核（2026-10-16）

- 最终复审指出 R3.4 的“按父调用作用域分开”和 F-S7 性能验收的“父调用完成后清空”会阻止现有测试跨父调用累计。已改为同一 agent 运行内按调用自身的完整内容标识计数，父、子互不覆盖；仅在途兄弟去重按 `parentToolCallId` 隔离。
- 明确父调用完成/取消、操作成功、容量淘汰和 `agent_end` 各自的清理边界；R3 验收同步写明“两次子调用失败后，拦截第三次准入”。本轮仅修订本文，未修改测试、生产代码或性能基准，未重新构建、运行本地测试或采集数据；新 head 的 CI 与 Codex 复审另行核对，仍待 Claude 复核及用户合并授权。

### R0 五处断言补强（2026-10-16）

- 文档 head `e20b1ecf2` 的六个 CI 分片全部通过；Codex 复审新增五处测试可能假通过的意见，经源码核对后，用户明确授权追加独立提交补强测试。
- F-B12 的续读基准改为从原始文本及模型保留的首尾计算遗漏部分，逐块校验源字符、预算、前进与完整终止；压缩前后均须完整恢复原文，不再以同一 API 的另一次返回值作为正确性基准。该断言同时用于超额 SDK 结果和历史投影。
- F-B9 先保存历史快照，拒绝相同预算及配置下的缩小，并验证投影与完整续读仍对应原始内容；零增长时要求历史不变，增长时仍允许计划中的“展开增量正确计入上下文”方案，未将其改成只接受完全不变。此处按后续复审统一措辞；原 `growth >= 0` 断言不只禁止“静默”缩小。
- F-B3/B4 保留原有小结果用例，另各加一个超额结果用例，经真实 SDK 转换验证模型结果不超过 1024 token、遗漏内容可完整续读、规范结果未被重放或改写。F-C2 要求下一次模型请求仍包含已处理子调用的原始诊断；F-C4 要求下一次模型请求保留源输出并明确说明展示截断/受限，不能用静默丢弃换取父调用成功。
- 本地先构建，退出码 0；修订前完整基线为 124 项、49 通过、75 已知失败；修订后为 126 项（56 顶层 + 70 子用例）、49 通过、77 已知失败，0 skip/todo/cancelled。新增两项失败均为已有的 `minimumNotice=unavailable` 预算阻断；77 个失败包含 8 个失败分组，实际失败叶子 69 项。类型检查通过；修订前后使用同一份新构建，记录 ai/agent/codemode 三包 dist 哈希。
- 临时模拟实现的 22 项断言敏感性对照通过：旧断言可接受的空/替代续读、历史丢失、预算绕过、诊断丢失、全部输出丢弃及静默截断均被新断言拒绝；完整恢复、稳定历史或正确计入增长、保留诊断和显式截断的对照可通过。这仅证明断言能区分这些行为，不是生产缺陷已修复。输出按 `super-pi-r0-assertions-` 前缀交接；生产代码及性能基准未改，性能包未重采，最新测试修订另待复审。

### R0 相邻预算断言与后续验收边界（2026-10-16）

- `b74cb0ab1` 的六个 CI 分片通过；再次自动复审指出 F-B8 与 F-B11 的相邻断言仍可能假通过。F-B8 现要求两种顺序下的大结果身份仍存在，且保留部分与续读能逐字符恢复原文；F-B11 除检查返回的 token 估值外，独立估算每段实际内容，拒绝低报估值的超限块。
- 当前 F-B3/B4 只覆盖 SDK 请求准备与结果投影，不证明自动压缩协同。R1.5 实施时须增加启用压缩的真实会话测试：预算阻断后恰好压缩一次、重新准备一次、原工具执行次数不增加；仍放不下时明确终止。现有直接转换测试不能代替该验收。（F-B7）
- 当前 F-S8 只覆盖两次暂时性失败后可恢复成功，不证明持续失败有界。沿用 R3.4 已约定的交付范围：R3 确定默认额度与配置口径后，增加连续 503 的离线测试，断言实际尝试次数、累计等待上限、取消及跨父调用不重置额度；禁止以 F-S8 转绿替代该验收。本轮不预设尚未制定的重试参数，也不把这两项后续验收报告为 R0 已覆盖。
- 补强后完整 R0 仍为 126 项、49 通过、77 已知失败，类型检查通过；沿用本轮已构建且身份未变的 dist。临时断言对照扩为 30 项并全部通过，新增对照分别证明丢弃大结果及低报长行续读估值的错误实现会被拒绝、完整有界恢复可以通过。另外两项真实 SDK 离线成功路径探针通过：使用充足上下文空间验证相同的超额结果断言可通过；它们不替代原模型预算场景，也不证明自动压缩已修复。

### R0 F-B8 纠错与三项覆盖补齐（2026-10-16）

- 复审确认 `projectMessagesForModel` 会改写调用方的外层数组。`275131ed0` 的 F-B8 把该数组再次作为续读来源，导致“大结果在最后”由原有可投影状态变成 `not on the active branch`；这是测试自身引入的错误。现改为投影 `messages.slice()`，保留原始数组供续读。上次仅比较失败名单与数量不足以证明失败原因未变；原 30 项模拟对照没有模拟输入数组改写，未能发现这个错误。
- 真实 owner 对照确认：不复制数组时两组均出现来源错误；复制后 20 条组的末尾分支完整续读通过、合计 1020 token，8 条组的末尾分支恢复为已知 F-B11 `cannot make forward progress`。两组首位分支仍是已知分配不足，没有以放宽预算或删断言来转绿。
- F-B10 现在只从下一次模型请求读取工具返回的续读结果，跟随其 `nextCursor` 直到完整终止，逐字符核对原始父结果；不调用私有恢复 API 获取正确答案。续读工具可将现有 V1 receipt 放在 JSON 正文，或将续读元数据放在 details、块放在 content，由 CodeMode 输出完整 envelope；每段模型输出及恢复内容均检查预算。工具若声明 `budgetTokens` 则请求 512，否则使用其默认值；测试必须实际经过多段，源工具始终只执行一次。
- F-S7 同时覆盖失败父调用和成功父调用。新增真实会话/CodeMode 集成：一次 agent 运行内发出三个不同父脚本，子参数一致，前两次执行失败、第三次执行前被拦；`allowFailure` 必须把拦截作为失败结果返回，三个父脚本都继续替代操作并成功，第四个脚本验证 store 已提交。另设明确第三次准入拦截的离线对照，用于在计数修复前单独验收“拦截经 `allowFailure` 返回脚本”，避免计数缺陷遮住调度缺陷；但当前产品尚无 `allowFailure`（R2.2 交付），该对照在第 0 轮即因普通失败抛出而中止，要到 R2.2 之后才能区分拦截处理（见下条及 Claude 复审修正）。
- F-B12 新增 artifact 对照：从真实规范结果取得 descriptor，在持久化前独立复制预期内容，压缩前校验全部内容及身份；压缩后确认源只保留在持久条目中，清空驻留 owner，再验证全部内容、id、摘要与字节数一致。基线在压缩后报 `stale-artifact`，与事实表一致。
- 本轮先构建并记录三包共 257 个 dist JS 的哈希。完整基线从 126 项、49 通过、77 失败变为 130 项（60 顶层 + 70 子用例）、49 通过、81 已知失败，无 skip/todo/cancelled；81 包含 8 个失败分组、73 个失败叶子。类型检查通过。新增 4 项依次复现 artifact 来源丢失、成功父调用交错时计数仍丢失、真实 guard 仍执行第三次子调用（`executions 3 !== 2`）、`allowFailure` 尚未实现导致对照在第 0 轮中止（`alternatives` 为 `[]`，与 F-C2 同源）。F-B8 的失败原因纠正如上，不能仅凭失败总数判断测试有效。
- 10 项临时真实路径探针、8 项模拟断言对照及既有 30 项断言对照全部通过。真实路径探针只注入临时续读工具或持久条目查找适配，保留真实 SDK/CodeMode/投影/恢复路径；模拟对照明确覆盖外层数组改写、成功父调用清空所有子计数、拦截异常逃出脚本和 store 丢失；另用真实 API 返回源引用后原地清空的对照，证明 artifact 预期不会跟随源数据一起被改写。它们只验证断言，不代表产品修复。本轮不改生产逻辑/基准、不重采性能数据，原交接包不改写。
- 复审已同意 F-B7 自动压缩按 R1.5、持续 503 有界重试按 R3.4 延后；对应线程回复计划章节后解决，不声称已有覆盖。F-B9 的“不缩小”措辞已与断言统一；F-C4 提示格式仍留到 R2 定义，届时须区分系统截断提示与源正文恰好包含 `omitted`/`output limit` 等词，当前固定源 fixture 不含这些词。R0.1 保持未完成，待新 head 的 CI、自动复审与 Claude 复核；合并另需用户授权。

### R0 Claude 复审与文档修正（2026-10-16）

- 复审 `617fcf0f6`：F-B8 浅副本修正、F-B10 全游标模型侧续读、F-B12 artifact 独立预期、F-S7 成功/失败父调用两种组合及集成测试均成立；逐项核对失败原因，均为真实缺陷或测试设计预期。CI 六个分片通过，自动复审无发现，未解决线程 0。
- 修正一处描述：产品代码当前没有 `allowFailure`，“third-admission block control” 在第 0 轮即因普通失败抛出而中止（`alternatives` 为 `[]`，与 F-C2 同源），尚不能单独证明“拦截后中止脚本”。已在 R2.2 写明准入拦截在 `allowFailure` 下同样返回失败结果，并把该对照列入 R2 验收；R3 验收注明 “real guard” 集成测试须 R2.2 与 R3.4 均完成后转绿。
- R1.6 补充续读工具的分片预算约定（可选 `budgetTokens` 或为 envelope 留余量），与 F-B10 的可见结果预算一致。
- 本次仅修改本文，未改测试、生产代码或基准，未重跑测试；R0.1 据此勾选。PR 合并仍须用户授权。

### R1–R5 分批与流程调整（2026-10-16）

- PR #154 经用户授权 squash 合并为 `ed892cb15`，合并树与复审 head `bb50735ce` 一致；R0 分支已删除。
- 用户确认三项流程调整：同一区域的任务合并为一个 PR（§4.1 第 1 条）；文件互不相交的 PR 在独立 worktree 并行开发（§4.1 第 6 条）；N≥5 的重复采样比较改为每波合并后集中进行；逐 PR 仍须运行相关生产分配基准并报告单次采样与主要分配位置，确定性计数、源码约束与生命周期证据仍逐 PR 硬卡（§4.2 证据分级）。另增 R0 断言冻结规则（§4.1 第 5 条）。
- 批次见 §5.0：第一波 A（R3.1、R3.2、R3.3a）、B（R2）、C（R1.1–R1.3）、D（R3.4、R3.3b）；第二波 E（R1.4/R1.6/R1.5）、F（R4）；第三波 G（R1.7）、H（R5）。R1.7 与 R5 区域不同，按第 1 条拆为两个 PR，共 8 个。
- Codex 复审 `06919cf96` 的两项意见经核对成立并已修正：其一，契约要求合并前运行相关生产分配基准并报告采样字节与主要分配位置，原稿把采样整体延到波末与之冲突，现改为逐 PR 单次运行并报告、仅 N≥5 统计比较延到波末；其二，R3.3 的“规避”措辞位于 `tool-loop-guardrails/core.ts`，与 D 同一模块，现将 R3.3 拆为 A 的拦截正文（3a）与 D 的恢复提示（3b），并约定 A 不改被 D 匹配的正文前缀与 `[SHELL_*]` 代码。
- 本次仅修改本文，未改测试、生产代码或基准。
