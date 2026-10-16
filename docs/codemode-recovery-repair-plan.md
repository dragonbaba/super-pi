# CodeMode 执行、预算与恢复修复计划

状态：2026-10-16 审查收敛，D1–D4 已由用户确认，R0 修复前回归基线已建立，待复审。四轮交叉审查（Claude ×2、Codex ×2）后形成本清单；Codex 负责实施，Claude 负责逐任务复审。勾选框表示实施、验收和复审全部完成，不能用“已查过源码”或“现有测试通过”代替。

**核心要求：已授权的正常任务，应能在局部、可恢复的错误之后继续完成。** 不得因为解析器不认识某种写法、某次结果需要缩减、展示额度不足或内部缓存淘汰，就把整轮任务堵死；也不得用吞掉退出码、统一改成成功、关闭预算检查或单纯调大数字来“修复”。

## 1. 固定基线

| 项目 | 值 |
| --- | --- |
| 仓库 | `D:\RMProjects\Pi`，`main` = `b44dc0962684a937835064fde130580ebc7a520c`（PR #153 已合并） |
| 现场业务项目 | `D:\RMProjects\ModelTest\GPTTest`（只作现场背景，不重跑其中有副作用的命令） |
| 现场权限 | `full-access + never-ask` |
| 现场配置 | `toolResultPresentation.budgetTokens = 1024`（该功能默认关闭，属用户显式配置） |
| 现场模型 API | `openai-codex-responses` |
| 原有工作区变动 | `docs/README.md`（已修改）、`docs/upstream-pi-1.1.0-task-plan.md`（未跟踪），实施中不得覆盖 |

证据文件（Codex 审查产物，离线探针，不含真实提供方请求）：

- `C:\Users\Administrator\Documents\Codex\2026-10-16\1-bash-exited-exit-8-0\outputs\super-pi-third-review-evidence.json`
- `C:\Users\Administrator\Documents\Codex\2026-10-16\1-bash-exited-exit-8-0\outputs\super-pi-fourth-review-evidence.json`

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
| F-S4 | 绕过预检后，高风险分析把“Shell 状态无法分析 / heredoc”标为 `unverifiable`，权限控制器在判断权限模式前硬拒：9 种写法中 Python heredoc、重定向 heredoc、修改 PATH、激活虚拟环境、子 Shell 切换目录 5 种在 `full-access` 下仍被拒。对照：`python -c "import os; os.remove('a')"` 放行，同样代码写成 heredoc 被拒 | `core.ts:385-395`；`permission-controller.ts:416-423, 932-972` |
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

## 3. 待用户确认的决定

未确认前，相关任务**不得开工**；实施者遇到需要决定的情形应停下询问，不自行选择。

| ID | 决定 | 建议 | 阻塞任务 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | 结果预算在 CodeMode 下按每个脚本计算，还是按子调用计算 | 按子调用计算，父结果另设上限 | R1.7 | 2026-10-16 用户确认建议 |
| D2 | 是否支持同一脚本内“读取 → 修改”（基于宿主真实快照、提交前再校验） | 本轮不改契约，只把限制写清；另行评审 | R5.5 | 2026-10-16 用户确认建议 |
| D3 | `full-access` 下“Shell 状态无法分析、但未发现变更动作”是否放行 | 放行；“有变更动作且目标不确定”继续硬拒 | R3.2 | 2026-10-16 用户确认建议 |
| D4 | CodeMode 总时限计量模型 | 拆为脚本计算时间 / 子工具执行（遵守各自 timeout）/ 排队 / 人工等待（暂停计时） | R4 | 2026-10-16 用户确认建议 |

## 4. 交付规则

### 4.1 分工与流程

1. 每个任务（R1.x 等）独立分支、独立 PR；一个 PR 只解决一类问题。
2. 提交、推送、开 PR、合并均须用户对当前任务的明确授权。开 PR 后评论 `@codex review`；推送审查修复后再次评论。
3. 每个任务完成后交 Claude 复审，复审材料必须包含：
   - 改动摘要与 diff 范围（含 `git status`，确认未动 §1 的原有变动）；
   - 该任务对应 R0 回归测试的**修复前失败输出**与**修复后通过输出**；
   - 运行过的测试与基准命令及结果（失败如实贴出）；
   - 是否触及热路径及对应证据（见 4.2）；
   - 未解决风险与证据边界。
4. 不重跑业务项目里有副作用的命令（写入、渲染、安装）。

### 4.2 热路径门禁

`tool-result-presentation.ts`、提供方请求转换、CodeMode 进度/结果交付、`codemode-tree.ts`、`scroll-view.ts`、交互渲染属于热路径。修改前先读 `docs/performance/hot-path-allocation-contract.md` 并审计完整生产调用链；修改后至少运行：

- `npm run test:hot`
- `npm run bench:tool-result-contextual-budget`
- `npm run bench:tool-result-budgeted-model-view`
- 触及 TUI 时：`bench:tui-tool-leaf-allocations`、`bench:tui-frame-allocations` 等相关项

提供确定性计数和生命周期/引用释放证据。不引入对象池，除非满足契约中的 profiler 门槛。

### 4.3 禁止的“修复”

- 关闭预算检查，或只把结果预算/时限数字调大。
- 吞掉退出码、把失败统一改成成功、隐藏原始失败事实。
- 恢复路径重新执行已完成的工具（尤其是变更）。
- 为单个写法继续追加零散白名单。
- 用模糊“语义相似”新增硬拒规则。
- 让“所有脚本先写临时文件”“每条命令先做能力检查”成为新的普遍负担。

## 5. 任务清单

### R0 回归基线（先做，所有后续任务依赖）

- [ ] R0.1 把以下离线场景固化为测试；断言目标是**任务能完成**，而不只是“按设计拒绝”。修复前这些测试应以已知方式失败，记录失败输出作为基线：
  - 预算：spark 首条结果（F-B3）、272k/128k + 约 144k 历史（F-B4）、结果顺序（F-B8，8 条与 20 条两组）、历史重新投影的估算增量（F-B9）、长单行续读（F-B11）、压缩后续读（F-B12）、CodeMode 父结果投影（F-B13）；
  - 错误：FFmpeg 风格输出（横幅约 1.9k 字符，末尾 `No such filter: 'volumedetect'` + `Command exited with code 1`）的模型正文（F-C1）；
  - 失败语义：捕获失败 → 替代成功 → store 写入（F-C2）、三个成功子调用各返回 100 块后 `show` 超限（F-C4）、6 次约 220,000 字符输入后 `show(first.ref)`（F-C5）、缩短时限下的串行累计与审批等待（F-C6）；
  - Shell：F-S3 列出的 8 种写法 + `python -c` + `node <<'EOF'`，分别断言预检、高风险分析、`full-access` 与 `workspace-write` 下的最终决策；生命周期违规（`npm run dev &`、`nohup`、`docker run -d`、`Start-Process` 无 `-Wait`）与 `rm -rf "$X"` 必须保持拒绝；
  - 重复调用：等长 5,024/5,564 字符、仅中间不同的 Bash 命令与 CodeMode 脚本（F-S6），父子交替失败（F-S7），503 暂时性失败（F-S8）。
- [ ] R0.2 测试不得依赖网络、真实提供方或业务项目。

### R1 预算与恢复（P0）

- [ ] R1.1 输出预留：不发送输出上限的 API（`openai-codex-responses`）改走动态算法；其他非自适应 API 只预留“最低回答额度 + 安全余量”，由发送端按剩余上下文裁剪输出上限。逐个核对会发送 `max_output_tokens` 的 API 的裁剪逻辑；保留 `anthropic-messages.ts:1193` 的思考预算检查。（F-B1–B4）
- [ ] R1.2 错误分类：修正 `sdk.ts` 的改写；所有 `budget-too-small` 路径填写 `minimumTokens`；错误区分结果预算不足 / 上下文不足 / 输出预留不合理 / 模型参数异常，并记录实际窗口、历史占用、输出预留、各份额与最低需求。（F-B5、F-B6）
- [ ] R1.3 批内分配改为两遍：先保证每条结果的最低必要信息（含恢复提示），再按实际需要分配正文，未用完的额度回流。只有最低需求之和确实放不下时才阻断。（F-B8）
- [ ] R1.4 历史稳定：结果作为当前批次被投影成什么样，进入历史后保持一致，不按单条预算重新展开；若无法稳定，则在重新投影后修正基于 usage 的估算。（F-B9）
- [ ] R1.5 压缩协同：压缩阈值与投影使用同一预留口径；预算阻断后允许“压缩一次 → 重新准备请求一次”，不重放工具；仍放不下时给出具体数字和可执行的恢复方式。（F-B7）
- [ ] R1.6 续读能力：
  - 注册模型可调用、CodeMode 内可用的续读工具，包装 `readToolResultContinuation` / `readToolResultArtifact`；
  - 普通文本允许按字符分片前进，并声明分片不提供编辑凭证；
  - 带快照的读取遇到不可拆分行时给出可执行出路，不只重复“缩小 offset/limit”；
  - 来源查找扩展到同一会话的持久化条目，保留来源摘要校验；
  - 续读结果送回模型时不能被外层预算再次裁成无法使用的提示；
  - 在该工具上线前，截断提示不得输出不可用的 `tr1.` 游标，应改为给出完整输出的文件路径或明确的现有恢复方式。（F-B10–B12）
- [ ] R1.7 按 D1 调整 CodeMode 下结果预算的作用单位。（F-B13）

R1 验收：

- R0 预算组全部通过；同一批结果换顺序不会从成功变为阻断。
- 历史重新展开的内容进入上下文计算。
- 通过真实工具调用链（含 CodeMode 内）完成续读；长单行可前进；压缩后仍可续读。
- 每次请求最多自动恢复一次，计数器证明无循环。
- 投影、实际请求、提供方接受三层都要验证；R1 末尾用真实会话做一次端到端验收（需用户授权）。

### R2 错误正文与失败状态（P0）

- [ ] R2.1 失败摘要：异常文本与模型摘要改为“首个诊断行 + 输出末尾若干行 + 状态行 + ref/完整输出路径”，复用 Bash 已有的末尾截断；显示端同步。（F-C1）
- [ ] R2.2 统一状态：分别记录是否执行、结果是否完整、展示是否受限、失败是否已处理、脚本是否完成。提供显式的失败返回方式（如 `callTool(name, args, { allowFailure: true })` 返回 `isError` 结果而不抛出）；父调用 `isError` 与 store 提交按“是否存在未处理失败 / 脚本是否完成”决定；打通调度层 `hasErrors`、`invocation.failed`、`result.calls` 与 store 提交。摘要中保留每个子调用的真实状态、退出码与原因，并注明“已处理的失败 N 个”。未开启该选项时保持现有行为。（F-C2、F-C3）
- [ ] R2.3 展示超限降级：`show` 超出块数/字符额度时合并块、截断并附说明，单独报告“展示受限”，不把成功的脚本判为失败。（F-C4）
- [ ] R2.4 引用生命周期：保留额度不计输入参数；被淘汰的 ref 返回“已淘汰”并附可持久访问的位置；在 CodeMode 说明中写明 ref 只在当前脚本有效。（F-C5）
- [ ] R2.5 更新 `CODEMODE_DESCRIPTION`，说明上述失败处理、展示与引用规则。

R2 验收：FFmpeg 样例的模型正文包含 `No such filter`；“捕获失败 → 替代成功 → store”最终成功且 store 已提交，摘要仍列出原始失败；全部成功的子调用不会因展示超限变成父失败；未处理的失败仍使父调用失败。

### R3 Shell 预检、权限与重复调用（P1）

- [ ] R3.1 生命周期预检：heredoc 改用 `prepareShellAnalysis`；与进程生命周期无关的“无法分析”不再在预检拒绝，交给权限层（已归类为 opaque）。真正的生命周期违规保持拒绝。（F-S1–S3）
- [ ] R3.2 高风险分析（依赖 D3）：区分“存在变更动作且目标无法验证”（继续硬拒，如 `rm -rf "$X"`、`Remove-Item -Recurse $x`）与“Shell 状态无法分析但未发现变更动作”（交给权限模式：`full-access` 放行，其他模式询问）。（F-S4）
- [ ] R3.3 提示措辞：解析器限制后改用其他写法不得称为“规避”；后台拒绝提示写明 `background: true` 及其适用条件（TUI/RPC + tasks 工具）。（F-S9）
- [ ] R3.4 重复调用：硬拒改用完整内容哈希（输入上限已有界），首尾采样只用于提醒；暂时性失败类别（5xx、超时、网络）不进入硬拒；失败计数按父调用作用域分开。（F-S6–S8）

R3 验收：R0 的 Shell 组在 `full-access` 下全部可执行、在 `workspace-write` 下全部询问；生命周期违规与动态递归删除仍拒绝；修正中间内容的长命令与长脚本不再被拦；真正连续三次完全相同的确定性失败仍被拦。**风险重点：**`#scopeAllows` 对“无原语、非 opaque”的 Bash 直接放行（`permission-controller.ts:1042`），必须证明放开预检后没有命令被误判为只读。

### R4 总时限（P1，依赖 D4）

- [ ] R4.1 按 D4 拆分计量；审批等待期间暂停脚本计时；子工具遵守各自 `timeout`。
- [ ] R4.2 超时报错区分耗时所在（脚本计算 / 子工具 / 排队 / 等待审批），并按运行环境给出可用退路（无交互环境明确说明后台不可用）。

R4 验收：2 分钟前台子任务不写 `@options` 可完成；多个子调用串行、等待审批均不被误判超时；用户取消仍能传到子进程；脚本自身死循环仍受时限约束。

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
| R0 | `test/codemode-recovery-r0` | 已建立修复前基线，待复审 | 待 Claude 复审 | 98 项（含子用例）：39 通过、59 预期失败、0 跳过；生产逻辑未修改；用户已授权提交、推送和创建 PR |
| R1 | | 未开始 | | |
| R2 | | 未开始 | | |
| R3 | | 未开始 | | |
| R4 | | 未开始 | | |
| R5 | | 未开始 | | |

### R0 复审记录（2026-10-16）

- 用户已在当前会话逐项确认 D1–D4，按 §3 的建议执行。
- 新增 `tests/codemode-recovery/`：预算与恢复、执行与失败语义、Shell 权限与重复调用三组回归，以及共享的离线会话夹具。命令字符串仅交给分析器和权限控制器，不执行 Shell 命令；执行组使用真实 CodeMode 调度器、模拟子工具和模拟模型流。
- 运行 `npm run test:codemode-recovery`，退出码 **1** 是修复前的失败基线；断言要求恢复和授权后的任务完成，没有用 `skip`、`todo` 或“预期拒绝”掩盖待修问题。98 项包含 10 个命令分组及其 50 个子用例；其中 59 个失败包含 8 个因子用例失败而失败的分组。
- `.regression.ts` 通过独立入口运行，暂不由普通测试发现器纳入。后续每项修复应使用同一用例记录转绿输出，并将已修复用例纳入常规回归；不得把这次基线失败报告为产品修复通过。
- `npm run check` 通过；相关现有测试 5 项通过（`codemode-guardrails.test.ts` 中两项、`tool-result-read-recovery.test.ts` 中三项）。预算不足、普通文本续读、取消传递、死循环时限、生命周期违规及目标不明的递归删除均有对照用例。
- 未改生产热路径，热路径基准不适用于本次仅新增测试的差异。没有提供方请求，也没有对现场业务项目执行任何命令；真实提供方与 Windows 实际终端验收仍留在 R1/R5。
- 接口约定：F-B10 要求可发现的续读工具接受 `cursor` 并说明 `tr1.`，随后实际从 CodeMode 调用且检查模型收到遗漏文本、原工具仅执行一次；R2 的显式失败处理用例采用计划示例 `callTool(name, args, { allowFailure: true })`。若实现阶段改 API 形状，可适配调用方式，不能削弱完成任务和不重放的断言。
- 原有 `docs/README.md` 与 `docs/upstream-pi-1.1.0-task-plan.md` 的 SHA256 与开工前一致。R0 勾选框待复审后再更新。
- 复审材料目录：`C:\Users\Administrator\Documents\Codex\2026-10-16\1-bash-exited-exit-8-0\outputs`，包含 `super-pi-r0-baseline.txt`、`super-pi-r0-existing-tests.txt`、`super-pi-r0-typecheck.txt`、`super-pi-r0-review.json`、`super-pi-r0-changes.patch`。
