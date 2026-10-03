# Codemode 外部审查复核

日期：2026-10-03。初次复核对象是 `codex/default-codemode` 未提交工作区，基线 `0949fc33f`；官方比较基线仍为本地 Pi `v1.0.0` / `a13d35a74`。下文逐项判定保留初次只读复核的证据，便于比较修复前后。用户随后授权“开始修复”；实际修复、组合验收和剩余边界见 [执行记录](codemode-default-execution-log.md)。没有提交、推送、创建 PR 或合并。

## 结论与证据边界

审查的主要方向成立。提示词、默认扩展组合、JSON 限额、变更结果持久化及 OAuth 锁均有实际问题。之前“全部完成、通过本地验收”的总体结论撤回，历史测试通过的记录保留，但不能替代缺失的组合和边界场景。

同时，审查并非全部准确：`exit()` 已存在；原生变更参数有执行前校验；store 更新失败会保留旧快照；同步锁会重试；增加 Codemode 关闭开关不是本任务的修复目标。默认强制 Codemode 的用户要求继续有效。

验证入口：`node scripts/bench/codemode-review.mjs docs/performance/codemode-review-probes.json`。

- [探针源代码](../scripts/bench/codemode-review.mjs) / [完整结果](performance/codemode-review-probes.json)。这是报告当前行为的诊断程序，不是要求缺陷继续存在的回归测试。
- Windows、Node v26.4.0；9 组探针完成，程序退出 0。本次未运行全量测试，因为没有产品代码变更；也不把探针退出 0 解释为产品无缺陷。
- 使用本地模拟模型，不调用在线模型；OAuth 使用隔离临时凭据文件及模拟授权等待，不访问真实凭据或外网。实际登录入口和回调监听器仍执行并关闭。
- 扩展对照为无扩展、仅 guardrails、加载整个 `packages/extensions` 包。后一组通过资源加载器加载 9 个扩展，加载错误为 0；它不是 `.sp/config/settings.json` 中全部 14 个包的完整启动验收。
- 所有探针自建工作区归属一个唯一临时目录，运行结束按该身份删除，结果中 `cleaned: true`。未删除此前遗留材料。

## 逐项判定

### R1 / P1：提示词与模型可调用工具不一致——成立

无扩展和 9 扩展两组的实际模型工具均只有 `ask_user`、`codemode`，但系统提示词 Available tools 列出 read/bash/powershell/edit/write，未列出 codemode。由真实 SDK 的模型调用上下文捕获，不是单独拼装的提示词样例。

原因：[`CodemodeController` 定义](../packages/coding-agent/src/core/codemode.ts) 没有 `promptSnippet`；[`_rebuildSystemPrompt`](../packages/coding-agent/src/core/agent-session.ts) 按活动工具集合生成提示，而提供给模型的声明经过暴露策略筛选。子工具的裸调用指导仍留在系统提示中。

修复应让提示词和实际模型声明使用同一展示策略，同时保留子工具指导但明确通过 `tools.read(...)` 等脚本入口调用。仅补一条 Codemode snippet 不足以消除原生工具误导。未使用在线模型测量“浪费轮次”，这是由冲突推导的风险，不是本轮测得的模型失败率。

### R2 / P1：顺序子调用被批次去重误拦——成立

同一脚本执行两次 `await tools.read({path:"file.txt"})`：

| 条件 | 第一次 | 第二次 | 父调用 |
| --- | --- | --- | --- |
| 无扩展 | 成功 | 成功 | 成功 |
| 仅 tool-loop-guardrails | 成功 | DUPLICATE_CALL | 失败 |
| packages/extensions 全包，9 扩展 | 成功 | DUPLICATE_CALL | 失败 |

[`index.ts`](../packages/extensions/tool-loop-guardrails/index.ts) 的 batch 集合仅在 `turn_start` 清空，每个嵌套调用都会进入 [`inspectBatchCall`](../packages/extensions/tool-loop-guardrails/core.ts)，没有区分协议同批兄弟调用和脚本中前后有顺序依赖的调用。

审查给出的修法需要修正：仅按 `parentToolCallId` 隔离，仍会误拦同一父调用内的第二次读取。应单独定义嵌套调用的批次/在途去重语义，保留长期循环、失败重试、权限与资源保护。不能一并跳过所有 guardrails。

另一个测试前提：现有 mutation guard 要求“前一已完成轮次中对模型可见的读取”。同一脚本首次 read→edit 即便取消去重，也应继续被 READ_REQUIRED 拒绝。修复测试必须先建立合法的前轮读取凭据，再验证修改和复查，不能为了通过样例绕过证据要求。

### R3 / P1：BoundedJson 错误拒绝合法数据——成立

[`bounded-json.ts`](../packages/codemode/src/bounded-json.ts) 把数字一律按 24 字符计数，又把数组索引当成 JSON 中实际输出的对象键。这不是注释声称的长度下界。

实测 `Array(20000).fill(0)` 的 JSON 长度为 **40,001**，在 **262,144** 字符上限下仍抛出 RangeError。VM 接受这个 store 写入，宿主提交失败，结果同时出现 `[CODEMODE_OK]` 和 `[TOOL_OBSERVATION_FAILED]`，对外 `isError: true`。

数据影响必须区分：

- `CodemodeStore.apply()` 失败回滚到此前快照：探针中旧值 `previous=7` 保留，新数组没有保存。不是每次失败都会清空所有旧数据。
- `restore()` 在校验前先清空对象；探针恢复同样的合法 JSON 快照失败后得到空 store。`_restoreCodemodeStore()` 也会在恢复异常时清空。若会话已有这类快照，重载会丢失恢复结果；普通失败的 apply 本身不会写入这种快照。
- details 共用此计数器，因此也可能被错误判为需要落盘；这是同一根因，而非三个独立算法问题。

修复须统一 VM/Worker/宿主的长度语义，兼顾转义、数组、数字、非 JSON 值、深度与对象规模上限。不能简单取消限额或全量无限制 stringify 后才检查。

### R4 / P1：副作用完成后结果序列化失败，缺少持久结果——成立但需限定

[`runChild`](../packages/coding-agent/src/core/codemode.ts) 先等待 `callTool`，再对变更结果 details 做 1 MiB 有界序列化，成功后才调用 `saveResult`。

受控模拟变更工具返回超过限额的 details，实测：副作用计数 **1**、已存调用记录 **1**、已存结果记录 **0**、父调用失败。该探针证明控制器在面对这种合法工具返回路径时存在缺口；没有声称某次历史真实文件写入已被重复执行或丢失。

审查关于“input 只有事后检查”的说法过宽：[`recordInvocation`](../packages/coding-agent/src/core/codemode.ts) 已在原生变更执行前检查并持久化参数。事后又序列化 input 的开销仍存在，但不能把它描述为完全没有预检。

修复应先保证有界、可持久化的真实执行结果，再生成可选的大详情/恢复内容。详情无法保留时应明确记录“操作已完成，但附加结果处理失败”，维持 `/changes` 的可核查性；不能自动重试变更，也不能把任何序列化失败都改成成功。

### R5 / P1：OAuth 长时间持锁——成立，并发现可覆盖其他条目的竞争

[`login`](../packages/mcp-bridge/src/oauth.js) 在整个交互授权过程中持有凭据文件锁。探针在真实 login 入口中暂停授权，用同一临时文件创建独立的第二个 owner：

1. 登录等待期间立即 read，约 **274 ms** 后收到 ELOCKED。
2. 再等待 **11.5 秒**，登录仍未结束，第二次 read 却成功取得锁。
3. 另一个模拟服务成功保存 `reviewMarker`，磁盘上确认存在。
4. 释放第一次授权等待，login 报告完成，但第二个服务刚保存的条目消失。

根因比审查原文更具体：[`FileAuthStorageBackend`](../packages/coding-agent/src/core/auth-storage.ts) 的异步锁设置 stale=30s，库默认 update=stale/2，即 15s；同步锁未设置 stale，所安装 proper-lockfile 默认 stale=10s。因此在异步锁第一次续期前，同步访问可以把健康锁认作过期。原持有者又在下一次心跳发现竞争之前提交旧快照，覆盖新条目。此参数不一致位于既有通用后端；新增 OAuth 交互持锁放大了触发窗口。

本轮是同进程独立 owner 的受控复现，未运行真实服务浏览器授权或跨进程部署测试。

审查两点需纠正：同步锁有 **10 次、间隔 20ms** 的重试，不是立即失败且完全不重试；30s stale 不是持有锁必然在 30s 到期，库有心跳更新。异步竞争者另有约 30s 获取锁期限，长时间用户交互仍会造成超时。

修复同时处理统一租约参数和缩短交互锁范围：浏览器等待放锁外，提交时重新读取最新文件并校验服务/登录版本后合并；刷新令牌的并发去重及轮换仍需锁。只把整个 transaction 移出去，会引入刷新竞争和 logout 后旧授权回写等新问题。

### R6：要求增加关闭开关——不作为本任务修复

`excludeTools:["codemode"]` 被拒、普通工具通过脚本调用，是用户明确要求“默认采用，不是可选”的策略。`noTools:"all"` 仍支持禁用所有工具，不等于回退原生工具。

小模型适配、脚本 token 和约 40ms 的固定启动成本值得记录和优化；它们不能自行推导出撤回既定产品策略。保留必选入口，优先修复协议提示、组合兼容和性能。本轮没有新增模式开关。

### R7：重复失败文案和收尾调用——前者成立，后者不是重复执行

guardrails 探针实际同时出现 `[CODEMODE_FAILED]`、`[CODEMODE_SCRIPT]` 和 `[NESTED_TOOL_ERRORS]`。合并展示可读性仍有改进空间。

[`agent-loop.ts`](../packages/agent/src/agent-loop.ts) 的重复赋值属于简化候选；[`NestedToolDispatch.close()`](../packages/agent/src/nested-tool-dispatch.ts) 会清空队列和引用，重复调用不重新运行子工具。try/finally 的收尾仍需覆盖异常，不能把“两次 close”认定为“工具执行两次”。

## 官方差异：哪些值得借鉴

对照本地官方 [`codemode.md`](D:/RMProjects/TempPi/pi/packages/coding-agent/docs/codemode.md) 与当前实现：

| 审查建议/判断 | 复核结论 |
| --- | --- |
| 官方返回值都更简单 | 不完全准确。read/edit/write 返回文本；bash 是结构化状态对象；MCP 返回 CallToolResult。可改善脚本易用性，但 Super Pi 的 ref/真实读取凭据仍有用途。 |
| 命名空间预算、描述检索、省略提示 | 值得采用。当前 32K 字符目录预算耗尽后静默省略；ALL_TOOLS/describeTools 仍可检索，不能把“描述没列出”说成“工具不可调用”。 |
| 稳定目录描述 | 值得优化。当前工具集合刷新会重新渲染签名并可能改变描述。是否造成提供方缓存损失及比例，尚未实测。 |
| 没有 exit() | 错误。当前 prelude 已实现；实测 text(before); exit(); text(after) 只输出 before 且成功。工具使用说明中缺少 exit 的提示是另一问题。 |
| 完全没有文档 | 过宽。已有中英文 README、方案及执行记录，但缺少一份像官方一样完整的独立 Codemode 使用文档。 |
| 复制官方 on/only 模式 | 与本任务既定默认策略无必然关系，不作为缺陷修复前提。 |

## 性能建议的采纳边界

以下为完整调用链静态复核结论。本轮没有重跑或新增分配基准，不把“存在额外操作”包装成已测得的性能收益。

- **重复 JSON 处理成立**：变更持久化、结果投影、保留预算统计、Worker 桥接各有序列化/parse。可复用已经验证的编码和长度，但跨信任边界仍需独立验证，且不同阶段的结果未必相同；不能机械压成一次。先修正确性，再用大数字数组、转义字符串、大 details 的 counters 和分配基准验证。
- **子调用闭包成立**：invoke 的两个 then 回调、dispatch 的 Promise executor 为每个子调用分配；父生命周期回调是另一量级。迁移 finally 要保留未 await 调用的追踪及 rejection 观察，避免先完成后入 pending 的竞争。现有“逐进度零闭包”结果并不表示“每次子调用零闭包”。
- **折叠卡片仍计算预览和 label 成立**：可以减少无变化的字符串生成。但若为了延迟计算而保存完整原始结果，会破坏当前有界保留和释放契约。应保持有界最新预览或等价的可靠来源，并测折叠→展开、失败和恢复行为。
- **store 快照与工具签名缓存是候选**：先建立不可变快照/版本及失效规则。工具对象可被扩展更新，仅按对象身份 WeakMap 缓存会有过期风险。setTools 已有相同数组的提前返回，也不是“任何调用都无条件重建”。
- **recordProjection 历史扫描可收敛**：找到全部待读取投影后结束，不应把当前只有一个父项的假设扩散到通用逻辑。
- **正则归并与字符串写法**：新增代码遵守不引入 String 构造、动态 RegExp、bind 的方向。模块常量整合可作为后续整理；三次 replaceAll 对短输入的收益未经测量，不能优先于正确性修复。
- **dist Worker 的 strip-types 参数**：对编译产物冗余，可按入口类型选择；必须保留显式 execArgv/env 边界，不改为继承宿主任意预加载参数。“未来 Node 删除此参数”仅是可能性，没有本轮故障证据。

## 不应根据此次审查直接删除的结构

- tool_search、MCP 搜索、Codemode 枚举分别承担活动集/远端工具/脚本目录职责。可统一对外使用方式，但不能合并时丢失授权、连接与生命周期边界。
- 审查把 boundCodemodeResult 一律写成 32KB/400 行不准确：普通内联内容门限是 128Ki 字符，details 64Ki；32KB/400 行是恢复输出预览选项。父输出预算与模型上下文预算是不同边界。是否发生无意义的重复截断需要用相同大输出端到端测试，而不是先删除任一层保护。
- Evidence Ledger 的收益需要分平台测量。本轮 Windows 的原生对照和 Codemode 对照都是 0 次命中、2 次真实读取，均走既有 `uncertain-identity` 平台回退。这不能证明 Codemode 造成性能退化。源码显示嵌套结果缺少原生协议证据接纳路径，需在支持精确文件身份的平台补测；读写授权窗口已有独立保护用途，不能连带删除。
- browser-use/chrome-devtools、structured_readonly_command 的取舍没有使用数据，本轮不做功能裁撤。

## 执行记录和诊断材料

“所有测试都用了 noExtensions:true，所以完全没测扩展”不准确：若干测试通过 extensionFactories 显式注入 mutation/plan 扩展。但是此前缺少默认扩展包与顺序重复调用的组合测试，这一验收缺口成立。

只读清点得到 37 个 `.tmp-codemode-*.log`，系统临时目录有 12 个 `sp-lsp-scope-*`，其中 3 个创建于 10-03。此前执行记录明确写了一个清理被拒的已知目录及更早失败夹具，没有声称系统只剩一个。因此计数本身基本符合审查，不能仅凭名字/日期认定 12 个都由当前任务产生或一律删除。诊断材料不纳入产品 PR；提交前仍按文件清单选择，不使用笼统暂存。

之前完整测试和性能采样是真实历史结果，但它们的覆盖范围不足以支撑总体完成声明。方案的相关目标重新打开，以本复核为当前状态依据。

## 修复分组及验收目标

这些是本地修改分组，不是已经创建的 PR。现有基线和用户未提交文件保持不动。

| 顺序/分组 | 对应原计划 | 必须满足的验收 |
| --- | --- | --- |
| R-A：工具提示与嵌套去重 | B1/B4 | 模型声明与系统提示一致；无扩展/9 扩展/完整默认配置的顺序与并行调用；已授权 edit→read、test→fix→test；同轮读取仍不授权修改；真正重复副作用及循环保护继续有效。 |
| R-B：序列化、store、变更结果 | B2/B3 | VM/宿主同一合法数据结论一致；JSON 边界与大 details；失败 apply 保留旧值；恢复错误可见；副作用完成后结果处理失败仍有可核查记录；不得出现 OK 摘要掩盖提交失败。 |
| R-C：OAuth 交互及租约 | C2 | 锁外等待、提交时重读并合并；同步/异步统一租约；双 owner 和跨进程慢授权；其他服务条目不丢；刷新只做一次；取消/logout 后无过期授权回写；监听器/锁释放。 |
| R-D：目录与显示性能 | C1/C4/C5 的补充 | 先记录基线；省略工具明确可发现；稳定目录、缓存失效；消除无意义重复失败文案；热路径 AST、确定性计数、分配及引用释放；相同显示内容下比较，不把折叠减少输出误作同工作量加速。 |
| R-E：组合验收与使用文档 | 最终交付 | 完整默认配置启动及脚本行为；类型/构建/全套测试；单独记录 Windows/Linux/最低 Node 的实测范围；复核分组 diff、诊断排除及许可证；通过后停在本地，由用户决定提交/推送/合并。 |

R-A、R-B、R-C 是本地交付前的阻塞问题。R-D 的优化需经过测量，不以拆除正确性边界换取更少代码；任何热路径修改继续执行现有 allocation contract。初次复核时这些修复尚未执行，禁止沿用当时的“可交付”结论。后续当前状态以执行记录为准。

## 授权修复后的复测

原始探针保留在 `codemode-review-probes.json`，相同入口复测另存为 [修复后探针](performance/codemode-review-probes-after.json)。9 组探针均完成，临时工作区清理成功；无扩展、仅 guardrails、9 扩展组合的顺序重复读取均成功，系统工具声明与模型可见目录一致；40,001 字符数字数组可保存与恢复；大详情处理失败的变更仍保留 1 条结果且副作用只执行 1 次；OAuth 等待期间可读写，最终保留其他服务的并发条目。

这些是针对缺陷的前后对照，不替代完整验收。新增完整默认配置、跨进程 OAuth、失败摘要及 JSON 边界回归；性能样本和生命周期计数见 [修复验证数据](performance/codemode-review-repair-validation.json)。Windows 的 Evidence Ledger 仍按既有平台策略回退，没有将零命中描述成已修复或已证明的性能问题。
