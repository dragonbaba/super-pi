本方案建议保留 CodeMode 作为日常编排入口，把当前权限体系收敛为一个明确授权入口和可验证的会话执行边界；将文件正确性、任务生命周期、工具目录、提示词组合和模型请求协调交回原生层，逐步退役承担这些职责的扩展入口。

**当前状态（2026-11-03）：本轮 Windows/Node 整合交付范围已完成。四项剩余任务、P0 真实桌面回放及性能检查均已闭合；结果、支持范围与兼容条件见本文件末尾 §70。以下旧状态均为历史记录。**

**审查基线：** `dragonbaba/super-pi` 的 `main` 提交 `ace4fda133b9c845c790d94013d9f460a2042367`，提交时间 2026-10-19 07:02:02 UTC。权限与原生能力整合部分为源码审查和方案设计。2026-10-19 的图片粘贴追加反馈已形成基于同一提交的本地候选补丁，完成 Linux 环境的离线构建、类型检查和定向回归；尚未完成真实 Windows 桌面验收。文中的“目标”“验收”仍表示计划行为，P0 下另列候选的实际验证结果。

**交付重点：** 先修 CodeMode 数据传输和错误归属，先拆出旧守卫里的正常能力，再替换权限边界。本任务按用户要求逐项实现、审查、记录后继续，不并行展开多个代码项。2026-10-27 根据主流 agent 官方资料复核，修订授权与隔离的关系、批量执行契约及 P3 顺序，依据见第十四节；未验证的方案不视为已实现。

相关既有工作入口：[OS 沙箱与 Windows Job Object 评估 issue #163](https://github.com/dragonbaba/super-pi/issues/163)。

# 一、建议采用的决定

1. **CodeMode 保持日常入口。** 保留现有 JavaScript 编排、工具发现、并发与结果处理；修复和验证源码、字符串参数、shell 输入之间的传输，不引入另一套命令 DSL。

2. **统一授权，停止扩展自制危险行为推断。** 保留明确的 allow/ask/deny 决策、用户拒绝、外部操作范围及调用绑定；删除重复风险扫描和多层 grant 总线。OS 边界限制实际资源访问，不能替代操作授权。已授权且符合当前规则的正常步骤继续执行；不默认给每次调用增加模型审批。

3. **删除默认的行为硬拦截。** 取消上一模型轮必须可见 read 的写入准入、重复失败硬封禁、自然语言“成功”判断及最终回复重写。文件冲突检查、资源上限、取消和真实错误必须保留。

4. **执行环境与审批方式分开。** `sandbox` 使用经过验证的系统边界；`trusted-host` 由用户明确选择宿主执行。是否可以询问、由谁审查另行配置；不询问不等于放行未授权操作，宿主执行也不取消明确拒绝。旧设置不静默扩大权限，沙箱失败不自动切到宿主。

5. **原生能力拥有唯一状态和生命周期。** 常驻协议与公共机制由 host 显式装配，可以继续放在独立包并按需加载。扩展贡献工作流、内容、适配器和界面。

6. **按可独立交付的工作包迁移。** 先让日常调用稳定，再逐入口退役旧权限实现；保留统一授权策略。Provider、Memory、Browser 等整合不拖住前两项。

完成标准是“基础能力脱离外部扩展仍能工作，执行结果可解释，实际边界覆盖所有受支持入口”，不以扩展文件夹减少多少作为成败指标。

# 二、当前装配和耦合

## 默认是 24 个扩展入口

`.sp/config/settings.json` 配置了 14 个包：13 个包各提供一个扩展入口，`@super-pi/extensions` 提供 9 个入口；加上 `.sp/extensions` 中的 `tps.ts` 和 `prompt-url-widget.ts`，源码启动器共显式注入 24 个入口。这是配置的入口数，尚未计入用户自行发现的扩展，也不代表 24 个外部服务都会连接或启动。

证据：[默认配置](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/.sp/config/settings.json)、[源码启动器](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/scripts/superpi.mjs)、[扩展包入口清单](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/package.json)、[两个直接加载的扩展](https://github.com/dragonbaba/super-pi/tree/ace4fda133b9c845c790d94013d9f460a2042367/.sp/extensions)。

## 目前的无扩展开关不能证明基础能力独立

`scripts/superpi.mjs` 将 bundled 项转换为显式 `--extension` 参数；`resource-loader.ts` 在 `noExtensions` 为真时仍保留 `cliEnabledExtensions`。因此，经这个启动器运行 `--no-extensions`，仍可能装上整套内置扩展。

子代理又优先复用 `SP_SOURCE_LAUNCHER`，同时用 `--no-extensions` 等参数构造精简子进程。从静态调用链看，存在“希望精简装配、却被启动器再次注入”的不一致；需要运行验证，不能仅凭源码认定已经发生权限越界。

目标：原生模块直接装配；用户显式 `-e` 和插件发现保持独立语义。提供没有显式插件、没有自动发现插件、没有 inline extension factory 的真正最小启动测试。parent、child、headless 是装配场景，角色只是配置，不能再与权限等级组合出几十套 profile。

证据：[资源加载器](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/core/resource-loader.ts)、[子代理启动与生命周期](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/subagent/index.ts)。

## 几个关键职责已经放错位置

| 当前位置 | 实际承担的基础职责 | 直接删除的影响 |
| - | - | - |
| resource-lifecycle-guard | 权限控制、后台任务、资源清理、`/changes` | 任务和变更能力一起丢失 |
| tool-loop-guardrails | 重注册 `read/bash`、读取快照、安装 Windows MSYS stdin 桥 | 基础工具和平台传输发生变化 |
| mutation-guard-write | 重注册 `edit/write`、delete/move/file_batch、文件提交正确性 | 正常文件操作和冲突保护一起丢失 |
| tool-classification | `tool_search`、工具激活、浏览器授权暂停 | 工具发现和真实连接授权状态一起丢失 |
| dynamic-instructions | 从已生成提示词中寻找字符串片段并替换 | 提示词组合依赖文本格式 |
| 两个压缩扩展与 fast-mode | Provider 注册接管、压缩选择、请求字段和全局状态协调 | 核心请求协议依赖扩展加载顺序 |

证据：[lifecycle guard](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/resource-lifecycle-guard/index.ts)、[loop guard](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/tool-loop-guardrails/index.ts)、[mutation guard](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/mutation-guard-write/index.ts)、[tool classification](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/tool-classification/src/index.ts)、[dynamic instructions](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/dynamic-instructions/src/index.ts)、[server compaction](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/openai-server-compaction/src/index.ts)。

# 三、权限简化后的职责划分

| 层次 | 保留的职责 | 实施方式 |
| - | - | - |
| 提示词与任务上下文 | 用户意图、已授权范围、如何处理预期失败、如实汇报 | 少量稳定规则，已有授权持续有效 |
| 授权策略与决策 | allow/ask/deny、明确拒绝、账户与操作范围、审批方式 | 一个原生 owner；只对缺失的授权询问，最终执行前复核 |
| 会话执行边界 | 可读/可写目录、临时目录、可用网络和连接、运行实例 | 固定的执行上下文，边界变化由会话 owner 处理 |
| 原生工具正确性 | 输入契约、文件冲突、唯一创建、退出码、取消、部分成功 | 工具和执行服务负责，不依赖模型轮次 |
| OS 后端 | 对实际进程及文件访问施加限制 | 复用可验证的系统隔离后端 |
| 可选工作流 | Memory、项目分析、Goal、浏览器自动化、界面 | 调用原生服务，按需启用 |

内部复用现有 `shellExecution`、后台任务、ManagedTaskProvider、scheduler、文件提交 receipt 等能力，先统一 owner。不要再给 shell、argv、subagent 各造任务表，也不要把旧 permission controller 原封不动改名为 ExecutionContext。

## 两种执行环境

**sandbox：** 会话启动时确定项目目录、只读工具链目录、会话临时目录及网络范围；通过授权策略的操作在这个范围内执行。实际访问超出边界时返回结构化拒绝，可在用户明确扩展范围后建立新的执行上下文。目录可写或网络可达不代表其中每项操作均已获准；显式 ask/deny 继续生效。

**trusted-host：** 用户明确选用当前账户的宿主执行环境，适合需要原生宿主集成的任务。它没有 OS 沙箱隔离承诺，仍遵守同一个授权策略。不维护另一套宿主风险扫描器，不会因 TLS 错误、脚本失败或沙箱安装失败而自动启用。

新默认切换的前提是目标平台后端及执行入口覆盖通过验收。旧 `full-access`、`never-ask` 的现有含义不等于无约束宿主执行，兼容层不能仅凭名称自动扩大边界。对无法等价映射的历史配置，在明确选择新 profile 前保持原有路径；为兼容入口设定一个有结束条件的发布窗口，避免长期双引擎。

同一次调用只有一个授权决策 owner，随后由实际后端强制执行资源边界；两者职责不同。迁移中的旧 controller 可以作为该入口的兼容实现，不能与新策略重复审批。无交互模式遇到尚需询问的操作时返回明确的未执行原因，不弹出隐形确认，不自动尝试宿主重跑。

## 授权复用与复合命令

固定请求绑定最终工具实现、规范化参数、cwd、会话与策略/边界版本；批量请求还绑定有序子项。执行前复核撤销和工具替换，失效后释放引用。保留这种必要绑定，删除重复包装与逐层转签；不能因为删除旧 grant 总线就删除版本、单次消费及防止输入替换的检查。

用户可明确授予一次操作或有范围的会话能力；复用只覆盖相同或更窄范围，并在模式、账户或策略变化时重新判定。配置中的硬性 deny 不由一次审批覆盖；用户改变规则是独立的显式操作。需要 ask 时展示具体目标、动作和范围；已有匹配授权不重复询问，但不能覆盖明确要求每次确认的规则。可选自动审查只接管需要审批的请求，设截止时间与取消；不可用或拒绝不转为自动允许，也不作为默认逐调用热路径。

命令规则只用经过验证的语法解析与明确匹配，不扩张成通用 Shell/PowerShell 解释器。可可靠拆解的复合命令逐段检查，最严格的匹配结果生效；带有无法可靠解析的展开、重定向或控制流时按完整调用处理，不能用第一段或解释器前缀的授权放行整段脚本。完整调用仍可凭已有明确范围执行；无法证明匹配范围时才询问或拒绝。命令规则不声称能识别任意脚本及其依赖的全部副作用，硬性资源限制仍由后端承担。

## 运行中的边界变化

执行上下文和最终规范化参数保持不可变，并绑定会话、cwd 与上下文版本。排队期间上下文被撤销，旧调用不得继续执行。切入更窄边界、进入受限 Plan 或切换后端时：停止新任务，取消并等待旧实例及其后代收尾，记录已完成/部分完成/未知状态，再启动新实例。

历史任务可以查看，不能在恢复会话时重放写入或恢复过期授权。第一版不做跨后端原地修改运行中进程权限。

现有配置与授权实现依据：[permission-controller.ts](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/resource-lifecycle-guard/permission-controller.ts)、[permission-contract.ts](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/resource-lifecycle-guard/permission-contract.ts)。

# 四、明确删除什么，保留什么

| 当前机制 | 目标处理 | 替代或保留能力 |
| - | - | - |
| 自制 Shell/PowerShell 危险片段推断、多层授权 grant | 等价授权入口与执行边界覆盖后逐入口删除 | 明确命令规则、allow/ask/deny、不可变调用绑定、版本复核及 OS 边界 |
| 上一模型轮必须展示 read 才能 edit/write | 删除 | 文件 revision/快照与提交时冲突检查 |
| 每轮 24 次变更、16 个文件等模型行为预算 | 取消默认准入用途 | 保留有依据的单次资源、输出、队列、时限约束 |
| 多次相同失败后硬封禁 | 删除默认封禁 | 可选提示与可配置任务预算 |
| 最终回复“成功”关键词扫描与重写 | 删除 | 工具和任务的结构化事实 |
| `show(ref)` 或读取结果是否展示作为权限凭据 | 删除该角色 | 展示继续服务于可观测性 |
| 文件唯一匹配、独占创建、目标身份与版本复核 | 保留并原生化 | 防止误覆盖和错误补丁 |
| 后台任务、取消、进程树清理、changes | 保留并原生化 | 单一 TaskManager 与文件结果记录 |
| 用户拒绝、外部连接授权、账户作用域 | 保留真实状态 | 显式类型字段，不通过错误字符串猜测 |
| Provider 认证一致性、OAuth 校验、压缩连续性 | 保留 | 这是协议正确性与真实账户边界 |

删除旧规则时，旧测试中专门要求该规则存在的断言应同步删除或改写。不能为了让旧测试全绿又把上一轮 read、自制危险语法分类或最终回复重写搬进原生层；明确拒绝、复合命令匹配、撤销与调用绑定的测试继续保留。

证据：[read 证据准入](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/mutation-guard-write/index.ts)、[每轮变更预算](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/mutation-guard-write/core.ts)、[重复失败拦截](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/tool-loop-guardrails/core.ts)、[自然语言成功检查](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/false-success-guard/core.ts)、[浏览器连接暂停状态](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/tool-classification/src/index.ts)。

# 五、CodeMode 与执行问题单独修复

CodeMode 保留当前职责：运行 JavaScript、调用工具、组合结果。不要增加正则补括号、自动改写引号、自动展开反斜线或猜测 shell 的修复器。解析错误应回到明确的源码位置和输入层。

## 这批日志能说明什么

| 日志现象 | 当前可判断的层次 | 修复或验证重点 |
| - | - | - |
| `0 child calls`、`expected '}' after template expression` | JS 解析阶段失败，未产生子调用 | 原始源码、行列映射、错误片段；不归类为权限拒绝 |
| Python 引号未终止、`unexpected character after line continuation character` | 到达 Python 的脚本文本不合法；具体由生成还是传输造成尚需对照 | 比对求值后的参数与进程真实 stdin/argv |
| GBK 无法编码泰文字符 | Python 输出编码 | 自动化子进程的 UTF-8 约定、解码及原始错误保留 |
| `/tmp/server.xml` 不存在 | 下载结果或跨环境路径映射 | 同一执行环境的临时路径，下载完成后再消费文件 |
| `IndexError` | 分析脚本边界条件 | 修脚本，不触发权限升级流程 |
| curl empty reply、Schannel TLS 失败 | 网络或 TLS 运行错误，来源尚未确定 | 保留完整 stderr、退出码及实际客户端环境 |
| 只显示 `=== DNS` 或一条 404 后标红 | 可能只是错误预览选了第一行 | 区分显示摘要、完整输出、退出码、是否真的提前停止 |

现有代码未支持“CodeMode 总会把所有换行改成字面 `\n`”这一断言。传输需要拿原文、求值后字符串和实际进程输入做对照，定位具体发生变化的位置。CodeMode 已有 `allowFailure`，目标是保留其预期失败语义，而不是遇到所有非零退出都取消整个探索流程。

## 第一批应交付的执行契约

内部统一使用 executable、argv 或原始 shell 脚本、stdin、cwd、env、deadline、task owner 等明确字段。复杂 Python/PowerShell 内容允许通过真实 stdin 或临时脚本文件交给解释器，临时文件的创建、路径与清理由执行服务负责。现有模型工具名和 CodeMode API 尽量兼容。

Windows Git Bash/PowerShell 的选择、MSYS stdin 桥、中文路径、LF/CRLF、UTF-8 输出进入平台执行层，不再靠 guard 扩展顺便启用。环境变量只传任务需要的集合；运行时凭据留在负责相应请求的组件。

结果区分：解析失败、尚未启动的边界拒绝、启动失败、普通非零退出、超时、取消、结果处理失败。返回真实退出状态、输出是否截断、任务 ID 和部分结果。普通 HTTP/TLS/Python 错误不自动变成“需要授权”。

显式 `background: true` 的 CodeMode 调用纳入原生任务目标。运行中的前台任务转后台应保持进程、原截止时间和唯一完成事件；当前实现对 nested CodeMode 的转后台有限制，第一阶段先保留原有适用范围，若扩展到正在等待的 CodeMode 子调用，单独验证 worker 等待和完成归属协议。

证据：[CodeMode 源码入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/codemode/src/source.ts)、[JavaScript 求值](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/codemode/src/runtime/worker.ts)、[子调用与失败归集](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/core/codemode.ts)、[allowFailure 契约](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/core/codemode-constants.ts)、[bash 结果预览](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/core/tools/bash.ts)、[MSYS 桥启用入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/tool-loop-guardrails/msys-bash.ts)、[后台执行限制](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/resource-lifecycle-guard/background-shell.ts)。

## 批量执行的三个契约

| 入口 | 调度与授权 | 结果与恢复 |
| - | - | - |
| CodeMode 多次 callTool | 独立且由 host 确认可并行的读取有界并发；修改、交互和依赖步骤顺序执行；每个实际子调用经过同一授权入口 | 保留子调用真实状态；父调用取消传递到子调用与任务，有限等待后仍未结束的操作标为未知/可能仍执行 |
| file_batch | 复用现有最多 16 项、1 MiB 输入与一个文件队列；全项准备/复核，依次提交，首个失败或取消后停止 | 已完成、失败、未知、未开始逐项记账；不宣称跨文件原子事务，不自动整批重放 |
| shell 管道或脚本 | 作为一个真实进程调用，规则可解析时逐段判定；运行顺序与退出语义由所选 shell 决定 | 返回真实进程退出码及输出；没有独立观测就不伪造每条语句的成功 receipt，不擅自改写脚本增加重试 |

静态、已固定的多个操作可以合并一次授权展示，但批准范围仍是具体子项与资源；混合允许/询问/拒绝的项目分别保留决策。只有被批准的子项可继续，依赖被拒绝项的后续步骤不得运行。file_batch 的准备阶段存在未批准项时整批不提交；CodeMode 是否继续独立项由显式编排与返回状态决定。动态代码不能事先列出全部调用，按实际调用时复用已有范围，不能通过批准脚本获得任意未来工具的权限。

保留当前 `allowFailure` 对真实执行错误和准入拒绝的可观察返回：脚本可查看拒绝并选择已获准的替代步骤；它不授予权限、不改变子项 isError/未执行事实，也不允许绕过拒绝重试。取消、超时、观察失败及普通失败须可区分，不把部分执行报告为整批成功。恢复只读取历史事实，不重放已经提交的写入。

复用 `NestedToolDispatch` 当前的 4 个并发读取、256 次子调用和 5 秒取消收尾期限；并发资格由实际工具契约与 host 决定，插件的只读提示不构成安全证明。保留现有队列，不新增工作流 DSL、DAG 调度器或无界 Promise.all。输出在工具端限额并按需引用，取消收尾到期不等于后端进程已停止，权限收窄仍需真实退出证据。

# 六、文件正确性与 changes

同一段 CodeMode 应可以完成 read → 计算 → edit，只要修改前置条件仍然成立；是否跨过模型轮次、是否向用户展示过读取结果，都不决定能否写入。

复用现有提交机制，保留必要的目标身份、父目录和版本复核，以及每次操作的结果记录。同进程队列只能协调自己的调用，不能阻止外部编辑器或另一个进程修改文件；不得把“先 hash，再普通 writeFile”描述为全局无竞态 CAS。对当前平台实际能保证的原子提交范围写明契约。

创建、修改、覆盖应有清楚的工具语义：创建要求目标仍不存在；基于读取内容修改需要有效 revision；整文件替换遵守明确的覆盖契约。保留编码、换行与必要元数据，move 默认不覆盖，delete 继续保持现有单文件/空目录范围，不趁迁移扩大为递归删除。

批量操作和取消不能抹掉已经发生的变更。每项返回未执行、完成、失败或未知；出现部分成功时不自动整批重跑。changes 展示能确认的文件操作事实与来源，不能宣称所有任意 bash 修改都可追踪或可撤销。

OS 沙箱限制可访问范围，不阻止一个已获写权限的进程破坏范围内文件。原生文件工具的窄契约与已有 Git/恢复手段仍有价值，但不再把模型上一轮 read 当作安全边界。

实施时立即停止旧扩展对相同 read/edit/write/bash 的重复注册，或将旧入口改为纯委托。默认安装和零外部扩展安装都验证实际 tool owner，防止旧扩展覆盖新实现。

证据：[edit/write 包装](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/mutation-guard-write/index.ts)、[delete/move](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/mutation-guard-write/native-tools.ts)、[批量变更与授权依赖](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/mutation-guard-write/file-batch.ts)、[changes 装配](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/resource-lifecycle-guard/index.ts)。

# 七、系统沙箱的最小实施范围

以 issue #163 为独立验证入口。先统一授权与执行契约，再核对受维护后端的可嵌入接口、平台要求及能力缺口，固定候选版本后验证一个主要平台；不因一个候选不合适立即转向自研完整隔离平台。用户当前日志来自 Windows，第一轮应验证原生 Windows，不以 Linux 或 WSL 成功代替。

| 候选或机制 | 在方案中的定位 |
| - | - |
| Anthropic sandbox-runtime | 已固定 0.0.81 的 Windows Alpha 候选并审查；上游已知限制不满足本方案默认接入要求，见 P3.1。不据此推断其他后端均不可用 |
| Microsoft MXC | 已核对稳定版 1.0.1、MIT 许可及 1.0.0 策略契约；P3.4 选择微软独立执行器进入验证，官方 Node SDK 保留为后续候选，比较与能力矩阵见第十五节；尚未开放 Super Pi 执行入口 |
| Codex 当前 Windows 后端 | 本机升级后已通过 Codex 的 MXC 启动检查；仅作为系统条件的旁证，不依赖 Codex 私有安装路径，也不替代 Super Pi 验收 |
| Windows Job Object | 用于进程归属、资源控制和进程树取消；单独使用不构成完整文件与网络隔离 |
| WSL | 可选 Linux 开发环境；微软明确说明 WSL 发行版本身不是与 Windows 宿主之间的安全边界 |

官方依据：[sandbox-runtime 平台与 Windows 说明](https://github.com/anthropics/sandbox-runtime#windows-alpha)、[Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[WSL security model](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/security.md)。

## Windows 验证清单

覆盖用户实际场景：中文目录和文件名、Python UTF-8、多行脚本、Git Bash 与 PowerShell、Git/Node/npm/Java 工具访问、正常 HTTPS 下载、超时和进程树取消。验证两个并发会话、权限撤销及崩溃恢复后仍符合各自声明的边界。TLS 错误单独诊断，不以关闭验证作为默认修复；现有日志不能证明由任何候选沙箱造成。

先做一个可替换的小后端接口，不同时自研多平台隔离实现，不额外建设 Shell 解释器、风险评分模型或通用工作流引擎。P3.2 AppContainer 原型已判定不通过，不作为默认后端路线或其他契约工作的前置条件。沙箱暂未通过时可以继续交付传输、文件和任务修复；不切换现有默认保护语义。

## 所有开放入口必须覆盖，按能力分期接入

先验收 native files、shell/argv 与其子进程，再接长期服务。某入口未覆盖时，sandbox 下必须在副作用发生前拒绝，并明确标为不支持；只有用户明确选择的 trusted-host 路径可使用该宿主能力。默认切换只针对已验收的入口集合，不让未迁移 LSP/MCP/Browser 留下宿主旁路，也不把全部生态接入作为第一轮后端实验的前置条件。

| 入口 | 需要接管的实际副作用 |
| - | - |
| native read/write/edit/delete/move/batch | 在受限文件 worker 中执行，复用文件提交机制；host 不留任意写入旁路 |
| bash / PowerShell / argv | 通过同一后端启动进程，继承上下文与任务 owner |
| subagent | 继承能力边界，子进程和子任务可以收尾，不能由 launcher 重新扩大组件集合 |
| LSP | server 的实际进程归属，以及 `lsp_fix` 的宿主直接写文件路径 |
| 本地 MCP | server 在对应受限实例中启动；既有宿主服务不能仅附加 sandboxId 就视为已隔离 |
| Browser Harness / Chrome | 新启动进程的归属；既有浏览器和远端连接另有明确连接契约 |

本地长期服务应选择绑定对应实例、使用经过验证的受限接口，或明确归入 trusted-host 能力，避免每次调用盲目重启所有服务。

宿主中加载的第三方 Node 扩展仍是受信任宿主代码。第一阶段迁移受支持的第一方执行入口，不承诺所有任意插件自动进入沙箱，也不同时建设完整第三方插件隔离平台。

证据：[LSP 直接写入](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/lsp/src/runner.ts)、[LSP server 启动](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/lsp/src/lsp-client.ts)、[Browser Harness 启动](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/browser-use/runner.ts)、[Chrome 启动](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/chrome-devtools/src/browser-manager.ts)。

# 八、Plan 与外部操作

Plan 状态、完成/提问协议、有效工具集合应由原生层拥有。Plan 的命令规则转由统一授权入口管理，等价覆盖后删除 plan-mode 自己维护的白名单与分析器。更宽松模式中的授权不能直接带入更严格 Plan；只隐藏写工具不构成只读边界。

受限 Plan 会话可以将工作区设为只读、会话临时目录可写，允许准备分析脚本；该边界必须覆盖 CodeMode、文件、命令、子代理和实际本地服务。进入 Plan 前要等待旧写入能力的任务结束，而不是只改变工具列表。

文件只读不等于远端只读。联网程序、MCP 和浏览器可能修改外部状态；工具可见性、插件自报 readOnlyHint 和自然语言描述都不是独立授权。对有明确只读协议的连接按其能力开放；未知副作用的远端工具不因本地文件只读而获准执行。需要硬性只读 Plan 时，任意联网执行必须使用相应受限连接或关闭这条能力。

trusted-host 若不能提供实际只读执行边界，就只提供明确标注的 Plan 工作流约束；需要硬边界时进入经过验证的受限会话。不能为了维持只读名称偷偷恢复 Shell 黑名单。

外部操作沿用用户实际任务授权及账户作用域。浏览器真正的 `user_denied`、`authorization_required`、`disconnected`、`timeout` 分开表示；显式拒绝继续有效，普通异常不升级成权限请求。工具被搜索、发现或激活都不增加授权。

证据：[Plan 模式独立拦截](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/plan-mode/src/plan-mode.ts)、[Plan 命令规则](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/plan-mode/src/tool-policy.ts)、[工具激活与浏览器暂停](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/tool-classification/src/index.ts)、[按工具名推测 Plan 状态](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/chrome-devtools/src/active-tool-policy.ts)。

# 九、24 个默认扩展入口的逐项去向

以下“原生”表示 host 明确拥有状态和生命周期，不等于全部搬进 AgentSession、不等于所有能力开机运行。包可以继续存在，纯兼容入口也可短期保留。

## A 先拆出基础能力，再退役旧守卫

| 扩展入口 | 目标归属 | 应留下与应删除的部分 | 源码 |
| - | - | - | - |
| resource-lifecycle-guard | 授权入口、任务/资源生命周期原生 | 留明确规则、后台任务、owner、取消、changes 与调用绑定；等价覆盖后删自制危险推断和旧 grant 总线 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/resource-lifecycle-guard/index.ts) |
| mutation-guard-write | 文件工具正确性原生 | 留 edit/write/delete/move/batch 与提交事实；删上一模型轮可见 read 准入及模型轮次预算 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/mutation-guard-write/index.ts) |
| tool-loop-guardrails | 基础工具和平台桥原生 | 留 read/bash、快照与 Windows 传输；删默认重复失败硬封禁，提示策略可选 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/tool-loop-guardrails/index.ts) |
| false-success-guard | 退役默认扩展 | 真实任务/工具结果进入原生状态；删自然语言成功扫描与最终回复替换 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/false-success-guard/index.ts) |
| structured-readonly-command | argv 执行机制原生 | cwd/argv/env/输出上限由执行层管理；rg/git 便利工具按需要保留，旧名称可作兼容别名 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/structured-readonly-command/index.ts) |
| tool-classification | 工具目录、发现和激活原生 | 统一工具元数据与有效集合；分类别名为数据，浏览器真实授权暂停转移到连接状态 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/tool-classification/src/index.ts) |

优先级：前五项属于权限简化主线；tool-classification 属于后续公共机制整合。迁移一个 owner 就同步停止旧入口的重复注册，本任务不并行展开不同代码项。

## B 模型、提示词与工具协议进入原生层

| 扩展入口 | 目标归属 | 迁移范围与边界 | 源码 |
| - | - | - | - |
| dynamic-instructions | 原生 PromptComposer | 用有 source/version 的提示词段落组合替代对最终字符串的查找与裁剪；扩展仍能贡献内容 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/dynamic-instructions/src/index.ts) |
| openai-server-compaction | 原生 compaction coordinator 与 Provider 适配器 | 去掉扩展重注册 OpenAI Provider 和跨包全局 Symbol 协议；保留 Provider 特定压缩实现 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/openai-server-compaction/src/index.ts) |
| provider-aware-compaction | 原生统一选择入口，策略配置化 | 压缩生命周期统一；特定代理商、模型名称和跨 Provider 摘要选择仍为显式配置 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/provider-aware-compaction/src/index.ts) |
| openai-fast-mode | 原生请求选项 | serviceTier 与会话/请求状态归一；`/fast` 可留薄 UI，复用同一请求快照 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/openai-fast-mode/src/index.ts) |
| mcp-bridge | 原生 MCP runtime，server 适配可选 | 注册/发现/激活、恢复、取消统一；server 配置、认证和 transport 按需启用 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/mcp-bridge/src/index.js) |
| lsp | 内置、可禁用且按需启动 | client/pool/诊断/导航及修复接入原生执行与文件服务；语言 server 配置仍可扩展 | [工具与生命周期](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/lsp/src/pi-lsp.ts) |

工具搜索、MCP 搜索和 CodeMode describeTools 应共享一个目录，避免分别维护激活集合。发现与激活不会提升执行权限。MCP OAuth、认证账户和取消校验继续保留。

Provider 请求、serviceTier、认证账户、压缩、transport continuation 使用同一明确快照；压缩不能无意改变账户或将会话发给另一个 Provider。当前代码中的自定义 provider/model 分支不应变成所有用户的固定默认政策。

这些包的源代码可以继续独立维护；原生化的变化是“由谁装配、谁持有状态、走哪个稳定契约”。

## C 会话和附件拆成原生机制与可选工作流

| 扩展入口 | 进入原生层 | 继续配置化或扩展化 | 源码 |
| - | - | - | - |
| subagent | 子任务调度、会话/进程 owner、wait/cancel、能力继承、完成通知 | planner/reviewer/scout/worker 等角色、提示词和调用链 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/subagent/index.ts) |
| session-memory-manager | 活跃会话 lease、删除/回收生命周期与薄管理界面 | Memory/Hermes 搜索索引同步适配 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/session-memory-manager/index.ts) |
| plan-mode | 模式状态、有效工具投影、提问/完成协议、受限执行上下文 | 计划文案、模板、保存与导出工作流 | [实现](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/plan-mode/src/plan-mode.ts) |
| auxiliary-vision | 粘贴与附件草稿已在原生层，先修现有输入链；继续收敛遗留附件桥接与生命周期 | 辅助视觉模型、inspect_image 策略、图片转描述选择 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/auxiliary-vision/index.ts) |

subagent 与 subagent_tasks 当前是 `modelOnly` 的长任务控制工具，这与日常使用 CodeMode 可以共存；不要为统一外观把长任务强塞进短时 worker 等待。

附件迁移保留旧会话读取及失败重试。具备图像输入能力的模型不因本次整合被强制额外调用辅助视觉模型。

会话本体的存储与回收不应反向依赖可选 Memory 索引是否安装；派生索引跟随会话事件更新。

## D 继续保留可选扩展定位

| 扩展入口 | 保留理由 | 需要减少的基础设施重复 | 源码 |
| - | - | - | - |
| memory | 长期记忆内容、检索、复核与整理是可选产品策略 | 消费原生会话与提示词契约；Markdown 保持真源，SQLite 搜索索引是派生数据，不新增常驻后台整理 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/memory/src/index.ts) |
| project-context | `/project-init`、refresh、codegraph 是显式项目工作流 | 扫描按需运行，任务与上下文贡献使用原生服务，不强制启动全仓扫描 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/project-context/src/index.js) |
| goal | 目标、预算、自动继续、完成/阻塞语义属于自主工作流 | 复用原生 continuation、abort 和完成事件，不新造通用工作流引擎 | [组合入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/goal/src/goal.ts) |
| browser-use | Browser Harness/Python 执行是可选浏览器适配 | 去掉对权限扩展内部契约的直接依赖，执行与连接状态交给公共机制 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/extensions/browser-use/index.ts) |
| chrome-devtools | CDP 调试与浏览器管理是可选适配 | 进程清理、连接状态和工具投影复用原生服务，不通过工具名称猜 Plan 状态 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/chrome-devtools/src/index.ts) |
| statusline | 布局、主题、图标、Git 与时钟展示属于界面 | 核心提供可靠状态快照和渲染生命周期 | [实现](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/statusline/src/statusline.ts) |
| tps.ts | 吞吐统计展示属于可选界面 | 消费准确的原生 usage/时序数据 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/.sp/extensions/tps.ts) |
| prompt-url-widget.ts | PR/GitHub 链接提醒属于可选辅助界面 | 使用原生会话事件即可 | [入口](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/.sp/extensions/prompt-url-widget.ts) |

Browser Harness 与 CDP 的实现方式和功能范围不同，本次证据不足以认定二者重复，应保留按需选择。保留为扩展不表示继续保留重复任务表、权限控制器或提示词拼接器。

清单合计：6 个基础/守卫入口、6 个协议入口、4 个会话/附件入口、8 个可选工作流或 UI，共 24 个。前 16 个需要原生化、拆分或退役入口；后 8 个保留扩展定位。

## 不应误列为扩展迁移的包

`packages/telemetry` 已是独立原生契约库；`packages/session-backends/sqlite-node` 已是可选 SessionRepo 后端，二者没有 `pi.extensions` 入口。后者与 Memory 的 better-sqlite3/FTS 派生索引不是同一个东西，打包包含也不等于默认启用。

证据：[telemetry manifest](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/telemetry/package.json)、[SessionRepo adapter manifest](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/session-backends/sqlite-node/package.json)、[Memory 数据与生命周期约定](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/memory/AGENTS.md)。

# 十、按交付包推进

按下面顺序拆成可审查的小变更；本任务只暂存已经审查通过的内容，未经用户明确授权不提交、推送或创建 PR。每项实现、定向验证、审查、记录通过后才开始下一项，持续保持 CodeMode 可用。

| 工作包 | 主要变更 | 依赖 | 完成后用户能得到什么 |
| - | - | - | - |
| P0 执行与图片输入修复 | 修 CodeMode/Windows 传输、输出归集与 allowFailure；排查 Ctrl+V/Alt+V 仅显示 `-` 的图片粘贴回归 | 无 | 日常调用和截图粘贴先恢复可诊断、可重试；不必等待架构搬家 |
| P1 原生装配与任务 owner | 分开 bundled 与用户扩展，明确 parent/child/headless；接管平台桥、shell/后台任务生命周期 | P0 代码审查通过；桌面验收按用户要求待办 | 真正零外部扩展下仍有基础工具、CodeMode、任务等待与取消 |
| P2 文件正确性与变更 | 原生 file service、revision、delete/move/batch 与 changes；旧包装改纯委托 | P1 的 owner 边界 | 同脚本 read/edit 可行，冲突与部分成功仍准确 |
| P3 统一授权与执行边界 | 先收敛调用绑定、授权复用与批量契约，再选后端；验收 files/shell/子进程，未覆盖服务显式禁用，详见第十四节 | P1/P2；每个子项独立审查；默认 sandbox 需实际验收 | 已授权操作少重复确认，拒绝原因明确，执行环境与审批方式分离 |
| P4 退役旧实现与默认行为策略 | 先移除重复失败硬封禁/成功重写；再按入口等价覆盖情况退役旧 controller、危险推断与 grant 总线，清理旧提示词和测试 | 用户已特许提前处理两项行为策略，见第十六节；其余仍在 P3 后。移除访问控制须替代授权及实际边界均已成立，或明确的 trusted-host 选择 | 保留明确规则与必要调用绑定，没有旧守卫重复覆盖原生工具 |
| P5 工具目录和提示词组合 | 统一 tool_search/MCP discovery/effective activation；显式模式状态；结构化 prompt segments | 按序在 P4 后 | 插件不再互猜工具名、覆写完整提示词或争抢激活集合 |
| P6 Provider 请求与压缩 | 合并 compaction owner、serviceTier、认证与连续性快照，配置化特定 provider 规则 | 不阻塞 P0 至 P4 | 模型协议不依赖三个扩展的加载顺序和全局 Symbol |
| P7 剩余机制整合与收尾 | 子任务/会话 lease/附件生命周期、MCP/LSP 原生入口、兼容 shim 删除 | 按各模块稳定契约逐个迁移 | 可选扩展只留下各自工作流和适配逻辑 |

## P0 图片粘贴回归

2026-10-19 现场反馈已补充：使用最新分支构建的离线版本，直接运行 `superpi`；Ctrl+V / Alt+V 曾显示 `[图片 1 · 截图.png · 正在添加]`，随后附件消失并变为 `-`，重复尝试仍失败。“正在添加”确认图片粘贴 handler 已进入，但该记录在读取剪贴板前创建，不能据此推断图片字节已读取成功。现场具体图片格式及 `-` 的来源仍需 Windows 回放确认。

**原生职责：** CustomEditor 将图片快捷键交给 handleClipboardPaste，先在 ImageAttachmentDraft 中创建“正在添加”记录，再读取、验证图片。正常标签是“正在添加”“已粘贴 · 未发送”或带原因的失败状态，没有单个 `-` 图片占位。现有异常分支已经能保留失败附件并阻止提交，本次候选无需重写 TUI 状态机。辅助视觉在发送阶段为文本模型转换图片，基本粘贴不依赖该扩展；本项不等待 P7。

**已确认的错误分类缺口：** Windows PowerShell 的普通读取异常会被转成 null；原生 helper 在 hasImage() 为 true 后，读出空数据也可能成为 null。上层随后删除准备中的附件并读取文本，因而存在“图片读取失败落入文字粘贴”的代码路径。这能解释反馈现象，但还不能证明现场两种 reader 各自失败的原因。基线证据：[clipboard-image.ts](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/utils/clipboard-image.ts)、[clipboard-native-process.ts](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/utils/clipboard-native-process.ts)。

**候选行为：** 确认图片存在后的读取失败使用专门的 ClipboardImageReadError；另一个图片后端仍可补救成功，补救无结果时必须保留图片失败。PowerShell 除 Bitmap 自动转换外，还读取 PNG / image/png stream，并沿用像素与字节限制。取消、超限、原生进程停止失败继续优先终止。普通无图文本（包括真正的 `-`）保持可粘贴；未确认有图时的可选 helper 不可用仍保留既有兼容路径。

**离线构建已核实：** `build:offline` 生成 Node 运行的 dist；根 `superpi` bin 经 scripts/superpi.mjs 加载 coding-agent/dist/cli.js。离线构建不等于 Bun 独立 exe，本轮不能以编译运行时限制解释现场问题。Windows DataObject 中 UnicodeText 与 FileDrop 的既有文字优先规则仍保留，避免修截图时改变普通文件/文本粘贴。

**失败证据：** PowerShell 使用专用退出码及 stderr 首行固定 marker，保留“已探测到图片后发生错误或超时”的信息；父进程保留原始错误 cause 和受限错误摘要。marker 不进入成功图片输出，也不以错误正文中的自然语言猜测图片存在。真实回放若仍失败，继续核查剪贴板格式、后端错误和附件最终状态，不以屏蔽 `-` 代替修复。

### 图片候选补丁与验证

交付文件：`super-pi-clipboard-fix.patch`。基线为 `ace4fda133b9c845c790d94013d9f460a2042367`，只改两个生产读取模块及三份测试/fixture 文件。候选已完成本地验证，尚未发布到用户的 Windows 安装。

| 验证 | 实际结果 |
| - | - |
| `npm run build:offline` | 通过 |
| `npm run check` | 通过 |
| 剪贴板与控制流程定向回归（2 个文件） | 37 通过，0 失败，8 个 Windows 专属跳过 |
| 完整图片占位输入测试 | 37 通过，0 失败，14 个 Windows 专属跳过 |
| 新增 25 个回归用例 | 21 个在 Linux 通过；4 个真实 Windows Forms 用例待 Windows 执行 |
| 补丁对干净基线的 `git apply --check --cached` | 通过 |

回归覆盖 Alt+V / Ctrl+V、辅助视觉开关、失败附件保留、Enter 阻止误提交、普通 `-` 文本、第二图片后端补救，以及取消/超限优先级。新增 Windows fixture 在私有 DataObject 中组合 PNG 或 image/png stream 与 UnicodeText `-`，分别验证有效图片和损坏图片，不访问真实系统剪贴板。

验收仍须在 Windows 上重新构建并从用户实际的 `superpi` 入口运行：有效截图从“正在添加”转到“已粘贴 · 未发送”；损坏/读取失败保留失败附件与原因；普通文字正常粘贴。模拟 helper 与内存 Forms fixture 均不能替代真实终端和截图工具回放。

实际回放使用 [现有 Windows 图片输入验收脚本](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/scripts/acceptance/windows-image-input.mjs) 的交互模式；其 --check 只覆盖 SDK 传图，--startup-check 只覆盖启动，都不能证明真实按键或剪贴板通过。先验证截图直接进入附件，再验证发送图片；模拟 helper 输出的单元测试不替代真实 Windows 回放。

源码：[快捷键](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/modes/interactive/components/custom-editor.ts)、[粘贴与文本回退](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/modes/interactive/interactive-mode.ts)、[附件状态](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/core/image-attachments.ts)、[读图后端](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/utils/clipboard-image.ts)、[原生 helper](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/utils/clipboard-native-process.ts)、[文本与 FileDrop](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/utils/clipboard.ts)、[模拟输入测试](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/tests/image-placeholder-input.test.ts)。

第一阶段只把 LSP/MCP 的实际执行入口接到统一边界，不要求先完成它们全部原生化。Plan 的真实状态与能力控制必须跟随执行边界，UI、模板和完整工具目录整合可以稍后完成。

## P4 删除检查表

P4 分两个可审查子项：先处理重复失败硬封禁与自然语言成功重写，不连带移除访问控制；再逐入口核对 edit/write、delete/move、file_batch、structured argv、后台任务、changes、subagent、Browser Harness 的旧 grant 消费者。只有新授权入口及执行边界已覆盖，才删除对应旧 controller、推断器、事件与全局状态。全部消费者迁完后才删除共享 permission-contract；保留原生调用绑定及撤销。Plan 复用统一规则，未覆盖入口在 sandbox 下保持不可执行。

拆掉 lifecycle guard 前确认任务仍有唯一 owner；拆掉 loop guard 前确认 Windows 桥已原生启用；拆掉 mutation guard 前确认实际文件提交实现没有退化。每次接管即关闭对应旧注册，不同时运行两套 owner。

## 配置与回滚

为旧设置提供明确、可移除的迁移兼容层；不能把旧 full-access/never-ask 自动变为无限制 host。执行 profile 与会话数据版本分开：回滚实现可以恢复旧入口，但不重放旧写入或复活过期授权。保留原会话历史与变更记录。

在新路径通过验收前不切默认。某个平台后端未通过只阻止该平台默认 sandbox 切换，不阻止发布 P0/P1/P2 或已明确选用的 trusted-host 路径。兼容窗口结束后删除旧引擎和废弃断言，避免无限期维护双轨。

实施入口优先复用 [现有服务装配](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/core/agent-session-services.ts)、[shell execution](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/core/tools/shell-execution.ts)、[基础工具注册](https://github.com/dragonbaba/super-pi/blob/ace4fda133b9c845c790d94013d9f460a2042367/packages/coding-agent/src/core/tools/index.ts)，由独立模块持有状态。

# 十一、验收与停止条件

这些是权限与原生能力整合实施阶段的必要验证，不能把下表当作已经通过的结果。P0 图片候选的既有测试见前节；2026-10-27 开始的实施、审查和验证结果见文末实施记录。真实 Windows 桌面回放单独验收。

| 组别 | 必须证明的行为 |
| - | - |
| 装配 | 默认配置与真正零外部扩展都能通过 CodeMode 使用 read/edit/write/bash；工具 owner 唯一，child 不重新带入 parent 扩展全集 |
| 文本传输 | 中文路径、UTF-8、LF/CRLF、字面 `\n`、`${…}`、引号与连续反斜杠到达实际解释器时符合工具契约 |
| 图片输入 | 真实 Windows 中分别验证 Ctrl+V/Alt+V 的实际事件、系统截图、应用复制图片与 Explorer 文件；成功出现附件标签并传入真实 image content；普通文本和 `-` 正常保留；无图、读取失败、格式不支持可区分；禁用 auxiliary-vision 仍可粘贴，原生多模态模型仍可收图 |
| CodeMode 结果 | 解析失败为零子调用；普通失败、allowFailure、取消/超时和结果处理错误可区分；摘要不冒充完整输出 |
| 文件一致性 | 同脚本 read/edit 成功；过期 revision、目标变化和独占创建冲突不静默覆盖；外部编辑器变更被按已声明契约处理 |
| 部分变更 | move/batch 部分成功逐项记录；提交之后的取消仍返回已变更或未知，不伪装完全回滚 |
| 授权与批量 | 既有范围复用；deny/ask 不被 sandbox、never-ask 或复合命令首段覆盖；静态批量授权只覆盖固定子项，动态调用最终复核；取消与部分完成不被 allowFailure 改写 |
| 任务生命周期 | CodeMode 显式后台任务可等待/取消；允许的前台转后台不重启进程、不延长截止时间、仅一次完成事件 |
| 实际隔离 | 所有已开放入口通过其声明的执行边界；未覆盖 LSP/local MCP/Browser 等在 sandbox 下副作用前拒绝；越界读写和未开放网络受到实际限制 |
| 模式与撤销 | 进入受限 Plan/切会话/退出会等待旧能力收尾；无法确认状态不宣布成功；远端副作用不因文件只读而放行 |
| 配置迁移 | 不静默扩大旧权限，沙箱不可用不降级；排队旧上下文失效；真实用户拒绝和账户范围持续有效 |
| 原生协议 | 工具目录、提示词、压缩、会话恢复、附件重试各有唯一 owner；不依赖扩展加载顺序和跨包全局状态 |

性能验证只针对本次变化的热路径：启动、第一次工具调用、常规命令、取消以及大量输出。使用固定真实场景比较基线，不为每种解释器拼写和风险类别扩张矩阵，也不在没有测量前声称性能已提升。

某个隔离后端若无法覆盖实际执行入口或需要反复修改用户机器配置，停止它的默认接入；不要为追求上线日期重新加 Shell 猜测器。已经独立完成的执行、文件与装配修复照常交付。

方案完成时应能回答三件事：这次调用实际执行了什么、执行在哪个明确边界内、产生了哪些可确认结果。

# 十二、提示词收敛

提示词保留少量稳定行为规则即可，不承载 OS 隔离实现，也不描述内部 guard 数量或授权令牌。

1. 按用户任务和已经给出的授权持续推进；既有授权内的正常步骤无需反复确认。

2. CodeMode 使用合法且简洁的 JavaScript，调用稳定工具接口；复杂解释器脚本通过可靠的 stdin 或文件传输。

3. 修改文件遵守原生工具的版本与覆盖契约，收到冲突后重新读取并核对，不盲目重试。

4. 预期失败按 allowFailure 和真实结果处理；区分脚本、网络、工具、边界与取消错误。

5. 对外发送、发布、生产修改等行为以用户实际授权为准；遇到新的资源边界或真正拒绝时处理对应问题，不改写命令绕过。

6. 汇报已确认的执行结果、失败与部分完成状态；没有证据时不要宣称成功。

重复调用建议、Memory 整理策略、Goal 预算和浏览器工作法继续属于可选工作流。它们可以指导模型，不再作为所有日常工具调用必须穿过的默认解释和拦截链。

# 十三、实施记录

## 推进约定（2026-10-27）

按 P0 至 P7 顺序推进；每个可独立交付的代码项必须实现、定向验证、审查、记录通过后，才进入下一代码项。阶段内有多个代码项时分别记账，不把某个子项完成等同整个阶段完成。用户已明确将真实 Windows 图片桌面回放保留为待办，不阻塞后续代码工作。

性能遵守 `docs/performance/hot-path-allocation-contract.md`：修改热路径前审计完整调用链，记录确定性计数、分配与生命周期证据；不以单次耗时或 GC 差值宣称优化。只运行受影响检查，代码不变且验证通过后不重复扩大测试。测试治理随变更进行：替代功能落地后删除过期断言，合并相同契约的重复矩阵；保留差异化故障和资源释放覆盖。CI 与测试资源按已创建的具体身份清理，不扫描删除无关临时目录或终止未知进程。

当前 Git 基线为 `ace4fda133b9c845c790d94013d9f460a2042367`。开始时已有 9 份文档删除记录，不属于本任务；图片补丁的 5 个文件已暂存。后续实现不创建提交、不推送。验收日志优先保留简明数字和命令，避免保存大体积输出或重复构建产物。

| 代码项 | 状态 | 当前证据与范围 |
| - | - | - |
| P0.1 图片读取与桌面回放 | 完成 | 真实截图、应用图片、Explorer、纯文本、失败阻止提交和辅助视觉路由通过；见 §70 |
| P0.2 CodeMode/Windows 传输与结果 | 完成 | UTF-8、原文、allowFailure、真实沙盒输出及失败归集通过 |
| P1 原生装配与任务 owner | 完成 | 原生生命周期、任务控制、进程关闭与最终整套回归通过 |
| P2 文件正确性与变更 | 完成 | 唯一原生文件 owner、版本前置条件、批量真实写回与冲突/部分结果保持 |
| P3 统一授权与执行边界 | 完成（既定 Windows 范围） | 通用 WSB 后端、AgentSession/CodeMode 接线、授权/撤销、成功/失败/取消/超时实测通过；未适配入口关闭 |
| P4 旧实现与默认策略退役 | 完成（新 profile） | 原生授权接管、旧 guard 不重复注册、默认行为硬封禁/成功重写退役；旧配置显式迁移，不扩大权限 |
| P5 工具目录和提示词组合 | 完成 | 原 P5.1–P5.7 约定范围及本次全量/分配检查通过 |
| P6 Provider 请求与压缩 | 完成 | 原 P6.1–P6.9 约定范围及本次请求/摘要/引用释放检查通过 |
| P7 剩余机制与整体收尾 | 完成（约定兼容范围） | MCP/LSP、lease、附件、statusline 与新后端整体接线通过；仍有消费者的兼容入口有明确保留与退出条件 |

<details>
<summary>2026-11-03 收口前的历史状态表（原文保留）</summary>

| 代码项 | 状态 | 审查与下一步 |
| - | - | - |
| P0.1 图片读取错误分类与 PNG 兼容 | 代码完成，审查通过；桌面验收待办 | 自动检查通过，允许进入 P0.2 |
| P0.2 CodeMode/Windows 传输与结果归集 | 代码完成，审查通过 | 修复 Windows Python 管道编码；既有传输和 allowFailure 保持；时限分离归 P1 任务生命周期 |
| P1 原生装配与任务 owner | 代码完成，审查通过 | 平台桥、启动器边界、计算/等待计时、原生任务机制与会话装配均完成；不代表执行隔离完成 |
| P2 文件正确性与变更 | 代码完成，审查通过 | 默认及零扩展会话共用原生文件 owner；版本、变更与兼容权限边界已接入 |
| P3 统一授权与执行边界 | Windows 固定任务及多项隔离/收尾限定验收通过，生产接入未开放 | 原授权/撤销机制及 P3.5.1 限定验收保留；固定 MXC 1.0.1 / Windows 26300.9711 的宿主剪贴板失败判定不变。Windows Sandbox 已完成固定包、0.8.107.0 客户端初始化、三项空白生命周期及固定 Node/PowerShell 各一次真实执行，退出和产物清理均确认。宿主剪贴板验证代码已审查；首轮前置流程因格式 49406 停止，用户明确复制可丢弃纯文本后的一次新前置流程仍因格式 49161 停止，两次均未读取内容或启动实例。只读确认 49161 本机注册名为 DataObject，其 HGLOBAL 完整存储摘要兼容及 GlobalUnlock 错误处理已实现、代码审查和三项定向验证通过；用户随后授权的一次恢复流程因 format-count-bound 在首份基线前停止，仍未读取内容或启动实例；随后获审的一次只读元数据诊断确认该时点共 7 项格式，其中两项当时未支持。现经用户新授权，host-v3 已按通用注册 HGLOBAL 契约修订、代码审查及三项定向检查通过，64 项硬上限与原内存/输出预算并行；随后唯一一次现场实验完成两份稳定基线、一个交互实例和一轮来宾操作，五阶段全部 Win32 存储与元数据一致，限定剪贴板验收通过、退出清理确认；不外推任意 OLE 语义或全面隔离，不回填前次失败数量。Linux/NVX 不在本轮验收。禁网验证方案/代码及四项新定向检查已通过审核，唯一一次现场流程在宿主接口元数据前置阶段停止（TCP 尝试 0、实例 0），尚无禁网通过证据；随后一次独立诊断已明确当前第一个接口的类型 53 被托管枚举关口拒绝（共 6 项），官方定义支持的类型 53 精确兼容已先审后测通过，恢复条件复核后唯一一次对照完成三份宿主健康、启网来宾阳性和禁网 10051/仅 loopback 的明确证据，两个实例及全部调用退出清理，IPv4 TCP 禁网限定验收通过；固定单进程等待负载的一次主动取消也已完成，计划取消时执行仍活动，实例/exec/产物全部收尾约1.73秒；专属可丢弃 RO/RW 及六个未映射路径的单实例对照已限定通过，五个宿主哨兵未变；固定单进程独立执行超时已限定通过，含清理约10.91秒；固定三进程树的 VM 边界收尾已限定通过，含清理约2.62秒；用户已批准首版不承诺平台存储总硬上限、全来宾不可信及宿主独占权威；共享 RW 硬容量已有本次固定配置/负载限定证据，真实工程适配仍未完成。宿主离线候选检查/结果来源区分已先审后测，11组新定向检查通过，revision 178 结果复核完成并精确暂存，不接运行入口；任务专属128MiB固定VHD生命周期实现已代码复审，8组新定向检查各自通过（含20项PS替身），失败与修正记录保留，原生单盘现场入口经revision214复审后新增5组/7项替身一次通过，revision218放行的唯一原生现场调用在VHD创建前因助手stderr失败，原因未知，revision221确认未进入创建；两产物经用户手动删除并核实，有界诊断修正经revision228复审后两组纯内存检查一次通过；用户新授权startup-only取证，revision236确认同一助手原启动链、一次编译与一次诊断，revision246复审后新增5组检查一次通过，revision248放行的唯一startup-only在assembly-check取得本次PS5无法识别Get-FileHash的明确错误，进程与产物清理确认；用户现明确宿主只用D:\PowerShell\7\pwsh.exe，已纠正三个入口及检查启动点、禁止PS5回退，源码边界与PS7最小兼容检查分别通过，RemoteSigned保留、Storage原生导入及零兼容会话确认；新授权下固定PS7实际startup-only已通过，原生对象只读构造、退出及清理确认；一次原生单盘在120秒后阻断：VHD及created待提交记录已存在、正式回执仍creating，记录替换空路径故障已合成复现并修正、单组通过，旧异常未直接捕获；经独立审查完成旧助手/父进程外部收尾及镜像/七叶/空根精确清理，旧历史验收仍失败；修正后唯一原生单盘完成准备/32B读写/正常解除附加释放退出及产物清理，限定生命周期通过；实验共享准入、实时VM收尾和固定安全读取已先审后测，唯一WSB卷GUID/32B实际往返及正常全链退出清理已通过；唯一容量现场在114MiB后取得原始112且宿主EOF/Allocation/哨兵核对一致，限定容量事实通过；最终记录检查失败已修正并单组离线通过，原任务外部退出/七叶清理完成，原现场失败不改写；异常失效仍未验证，原shareAdmission固定false，实验许可不接生产；旧 G0/G1/G2 没有因此通过。真实工作区接入、P3.6、默认切换及相关权限退役继续关闭，见第十五节 |
| P4 退役旧实现与默认行为策略 | 提前处理的 P4.1/P4.2 均完成并审查记录；其余等待 P3 | 已按局部调序移除重复失败硬封禁、自然语言成功扫描及回复重写。结构化 goal 完成检查保留；其他访问控制退役仍等待 P3，见第十六节 |
| P5 工具目录和提示词组合 | P5.1 至 P5.7 的约定契约完成、审查并记录 | 共同目录与宿主接受结果、现代宿主显式模式协调、结构化提示词和实际装配均完成；自动注册/恢复与 Plan 的已复现冲突已修复。边界及证据见第十八至二十一节，未扩大到 P6 |
| P6 Provider 请求与压缩 | P6.1–P6.9 的约定契约完成、审查并记录 | 原生 owner、认证/Fast/能力与传输状态、唯一策略/显式 preset、补充摘要隔离、连续性拒绝/恢复边界及三包真实装配均收口；保留低层 legacy 共享域、旧宿主和非 GPT 回退，不承诺透明自动恢复。P3 不开放 |
| P7 剩余机制整合与收尾 | P7.1–P7.7 按各自范围完成、审查并记录；整体验收缺口与交接见 P7.8 | 原生会话保护、附件现代/历史入口分离与 Windows 别名清理、MCP/LSP 实际装配、statusline 旧版本探测退役均已完成；保留仍有消费者的兼容入口。完整 P7 未完成，真实执行接入、默认边界切换及依赖 P3 的权限退役继续关闭 |

</details>

## P0.1 审查与验证

范围：原样应用 `super-pi-clipboard-fix.patch`，两个生产读取模块与三份测试文件，共 +338/-14 行。

审计链：CustomEditor 快捷键 → InteractiveMode.handleClipboardPaste → PowerShell / 隔离 native helper → ImageAttachmentDraft.finish/fail → 提交检查、取消与清理。确认有图后的读取错误不会删除准备中的附件并读取文本；第二图片后端仍可恢复；取消、超限、未确认 helper 退出继续优先失败。错误对象只转为受限文字保存在草稿，native close 清除监听器、计时器、字节块和 activeRead；取消/停止路径保持原有独占所有权。没有新增逐帧、逐进度回调分配或对象池；新分配位于显式粘贴操作及异常边界。

已执行（Windows，Node v26.4.0）：

- `node --experimental-strip-types --test --test-reporter=spec --test-concurrency=1 tests/github-review-regressions.test.ts tests/image-placeholder-input.test.ts tests/interactive-control-images.test.ts`：134 通过，0 失败、0 跳过，约 25.2 秒；包含 4 个真实 Forms 内存数据源用例，以及 native child 取消后再次读取、超时回收、草稿晚到结果等生命周期覆盖。
- `node --experimental-strip-types --test --test-reporter=spec --test-concurrency=1 tests/source-invariants.test.ts tests/tui-hot-paths.test.ts`：13 通过，约 1.5 秒。
- `npm run check`、`npm run build:offline`、补丁反向一致性检查及 `git diff --cached --check`：通过。
- 既有 `interactive-image-input.ts . --sample`：10,000 次普通编辑产生 0 微任务、保留文本长度 0；截断结果 10 行、跳过 9,991 行。采样 13,300,308 bytes/operation、GC 后差值 +916,280 bytes；该基准测量既有文本截断及旧附件 owner，不能据此证明剪贴板 helper 的分配改善或无泄漏。补丁未修改该基准覆盖的高频链。

审查结论：未发现阻止代码项完成的问题。真实截图工具、应用复制图片与终端快捷键回放仍未执行；用户于 2026-10-27 明确选择保留桌面验收待办。测试没有访问或覆盖用户真实剪贴板，没有新增常驻任务或大体积证据文件。

## P0.2 审查与验证

复现：通过生产 `createPowerShellTool` 执行 Python 3.13（显式 `-X utf8=0` 固定 Windows locale 路径），打印泰文失败，真实退出码 1，错误为 GBK `UnicodeEncodeError`。PowerShell 的 Console.OutputEncoding 不能改变 Python 重定向管道编码。

修改：Windows `getShellEnv()` 仅在未提供大小写不敏感的 `PYTHONIOENCODING` 时设置 `utf-8`；保留显式值与空字符串、PATH 原有选择规则、宿主环境以及 Python 文件打开的默认编码。新增一个用例覆盖默认值、混合大小写覆盖和显式空值；没有扩大解释器/权限写法矩阵。

验证与审查：

- 新用例修复前失败，修复后通过；真实 PowerShell 与 Git Bash 分别启动同一 Python 命令，均输出 `ไทย`，退出码 0，输出完整。
- `powershell.test.ts`、`codemode-r2-failure.test.ts`、`codemode-recovery/execution.regression.ts` 共 36 项：34 通过，2 项 D4 既有时限验收失败。失败原因经 `Execution` 绝对计时器及历史 R4 记录确认：子调用/审批等待仍消耗脚本总时间；与本次仅改变 Windows 管道环境的补丁无调用关系。保留这两项真实缺陷测试，在 P1 任务生命周期项处理，不将失败用例当过期测试删除。
- 既有 Bash 原文/CR/UTF-8 传输与 CodeMode 非法源码三个定向用例通过；类型检查及 coding-agent 单工作区构建通过。没有重跑全仓构建或全套测试。
- 审计 `getShellEnv → resolveSpawnContext → local Bash/PowerShell spawn / Windows Job`：只在命令启动边界复用已有键数组做一次有界扫描，无逐输出/帧改动、无新增 Promise/定时器/常驻状态，不需运行无关渲染基准。人工复核 diff 后保留原先 PATH 首匹配语义。

结论：P0.2 范围内未发现遗留问题，允许进入 P1。P0 代码修复完成；真实桌面验收仍按用户选择保留待办。没有宣称所有 CodeMode 时限问题已解决。

## P1 子项与当前阻断条件

| 子项 | 状态 | 需要证明 |
| - | - | - |
| P1.1 Windows 平台桥由原生 Bash 默认提供 | 代码完成，审查通过 | 原生默认桥；旧扩展纯委托；自定义后端/Hook 兼容检查通过 |
| P1.2 bundled、用户扩展与子进程装配边界 | 代码完成，审查通过 | 真实最小启动 0 扩展/0 工厂；child 仅显式守卫；原生工具实测通过 |
| P1.3a CodeMode 等待计时 | 代码完成，审查通过 | 两个 D4 失败修复；累计预算、死循环、取消及释放通过 |
| P1.3b.1 公共任务机制进入原生包 | 代码完成，审查通过 | 调度、记录、等待、历史、前台 owner 与 checkpoint codec 单一实现；旧路径委托 |
| P1.3b.2a 后台 owner 与公共控制入口原生化 | 代码完成，审查通过 | 后台机制和 tasks 目录单一实现；旧路径纯委托；生命周期与分配通过 |
| P1.3b.2b 原生会话任务装配 | 代码完成，审查通过 | 零扩展任务、后台运行、等待/取消、一次完成、重载及失败清理；兼容入口复用同一 owner |

## P1.1 审查与验证

将已有 MSYS stdin 桥作为原生本地 Bash 的默认 spawnHook；显式自定义 hook、自定义 backend 和 PowerShell 保持原传输。旧 `msys-bash.ts` 包装不再安装桥，只转交配置。桥的 12 KiB 命令限制、Windows 环境大小限制、超限错误及取消路径未改变。

加强既有长 `node -e` 用例：由两个关键词存在断言改为完整原文比较，测试数量不增。修复前实测连续反斜杠变少；修复后全部字符一致。审计工具创建 → spawn context → 固定桥 → shell child → stdout/stderr/OutputAccumulator → close/取消，不向逐输出链增加闭包、Promise、容器或复制。已有桥只在需要传输的显式命令边界分配 base64 与独立环境；不新增缓存或池。

验证：`bash-heredoc-binding.test.ts` 与 `shell-observation-hot-paths.test.ts` 共 25 项全通过（约 2.9 秒），包含自定义 hook/backend/prefix、UTF-8、CR、拒绝零子进程及高频回调 AST 约束；coding-agent 重建及类型检查通过；真实 `superpi` 启动器的 paired-backslash 回归 1 项通过（约 2.9 秒）。

`shell-common-compatibility.ts --allocation-gate`：96 append / 96 snapshot，1 个 spill，5,242,880 bytes 上限，0 spill error；20 个完成生命周期的 owner 受控 GC 后存活 0。采样 5,093 bytes/append，主要站点为 Buffer.toString、模块首次加载、有界截断及 Writable.write；未更改输出链，无跨版本性能提升声明。基准按记录路径删除 spill 与工作目录。

审查结论：本子项通过，进入 P1.2。守卫扩展的其他工具注册与权限策略仍待后续迁移，没有提前删除。

## P1.2 审查与验证

复现：真实构建 CLI 在 `--no-extensions` 下仍加载 24 个 bundled 入口及 `<inline:llama.cpp>`。启动器把 bundled 项注入显式参数，CLI 又无条件添加内置 factory，因此资源加载器的自动发现开关不足以隔离两者。

修改：启动器复用 CLI 参数解析器，分别尊重 no-extensions/no-skills/no-prompt-templates（含短选项），保留用户显式资源。三个开关均关闭时不读取 bundled 清单。只有首参数为管理命令时跳过注入，避免把 `--model list` 或 `--` 后的普通消息误当命令。CLI 在 no-extensions 时停用隐式 llama.cpp factory；调用方显式传入的 factory 与显式 `-e` 保持可选装配语义。子进程现有参数和独立守卫无需修改。

验证：两个回归修复前失败、修复后通过。`bundled-extensions.test.ts` 与 `cli-args-terminator.test.ts` 共 19 项全通过，约 1.8 秒。参数边界合并在既有测试的单个短命进程中；仅增加 1 个真实装配测试，两个 CLI 进程各有 20 秒超时和 512 KiB 输出上限。隔离用户目录中放置会报错的自动发现扩展，真实最小启动仍为 0 扩展/0 工厂；显式 child-guard 模式只加载该守卫，0 工厂/0 加载错误；两个进程均为 0 网络尝试。临时目录按创建路径清理。

加强既有 SDK 最小会话用例，确认没有外部或 inline 扩展，实际经 CodeMode 执行 read/write/bash，并核对文件和展示输出；1 项通过。类型检查和 coding-agent 构建通过。

审查覆盖启动器 → 参数解析 → main → resource loader → session，以及 subagent 的 SP_SOURCE_LAUNCHER 调用；默认资源顺序保持，显式守卫未被丢弃。改动仅在启动/资源装配边界，无逐进度或渲染路径变化，不运行无关热路径基准。审查通过，进入 P1.3；本结论是装配独立性，不代表 OS 隔离已实现。

## P1.3a 审查与验证

CodeMode controller 选择 active 计时；底层 CodemodeSandbox 默认仍为 wall 计时以保留公开 API 兼容。active 预算包含启动、VM 计算和消息交付，只有 VM 执行及微任务排空、且宿主仍有待处理调用时暂停。工具/审批等待不消耗脚本额度；工具自己的超时与取消保持，调用方可通过 signal 给出总截止时间。

审查全链：controller → Execution.start / WorkerPool.acquire → worker prelude / run / drain → host call / result → drain → finish / VM.dispose → pool.release / retire。idle 协议携带已交付回复计数，晚到的 idle 不能暂停已恢复计算的 VM；未 await 的工具不能掩护死循环。预算跨多次等待累计，不在恢复时重置。新消息由每个 VM 的单个对象复用，桥接克隆不保留引用；idle 数量上限 257，回复计数上限 256。宿主最多持有一个截止计时器，使用稳定实例回调；在完成、失败、取消时清除计时器、监听器、工具表及 pending，池按原契约只复用成功且已释放 VM 的 worker。

检查：runtime、hot-path AST、execution regression 合计 45 项通过，约 8.2 秒；两个既有 D4 失败均修复。只新增 1 个组合回归验证累计计算预算、快速回复/晚到 idle 和失败后的复用；原死循环及取消用例改为覆盖 active 模式。协议边界断言并入原测试。审查后补充的 wall 兼容与 idle 上限 2 个定向用例通过。类型检查、codemode 与 coding-agent 工作区构建通过。

分配基准 `codemode-runtime.ts --active-time`：真实 QuickJS/worker，30 次 warm no-op 加 100 次含等待的 4 KiB 工具结果；32 worker 启动/32 退出，128 跟踪引用在受控 GC 后存活 0。宿主采样 2,850,008 bytes，主要为 stringify、post、handleCall；采样不覆盖 worker 堆。新回调/异步工厂 AST 门禁通过；没有对象池或逐进度回调新增，不据该次采样宣称性能提升。复用既有基准，仅加 active 模式，未保存大体积采样文件。

结论：审查通过，进入 P1.3b。active 模式有意不为外部工具/审批施加脚本总时限；工具不响应取消的宿主代码仍不能由 VM 强制终止，原生执行 owner 继续承担其生命周期。

## P1.3b.1 审查与验证

将公共任务记录/等待/历史、FIFO 调度、前台调用 owner、容量读取、checkpoint 序列化迁入 `coding-agent/src/core/tasks`；通过专用 internal/tasks 导出供旧扩展路径委托。原路径不再保留机制副本。子任务分工和 checkpoint 规划提示词继续留在可选扩展，路径包含判断与调度共用原实现。

机械比对确认 6 个模块除 import 和已分离工作流文字外，实现主体与 Git 基线一致；原生任务模块不引用扩展代码。兼容路径和原生包的三个 owner 类对象严格相同，避免在标准构建中形成两套实现。迁移不改变 64 并发/256 任务硬上限、每类 64 等待者、12,000 字结果、128 MiB 历史库上限与现有格式，不新增轮询或进度持久化。

验证：历史/checkpoint/AST 共 26 项，25 通过、1 项 POSIX 专用检查在 Windows 跳过；调度、等待、释放、真实子进程前后台交接等 8 项定向检查全通过。类型检查和 coding-agent 构建通过。只更新既有 AST 的生产文件路径，并在既有测试中加入实现身份断言，测试总数不增加。

完整链审查包括 task create/start/finish → 等待者释放/结果淘汰 → history 事务、句柄关闭，以及 foreground publish → detach/finish → 父信号和更新引用释放。复用基准：四种历史生命周期各 8 任务，写入次数 24/24/24/16，未完成恢复 8，关闭后句柄/owner 均为 0；临时库各 20–116 KiB，144 个弱引用存活 0。前台基准 256 调用、256 deferred、256 controller、64 detach、0 晚到更新、0 残留父监听器、0 handoff timer，768 个前台弱引用存活 0；调度及结果另外 344 引用存活 0。分配采样记录在工具结果，迁移未改变主体，不宣称性能优化；临时库与目录按已创建路径清理。

结论：公共机制迁移审查通过，进入会话装配。此时无扩展会话尚未获得 tasks 工具或后台启动 owner，不能把本子项当 P1 整体完成。

## P1.3b.2a 审查与验证

后台 shell owner 与公共 tasks 目录迁入原生 tasks 目录；旧入口纯导出。通过窄化 TaskHost 接口使用工具、会话事件和通知能力，不引入扩展实现依赖。旧权限变更事件暂保留为兼容订阅，直到权限消费者在 P4 迁完。机械比对确认两个模块的执行主体未改变；既有测试确认原生与兼容路径为同一个类。

29 项后台行为与热路径 AST 检查通过，包含真实 Bash/PowerShell 交接、权限撤销、导航清理、失败闭锁、历史恢复；构建和类型检查通过。只更新已有断言与生产路径，测试数量不增加。基准初次失败定位为旧 fixture 未声明 Bash 支持受管后台，补齐与实际工具一致的元数据后通过，未放宽生产校验。

审查完整链：最终授权交接 → 队列/任务 → shell output → 终态记录/单次通知 → 取消/退出/历史关闭。四种模式各 1000 输出块，逐块 Promise/controller/历史写入均为 0；后台和交接各 1 次通知，交接后更新 0。完成/失败/取消/关闭各 8 个 reservation 全释放；152 个弱引用存活 0。仍运行的 4 个后台任务已释放原前台 16 个引用，父监听器和晚到更新为 0。Windows Job/进程句柄均为 0。采样约 5335–6081 bytes/块，主要为 Buffer 转码，未改变热路径主体、不宣称性能提升；基准临时目录及输出按已记录路径清理。

结论：本项审查通过，进入 P1.3b.2b 的原生会话装配；尚未声称零扩展后台运行已可用。

## P1.3b.2b 审查与验证

DefaultResourceLoader 显式创建 SessionTasks，先于可选扩展；AgentSession 将其 tasks 定义作为 builtin 装配，运行器接入原生生命周期和 /tasks 命令。没有添加 Extension 条目或 inline factory。原生 shell 说明进入工具 promptGuidelines；旧守卫通过会话事件取得同一个后台 owner，subagent 继续贡献同一个目录中的 provider。既有授权存在时仍由其最终 grant 裁决，本项不提前删除权限检查。

原生调用边界固定 command/cwd/timeout/purpose/background、目录身份、会话和撤销信号；排队及真正启动前检查。原生 grant 在交接/拒绝时清除输入、上下文、binding、runtime 等引用。显式后台允许嵌套 CodeMode；前台转后台仍限 TUI/RPC 中顶层、显式 cwd/timeout 的本地 shell，不将嵌套等待变成后台。工具选择、SDK allowlist 和 no-tools 保持约束；无交互会话拒绝后台启动。关闭、失效、重载和启动失败都会撤销并释放原生 owner，已发生的清理失败仍可由 awaited shutdown 取得。

审查发现并修复构建版 Jiti 将 internal/tasks 子路径拼到 index.js 后的问题；增加子目录别名，并为源码/独立二进制的 virtualModules 补齐原生模块。真实构建启动器分别验证零扩展、仅 child-guard、仅 lifecycle/subagent：均无加载错误，0 隐式 factory、0 网络尝试。源码默认 bundle 中 tasks 只有一个 builtin 入口和一个命令，shell/subagent 在同一目录可见。没有在本轮构建或宣称验证独立 Bun exe。

只新增一个有 15 秒上限的集成用例，覆盖零扩展 CodeMode 后台命令、真实结果、取消、嵌套前台不交接、同 PID 前台交接、单次通知、headless 拒绝、输入/撤销失效、重载与启动失败清理。其他断言并入已有用例。CodeMode 会话文件运行得到 104 通过、2 个旧 wall-time 用例超时；两者改为主动耗尽计算预算，保留浏览器审批状态和不响应取消工具的清理断言，并加 5/10 秒上限，定向复验均通过（约 1.1/5.2 秒），不再重复整文件。后台既有 25 项通过，事件/时限/AST 18 项通过，选择与最小装配检查通过；类型检查、coding-agent 构建通过。

审计链涵盖 loader/runtime → session/runner → 最终调用交接 → task/scheduler → shell output → terminal notification → tree/reload/invalidate/close。热事件仅多一个无分配 hasHandlers 查询；原生生命周期调用不进入逐输出路径。既有后台基准改用真实 SessionTasks 和 native grant，不另造基准：四模式各 1000 输出，逐块 Promise/controller/历史写入仍为 0，交接后发布 0，后台/交接各 1 次通知；167 个引用受控 GC 后存活 0，Windows 句柄 0。采样约 5382–6042 bytes/块，主要仍为 Buffer 转码，无性能提升声明。临时数据按创建路径清理，未保存大体积采样文件。

结论：P1 各子项审查通过，进入 P2。真实图片桌面验收继续待办；P3 OS 边界与 P4 旧策略退役尚未完成，不能将当前原生装配称为已实现 sandbox。

## P2 子项

| 子项 | 状态 | 边界 |
| - | - | - |
| P2.1 文件提交、创建及身份基础机制 | 代码完成，审查通过 | 原生单一实现；旧入口纯委托；语义和文件格式不变 |
| P2.2 平台元数据与文件 worker | 代码完成，审查通过 | 元数据后端原生化、惰性加载、单 worker、失败与释放保持 |
| P2.3 revision、原生文件工具及变更服务 | 代码完成，审查通过 | 同脚本 read/edit、单一工具 owner、delete/move/batch、/changes；旧访问边界保留到 P3/P4 |
| P2.3a 原生 revision 与有界快照 | 代码完成，审查通过 | 独立 owner、过期/清空/关闭复核；旧入口纯委托 |
| P2.3b 默认文件工具装配与策略解耦 | 代码完成，审查通过 | 原生 revision 接入默认及零扩展会话；兼容扩展不再注册重复文件工具 |
| P2.3b.1 一次性文件调用绑定 | 代码完成，审查通过 | 旧 controller 签发，原生模块验证/消费；不提前删除访问边界 |
| P2.3b.2 基于 revision 的精确替换与覆盖 | 代码完成，审查通过 | 独立版本前置条件；有界原始字节替换；不携带每轮策略 |
| P2.3b.3 原生分页读取与空文件 revision | 代码完成，审查通过 | 读取窗口/续页可签发 compact revision；拒绝半行/伪造来源 |
| P2.3b.4 原生文件执行服务 | 代码完成，审查通过 | 同一服务准备/执行创建、版本编辑/覆盖、move/delete；保留真实结果 |
| P2.3b.5 原生批量操作 | 代码完成，审查通过 | 全项准备/复核、单一队列范围、逐项真实结果、共享预览额度 |
| P2.3b.6 原生 changes 事实与展示 | 代码完成，审查通过 | 有界历史重建、显式验证、来源绑定与展示；旧入口纯委托 |
| P2.3b.7 原生文件 owner 与默认装配 | 代码完成，审查通过 | 单一会话服务、受限调用交接、重载撤销、宿主/CodeMode 两条入口及读取缓存兼容 |

## P2.1 审查与验证

将 native-file-core、file-commit、file-creation、protected-path-policy 和文件协议正则移入 coding-agent/core/files，旧入口纯导出。package exports、TypeScript 路径、构建 Jiti 别名和源码/二进制 virtualModules 同步提供映射。5 个生产模块机械比对与基线完全相同，无第二实现；既有提交测试核对兼容入口与原生函数身份。

审查 preparation → 路径/内容复核 → 独占创建或既定提交策略 → 平台 metadata/worker → 发布后验证 → 临时对象清理与 receipt。保留 64 KiB 有界哈希缓冲、父目录/对象复核、保留不明归属临时文件、提交后取消仍记录已提交、硬链接兼容、move 不覆盖和非递归 delete。没有扩大权限，也不将观察与普通文件系统调用描述为全局 CAS；平台后端仍待 P2.2 迁移。

提交/元数据/原生操作/源码检查共 101 项：78 通过、22 个平台专用跳过、1 个 AST 仍指向旧文件而失败；更新到原生生产路径后该项定向通过。真实构建扩展加载检查通过，类型检查与构建通过。没有新增测试用例，也没有重复 Windows ACL 全矩阵（首轮约 31.7 秒）。

复用 native-file-commit 基准，50 次 64 KiB 实际提交、50 次发布、单 worker、352 次原生调用，读取 6,553,600 bytes、哈希 6,648,656 bytes；句柄/描述符/待处理调用全为 0，关闭后 worker 未加载。主线程采样 10,056,176 bytes，不含 worker/native 堆。为既有基准补充 200 个 plan/metadata/hooks/receipt 弱引用：受控 GC 后存活 0；首次采样发现基准最后一轮局部作用域保留 4 个对象，隔离测量调用后消除，未修改生产释放逻辑。所有临时文件按创建路径清理，未保存采样文件。

结论：P2.1 审查通过，进入 P2.2。此时默认 edit/write 包装和跨轮 read 准入尚未移除，不能宣称 P2 整体完成。

## P2.2 审查与验证

file-commit-metadata、native-file-client、native-file-worker.mjs 和配套 worker 正则迁入原生 files 目录；4 个实现机械比对与基线一致，旧入口纯委托。原生构建复制两个必要 mjs 资产；Node 包导出和源码 virtualModules 补齐映射，导入 metadata/client 不创建 worker。既有全局 owner 标识不变，避免兼容路径、源码/构建入口和重载形成多个 worker。

审查 metadata 选择 → 固定操作协议 → worker 的固定库/符号装载 → 文件、token、descriptor 句柄 → 回包/失败 → pending 清空及 terminate。保留 16 请求上限、64 KiB 安全描述符/属性名上限、256 KiB 属性值上限；Windows 系统库来自 OS 目录，调用请求不能指定 FFI 符号。普通错误不触发策略降级；发布后失败仍保留已提交事实，正在执行的 OS 操作不被假装取消。

9 个定向检查通过（约 1.1 秒），覆盖惰性启动、真实普通文件/长路径替换、硬链接、发布后故障、缺少平台二进制、模块重载和 AST；默认 bundle 的真实编辑检查通过。类型检查、coding-agent 构建通过，测试数量不增加。未重复上一子项已经通过的 Windows ACL 全矩阵。

原生构建入口基准实际启动复制后的 worker：50 次 64 KiB 提交、352 次原生调用、单 worker、50 次发布；句柄/descriptor/pending 全为 0，关闭后 worker 未加载；200 个引用受控 GC 后存活 0。主线程采样 10,104,784 bytes，不含 worker/native 堆，不宣称提速。临时工作目录按创建路径清理。

结论：P2.2 审查通过，进入 P2.3。此项只迁移平台后端，并未提前改动文件工具权限或读取证据契约。

## P2.3a 审查与验证

快照编辑、行锚点协议、UTF-8/语法校验、compact capture 与有界预览进入原生 files，旧入口纯导出。路径/hash 公共实现同步原生化。行协议、语法检查与预览主体机械比对保持不变；渲染 AST 改指向实际实现。Native FileRevisions 按会话持有最多 128 份、8 MiB 记录，不与兼容全局 store 共用清空操作；clear/dispose 的 generation 防止异步读取在会话结束后重新填充。

完整审查 read 来源 → 有界捕获 → session/目标/revision 复核 → 编辑计划 → metadata/commit → 结果及释放。读取改为既定大小加一字节哨兵、每次最多 64 KiB，避免 stat 后增长导致无限 readFile；内容、身份、父目录和提交边界复核保留。提交前清空拒绝操作；发布后清空保留 committed receipt，不声称撤销已送入 OS 的操作。compact 扫描对未保留行只推进原始计数，停止逐行创建空数组和 Buffer。

新增 3 个合并的定向用例和 1 个 AST 门禁，覆盖独立 owner、无模型轮次/展示的连续 read/edit、并发 clear、关闭、提交前后失效、容量及受控 GC；全部通过，约 0.6 秒。既有 6 个恢复/外部修改/Unicode CRLF/compact/解析器/分配检查最终通过：第一次发现增长后的错误类别丢失，改由统一 stale-source 边界撤销旧快照并保留原始 cause，定向重测通过。5 个 source invariants、类型检查和 coding-agent 构建通过。

131 次实际捕获，128 份上限；独立字节容量用保守记账验证 8 MiB 上限。261 个 owner/receipt/source 弱引用受控 GC 后存活 0；主线程分配采样 17,729,504 bytes，固定回归上限 256 KiB/次。既有 32 调用/8 提交恢复基准采样 12,241,704 bytes、pending 0、owner 存活 0。2,240,014-byte compact 文件只保留 3 个可见行，采样 2,990,328 bytes，固定上限 8 MiB；未保存 profiler 文件，测试临时目录按创建身份清理。采样不代表总分配或跨版本提速。

结论：P2.3a 审查通过，进入 P2.3b。当前仅原生机制支持无跨轮条件的 read/edit，默认工具尚未切换，不将其记为 P2 整体验收完成。

## P2.3b.1 审查与验证

文件调用的请求 hash、不可枚举的一次性绑定、消费与撤销检查迁入 file-invocation；原权限 contract 对这些符号纯导出，其他 subagent/browser/LSP delegation 保持原处。3 个执行函数与基线逐字比对一致，保留原 Symbol 名称和 schema，避免源码/构建兼容调用各拿一份凭据。原生文件服务后续只依赖调用绑定，不依赖命令分类 controller。

审查签发 → 终端授权消费 → call ID/operation/payload hash 校验 → 当前权限复核 → 清空附着引用。消费前即清除附着值，失败不会留下可重用凭据；具体访问范围仍由旧 controller 决定，后续 P3/P4 才替换。8 个既有定向用例通过，覆盖审批中目标变化、撤销、创建竞争、打开句柄变更、覆盖目标消失、批量拒绝及部分失败；无新增测试。类型检查、构建及机械比对通过，未重复长时间权限交互或 ACL 矩阵。

结论：P2.3b.1 审查通过；继续默认文件服务装配。

## P2.3b.2 审查与验证

新增原生 revision-mutations：精确替换与整文件覆盖都准备成同一提交计划，由已有 metadata/commit 执行；只依赖 session、文件 identity/revision 和单次资源限制。精确模式匹配原始内容，重复文本需唯一位置或 expectedLine；一次调用全部匹配原始版本并检查重叠。未触及字节、BOM 和混合换行原样保留；不自动作模糊文本修复。覆盖是明确的整份 UTF-8 内容替换。未引入模型轮次计数、展示准入、累计修改预算或新的语法拦截。

审查输入字节额度 → UTF-16 完整字符 → revision/current source → 原始字节位置与重叠 → 有界预览 → 准备对象身份 → 提交复核。精确来源/输出最多 2 MiB，单次替换输入及作用范围 256 KiB；覆盖输入最多 1 MiB；预览来源总和最多 256 KiB、结果受既有 64 KiB/400 行预算限制。审查修正了半个代理字符导致 UTF-8 字节位置不可靠的问题，并把额度检查放到分配 replacement Buffer 前。超过精确来源上限继续使用已有 bounded LINE#ID 编辑机制。

复用原生 revision 测试文件，增加 1 个合并用例覆盖 BOM/混合换行/中文 emoji、重复目标、重叠、非法代理字符、额度、覆盖冲突与正常覆盖；4 项全部通过。既有容量/GC 用例扩展两次实际提交，133 捕获、2 提交、275 个 owner/receipt/plan/byte edits/hooks/result 引用，受控 GC 后存活 0；主线程采样 19,126,280 bytes，保持固定回归上限。AST 门禁、类型检查、构建通过；最终额度修正只重跑受影响用例，没有重跑全套测试或保存临时采样。

结论：P2.3b.2 审查通过；原生执行机制已覆盖行锚点、精确替换和版本覆盖，仍需默认会话工具装配、批量/changes 迁移及有效 owner 验收。

## P2.3b.3 审查与验证

默认 read 超过 256 KiB 会走原生分页，原快照实现只识别旧式文本投影，导致这类正常读取不能得到 revision。现在共用生产分页文本格式，并结合原生内容来源、字节窗口、文件版本及完整行边界签发 compact 快照。每个原生窗口只保留选中行和相邻边界（单份最多 128 KiB），包括 2 MiB 以下文件，避免为分页结果建立全文件行数组。半行、二进制和复制文本伪造 metadata 均不签发；空文件和仅 BOM 的空文本可取得用于覆盖的 revision。

审查原生 read → 来源绑定/窗口 → 有界扫描及整文件 hash → 原生展示投影逐字核对 → 快照计划 → 提交/清空。保留源内容和元数据复核，不把 Windows stat 字段当可靠内容版本。窗口 hash 需要扫描文件，最多既有 32 MiB（脚本文件 4 MiB），不宣称免费读取或跨进程 CAS。精确读取的取消、错误、cursor 作用域及原展示文本保持。

增加 1 个合并用例，实际验证 400 KiB/2.8 MiB、中文/emoji/CRLF、offset/limit、cursor、伪造来源、半行，以及两个空文件覆盖；通过。四次窗口/续读、两次提交的主线程采样 35,024,848 bytes，固定回归上限 128 MiB；4 个快照/可见行数组引用受控 GC 后存活 0。初次全文件行投影审查后改用 compact，最终方案不保留窗口外行数组。5 个既有 read-window 定向检查、compact 兼容投影与 AST 门禁通过，类型检查及构建通过。

复用 read-windowing 分配与 GC 基准并加入生产格式化调用：24 次读取，24 次打开/关闭，24 个源 Buffer/decoder，lineArrayEntries 与 completeFileCopies 均为 0，最大输出 16,384 字符；取消/错误/续读后的 14 个跟踪引用存活 0。20 MiB 基准输入按创建目录清理，无 profiler 文件落盘。未重跑全套测试。

结论：P2.3b.3 审查通过；继续会话文件服务与默认工具装配。

## P2.3b.4 审查与验证

FileService 按会话拥有 revision，统一创建、精确与行锚点编辑、覆盖、move/delete 的准备及执行。公共参数迁入原生层，兼容入口纯导出；输入验证后复制并冻结，计划绑定服务及 generation，重复执行拒绝。edit/write 路径继续兼容 @ 前缀，move/delete 保留字面 @。既有写入目标仍须有效读取版本；消失的覆盖目标不能变成创建。

审查输入 → 规范路径与版本计划 → 同进程文件队列 → 调用边界复核 → 原生提交/创建/移动删除 → 事实记录与释放。访问策略由调用边界提供，没有搬入上一模型轮、展示或每轮预算。origin/intent 在产生效果前记录，结果记录失败保留已发生变更和需验证状态；变更或保留临时文件均撤销相关旧 revision。finally 清空编辑 Buffer；服务只用 WeakSet 标记调用，不持有无限计划目录，下一装配子项负责未执行调用的生命周期。

4 个合并定向用例通过（约 0.55 秒），覆盖六种操作、不可变输入、撤销/clear、竞争消失、创建/覆盖模式、记录失败及释放。3 个既有公共契约恢复用例与新的执行回调 AST 门禁通过，类型检查、coding-agent 构建通过。16 个准备调用中 8 次创建完成、8 次撤销、重复执行实际启动 0；67 个 owner/plan/input/hooks/receipt 引用受控 GC 后存活 0。主线程采样 4,481,640 bytes，固定 16 MiB 上限。无逐输出新增回调、Promise/controller 或对象池；队列为单次操作边界，沿用原有队列实现。临时文件按创建身份清理，不保留采样文件。

结论：P2.3b.4 审查通过；下一项接批量准备与执行，再统一接入默认会话工具。当前默认装配尚未切换，P2 仍进行中。

## P2.3b.5 审查与验证

原生 FileBatch 使用同一 FileService，最多 16 项、1 MiB 输入，write 明确 create/overwrite；全项准备与 metadata 能力检查后，再在同一有序文件队列范围复核全部目标。依次执行，首个失败/取消后停止，保留成功、部分、未知及未开始状态；不回滚、不自动重放。冲突检测、公共参数、结果格式与渲染从旧批量模块提取共用，旧 guard 的模型轮次/证据预算留在兼容入口，未复制到原生服务。

审查预演/准备 → 路径与身份独立性 → 整批有序队列 → 全项及每项复核 → 文件服务效果 → 持久化事实 → 格式化/渲染 → 取消与释放。Windows 队列按大小写规范键排序，避免重复拿锁；已启动效果收尾前不释放队列。共享父目录仍核对已创建对象身份。整批共用 64 KiB/400 行预览额度，持久化记录不再重复保存 diff/patch。预演不建目录、不写事实或消费调用授权；真正执行仍要由下一子项的会话调用边界提供授权。

新增 2 个合并批量用例，服务文件共 6 项通过（约 0.74 秒）；涵盖共享父目录、版本编辑/覆盖、硬链接/祖先冲突、全项过期检查、不可变输入、取消、clear、记录失败及单次消费。既有 4 个批量参数/冲突/部分失败/TUI 检查通过，AST 更新到真实原生渲染位置并检查稳定执行回调。类型检查及构建通过。没有重复旧权限交互全矩阵。

复用服务生命周期采样：22 个准备项，8 个单项完成、8 个撤销；3 个二项 batch 含正常完成、准备后释放及中途取消，共完成 3 项。48 次渲染复用 2 个组件，新增逐帧闭包/Promise/controller 为 0；展示数组保持最多 400 行。98 个 owner/plan/input/hooks/result/renderer 引用受控 GC 后存活 0；主线程采样 7,345,168 bytes，仍在既有 16 MiB 上限内。整批执行时最多保留 16 个结果 Promise，离开持锁范围全部等待并清空；无对象池。临时目录按创建身份清理，无采样文件落盘。

结论：P2.3b.5 审查通过。继续迁移 changes 的事实读取与展示，再接默认会话 owner；默认工具尚未切换。

## P2.3b.6 审查与验证

changes 进入原生 files，历史事实聚合从旧 session-evidence 拆为 change-receipts；原守卫仅保留其读取证据恢复策略，事实函数共用原生实现。公共命令依赖缩为注册/写入记录与观察授权接口，不依赖权限 controller 实现。恢复参数限制改用中性资源常量，值不变；并不恢复每模型轮的写入预算。机械比对确认迁移函数/类主体保持一致（常量等值重命名除外），没有放宽来源或镜像结果校验。

完整审查文件事实生产 → 原始请求 hash/有序阶段 → 512 条有界历史 → 最多 128 个变化 → 用户显式观察/验证 → 有界显示 → 关闭释放。审查发现新服务原先会为覆盖生成重复 intent、为批量/native 操作生成不兼容 origin；已按既有记录契约改为单项 origin→选定提交 intent、批量 prepared→intent→commit_prepared、move/delete intent→result。批量在进入单项后记录 intent 再做复核。原严格恢复规则保持，未以宽松解析掩盖生产端问题。

新增 1 个合并实盘用例，覆盖创建、编辑、覆盖、move/delete、显式当前状态观察，以及提交后取消的批量恢复；实际返回 succeeded/cancelled/not_started，全部可绑定原请求，没有执行重放。受影响的取消用例及 5 个既有缺失/篡改/镜像/部分提交恢复检查通过；6 个 AST/source 门禁、类型检查、构建通过。未运行 60 秒 SDK 大用例或重复 ACL 全矩阵。

复用既有 changes 视口采样：20,000 次稳定渲染新行 0，200 次变化最多 23 个可见行，累计物化 4,422 行；主线程采样 1,360,608 bytes。65,536 字符报告及 786,444-byte 数值滚动索引在关闭后清零，缓存行和生命周期引用为 0；新增跟踪的 TUI/关闭回调两个弱引用受控 GC 后存活 0。渲染无新增逐帧闭包/Promise/controller/整份报告拷贝或对象池；采样不落盘。

结论：P2.3b.6 审查通过；继续默认及零扩展会话的文件 owner 装配。

## P2.3b.7 审查与验证

SessionFiles 在可选扩展前建立，原生提供 read revision、edit/write/delete/move/file_batch 与 /changes。默认及零扩展会话只拥有一份文件服务，旧 mutation 和 loop 扩展在发现 owner 后不再注册文件包装；resource-lifecycle 仍提供现有访问授权，待 P3/P4 替换。没有把上一轮 read、show 展示或历史 receipt 恢复成写入凭据。SDK 白名单、no-tools 与自定义工具覆盖继续生效。

审查完整链：资源装配 → 最终有效工具执行函数 → schema → 原生准备 → 兼容授权 → 一次性参数交接 → FileService/Batch → 实际提交与日志 → CodeMode/changes 展示 → 取消、重载与释放。每 owner 最多 128 个待交接及 128 个在途操作，revision 沿用 128 份/8 MiB；调用身份、输入 hash、generation 与授权在执行边界复核。审查修正了宿主直接调用复制工具对象导致准备遗漏，以及重叠重置可能清除新状态的问题。预演可以显示预览，但不创建文件、目录或 mutation-progress 事实。

读取缓存链同时审查 native read → revision 私有标识 → Evidence Ledger → resident artifact → 当前 revision 检查 → 失效重新读取。支持原生两块读取结果时，Ledger 只新增最多 64 字符的版本标识，仍受原有元数据总额度约束；不保存结果对象或文件内容。缓存版本过期不能阻止再次真实读取。只读 SDK 白名单保持原有单块结果，不额外捕获 revision。Windows 的 stat 不足以可靠复用读取，原有拒绝命中策略保持；本机没有宣称完成非 Windows 文件系统的真实命中验收。

45 个相关 CodeMode 用例通过（约 7.2 秒）；预演补充到既有单一 owner 用例后定向通过。包括默认/零扩展同脚本未展示 read→edit、覆盖/批量、Plan 拒绝、外部版本变化、重载失效、取消与自定义工具覆盖。更新过期的跨轮/展示断言，删除重复的历史授权恢复测试；该文件净减少 32 行。新增两项合并 owner/缓存生命周期检查，没有运行整个长耗时 CodeMode 套件或重复 ACL 矩阵。Evidence Ledger 相关 56 项检查中 38 通过、18 按既有 Windows/显式 GC 条件跳过；后续新增缓存生命周期和版本元数据门禁定向通过。AST/source invariants、类型检查、coding-agent 构建及三个真实离线启动模式通过。

实际交互基准为 regular/fullscreen 各 5 次，均使用生产 InteractiveMode/ProcessTerminal 和合成输入输出，非桌面验收；首个两项文件批量全部成功，pending tools/input listeners/resize listeners 均为 0。首次操作 p50 13.53 ms、p95 27.61 ms，时间仅供同机观察。文件 owner 7 次调用中 2 次完成，其余覆盖篡改、放弃、取消、缺失授权和执行前撤销；3 次读取覆盖重置期间排空与只读白名单。23 个弱引用受控 GC 后存活 0，采样 2,291,696 bytes，固定 16 MiB 上限，pending/inFlight/revisions 清零。

两块 resident artifact 做 1,000 次查验，完整性扫描恰好 1,000 次；超额 metadata 在扫描前拒绝。主线程采样 2,319,248 bytes（约 2,319 bytes/次），固定 8 MiB 上限；4 个 owner/source/message 引用在 clear/dispose 后受控 GC 存活 0。查找没有新增闭包、Promise/controller、临时数组或完整文本复制；两块结果的属性描述检查最多 8 个有界描述对象，沿用一次现有完整性 hash。工具调用边界可以拥有准备对象和异步等待，逐进度、渲染、终端帧路径无新增分配。没有对象池、落盘 profiler 或持久测试进程，临时目录按 fixture 身份清理。

结论：P2.3b.7 及 P2 审查通过，进入 P3 的 Windows 执行边界验证。P0 真实桌面验收仍待办；尚未实现或默认启用 OS sandbox，旧访问边界和非文件守卫仍保留，未把既有 full-access 静默改为 trusted-host。

## P3.1 Windows 候选预检与决策

固定 npm 候选 @anthropic-ai/sandbox-runtime 0.0.81，registry integrity 为 sha512-bjHDu87gjIR7+Oxy9jPiK3v8CvSELCzfpXa3fjqfSKdvlZET2iF51xcXILWPayTpowB3xtZeQVf2JR916nVW/w==。只下载并解包到本任务创建的临时目录，未安装依赖、修改项目锁文件或运行安装脚本。随包 x64 helper --version 返回 srt-win 0.0.1，因此不能单凭 helper 版本标识后端发行版。

Windows 10.0.22631 / x64 / Node v26.4.0 上实际运行只读 status：专用账户、组及 WFP 过滤均不存在；Secondary Logon 可用。没有读取凭据内容、运行 install、授予用户目录权限或修改网络规则。

候选随包 README 的 Windows Known limitations 明确记录：Schannel 客户端不兼容；匿名或派生令牌可使网络连接绕过按账户 SID 设置的过滤；系统服务代理的 SMB/WSL 与 DNS 也不由该过滤覆盖。这些是上游声明的限制，不是本机已重现实验。它们与本方案的 Windows 工具可达性、受限网络和 Plan 硬边界要求存在缺口，因此当前候选不具备默认接入资格。没有用绕过 TLS 验证或改变其他账户网络策略补救。

审查结论：候选预检完成，P3 整体未通过；不执行需要修改整机账户、WFP 和目录 ACL 的初始化。继续可替换的 Windows AppContainer 原型评估，限于新建临时资源及其具名清理，不同时建设多平台实现。系统 API 的可用性不等于所有工具、并发及撤销已通过验收。

后续修订：上段保留当时的决策记录；AppContainer 优先方向已由第十四节取代，不再作为下一代码项的前置条件。

参考：[固定版本 npm 元数据](https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/0.0.81)、[上游 Windows 安装和限制说明](https://github.com/anthropics/sandbox-runtime#windows-alpha)、[Microsoft AppContainer 启动接口](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。具体结论以本次下载的 0.0.81 随包文档为准。

## P3.2 Windows AppContainer 原型（验证已完成，后端不通过）

新增手动 acceptance 原型三个文件：windows-appcontainer-spike.ps1、windows-appcontainer-spike.cs、windows-appcontainer-probe.mjs。未接入生产路径或 CI。固定 Windows x64 系统 AppContainer/SECURITY_CAPABILITIES，子进程以 suspended 创建并加入 kill-on-close Job 后才恢复，最多 16 个进程、单进程 256 MiB，主探针 10 秒、排空 5 秒。只对本次创建的临时目录设置 SID 权限，不修改既有用户或工具链 ACL；脚本记录具名 profile/目录并在 finally 清理，退出结果包含未释放句柄、profile 和进程排空状态。

预定验证：中文文件名、泰文 UTF-8、LF/CRLF/字面反斜杠；可写工作区与只读工具链；外部 canary 和 junction 越界；本机临时监听端口拒绝；实际子进程留存及 Job 清理。该小型探针不等同 Git Bash/PowerShell/Java/HTTPS、并发会话或所有生产入口验收。

C# 编译、PowerShell AST 解析、Node 语法检查与 diff 检查通过。静态审查修正了异常路径的原生内存释放、x64 限定、profile 删除结果记账、Unicode 精确比较，以及先授予 ACL 再创建 junction，避免准备过程意外给越界目标授权。

实际执行命令被自动审批拒绝，仅提供 blocked by policy，未给出具体命中规则；命令没有执行。已请求用户明确许可临时验证及清理。没有创建 AppContainer 或声称隔离通过，P3.2 不记为完成，P4 仍不开始。此前下载的候选目录 C:/Windows/TEMP/sp-sandbox-audit-654bff9eb68e446184de886350771fa1 仍待按该精确身份清理；原型三个文件暂不加入已通过项目的暂存集合。

### P3.2 后续授权、实测及审查（2026-10-27）

用户随后明确允许临时验证和清理。以上未执行状态为历史记录；本次共运行 6 次短探针，每次只针对已定位的启动或诊断问题，不接入 CI。先补原始 Win32 错误码，确认启动失败为 203（环境变量缺失）；显式加入 LOCALAPPDATA 后进程成功启动且 TokenIsAppContainer 为真。未继承完整宿主环境或修改现有目录权限。Windows 错误码依据：[System Error Codes](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-)；LOCALAPPDATA 的影响由本机前后对照确认。

随后采集最多 16 KiB 诊断输出，发现 Node 的文件入口解析会 lstat C:\ 并收到 EPERM。改为内联运行固定探针，未给驱动器根目录增加权限；这只使权限探针可执行，不证明普通 Node 文件入口可用。诊断句柄通过明确的 HANDLE_LIST 传递，只包含 NUL 输入和新建 fixture 日志；每次释放所有原生分配及句柄。子进程 spawn 的同步错误也写入结果，避免丢掉已完成的检查。

最终一次探针主进程退出码 0，约 402 ms；整体 passed=false，结果如下：

| 检查 | 本机观察 | 判定 |
| - | - | - |
| 工作区与只读工具文件 | 中文路径写入及泰文、LF/CRLF、字面反斜杠内容精确读回；工具文件可读 | 该固定探针通过 |
| 只读目录写、越界读写、junction 越界读 | 均返回 EPERM | 对这些已知存在目标的限制有效 |
| 本机临时 TCP 监听端口 | 连接返回 ETIMEDOUT | 仅证明未连通，不能记作明确的网络权限拒绝；验收条件已收紧 |
| 后代进程 | Node spawn 返回 EPERM，关闭前 Job 活跃进程为 0 | 子进程可达性失败，未验证活跃后代的收尾 |
| 清理 | 六次均报告打开句柄 0、profile 删除成功、Job 排空；按记录的六个 fixture 路径复核均不存在 | 本次创建的探针资源已释放 |

审查结论：手动验证工具的诊断与失败报告修正完成，C# 编译、PowerShell AST、Node 语法检查通过；未修改生产热路径，无需运行产品分配基准或整套测试。未分配进程进入 Job 时的异常清理增加显式等待，该异常分支只完成静态审查，未制造系统故障来重复测试。保留三个小型手动 acceptance 文件与结果记录以便复现，不新增 CI 矩阵、不保存完整日志或二进制产物。此项验证完成并记录，候选不具备生产接入资格，继续修订后的 P3.3；不据此退役旧访问控制。

当时的临时包清理记录：虽然用户已授权，自动审批再次拒绝了对 C:/Windows/TEMP/sp-sandbox-audit-654bff9eb68e446184de886350771fa1 的具名删除，仅返回 blocked by policy。命令未执行；当时只读复核该目录有 215 个文件、21,404,235 bytes（约 20.4 MiB），无 reparse point。本任务未换用其他方式绕过该拒绝。

清理状态更新：用户随后自行删除该目录；本次只读检查 Test-Path 返回 false，清理待办已关闭。

## P3.3.1 授权附件消费时的有效期复核

先核对现有实际路径：CodeMode/NestedToolDispatch → Agent 工具执行 → ExtensionRunner 的准备与 hook → SessionPermissionController → 单次授权消费 → 原生文件/任务或扩展执行。文件由 NativeFileInvocation 绑定准备结果并复核版本，shell 保留一个终端授权与 cwd binding；原生 shell fallback 只在没有旧授权时装配。未把有多个不同职责的校验直接视作重复审批，也未改动旧允许/询问/拒绝规则。

发现并复现的缺口：browser_exec、structured_readonly_command、subagent 的附件有序号及调用/路径检查，但消费时没有对照当前控制器版本。新增一个合并回归，修复前在“browser_exec 授权后收窄权限”处失败，确认旧附件仍可消费。

修复：三类附件统一要求即时有效性校验，签发时绑定控制器恢复代际和权限序号；消费先清除原附件，再检查授权仍有效。既有输入 hash、目录身份及调用 ID 校验保持。每个控制器只有一个弱引用，每个已批准调用一个校验回调；附件不强引用整个会话/控制器，不从历史 JSON 恢复授权。没有新增策略引擎、审批弹窗、全局任务表或模型分类器。

审查覆盖签发 → 异步审批完成 → 附件交接 → 权限收窄/恢复 → 消费成功或拒绝 → 引用释放。校验回调属于明确的单次调用生命周期；逐输出、进度、渲染及 Evidence Ledger 路径无新增闭包、Promise、AbortController、数组或文本复制。原有附件冻结及请求 hash 成本保留，未宣称全部授权过程零分配；未采用对象池。

验证：3 个权限定向检查通过，其中合并用例覆盖三类入口各自的当前/收窄/恢复状态、重复消费及附件清空；1 个 AST/source 门禁通过；既有子代理权限变化取消用例通过。类型检查、差异检查通过。复用 permission-interaction 基准增加显式 --delegation 分支，12 次测量调用加 1 个故意保留附件的调用，审批弹窗 0、计时器 0；受控 GC 后 12 个已消费附件、13 个调用上下文及控制器均不存活，未消费附件在控制器释放后拒绝并清空。最后一次主线程采样 166,080 bytes，固定上限 16 MiB；这是授权/消费样本，不包含实际工具、UI 或 worker，也不是性能提升声明。未运行原有大输入 UI 基准或整套测试，未保存 profiler 文件。

结论：P3.3.1 代码完成、审查通过并记录。此项只保证附件消费时的当前性；浏览器消费后的异步准备、子代理排队后的最终启动、运行中撤销，以及 Plan/LSP/MCP 等剩余入口的统一接入仍需后续子项逐项审计。P3.3 整体和 OS sandbox 均未标为完成，旧访问控制继续生效。

## P3.3.2a 结构化命令异步准备后的复核

真实回归在临时 Git 仓库中执行：授权并消费附件后，prepareStructuredCommand 的文件/可执行文件检查尚在等待时收窄权限。修复前 Git 仍成功启动，回归失败；修复后保留已签发的 assertCurrent 引用，并在异步准备完成、executeBoundedCommand 调用之前复核，旧授权被拒绝。当前授权的正常 Git 调用仍通过。

审查消费 → 规范化路径与 Git 元数据检查 → 可执行文件定位 → 最终权限复核 → executeBoundedCommand 的同步 Promise executor → spawn；复核至启动之间没有 await。沿用原校验回调，仅在已有返回对象增加引用字段，不新增闭包、计时器、Promise 或策略扫描，输出处理链未改变。外部文件系统路径竞争仍受既有契约限制，未据此宣称 OS 隔离或全局无竞态。

2 个定向功能检查、1 个 AST/source 门禁及类型检查通过；复用 delegation 基准覆盖完整只读 policy 返回与再次复核，12 次测量、13 次授权、弹窗/计时器 0，控制器、授权及上下文引用均释放，主线程采样 169,208 bytes（16 MiB 上限）。只有一个合并 Git 回归，临时仓库按 fixture 身份清理，未运行整套测试或新增 CI 矩阵。

结论：P3.3.2a 代码完成、审查通过并记录；下一项核对排队子代理的最终启动，浏览器异步准备与运行中撤销仍待后续子项。

## P3.3.2b 排队与准备后的子代理启动复核

新增一个合并离线回归：两个受控子进程占用队列，第三项在等待期间失去授权；修复前它仍启动并完成。修复后在取得调度位置、创建提示词临时文件前、异步准备完成后的实际 spawn 前分别复核同一授权。另一个阶段在真实提示词写入完成时撤销授权，确认没有子进程 ready marker。未触发全局取消事件来掩盖消费后的权限版本缺口。

各 task policy 只保留同一批次已签发的校验函数引用，没有为每个子任务创建新授权回调。审查 delegation → reservation/FIFO → runManaged → runSingleAgent → 提示词临时文件 → SubagentProcessRun 构造/spawn → 结果、取消及 finally 释放；旧排队项失败后释放 reservation，既有成功和部分结果保留。后台权限变更事件仍按原生命周期取消已运行的后代；此次不把这些进程的实际停止归功于新增的启动检查。

3 个相关功能回归通过，包括旧权限事件取消和并行部分失败；4 个子代理 AST/source 门禁及类型检查通过。调用级 delegation 基准改为消费真实 task policy，测量仍为 12 次、总授权 13 次；控制器及所有追踪引用释放，弹窗/计时器 0，采样 166,648 bytes（16 MiB 上限）。进度、IPC 事件、输出处理和渲染没有新增工作，不重复运行这些未变路径的大矩阵。受控子进程及测试临时目录按既有 fixture 生命周期收尾。

结论：P3.3.2b 代码完成、审查通过并记录，下一项检查浏览器的异步准备与实际调用边界。

## P3.3.2c 浏览器异步准备与最终调用复核

离线合并回归先复现版本检查期间收窄权限后脚本仍启动的问题。修复后保留已消费授权，在版本检查自己的异步文件指纹边界复核当前代际，在工作目录准备前和进度回调后复核完整请求 hash 与调用身份。版本缓存命中也必须复核；显式用户 status 与归属清理沿用自己的生命周期，不要求旧工具授权。正常离线调用通过，版本、目录、进度回调期间收窄权限，以及回调中更改脚本均被拒绝；文件指纹等待期间撤销可阻止版本子进程启动。替身只替换进程启动，实际执行生产准备、版本和授权代码，不连接真实浏览器。

审查签发/单次消费 → 可执行文件定位 → 版本检查 → 归属目录准备 → 进度回调 → 最终 hash/代际校验 → runner 同步 Promise executor/构造/spawn → finally。最终复核到启动无 await；完整 hash 仅发生在低频调用边界，最多 16 KiB 的原始脚本限制不变。复用同一授权回调，逐输出、进度和渲染未新增闭包、Promise、AbortController 或对象池。浏览器运行中的撤销留给下一项，本项不代表隔离完成。

2 个定向功能检查（其中浏览器合并检查覆盖 6 个边界）、1 个 AST/source 门禁、类型和差异检查通过。复用授权基准覆盖两次最终请求复核，12 次测量、13 次授权、弹窗/计时器 0；受控 GC 后授权、上下文、控制器引用均为 0，主线程采样 164,472 bytes（16 MiB 上限）。一个合并回归，无真实 Chrome、额外 CI 矩阵或 profiler 产物；临时 fixture 按身份清理。

结论：P3.3.2c 代码完成、审查通过并记录，继续核对运行中撤销及剩余入口。

## P3.3.3a 调用级运行中撤销信号

运行中回归复现 browser_exec 在 /permissions 收窄后仍正常返回的问题。权限控制器现在为同一代已批准调用共享一个撤销信号；持久化权限变化、恢复会话和关闭会话时撤销旧信号。浏览器、结构化命令及子代理保留该信号，使用各自已有的终止/超时/输出释放流程。前台取消仍参与组合，后台子任务继续由会话/任务授权负责，不因父调用正常结束而误取消。成功授权自身的规则保存不改变恢复代际，避免误伤正在完成的审批；现有子代理事件监听保留兼容，未添加另一套策略或任务注册表。

审查 controller 签发/持久化/恢复/关闭 → grant 消费 → 每调用信号组合 → runner 的既有取消 → 子进程结束/输出和监听释放。新增 AbortController 仅为控制器初始化和低频权限代际更换，每个调用或批次最多一个新增组合信号；数据块、IPC、工具进度、UI 渲染无新增闭包、Promise、AbortController 或包装对象，不使用对象池。授权对象不反向强持有控制器。结构化命令的原有 runner 闭包及浏览器强制终止机制未在本项重写。

验证：permission-interaction 文件 38 项全通过（因改动涉及持久化/恢复与交互审批，扩到这一相关文件），新增一个合并回归覆盖两类工具 × 权限持久化/恢复，确认已启动调用取消且输出/abort 监听清零；浏览器全部用离线替身。复用已有子代理取消测试追加授权信号分支，真实受控子进程在两种取消来源下均退出，无迟到通知；排队/异步准备旧回归通过。1 个授权 AST、4 个子代理 AST/source 门禁、类型和差异检查通过。授权基准 12 次测量、13 次授权，采样 414,464 bytes（16 MiB 上限），授权/上下文/控制器及 12 个组合信号受控 GC 后均释放；无审批弹窗和挂起计时器。未运行整套测试、增加 CI 矩阵或保留 profiler 文件。

结论：P3.3.3a 代码完成、审查通过并记录。这证明撤销传递和已测执行器的收尾，不代表已经具备全会话“停止准入 → 等全部旧任务退出 → 开放新边界”的切换屏障；该屏障与剩余 Plan/LSP/MCP 准入仍需继续审计，OS 后端和默认配置均未切换。

## P3.3.3b shell/子代理权限切换期间暂停准入

扩展已有两个生命周期回归，确认权限事件只发出取消、立即换代时，旧进程/资源尚未收尾便能接受新任务；修复前 shell 和子代理均失败。修复只调整事件绑定：原生 shell 复用 beginSession，子代理复用 drain，沿用已有 changingSession 计数、任务取消和有界 pending 集合，等旧操作的 finally/资源释放完成后重新开放准入。重复/重叠切换沿用计数，不新建任务表或输出监听；归属历史仍可查询，不重放任务。

审查权限事件 → 同步关闭准入 → 旧 authority 撤销/队列取消 → Promise.allSettled 等待现有 pending → reservation、进程、输出与引用释放 → finally 开放准入；现有 cleanup failure 继续阻止新启动。等待只在低频权限/会话切换边界，复用的数组/Promise 受现有最多 256 个 admitted 任务限制，逐输出/进度/渲染路径未改变。此项是两个现有任务服务自己的屏障，尚不等于全会话跨入口屏障。

4 个定向生命周期检查通过（含真实受控子进程退出、旧会话通知抑制），8 个 shell/子代理 AST/source 门禁通过，类型和差异检查通过。shell 兼容导出指向 dist，初次验证仍读到旧产物；定位后只重建 coding-agent，再验证受影响路径通过。生产 shell 分配基准四种模式各 1000 块，逐块 Promise/AbortController=0、热路径历史写入=0；主线程采样分别约 6285/5341/5561/5354 bytes/块，主要为既有 buffer/解码，不作为性能改善声明。完成/失败/取消/销毁各释放 8 个资源，运行/排队峰值各 4、保留引用 0；167 个弱引用 GC 后均释放，后台历史句柄和 Windows Job/进程句柄均为 0。不重跑整套测试或完整离线构建，无新测试文件、CI 矩阵或 profiler 产物。

结论：P3.3.3b 代码完成、审查通过并记录，继续审计其他执行入口与原生准入边界。

## P3.3.4a LSP 修复目标与最终授权绑定

两项回归先复现：lsp_fix 指定外部 root 时，旧控制器仍以 Session cwd 解释相对 path，workspace-write/never-ask 因而没有拒绝真实的外部目标；runFix 对缺少授权或异步服务回复后失效的授权也没有最终写入门禁。现在按 LSP 一致的 root/path 规则评估完整目标，为每次 lsp_fix 签发原有单次文件附件，并附当前代际回调和共享撤销信号。工具入口在任何异步加载前消费授权、保存已批准参数的调用内快照；runner 在读取/获取服务前及最终同步写入前复核规范目标和授权，异步等待中的撤销交给已有 lease discard 流程。

Windows 回归额外暴露同步 realpath 与异步 realpath 对 8.3 短路径的不同表示；最终检查采用 realpathSync.native 与控制器的原生规范路径一致，不用大小写模糊匹配或重新解析授权目标来放宽边界。缺失授权在加载服务前拒绝，复用/失效/目标替换拒绝，当前授权写入及既有 preview 仍通过。无控制器的独立 LSP 写入现在明确要求授权，preview 可继续使用。

审查控制器目标评估/签发 → 参数快照/单次消费 → route → pool acquire/异步诊断与 action → 最终检查 → 同步 write → didClose/release/discard。新增快照和信号组合仅限调用启动，不增加 LSP 通知/扫描、工具进度或渲染的分配。授权检查复用同一函数，未添加政策分类器、重复审批或对象池。此项不解决原有直接写入的内容冲突/元数据保留，也不将已有宿主 LSP server 声称为隔离服务，后续继续处理。

3 个相关功能检查通过（新增 2 个合并检查，覆盖实际入口缺失授权、外部 root、单次消费、恢复撤销、当前/失效/错误目标写入），1 个授权 AST 和1 个 LSP 扫描 source 门禁通过；根类型检查、LSP 包类型检查及核心声明重建通过。授权基准加入 LSP，16 次测量/17 次授权，采样 304,528 bytes（16 MiB 上限），授权/上下文/控制器/16 个组合信号 GC 后均释放，弹窗/计时器 0。复用已有测试文件、离线 fixture 和基准，无整套测试、新 CI 矩阵或 profiler 产物。

结论：P3.3.4a 代码完成、审查通过并记录；继续核对 LSP 等待期间的内容冲突及原生提交接入。

## P3.3.4b LSP 写入复用原生提交与有界读取

扩展上一项合并回归，复现 LSP 服务等待期间文件被改为新内容，旧 writeFileSync 仍覆盖该内容。runFix 现于服务请求前保存文件身份、原内容 hash、父目录身份及原生元数据能力，提交时复用 commitPreparedFile；源内容/身份变化时保留新内容并返回 not_committed，原生已提交或未知状态沿用结构化 receipt，不宣称自动回滚。结果达到 4 MiB 上限后拒绝再写。平台/元数据不受原生提交支持时明确拒绝，不回退到旧直接写入；写入能力当前限已支持的 Windows/Linux x64，preview 保持可用。LSP 变更目录展示与长期服务实例归属仍待后续整合。

审查还修复了等待 pool.acquire 期间取消的 lease 收尾：旧 abort 回调当时没有 lease，获得 lease 后又因 aborted 跳过 release；现在 finally 必须等待 discard，已开始的 discard Promise 只发起一次，提前观察拒绝并在 finally 报告。扩展合并回归验证 acquire 中取消后没有写入且 discard 已完成。

完整调用链：已批准目标/参数 → 限长源读取与原生 plan → LSP acquire/诊断/action → 取消/目标复核 → 原生准备/内容复核/发布 → receipt → client lease 与文件资源释放。源读取由先 stat 后无限 readFile 改为一份文件调用所有的 size+1 Buffer（最大 4,194,305 bytes），逐 readSync 循环无新闭包/Promise/AbortController/包装对象/数组，fd 在所有退出路径关闭。原生提交仍只在低频文件调用边界配置 hooks；原文与编辑结果为必要单份文本，不额外保留完整预览。未改变 LSP 通知、工具进度、UI 渲染或对象池策略。

验证：LSP 共享读取受影响，运行该相关文件 21 项全部通过（约 8.4 秒）；其中合并回归覆盖当前/缺失/失效/错目标/并发修改/acquire 取消。2 个 LSP AST/source 门禁、1 个原生 worker source 门禁、2 个已有提交终态检查、根与 LSP 类型检查通过。复用 native-file-commit 基准增加显式 --lsp-fix 分支：仅 2 次 4 MiB 离线生产 runFix，使用原生提交和读回；主线程采样 10,691,744 bytes（总上限 32 MiB），12 个授权/客户端/结果等弱引用 GC 后全部释放，释放后的 ArrayBuffer 增量 22,256 bytes（上限 1 MiB），文件/原生句柄和 pending=0，worker 已释放。原生发布尝试 2 次、队列峰值 1。采样不包含原生分配器/worker 堆，不把两次计时作为性能改善证据。

测试直接扩展既有合并用例，新增的读取 AST 门禁及可选基准不引入 CI 矩阵或大数据文件；fixture/原生 worker 按身份在 finally 清理，未保存日志或 profiler 文件。审查与差异检查通过，P3.3.4b 记录完成，继续剩余统一授权/Plan/MCP/服务生命周期入口。

## P3.3.5a 原生执行切换协调器（2026-10-28）

新增 SessionExecutionBoundary 作为原生会话协调组件：最多 16 个服务级资源 owner，复用它们已有的 revoke/drain；不建立另一份任务表，不负责 allow/ask/deny。切换同步关闭准入、递增代际并撤销旧信号，随后通知所有 owner 撤销并等待收尾；只接受同步发布函数，成功后才开放新代际。重入请求拒绝而不无限排队。默认等待上限 10 秒，失败或超时保持关闭；超时仍保留未结束 owner 的准确身份，清理失败不能伪装释放成功，显式重试才能恢复。关闭与切换交叠不会发布新状态。

审查覆盖注册/容量/撤销、全部清理等待、发布抛错、重入、截止时间、关闭交叠、失败后显式恢复及引用释放。常规 assertCurrent 是原始字段比较，无闭包、Promise、AbortController、包装对象或数组；信号、计时器、Promise/有界数组仅出现在命名的初始化/切换/关闭边界，不接入逐输出与 UI 路径，不使用对象池。清理超时期间只保留至多 16 个服务 owner，不丢弃仍未完成的清理身份。

验证：在既有 permission-interaction 中新增 2 个合并用例，包含容量上限、当前/旧代际、revoke/drain/publish 失败、超时、关闭交叠、失败关闭保留 owner 等分支；1 个 AST 门禁和根类型检查通过。复用现有基准增加 --transition，3 万次准入检查、3 次切换场景、10 次 owner 撤销/收尾；15 个跟踪引用受控 GC 后全部释放，计时器 0，主线程采样 124,256 bytes（4 MiB 上限）。测试与采样只覆盖协调器，不声称已协调实际工具或系统进程；无新测试文件/CI 矩阵或 profiler 产物。

结论：P3.3.5a 组件实现、审查与记录完成。下一项将它接入真实 runtime 的准入及现有资源 owner，再接 Plan；尚未改变产品的模式切换行为。

## P3.3.5b Runtime、原生文件与命令 owner 接入（2026-10-28）

每个 ExtensionRuntime 现持有一个协调器，失效时启动关闭。原生文件/命令只注册服务 owner，继续使用各自已有的 inFlight、pending、scheduler 和进程清理机制；普通工具入口、每次异步 hook 返回、授权交接以及原生文件操作检查当前代际。直接调用原生命令管理器也检查准入。审查补上辅助授权 consume/release 回调之后及最终 shell 授权返回后的代际复核，防止回调内开始切换仍交付旧调用。清理失败保持关闭，不发布新边界。未为输出 chunk 创建新对象或第二份任务表。

完整调用链核对覆盖 runtime → runner/hooks → 私有最终授权 → 文件 revision/commit/receipt 与 shell cwd/调度/子进程 → 原有 pending 收尾；边界检查只比较原始字段，低频服务注册/切换/关闭复用已有收尾。终止与 runtime.invalidate 交叠复用 owner 的 reset/dispose，不宣称所有扩展或会话前台已经纳入屏障。

验证：扩展现有 native-file-service 合并用例，8 个准入调用、5 次读尝试、1 次切换，证明等待旧 read、拒绝旧写入/新准入、恢复后读取正常；25 个跟踪引用 GC 后为 0，采样 2,443,640 bytes（原有 16 MiB 上限），pending/inFlight 为 0。background-shell-tasks 中 2 个定向用例验证真实子进程退出后才发布、禁止直接准入、旧最终授权和跨切换异步 hook 拒绝；最初发现测试装配遗漏原生 tasks 定义，按生产装配修正后通过（约 1.1 秒），并非放宽生产检查。

2 个相关 source/AST 门禁、4 个 shell 热路径门禁、核心构建与根类型检查通过。已有 shell 基准保持 4×1000 输出量，逐 chunk Promise/AbortController=0；4 种收尾场景各释放 8 项，167 个跟踪引用全部释放，原生 job/process 句柄均为 0。采样每 chunk 约 5.3–6.2 KiB，包含已有文本解码/截断，不据此宣称性能提升；未增加 CI 矩阵、数据文件、日志或 profiler 产物。现有 fixture 按记录身份清理，没有新增过期测试。

结论：P3.3.5b 实现、针对性验证和审查完成。下一项接入未交付授权/权限控制器以及其他执行 owner；未把普通自定义工具的最后执行边界、Plan、整个 P3 或 OS 隔离标为完成。

## P3.3.5c 权限 owner 撤销、交互收尾与引用释放（2026-10-28）

ExtensionAPI 增加可选 registerExecutionOwner 服务注册入口，使用扩展路径命名空间及协调器原有 16 项总上限；名称最长 80 字符，重复注册拒绝，工厂初始化失败只移除该次注册。旧独立 host 可缺省此 API，但不能据此声称支持完整会话切换。权限控制器注册一个 owner：切换撤销已签发调用、递增权限代际、取消旧审批，等待当前 select/input 返回后才允许协调器发布；只保留一个交互 Promise，finally 清空，不建立调用历史表或等待队列。权限模式、工作区和白名单本身不由这一步修改。

完整链路审查覆盖扩展加载/失败回滚 → 权限请求及确认 → 一次性授权/取消信号 → 切换/关闭 → UI 等待与引用释放。已有普通 shell、浏览器、结构化命令、子代理及 LSP 的授权代际检查继续生效。普通无超时扩展 hook 的完整收尾及已运行服务仍需各自 owner 接入，这里不把权限撤销等同于所有进程已经退出。

首次释放基准发现旧未消费授权虽只弱引用签发者，取消 signal.reason 中 V8 延迟 CallSite 仍强引用权限控制器。一次内存内堆引用分析确认路径为旧输入 → grant → revocationSignal → Error → CallSite → 控制器；没有写入堆快照文件，诊断代码已移除。权限取消原因现显式保存消息字符串堆栈，保留 Error 类型/消息，不保留实例调用栈。修复后旧授权仍拒绝消费，控制器、授权、上下文和组合信号受控 GC 后均释放。

验证：7 个相关交互/代际/工厂失败用例通过（约 0.8 秒），包括取消后仍迟到的确认不能生效、实际交互未返回前不发布、设置保持不变、旧/新授权和既有人类等待预算；根类型检查通过。沿用 --delegation 原有 16 次测量授权及 1 个未消费授权，仅加入 4 次切换，采样 66,016 bytes（16 MiB 上限），关闭后 owner/计时器/存活跟踪引用为 0。原有 UI 基准固定 100 次测量审批（另 10 次预热）、2200 次 render，采样 277,360 bytes，单计时器峰值 1，结束时计时器/提示 owner/跟踪引用均为 0。未扩大工作量上限或增加 CI 矩阵/测试文件/磁盘产物；没有对象池或逐输出分配变更。

结论：P3.3.5c 实现、复查、释放回归与记录完成。继续接入真正执行中的子代理、浏览器及其他服务 owner，再处理前台/Plan 发布入口；P3 总体验收仍未完成。

## P3.3.5d 子代理启动准备与实际任务统一收尾（2026-10-28）

子代理通过同一服务注册 API 接入协调器。撤销同步阻止新提交/转后台/steer，取消当前 authority 和现有任务；收尾复用 pending/scheduler/进程树 owner，清理失败拒绝发布。审查发现旧 pending 只包含已开始的批次，未涵盖模型路由/认证准备及项目 agent 确认；现于调用准入创建一个 preparation deferred 放入同一个 pending 集合，在交接时由原批次 operation 替换，提前失败时 finally 删除并完成。集合准入沿用 maxTasks 上限，无新增任务表、无排队重试；项目 agent 确认传入现有取消信号并在返回后复核。

完整链路：工具参数/配置/当前委派 → 有界启动准备/调度预留 → 路由与用户确认 → 队列内权限复核 → 原有 prompt 文件/子进程 owner → 输出解析/保留/前台发布 → 进程退出、预留与 pending 释放。新增 Promise 只出现在显式调用准入（一项一个），替换或提前失败后立即释放；未进入 onStdoutData/processLine/progress/render，也未新增逐输出控制器、快照、序列化或对象池。超时仍由协调器保持关闭并保留原 owner，未完成的准备不能被称为已停止。

验证：4 个原有相关生命周期/取消用例及新增合并用例定向通过；随后扩展既有 Windows 清理失败回归，确认不发布且保持关闭。新增合并用例共 4 次调用、3 个 preparation deferred、2 个真实离线 fixture 子进程、1 次切换，旧准备结束前不发布，旧子进程已退出、过期/切换期间调用没有启动记录，新调用恢复；4 个输入弱引用 GC 后全部释放，关闭后协调器 owner=0，主线程采样 2,005,504 bytes（16 MiB 上限）。失败 fixture 已按既有方式收尾准确记录的进程。

4 个 subagent AST 门禁、根类型检查和差异检查通过。原有固定基准的 8/16/64 个进程解析对象各处理总计 1000 次更新，采样约 8.5–8.8 KiB/update，快照/完整消息序列化均为 0；344 个结果/任务引用与 768 个前台引用回收后为 0，父监听器/迟到发布/交接计时器为 0。该基准不执行真实外部 agent，真实子进程只来自上述有界 fixture。不新增测试文件、CI 维度、日志或采样文件。

结论：P3.3.5d 代码、审查、定向验证与记录完成。浏览器/LSP 等服务和前台/Plan 的完整切换仍在后续队列。

## P3.3.5e 前置核对：浏览器收尾事实与过期测试夹具（2026-10-28）

浏览器接入前审查发现，runner.finishTermination 在终止等待到期时可调用 settle，即使尚未观察到 helper 的 close；现有返回值也没有独立的清理确认事实。index 的 shutdown 在 activeRuns > 0 时只记录延后清理意图并返回。因此不能直接把现有 shutdown 注册为完成屏障。后续必须先补齐“已观察到退出/清理未确认”的结果及失败处理，再纳入实际调用、版本检查、临时标签清理和 release 命令的等待；只处理已记录的 helper/workspace/tab 身份，不扩展到用户其他浏览器窗口。

定向回归发现 tool-reliability-recovery 的旧假 host 缺少已使用的 events，导致整个文件在用例开始前失败；浏览器假授权仍返回 undefined，也落后于当前一次性授权接口。现复用真实 EventBus 并在文件结束清理，假授权只补足取消信号和检查方法，继续保留原测试的失败结果、活跃调用期间不删目录、准确标签归属及有界清理断言。没有删除这些有效回归，也未新建重复测试；原定向用例恢复通过（约 0.9 秒）。此处仅完成前置审查和过期夹具维护，浏览器生命周期改造尚未完成。

## P3.3.5e1 浏览器 helper 退出与清理事实（2026-10-29）

BrowserUseRunResult 新增 cleanup（complete/unconfirmed）及 exitObserved。普通完成只证明本次 helper 已退出；不把持续存在的浏览器/daemon 视为已关闭。取消/超时只有观察到根进程 close、确认进程树终止且终止辅助进程已 close 才返回 complete；终止器失败、等待到期或 POSIX 只能停止根进程都返回 unconfirmed。启动前已取消则无进程需清理，complete 且 exitObserved=false。返回事实不因迟到事件而修改。

逻辑返回后立即清空输出缓冲、调用 resolve/reject、取消监听器和所有计时器；未观察到 close 时仅保留准确的 child/terminator 引用与稳定 error/close 观察器，避免迟到 error 无人处理。物理 close 到达后再释放这些最小引用。同步终止器启动异常和 kill 异常不会逃出生命周期回调；不能证明的清理仍返回 unconfirmed，不据此重试或扩大进程清理范围。

完整链路审查为 runner 准入/spawn → stdout/stderr → BoundedStream → 终态文本 → 截止/取消 → 平台终止及 close → 逻辑与物理释放。输出回调没有新增闭包、Promise、AbortController、包装对象或数组；append 忽略空 chunk，避免空事件扩大原有 chunk 数组。正常 Buffer 输入继续使用原有有界保留和一次终态拼接；字符串输入的 Buffer.from 与终态 Buffer.concat 属既有分配，没有声称消除此成本。新原始状态字段仅在生命周期更新，无对象池。

验证复用 tool-reliability-recovery：一个合并场景测试含 9 种有界虚拟进程场景、8000 次输出更新、每流保留上限 8192 bytes；3 个热方法 AST 门禁、39 个进程/信号/回调/结果弱引用 GC 后为 0、计时器 0；主线程采样 5,724,416 bytes（含 VM 夹具，16 MiB 上限，不作为生产每事件分配或性能改善结论）。另一个用例启动且收尾 2 个本地 Node helper 验证真实普通退出/超时，另覆盖未启动即取消；没有浏览器连接、文件或日志产物。两用例约 1.4 秒，根类型检查和差异检查通过；更新 3 处旧测试结果形状，不新增测试文件/CI 矩阵。

结论：e1 实现、审查、验证与记录完成。下一项让浏览器服务消费清理事实、等待实际调用并注册协调器；本项尚未把旧 shutdown 当作完整屏障。

## P3.3.5e2 浏览器服务切换、关闭与失败封闭（2026-10-29）

浏览器服务注册原生执行 owner，统一覆盖 browser_exec、版本探测、显式 release 及已记录标签/目录清理。只允许一个普通执行/控制调用，拥有一个 idle-to-busy 完成 Promise；清理和 drain 各复用一个共享 Promise，无第二份任务表、后台轮询或无限排队。撤销先暂停准入并取消当前执行信号，收尾等待准备、实际 helper 与已有清理结束，然后关闭本任务临时标签并移除本实例准确记录的工作区。session_shutdown 同样等待收尾且永久关闭旧实例。

所有 helper 都经过同一个结果检查。cleanup 未确认时锁定服务、保留目录及标签归属，停止继续发起 helper 或自动重连；版本探测不能缓存未知清理结果，工具详情和错误文本保留清理事实，未知状态不再读取截图。已确认进程退出但临时标签未清完时也拒绝发布；后续显式切换重试只能清理该实例自己的记录，不会移除其他 owner 保留的目录。取消错误使用纯消息堆栈，避免旧信号保留服务实例。审查还将 runner 的“已有 PID、spawn 事件尚未到达”错误按可能已启动处理，不能当作完全未启动而释放物理观察器。

完整调用链核对：授权/参数/服务准入 → 模块与可执行文件准备 → 版本 helper → workspace → 执行 helper/有界结果与截图 → 共用清理 → mode drain/shutdown。新增 Promise/信号组合仅属于准入、控制命令、agent_end 清理或切换边界；逐 stdout/stderr、进度与 UI 渲染无新增回调/Promise/控制器/容器。原有最多 8 个工作区、8 个任务临时标签和 5 秒清理截止时间保持有界；不建立对象池、不宣称持久浏览器/daemon 已被停止。

验证复用原有浏览器合并测试：3 个离线服务、23 次受控 helper 调用、8 次标签清理、移除 4 个本实例目录；分别验证主执行/版本/status/release 等待、迟到结果、关闭后拒绝、未知进程清理及可恢复的标签清理失败，均不提前发布。15 个服务/回调/工具引用在释放隔离测试 host 后 GC 为 0，主线程采样 1,165,464 bytes（8 MiB 上限）。失败状态持有 owner 的事实在释放 fixture 前另有断言，未将其称为成功清理。2 个原有真实权限撤销/最终复核用例、版本缓存/部分结果回归、e1 的 AST/迟到退出回归、根类型检查和差异检查通过；全部为有界定向运行，无新增测试文件、CI 维度、真实浏览器连接或日志产物。

结论：e2 实现、审查、验证和记录完成。浏览器服务已纳入协调器；下一项转向 LSP/其他服务的执行与长期实例收尾，前台/Plan 尚未开放新切换入口。

## P3.3.5f1 LSP 进程退出事实与服务池保留（2026-10-29）

审查发现旧 LSP shutdown 在发送 SIGKILL 后直接删除子进程引用，服务池先移除客户端再吞掉 shutdown 拒绝；这不能证明退出。现仅在实际 close（含管道关闭）后释放进程与稳定监听器；共享一次关闭操作，协议关闭、TERM、KILL 各自有界等待，失败返回 LSP_CLEANUP_UNCONFIRMED 并保留准确进程身份与迟到 close/error 观察。服务池只有清理成功才删除 entry，初始化、discard、空闲回收和整体关闭均复用此规则；失败关闭准入，显式清理重试后才能 reopen。最多保留 8 个工作区服务，不因失败无界新增服务。

完整审查链：pool acquire/初始化/lease → 协议 stdout/解析/诊断通知/settle → release/discard/idle/shutdown → 实际 close 与引用释放。顺链修复每条诊断通知重建 settle 回调和 waiter 数组；只在一次诊断等待初始化时创建稳定回调。分帧拼接不再创建 Buffer.concat 参数数组，完整帧复用输入 Buffer，残帧仅分配限长拼接 Buffer。解析对象与每个文档的最新诊断为必要协议内容，文档缓存上限仍为 256、接收缓冲上限仍为 8 MiB+64 KiB；未引入对象池或每条通知的 Promise/AbortController。

既有测试文件内一个合并回归覆盖正常关闭、exit 早于管道 close、信号抛错、关闭超时、迟到 error/close、启动失败、并发关闭共享、服务池失败保留/重试/容量/空闲失败；2000 次生产通知、2 个 settle 回调、计时器峰值 2/收尾 0、18 个弱引用 GC 后全部释放。采样 9,135,752 bytes（含 VM fixture、16 MiB 上限），不作为跨运行性能改善结论。9 项既有真实协议/入口检查、3 个 LSP AST/source 门禁、根与 LSP 类型检查、差异审查通过。复用现有离线 fixture 与测试文件，无新 CI 维度、日志或 profiler 文件。

结论：f1 实现、审查、验证并记录完成。本项确认直接启动进程与管道的退出，不将独立 daemon 或脱离的后代算作已清理；下一步继续会话私有 LSP owner、调用准备/取消和进程族边界，尚未开放 Plan 切换。

## P3.3.5f2 LSP 会话归属、调用撤销与进程族收尾（2026-10-29）

LSP 服务池由模块共享改为每个扩展实例独立持有，注册一个 lsp owner；最多 8 个活动调用，复用一个忙闲周期 deferred，不建立另一份任务表。准入覆盖懒加载前后的准备阶段，撤销立即取消调用并启动服务关闭；drain 等待旧调用、启动和进程收尾，成功后才恢复准入。关闭失败保持暂停，显式重试；session_shutdown 永久关闭该实例。诊断和导航补齐 acquire 期间取消后的租约回收，观察并等待原 discard，不再留下未等待的清理 Promise。

Windows 启动复用现有 WindowsShellJob，增加内部包出口而不复制进程管理器；宿主先归入 Job，再启动服务，退出时确认所属后代退出。POSIX 服务使用自己创建的进程组，终止及探测失败保留未确认状态；这不是防止恶意脱离进程组的 OS 隔离能力。服务退出不能代替外部已存在 daemon 的归属证明。启动期间关闭还需等待实际 launcher 返回并收尾，撤销信号传给原启动门禁，避免晚到的进程落在已完成关闭之后。池关闭先取消初始化中的服务请求，再等待初始化结束，避免等普通请求超时才开始收尾。

审查覆盖 extension 懒加载/准入 → pool 初始化/共享租约 → diagnostics/fix/navigation → 协议等待/取消 → Windows Job 或 POSIX 进程组 → 管道 close → owner 重开/永久关闭。诊断稳定计时器改为 refresh：合并回归的 3000 次通知只有 3 个 settle 回调及 3 次 settle 计时器创建，峰值 2、结束 0；24 个引用 GC 后释放。服务级回归覆盖两个会话、4 次 acquire、3 次切换尝试、晚到 acquire、清理失败不发布及显式重试、旧实例关闭拒绝；实测 Windows 所属后代退出，另一会话服务仍存活，清理后 14 个工具/池/客户端引用全部释放。两项主线程采样分别 11,615,800 和 11,655,000 bytes，均低于各自 16 MiB 上限；包括 fixture/编译及启动开销，不包括子进程堆，不宣称零分配或性能提升。

本项最终运行现有 LSP 相关文件及 AST/source 门禁共 27 项，全部通过，约 10.3 秒；根/LSP 类型检查、核心声明重建和差异审查通过。仅增加既有文件中的合并场景与原协议 fixture 的受控后代模式，无新测试文件、CI 维度或 profiler 产物；资源按本次 fixture/进程身份清理。原剪贴板桌面验收继续保留待办。

结论：f2 实现、审查、验证并记录完成，LSP owner 已接入。下一项继续 MCP/其他服务与前台完整收尾，之后才接 Plan，未把 P3 整体或新的默认隔离后端标为完成。

## P3.3.5g1 MCP 调用与连接清理状态（2026-10-29）

MCP runtime 现在将连接准备及真实 SDK 调用一起纳入有界调用计数（最多 16），使用一个忙闲周期 deferred。close 立即撤销准入和进度，但不提前 clear 活动调用；调用自己的 finally 才释放记录，关闭等待调用及连接准备实际结束。连接、transport、OAuth 清理并行启动并全部等待，仅释放成功项；连接失败保留 client/transport，protected refresh 仍等待原子写入和文件锁释放。错误只返回固定 MCP_CLEANUP_UNCONFIRMED，不带服务端秘密。生命周期 begin/shutdown 不再吞掉清理错误或先丢弃 current/starting；失败 owner 保留供显式重试，成功清理才设置 cleanupComplete 并释放。

完整审查覆盖工具准备 → 共享连接/SDK call → 进度 → 取消 → SDK/transport/OAuth close → 调用 finally 与 owner 释放。新 deferred/信号组合只在调用准入或关闭边界，不改逐进度回调。取消错误改为固定已物化 stack，防止外部仍持有已取消信号时，经 V8 延迟 CallSite 保留 runtime/上下文。合并回归含 2 个已准入调用（含连接准备）、1000 次进度、1 个 idle deferred；已取消信号仍被测试保留时，7 个 runtime/生命周期/客户端/上下文引用 GC 后全部释放，采样 754,752 bytes（4 MiB 上限）。失败 owner 在重试前明确仍被持有，未把取消当作远端操作已回滚。

调用/凭据刷新相关文件 21 项通过；4 项现有后台发现/替换回归及 3 项实际 SDK 边界回归通过，其中固定 10 万次进度通知仍为逐通知 Promise=0（约 4 秒）。根类型与差异检查通过。只扩展既有合并场景并更新旧测试中“忽略关闭失败”的预期，无新增测试文件、CI 维度或产物。

结论：g1 代码、审查、验证和记录完成。本项仍依赖 transport 对 close 的报告，尚未把 MCP stdio 进程退出或远端实际执行停止作为已验证事实；下一项核对传输层并接入 MCP owner，之后才进入前台与 Plan。

## P3.3.5g2 MCP stdio 进程族与实际退出确认（2026-10-29）

核对仓库锁定的 SDK 1.32.1 源码：原 StdioClientTransport.close 在 SIGKILL 后不再等待实际 close，不能作为完整收尾证明。新增很小的 OwnedStdioTransport 适配层，继续使用 SDK 有界解析、协议校验及发送；只接管进程启动、稳定监听器和退出等待。Windows 复用原 WindowsShellJob，POSIX 使用本次启动的进程组。启动和关闭交叠时等待原 launcher 返回并清理，结束前确认根进程/管道及所属进程族，失败保留 owner 和固定错误；根进程迟到退出不覆盖进程族清理失败。

沿用锁定 SDK 自己使用的 cross-spawn 解析器处理 Windows 命令、脚本和参数，缺少所需接口时拒绝启动。原 WindowsShellJob 只增加可选 windowsVerbatimArguments 转发（默认 false），以保留解析器已完成的转义；不另建终止器。实际协议 fixture 验证直接启动的正常退出及 .cmd 启动的强制收尾，空格、&、引号和日文参数原样保留，两个所属后代均退出；Windows Job/process handle 计数回到 0。共享 launcher 的原 LSP 协议回归通过。

审查链覆盖 command 解析 → Job/进程组 → SDK stdout/readBuffer/processReadBuffer/校验 → 原请求分发 → 关闭与迟到事件 → handle/listener 释放。交付回调保持稳定，正常消息路径不新建 Promise/AbortController/闭包或包装数组。既有测试文件内合并 AST、晚到启动、未知收尾及 GC 回归：1000 条生产适配层消息逐条 Promise=0，保留已取消启动信号时 3 个 transport/child/callback 弱引用全部释放。首个 4 MiB 预算失败后定位分配主要来自 SDK 的 Zod 校验，因此用相同 1000 条消息直接经过原 SDK parser 作为对照，保留完整校验；最终采样适配层 8,072,192 bytes、原 SDK 8,546,240 bytes，门禁为总量 <16 MiB 且不超过同次 SDK 基线+2 MiB，不以这次差值宣称性能提升。

两个合并检查约 2.6 秒，根类型、核心重建和差异审查通过。无新测试文件或 CI 维度；真实协议与 .cmd fixture 仅在本次记录的临时目录创建并清理，无日志/profiler 文件。POSIX 仅有实现与静态审查，本机未执行其真实 OS 验收；远端 HTTP/SSE、外部已存在 daemon 也不纳入本项退出证明。

结论：g2 代码、审查、验证并记录完成。下一项继续 HTTP/SSE 的本地连接收尾、MCP owner 接入，然后处理前台与 Plan。

## P3.3.5g3 MCP HTTP/SSE 本地响应与读取器收尾（2026-10-29）

SDK HTTP/SSE close 主要发送 abort/关闭 EventSource，不代表自定义 fetch/OAuth 或响应读取器已结束。现为每个 fetch adapter 建立一个本地 HTTP owner，准入时限制 pending 请求与存活响应之和不超过 32，复用一个请求忙闲周期 deferred；响应只创建一次原有有界读取器，结束时释放 reader lock、body 和 owner 引用。关闭同步拒绝新请求、撤销正在等待的 fetch，并等待晚到 response、全部已持有 reader 的取消、上传重试分支与请求 finally。原始 body 取消或 reader 取消失败会保留准确身份并拒绝完成，不吞掉错误后宣称已关闭。

连接 state 保留 fetchOwner，和 SDK client、transport、OAuth 一起收尾；只有确认成功才清空相应引用。保护中的 OAuth 刷新仍由原 owner 等待原子写入/锁释放，不中断或伪装事务回滚。未知 body 取消首次失败即关闭准入，只允许当前有界已准入批次增加失败身份记录，不接纳新的请求。这里证明的是本地请求/读取器结束，不能证明远端已执行的操作被取消或撤回。

完整审查覆盖 HTTP/SSE SDK → 自定义 fetch/header/一次 OAuth retry → 限长响应 → 每块检查/读取 → 结束/取消 → reader/tee/受保护刷新 → state 清理。chunk/check/pull/finish 四个 AST 门禁无新增内联闭包、临时对象/数组或 new Promise/AbortController；Web Streams 原有异步读取保留，新 owner 状态只在请求/响应启动及关闭边界创建，不为每块建立另一份等待记录。

既有生命周期文件内一个合并回归覆盖 5 个响应（晚到、晚到后取消失败、持有 SSE、reader 取消失败、完整读取）、1000 个块、4 次取消；测试仍保留全部已撤销 fetch 信号时，16 个 fetcher/body/reader/response 引用 GC 后释放。采样 7,067,176 bytes（含 Web Streams、16 MiB 上限），不将 Web Streams 内部 Promise 计为零。3 项原后台发现/关闭真实本机 HTTP 回归、14 项凭据刷新/锁释放回归、7 项 header/Request body/401/取消回归、根类型及差异审查通过。无新增测试文件、完整 OAuth 大矩阵或日志/profiler 产物。

结论：g3 代码、审查、验证并记录完成；下一项接 MCP 服务级 owner 与准备/命令门禁，再处理前台与 Plan。

## P3.3.5g4 MCP 服务 owner、暂停与目录复用（2026-10-29）

MCP 现向会话协调器注册单个 owner：撤销立即停止新搜索/登录/管理/重载，取消启动代次、发现、远端调用及当前交互；drain 等待实际启动准备、管理界面、登录 finally、连接与请求 owner 全部结束。登录/管理操作仍先释放自身，再触发 reload，避免等待自己的 session_shutdown。启动只保留一个在途准备操作；不新增等待队列。清理失败保留原 runtime/连接身份并阻止恢复，连接导入晚到后的 owner 也必须由原连接 catch 清空才算结束。

已发布 runtime 可暂停后恢复：复用原有有界 schema/搜索目录和工具定义，恢复时只轮换连接信号，不提前连接全部服务；缓存目录搜索不联网，实际调用按需重连，未完成首次发现的服务在下一次搜索恢复发现。未发布的半初始化 runtime 则关闭，不发布旧代次。永久 shutdown 清空目录，不能再 resume；暂停和永久关闭保持不同语义。远端执行结果仍不作撤回承诺。

审查覆盖 session_start 的 import/配置/attach/publish、runtime 连接/调用/目录刷新、搜索激活、授权 UI 与 reload、自身关闭、失败重试及晚到准备。更改位于服务生命周期、显式搜索/调用准备；没有为进度事件增加闭包、控制器、Promise 或目录副本。原 100000 次 SDK progress 的 Promise=0 门禁及晚到进度检查通过。合并生命周期用例保留 2 个准入调用、1000 次更新、1 个忙闲 deferred；失败暂停拒绝恢复、重试后同一目录可用、永久关闭后目录清空；保留旧取消信号时 7 个 owner/回调引用 GC 后全部释放，最终采样 756,232 bytes（4 MiB 上限）。

复用现有 3 个测试文件：新增 2 个组合场景、扩展 1 个原生命周期场景。真实本机 HTTP 验证准备期撤销、缓存目录复用、按需重连与未完成发现恢复；命令夹具验证管理菜单和登录分别晚结束时 drain 都等待、旧 reload 被抑制，恢复后可再次登录且 reload 不死锁。相关 9 项取消/替换回归、7 项目录/关闭/命令检查、根类型检查和差异审查通过。测试调试曾误把服务器标签当作缓存身份，已根据配置指纹改为不同连接 header；未增加超时。所有临时目录由各夹具按创建身份清理，无新增测试文件或持久采样产物。

结论：g4 已完成实现、审查、验证与记录。尚需全局命令准入门禁，防止某个服务先完成 drain 时在其他 owner 清理期间接受直接命令；还需前台与 hook 的实际结束确认，再接 Plan。此项不宣称全会话切换已可用。

## P3.3.5h1 共享准入与普通工具的最终代次检查（2026-10-29）

新增只读 `assertExecutionCurrent` 原生扩展 API，复用协调器的基本类型检查，不签发新权限。浏览器实际操作入口、LSP 服务获取、子代理启动/steer/handoff、MCP 搜索/连接/调用和登录/重载使用同一门禁；原生文件与 shell 原已有此检查。服务先结束自己的 drain 不代表全局重新开放；其他 owner 仍清理或失败时，这些工具和直接命令继续拒绝执行。查看状态等不创建执行资源的入口保留。

普通工具现在也取得单次使用的代次 guard；移除 AgentSession 在“无 tool_call handler”时绕过最终检查的快捷路径。调度器沿原有 consume/release 通道检查 guard，原生修改仍保留私有参数与终端授权检查；guard 本身不作额外权限裁决。Runner 向同一协调器注册 owner，撤销时释放全部未交付授权，并继续释放其他授权，即使一个 release 抛错。准备中授权总量沿用 128 上限。内置和扩展工具共用的实际 execute wrapper 再检查当前准入，覆盖同步输入校验后边界改变及直接调用。控制器、对象/包装结果只在单次调用准备创建，进度/渲染路径没有增加工作。

完整审查链：Agent beforeToolCall → 原生/扩展权限 hook → 返回 guard → 调度器调用前 consume → 通用 wrapper → 服务入口 → 失败/revoke/release。现有 AST 门禁扩展检查 API 实现，正常准入路径无数组/对象/闭包/Promise 分配。一个合并用例验证快速服务先 drain、慢服务失败、失败后继续关闭、显式重试、普通工具旧 guard 失效、128 上限、一次消费与 wrapper 最终拒绝；10000 次检查、132 个 guard/runtime/runner 引用 GC 后全部释放，采样 1,531,656 bytes（4 MiB 上限）。原协调器基准 30000 次检查/3 种结束、10 次撤销/收尾、15 引用释放、定时器归零，采样 136,880 bytes。

最小回归包括 4 项权限/共享准入、真实本机 HTTP 恢复、原生文件 owner、LSP 两会话/实际子进程退出、16 项前台 settlement（无 GC 参数的该文件原 GC 案例跳过）；根类型、LSP 类型、核心构建与差异审查通过。复用原测试文件并只增加一个组合用例；权限夹具按调度器语义消费新 guard，保留原许可断言。没有运行全套测试或留下采样文件。

结论：h1 实现、验证、审查及记录完成；无超时 hook 与超时后仍在运行的真实 handler/界面、前台停止和通用命令上下文仍需随后处理，Plan 尚未切换到此边界。

## P3.3.5h2 tool_call hook 的实际结束与晚到授权（2026-10-29）

Runner 的 owner 现在同时持有未交付授权和真实 tool_call hook。所有 tool_call（包括 timeout=0）沿同一个调用 owner：投递结束、实际 handler 结束、已准入 select/input/confirm 结束分别计数，共用一次结束 deferred。超时/取消可立即拒绝原调用，但不提前删除仍执行的 handler 或仍打开的对话框；会话切换等待实际结束，超过协调器原有期限保持关闭。机器计时仍在人等待期间暂停，timeout=0 不建立机器定时器。无法取消的 editor/custom 在该安全 hook 中统一拒绝。

handler 取消后返回的 finalAuthorization 由原 owner 释放，返回交付前再次失效的结果同样释放。释放失败（包括抛出 undefined）保留失败 owner 和授权引用，drain 不会成功。对话框的单一占用直到真实 UI Promise 结束才释放，避免取消等待后另一个菜单提前占位。每个 handler 开始前复核原代次，防止文件准备晚到后开始新的旧代次 hook。现有活动 hook 上限仍为 128，无无限等待队列；取消不能强制停止任意扩展 JavaScript，未完成就不发布新边界。

完整审查覆盖 invokeHook → 调用 deadline → UI wrappers → 真实 handler/对话框结果 → 迟到授权 → dispose/drain。构造、trackHandler/trackDialog、显式关闭属于单次拦截/生命周期边界；5 个稳定完成/释放检查体通过 AST 无临时闭包、数组/对象或 Promise 门禁，进度与渲染事件没有进入新增 owner 路径。沿用原审批基准：100 次测量、10 次预热，2200 次 render，220 次缓存构建，最大 12 行/4080 缓存字符，定时器峰值 1/结束 0，owner 和引用结束归零；存活分配采样 146,320 bytes，不声称总分配为零。

现有权限文件新增一个合并用例覆盖无超时、真实对话框晚结束、机器超时、迟到授权释放失败：4 个真实 handler、1 个 UI、4 次迟到授权释放；保留 4 个已撤销信号时，20 个 ctx/deadline/runtime/runner/grant 引用 GC 后释放，最终总分配采样 1,003,064 bytes（4 MiB 上限）。6 项既有串行/超时/取消/机器剩余计时回归、源门禁、根类型与核心构建通过。测试自身失败时也释放具名 gate 并等待已记录操作，未增加超时、测试文件或持久日志。

结论：h2 已完成实现、验证、审查与记录。剩余前台停止、非 tool_call hook/命令上下文和失败授权清理的最终复核仍需完成后，才开放 Plan 的原生切换入口。

## P3.3.5h3 已交付授权释放失败的保留与重试（2026-10-29）

最终复核发现旧 PendingToolAuthorization.release 在辅助 release 抛错时忽略错误，且先移除 owner/清空终端授权；失败重试可能丢失实际清理责任。现先撤销可消费状态，再逐个释放；成功的引用就清空，失败的精确引用保留在原来有界 owner 内，继续释放其他项，最后统一拒绝完成。文件终端授权及辅助 consume/finally 的失败同样保持原引用；终端 shell consume 成功后才交出引用。重新执行切换只重试未清理项，不重复消费/执行工具。关闭成功后解除 guard → 活跃注册表引用，保留旧 guard 的调用者不再间接保留后续调用。

释放方法使用索引遍历原数组并清空原槽位，没有新快照、历史记录或新的等待队列；增加重入标记避免 release 回调再次 release 同一 owner。AST 检查正常 release 路径无临时对象/数组/闭包/Promise。扩展原共享准入用例，验证抛出 undefined 仍算失败、其他授权继续释放、失败记录仍在、显式重试仅释放未完成项、已释放 guard 解除注册表引用：10000 次准入检查，峰值 128 个准备调用，135 引用 GC 后释放，采样 1,302,720 bytes（4 MiB 上限）。原委托基准 17 次授权/16 次消费/4 次切换后 grants、ctx、组合信号、定时器均归零，采样 231,752 bytes。

3 项权限/清理回归、2 项原生文件生命周期与修改前复核、3 项实际 shell hook（完成、拒绝、输入变化）、源门禁、根类型及差异审查通过。只扩展已有测试，不新增文件或超时，不执行 shell 副作用。结论：h3 代码、验证、审查与记录完成；继续前台/命令/其他 hook 与 Plan 的调用链整合。

## P3.3 全会话切换与 Plan（实现与审查记录）

### P3.3.5h11 拒绝授权的交接与清理责任（2026-10-29）

Plan 接入后的最终复核发现 h3 仅覆盖已接收授权：超出容量、终端授权冲突或撤销后晚到的授权，如果直接 release 抛错，可能丢失实际清理引用。现于任何原生准备/扩展钩子开始前保留调用名额（最多 128），每项最多 32 份已接收授权和 1 个被拒绝的交付槽位；拒绝后立即结束接收，不继续生产授权。撤销先禁用消费，名额保留到真实交付/finally 结束；成功释放的槽位清空，失败的精确对象留在原 owner，切换拒绝发布，重试只释放未完成项。修正第 128 个调用自身已经占用名额时，后续授权被误判为全局超额的问题。

审查完整链：AgentSession beforeToolCall → 原生文件/命令准备与 tool_call deadline → PendingToolAuthorization 接收/最终消费 → agent-loop 拒绝、取消、执行及 finally → runner revoke/drain → 协调器发布。沿用低频拦截钩子的实际活动计数与每个忙周期一个 idle deferred，覆盖原生交付和最终清理；不增加队列、历史表或逐进度/逐渲染分配。AST 检查 add、finishCollection、hasChecks、release 及完成回调正常路径无临时对象/数组/闭包/Promise，调用名额早于首个 await 建立，无对象池。

复用共享准入组合用例：10000 次准入检查、128 个待执行调用、容量/冲突/晚到三种失败交付（release 抛出 undefined）、33 份已接收授权各释放一次、3 次失败项重试；182 个跟踪引用 GC 后存活 0，活动计数与 deferred 清空。最终联动运行采样 2,233,104 bytes，定向运行 2,886,056 bytes，均在原 4 MiB 上限内；新增分配属于调用准备/收尾，不宣称性能提升。测试最初为名额边界重复执行了无关钩子，已改为只在最后一个名额安装，未放宽预算。

14 个相关用例最终通过，覆盖权限交互/晚到钩子、源门禁、原生文件、实际 Windows 命令族退出与旧授权拒绝、Plan 14 次切换及自动菜单动作；根类型、核心构建、差异检查通过。两处旧 shell 测试预期同步修正：接受明确的旧授权拒绝原因，并先释放旧钩子再等待切换，继续断言提前不发布/不启动旧命令；后者由错误等待造成的 5 秒超时恢复为约 5 毫秒。未新增测试文件、矩阵、持久采样文件或超时，临时资源仍由现有夹具按身份清理。本项实现、验证、审查、记录完成。

### P3.3.5h10 Plan 原生发布与界面收尾（2026-10-29）

Plan 的命令、工具选择后启动、启动 flag/历史恢复、保存、退出、实施及失败回退均等待 transitionExecution，旧执行确认结束后才同步发布状态/工具/提示信息。未提供原生能力的宿主明确拒绝切换；默认关闭状态启动不为此暂停所有服务。新会话 setup 已在 session_start 前完成，删除第一个 before_agent_start 的延迟恢复；明确启动新实施会话时，继承的 --plan 不覆盖用户批准的实施状态。

自动完成菜单先等待完整前台空闲，agent_settled 本身及时返回，避免菜单动作等待包含自己的收尾。正在关闭的菜单至多保留一个最新计划展示意图；新修订取消旧菜单，不积累菜单任务。新增单个 Plan owner 持有实际 UI Promise、导出写入及既有设置写入，最多 8 个活动项和每忙周期一个 deferred。切换关闭菜单/问题选择并等待真实响应，文件写入结束才放开新状态；菜单动作本身不计入它要等待的 UI/文件清理。编辑器无取消接口时保留真实等待，超时后不发布。已有菜单、导出控制器改为 await 异步动作，消除漏等待的提前关闭。

审查命令/启动 → 原生协调器 → Plan owner → RPC select/input 与 TUI custom → 实际导出/设置写入 → 状态发布/实施消息，以及准备、结束回调和新会话恢复；TUI 的 runMenu/输入提交、showExtensionCustom、组件 dispose/waitForPending 调用链一并核对。新增分配只在明确 UI/文件调用、结束与切换边界，不改变渲染/增量/工具进度；源门禁验证完成释放体无临时分配、8 上限以及所有模式切换调用被 await/返回。无对象池。

组合验证 14 次原生切换、清理失败拒绝 1 次、真实 UI 延迟结束、旧菜单关闭后展示新修订、3 种自动动作（保存/导出/丢弃）、实施交接 1 次；准备归零，保留旧信号时 4 引用 GC 后释放，最终单项采样 3,889,896 bytes（16 MiB 上限，不含模块加载）。原 regular/fullscreen 替换用例加入真实 TUI 菜单关闭和输入框内导出后切换，两种模式均完成，无自等待；新会话/分叉/恢复、旧上下文失效和最终原始输入模式/监听释放仍通过。21 项前台测试、3 项协调器/源门禁、实际 Plan+Codemode 只读授权、两项 TUI/会话替换、根与 Plan 类型及核心构建通过。

测试复用现有文件，合并场景，不扩大 CI 矩阵或放宽超时。诊断中发现测试错误使用不存在的 session.cwd 导致两次等待超时，改为真实 SessionManager 路径并补上超时应急清理；两个遗留的空夹具目录按完整路径确认后非递归删除。临时导出由各自夹具清理，无持久 profiler 文件。本项实现、验证、审查及记录完成；这完成当前已登记服务的 Plan 切换，仍不等于 OS 隔离或 P3 整体完成。

### P3.3.5h9 新会话的初始化顺序（2026-10-29）

核对 Plan 新会话恢复时发现 setup 原本晚于 session_start，迫使 Plan 在第一个 before_agent_start 才补读状态，此时 prompt 准备已开始，不能再等待自身切换。现先在目的 SessionManager 完成 setup 并检查替换代次，再关闭当前会话、创建并启动目的会话。启动钩子首次就能读到初始化后的状态；setup 抛错时当前会话仍可使用，不执行关闭。setup 的对象仍是目的 SessionManager，withSession 仍在替换完成后执行。

在原 regular/fullscreen 两个替换组合测试中加入“setup 失败不关闭原会话”和“session_start 已看见 setup 消息”断言；原 new/fork/resume、UI 重置、旧上下文失效、句柄/监听释放均通过。根类型与差异审查通过，没有新增测试文件、计时器或热路径。这项顺序修正已完成并记录；下一项删除 Plan 延迟恢复并接入原生发布。

### P3.3.5h8 原生切换与完整空闲 API（2026-10-29）

扩展 API 新增可探测的 transitionExecution 和 waitForExecutionIdle，绑定真实会话协调器与准备/前台/settlement 完成。未绑定的独立宿主明确拒绝，不回落到仅替换工具；旧 runtime 仍由既有 assertActive 拒绝。发布回调要求同步，只允许从用户命令或启动恢复等不属于被等待执行的入口调用；工具/自身 hook 不得 await 此 API。API 本身不赋予工具或文件权限。

原前台组合用例改为通过真实扩展 API 发起两次切换，并增加完整空闲仍在等待 settlement 的断言，6 引用 GC 后释放、采样 832,944 bytes。根类型与核心构建通过；审查 loader → runtime action → 会话 coordinator 和空闲等待链，没有增加事件/进度分配。本项完成实现、验证、审查、记录。Plan 调用方仍待转换，不能仅因新增 API 就标记 Plan 完成。

### P3.3.5h7 独立命令的进程族确认（2026-10-29）

独立 executeBash 现登记完整操作并检查共享准入；运行与未确认清理合计最多 8 个 owner。切换撤销既有信号，等待实际命令、输出文件和记录结束。返回事实新增 processCleanup，独立本地执行要求既有 managed 生命周期：Windows 使用 Job，完成/取消均等待所属进程计数归零和句柄关闭；POSIX 只对本次 detached spawn 的进程组发送终止并限时检查 ESRCH，EPERM/仍存在不算退出。自定义后端必须明确提供清理事实，缺失/失败保留对应 controller/backend，后续切换继续拒绝，不把旧 exitCode 或取消异常当作进程族证明；本项不增加自动抹去未知 owner 的“恢复”入口。

完整审查 executeBash → executeBashWithOperations → local operations → Windows Job/已记录 POSIX 组 → 输出清理 → 会话记录/准备释放。新增字段只在调用完成时产生；数据、输出、进度和排空回调通过原 AST 门禁，没有新增每块 Promise/控制器/闭包/包装。已有 ANSI 基准约 9 秒完成：正常输出每块约 252–257 bytes，本地双管道约 944–1036 bytes，原交互与落盘场景保留；72 个普通引用和 84 个落盘引用全部释放，1354 个测试输出文件按身份全部删除、流保留 0，4 个临时模块目录均删除。没有保存 heapprofile 或持久报告。

真实 Windows 验证 2 个带后台后代的 Node 命令，覆盖正常父进程退出及切换取消；后代均确认不存在，Job/进程句柄回到初值。组合用例另验证无清理事实的自定义取消保持关闭，准备归零，3 引用在保留旧信号时释放，采样 1,760,288 bytes（16 MiB 上限）。45 项短 shell/输出回归通过、5 项平台不适用跳过，3 项退出回归、源门禁、根类型和差异审查通过。POSIX 分支仅代码审查，本机没有实测，不宣称跨平台验收完成。本项实现、验证、审查、记录完成；下一项接入原生切换 API 与 Plan 调用方。

### P3.3.5h6 手动压缩与分支摘要（2026-10-29）

手动压缩从等待前台停止之前就登记准备，等待后核对代次；压缩及分支摘要在请求准备、实际 provider 调用和写入会话前复核原代次。切换撤销两个既有控制器并等待整个操作，包括控制器已清空后的失败 hook；同类摘要未结束时拒绝覆盖控制器。复用 h4 的计数/deferred，没有新的活动队列、进度包装或输出复制。

组合验证覆盖压缩 hook 晚结束、失败清理仍在运行、分支 hook 返回过期摘要、压缩尚在等待前台停止：3 次切换、provider 调用 0、过期提交 0、准备归零；保留旧信号时 3 引用 GC 后释放，采样 481,960 bytes（8 MiB 上限）。原 regular/非 signal 退出的压缩、树、Bash 三项回归通过；根类型、差异审查通过。最初 GC 失败源于测试 mock 的调用历史保留会话，去掉该场景不需要的 mock 历史后通过，没有放宽断言或上限。本项已完成并记录；独立 Bash 的进程族证明仍须处理，不能把 Promise 返回视作全部子进程退出。

### P3.3.5h5 低频 hook 超时后的实际清理（2026-10-29）

明确列出的拦截 hook 和结束边界现在保持实际 handler 所有权；超时 fail-open/fail-closed 的调用方语义保留，但切换必须等待真实 Promise 结束。使用 128 上限计数、每个忙周期一个 deferred 和 runner 上两个共享完成回调引用；无第二份事件队列或结果历史。session_start/session_shutdown 不参与可能等待自身的转换；message_update、tool_execution_update 及观察器未接入这条路径。前台 owner 在完整 settlement 后再次加入 hook drain，覆盖切换开始后才进入的结束回调。

审查 invokeHook → 明确事件集合 → 实际 handler → 原超时处理 → drain/稳定释放；invokeOwnedHook 是低频拦截豁免，finishHook 通过 AST 无临时分配。扩充原晚到 transform 用例验证原超时结果不被覆盖、发布等待实际完成、结束计数和 deferred 引用清空：2 个实际 hook、1 次超时、4 引用 GC 后释放，采样 335,408 bytes（4 MiB 上限）。10 项原 hook 回归、前台切换与源门禁、根类型和差异审查通过。没有新增测试文件或超时。本项完成实现、审查与记录；下一项为独立手动工作，然后接入 Plan。

### P3.3.5h4 前台准备与完整 settlement（2026-10-29）

会话向协调器注册单个 owner，切换撤销前台、重试及自动压缩，等待提示词准备、实际 agent run、自定义消息清理及 agent_settled 全部结束，再次核对 runner 的真实 hook 清理。提示词准备采用最多 128 个计数和每个忙周期一个共享 deferred；准备后及真正提交前检查原代次。直接 host operation 在任何日志写入前也检查准入。用户命令不纳入它将要等待的 prompt 准备，避免自等待。独立手动工作尚未接入时保持关闭，不声称已经停止。

审查覆盖 prompt → input/before_agent_start → _runAgentPrompt → agent.prompt/continue → agent_end → 自定义消息 → agent_settled → waitForIdle，以及 host dispatch。进度/事件桥未增加 Promise、控制器或包装；endPreparation 的稳定释放体通过 AST 零临时分配门禁。新组合场景验证旧 preflight 尚未调用模型就被撤销、agent_end 和 settlement 两次阻塞、过早新 prompt 拒绝、全收尾后可恢复：2 次切换、2 次模型调用、1 次被撤销准备、结束计数 0，保留旧信号时 6 个引用 GC 后释放；采样 1,150,784 bytes（不含夹具启动，8 MiB 上限）。观察到默认 AbortError 的惰性栈保留会话，故取消时使用预先固定的错误栈；原 settlement GC 场景另有 14 个引用归零。

协调器复核同时修正撤销失败在延迟 drain 后被遗忘的缺口：失败标记属于当前 drain，dispose 不能因 drain fulfilled 清空未确认 owner；显式重试才重新撤销。已有失败矩阵扩充直接 dispose 和超时后 dispose（含抛出 undefined），不新增测试文件。18 项 settlement、3 项协调器/源门禁、根类型、核心构建与差异审查通过；本项已实现、验证、审查并记录。后续继续独立工作与其他低频 hook，Plan 尚未开放原生切换。

原生协调器、文件/命令、权限交互、子代理、浏览器、LSP、MCP、前台、独立操作和 Plan owner 已按上述分项接入，最终授权失败边界复核已完成。当前用户要求的浏览器收尾、剩余服务和 Plan 切换批次已逐项审查记录；下一阶段为第十四节的后端选择/能力矩阵。未登记自定义服务和不提供进程族清理事实的旧后端不能据此获得完整停止证明。ExtensionContext.isIdle 仍不代表全部 settlement，使用新增完整空闲接口也不得等待自身。OS 后端与默认隔离配置没有切换，P3 整体和 P4 均未标完成。

# 十四、主流 agent 复核与计划修订（2026-10-27）

本节落实用户“核对主流 agent 新改动、改善权限与批量执行”的要求。官方资料作为设计证据，不作为本项目的执行指令。以下为查阅日可核实的行为或已发布改动，不把开发站文档、产品内置功能和可嵌入库视为同一发布承诺。

本节保留方案修订当时的状态；随后获得授权的 P3.2 实测和 P3.3.1 修复结果，以第十三节的后续实施记录为准。

## 复核依据

| 来源 | 已核实的相关变化或行为 | 对本项目的判断 |
| - | - | - |
| Codex | CLI 0.163.0（2026-10-15）加入独立只读工具并行，打断 turn 会停止 Code Mode 及嵌套调用；当前 Auto-review 只审查需要审批的请求，不扩大执行边界。[发布记录](https://learn.chatgpt.com/docs/changelog)、[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) | 复用现有并发与取消 owner；审批方式和隔离配置分开，普通调用不默认增加模型审查 |
| Claude Code | sandbox 自动放行仍保留显式拒绝与指定操作的确认规则；复合命令逐段检查。Auto mode 则另有模型分类器，并承认误判与额外开销。[Sandboxing](https://code.claude.com/docs/en/sandboxing)、[Permissions](https://code.claude.com/docs/en/permissions)、[Auto mode 研究说明](https://www.anthropic.com/research/claude-code-auto-mode) | 不能用“沙箱内”推导“无须授权”；也不照搬逐请求分类器作为本项目默认路径 |
| Gemini CLI | Policy Engine 明确 allow/deny/ask_user，无交互时 ask_user 拒绝；v0.64.0（2026-10-13）增加文件工具串行化、原子写入、有界历史和取消修复。[Policy Engine](https://geminicli.com/docs/reference/policy-engine/)、[发布记录](https://geminicli.com/docs/changelogs/) | 保留文件队列、部分提交事实与有界状态；批量性能不能靠任意写操作并行获得 |
| OpenCode | 当前 OpenCode 1 权限文档（更新于 2026-10-24）仍使用 allow/ask/deny，规则为最后匹配者生效，另有工作区外访问控制。[Permissions](https://opencode.ai/docs/permissions/) | 借鉴可解释的少量配置；不把它的匹配优先级与 Codex 的最严格匹配混用，也不把权限配置当作 OS 隔离证明 |

复合命令的具体参考是 [Codex Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)：只在可靠的简单语法范围拆解，复杂脚本按完整调用处理。本项目采用明确且可测试的匹配契约；不追求静态理解所有 shell 副作用。

Claude API 的 [Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) 支持在代码中编排工具并过滤结果、减少模型往返。这是 API 层能力，不等于 Claude Code 的批量审批实现；它支持继续使用现有 CodeMode 的方向，不为调用者免除每个工具的真实授权义务。

[Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) 已列出 MXC 和 legacy 路径，也明确 MXC 的系统条件、主命令退出时终止剩余子进程等限制。以下为 2026-10-27 的历史状态：当时本机 Windows build 为 22631，低于 MXC 要求，尚未验证可复用。2026-10-29 升级后的结果及 2026-10-30 候选复核以第十五节为准。长期后台任务的归属仍须单独适配，不能把产品支持等同于 Super Pi 已接入。

## 本次纠正的决定

原文将“删除自制危险推断”扩大为“删除逐命令授权判断”，并把独立 Windows 原型置于统一权限契约之前，均不合适。本次已直接修订第 1、3、4、5、7、8、9、10、11、13 节，保留历史实施记录以便追溯；P3.1 中“继续 AppContainer”的后续方向由本节取代，P3.2 仍未验收。

采用一个授权入口、一个实际执行上下文、原有文件/任务 owner。授权决定能否做，执行后端限制实际能接触什么，工具契约保证修改与结果正确；不再让多个扩展分别重复问同一件事。一个申请可展示多个固定操作，但不能把一段 CodeMode、一个解释器或命令首段当作无限授权。

当前源码核对：`packages/agent/src/nested-tool-dispatch.ts` 已有 4 个读取并发、256 次子调用和 5 秒取消收尾限额；`packages/coding-agent/src/core/codemode.ts` 已保留 `allowFailure` 的真实拒绝结果。P2 的 FileBatch 已有准备、复核、顺序提交与部分完成记录。此次保留这些实现，后续仅补统一授权、撤销和结果区分的缺口，不再造批量执行引擎。

## 修订后的 P3 顺序

| 子项 | 实现与审查边界 | 通过标准 |
| - | - | - |
| P3.3 授权入口与批量契约 | 先列出现有所有准入/最终执行调用链，以旧 controller 适配为唯一裁决，收敛原生接口、调用绑定和结构化原因；随后按调用类型补授权复用、固定批量展示、动态子调用复核与取消 | 每个代码小项分别审查；旧默认权限不扩大，无双重审批、无无限授权，部分结果与调用生命周期可证明 |
| P3.4 后端选择 | 只读核对受维护候选的接口、许可、版本、系统要求与能力矩阵；选择一个可接入候选，或记录明确的不可用结论 | 不把上游功能介绍当成本机验收，不继续扩大自研 AppContainer 项目 |
| P3.5 最小 Windows 接入 | 有合适候选时验证文件、shell/argv、子进程、网络与取消；同一真实生产路径验证并发会话、撤销、Plan 收窄 | 仅测试支撑实际开放能力的最小集合；失败不降级宿主，未观测不标通过 |
| P3.6 开放入口与默认切换审查 | 列出已验证和未支持入口；未覆盖服务在 sandbox 下拒绝，trusted-host 需用户明确选择；复核配置迁移 | 每个可用入口有实际边界证据；可以分期扩展，不能保留宿主旁路或把缺失后端标为 sandbox 完成 |

原定 P3 → P4 → P5 → P6 → P7 顺序继续适用，例外为用户在第十六节明确批准提前执行的两项 P4 行为策略简化、第十八节的 P5.1 工具目录与状态读取、第十九节的 P5.2 显式选择模式、第二十节的 P5.3 提示词结构化、第二十一节经用户授权逐项收口的 P5 剩余工作，以及第二十二节用户批准提前推进的 P6 Provider 请求与压缩整合。每项实现、验证、审查、记录完成后再进入下一项。后端不可用不自动跳过默认 sandbox 验收门槛；P4 的访问控制退役继续受前述依赖约束。

## 性能、测试与本项审查记录

权限规则的编译/解析限定在配置变化或实际调用准备阶段，缓存有容量与版本失效边界；不缓存过期的最终授权或路径身份，不在每条进度、输出、渲染和 Evidence Ledger 查找上重新解析命令或调用模型。触及热路径仍逐条满足 [分配契约](performance/hot-path-allocation-contract.md) 的 AST/source 门禁、确定性计数、分配采样与引用释放证据，不用缓存或对象池掩盖完整调用链成本。

优先改写已有测试、合并重复矩阵；保留拒绝、撤销、输入替换、部分完成与释放等不同故障。新增测试须对应未覆盖契约。以现有 CI 每个 job 30 分钟上限为基线，达到 24 分钟（80%）就先检查慢项、重复测试与未结束资源，不直接增加超时；真实 OS 验收保留显式入口，不重复塞入每个单元测试组合。此阈值是本项目的治理约定，不是上游规定，也不表示已经增加自动监控。

审查范围：官方证据与推断分开、复合命令与授权聚合无整体放行、兼容 allowFailure、不扩大旧权限、P3/P4 依赖一致、测试和资源有界。本段保留 2026-10-27 方案修订时的历史状态：当时 P3.3 及后续生产实现尚未完成，只检查文档差异和空白错误，没有执行被拒绝的实验或清理。后续 P3.2 清理及 P3.3 实现以各自审查记录和当前状态表为准；P0 桌面验收仍由用户明确保留待办。

# 十五、P3.4 受维护后端选择与能力矩阵（2026-10-30）

## 版本、环境与选择

本机 Windows 11 26H2 build 26300.9711 已满足上游列出的 ProcessContainer 26300.9550 基线；2026-10-29 的 Codex MXC 启动检查返回 `MXC_OK`、退出码 0。用户更新 Node 后，本次实际执行 `node --version` 为 **v26.13.0**，`process.execPath` 为 `D:\Nodes\26.13.0\node.exe`，满足 Node SDK Windows 标准输入输出要求的 24.21+ 或 26.8+。PATH 仍存在旧 26.4 后备项，不影响本次已观测的版本；不将本机升级自动变成项目的 Node 最低版本变更。

固定微软 [MXC 1.0.1 稳定版](https://github.com/microsoft/mxc/releases/tag/v1.0.1)，发布于 2026-10-17，源提交 `fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2`，MIT 许可，策略契约固定 `1.0.0`。以签名原生 `wxc-exec.exe` 作为 **P3.5 的首选验证路线**；不复制上游隔离实现，不调用 Codex 私有二进制，不继续扩张失败的自研 AppContainer 原型。该结论是候选选择，不是生产启用或验收完成。

后续 P3.5.2 已证明上述固定候选在 Win32k 兼容配置下不能保护宿主剪贴板完整性；本节保留最初选择依据，**当前没有通过完整验收的 Windows 执行后端**。本节末尾的官方修复与替代路线复核更新当前候选状态，不将已有局部成功恢复为生产准入。

| 维度 | 官方 Node SDK 1.0.1 | 官方独立执行器 1.0.1 | 本次判断 |
| - | - | - | - |
| 受维护接口 | `@microsoft/mxc-sdk/v1`，类型化 `run/spawn/spawnWithPty` | 官方明确支持的原生执行器，版本化 JSON；`--` 后可传命令参数数组覆盖 commandLine | 两者均为微软维护，无需自研 Windows 隔离层 |
| Node 条件 | 本机 26.13 满足；包要求 >=24，Windows stdio 要求更高，项目当前最低版本仍是 22.19 | 执行器本身不要求提高项目 Node 基线 | 不再以本机 Node 版本排除 SDK；项目兼容性仍需单独决策 |
| 禁止宿主权限回退 | 公开 `ContainerRequest` 不包含 `fallback`；转换代码也不透传；包根入口为空，exports 没有公开 raw-config 入口 | 稳定契约支持 `fallback.allowDaclMutation: false` | 这是本轮选择执行器的主要原因；不深导入 SDK 私有 binding、不通过类型强转伪造支持 |
| 流与退出 | 原生管道、异步 wait/kill；`dispose()` 返回 void，后台清理不能当作已排空 | workload 使用标准流；退出码不提供独立的“全进程树已清理”证明 | 两条路线均需复用 Super Pi owner 的完成事实；执行器优先验证已有 WindowsShellJob 的嵌套 Job 兼容性 |
| 热路径 | `MxcProcess.poll()` 每轮新建定时闭包；引入后须纳入完整生产调用链分配审计 | 通过已有进程标准流接管，不需新增 JS SDK 轮询 | 这是待测成本差异，不据源码宣称执行器更快；本轮没有生产热路径修改 |
| 分发和依赖 | 包含多平台原生文件，依赖 koffi、node-pty、semver | 从固定官方制品取得目标架构执行器，保留 MIT 声明，校验包完整性与签名 | 暂不修改 package.json/lockfile，不安装整套 SDK；后续分发必须按版本和架构固定，禁止静默下载 latest |
| 启动恢复 | 原生库仍须审计恢复行为 | CLI 在 probe 前也调用 DACL 遗留恢复 | 不能把 CLI probe 宣称绝对只读；利用上游 `MXC_DACL_STATE_DIR` 指定本任务独占目录，不访问其他产品的恢复记录；该实现级环境接口需随版本复核 |

依据：[Node README](https://github.com/microsoft/mxc/blob/v1.0.1/sdk/node/README.md)、[公开导出](https://github.com/microsoft/mxc/blob/v1.0.1/sdk/node/src/v1/index.ts)、[请求转换](https://github.com/microsoft/mxc/blob/v1.0.1/sdk/node/src/v1/container.ts)、[进程生命周期](https://github.com/microsoft/mxc/blob/v1.0.1/sdk/node/src/v1/container-process.ts)、[执行器说明](https://github.com/microsoft/mxc/blob/v1.0.1/README.md)、[稳定策略契约](https://github.com/microsoft/mxc/blob/v1.0.1/docs/containment-policy/1.0.0/policy.md)、[启动恢复实现](https://github.com/microsoft/mxc/blob/v1.0.1/src/mxc-sdk/src/core/mxc_common/filesystem_dacl.rs)、[系统版本矩阵](https://github.com/microsoft/mxc/blob/v1.0.1/docs/backends/process-container/os-version-support.md)。

## 能力矩阵与开放门槛

下表的“上游支持”仅指固定版本契约或实现；“本机”仅填写实际观测，现已补入 P3.5.0 的限定验证结果。**Super Pi 的 MXC 生产入口全部尚未接入，不存在可对外宣称的 sandbox 完成状态。**

| 能力/入口 | 上游与本机证据 | Super Pi 接入缺口与拒绝条件 |
| - | - | - |
| 后端与实际隔离级别 | 本次官方执行器携带实际策略的 probe 返回 base-container、needsDaclAugmentation=false、warnings=[] | 只验证本轮选择的 base-container。不可用、未知级别或需要 DACL augmentation 时拒绝；probe 不替代启动时验证，也不保证所有能力已测试 |
| 文件只读、可写、拒绝路径 | 兼容配置+受控内联 Node：中文/空格路径读写通过；只读写入、未授权读取、显式拒绝路径及 junction 越界访问均返回 EPERM | 未验证原生文件提交、路径替换竞态与一般工具链；不能将有限夹具扩大为完整文件工具验收 |
| 原生文件工具 | MXC 能隔离实际进程 | 当前 native-file-client 使用宿主 worker_threads，且文件服务还有宿主读写/提交路径；必须整体迁入受限进程，不能仅给 worker 标记 sandboxId |
| shell / PowerShell / argv | Node 内联模块通过；P3.5.1 增加两个显式加载选项后，普通磁盘入口与相对 ESM/CommonJS 导入通过，未增加祖先目录授权 | 仅验证受控工作进程；加载选项有模块身份兼容条件。BashOperations、最终授权、真实 PowerShell/Git Bash/其他工具链未接入，不能扩大成所有 shell 通过 |
| 网络全拒绝 | 全 deny 策略下，宿主正对照连接成功，受限进程同端点连接返回 EACCES，监听器未收到额外连接 | 只证明本轮 TCP IPv4 loopback 拒绝；公网、UDP、IPv6、DNS及入站服务尚未验证，不把它们统一标为已验收 |
| UI 与 Win32k | 严格禁用 Win32k 时 Node 初始化失败；兼容配置下 HWND、输入注入、剪贴板读取/发布对照成立；none/container 成功 EmptyClipboard 后宿主从 4 种格式变成 0 种、文字格式消失 | 已确认剪贴板完整性失败，当前兼容候选不合格；不能作为真实执行边界，不开放或默认切换 |
| IP/端口及域名网络 | 原生规则支持 IP/CIDR、协议、端口；域名过滤需调用方代理 | 初期不开放域名白名单/下载能力；HTTPS/TLS、代理直连绕过及身份绑定待单独验证 |
| 私网与代理回环 | Windows 私网能力存在双向限制；代理的 hostLoopback allow 有上游已知实现缺口 | 不表达成一个笼统的 network=true；私网仅出站、代理与本机入站分别列能力，未验证组合拒绝，不放宽 ingress 来假装满足 |
| 子进程、取消、崩溃 | 复用 WindowsShellJob，4 次原生调用全部收尾，4 次 QueryInformationJobObject 清理检查，结束 handles/processHandles 均为 0；取消用例在后代 ready 后触发 | 尚未覆盖整个应用崩溃与恢复；CLI 退出码不等价于进程树完成。只有 owner 确认排空才能记 complete，否则 unconfirmed 并保留切换阻塞 |
| 并发会话和 Plan | 独立只读配置的工作区写入返回 EPERM，临时目录可写 | 该用例是新进程策略验证，不是用户会话 Plan 切换验收；仍需真实路径验证并发会话、撤销、排空后发布新边界 |
| subagent / CodeMode | 子调用复用权限裁决；MXC 不是批量审批引擎 | 所有实际子调用绑定相同边界；有限批量授权不等于放行整段解释器脚本；未接入启动路径时拒绝 |
| LSP / MCP / Browser | 可在受限进程里启动某些长期服务，具体协议和网络需求另验 | 现有 owner 收尾通过不代表服务已经隔离；保持受管前台服务进程，不通过 detached 逃离根任务；宿主既有服务/远端浏览器须独立连接契约 |
| 第三方宿主扩展 | 不在本次 MXC 接入覆盖范围 | 明确为受信任宿主代码；不能将任意 Node 扩展标为已隔离 |

固定基线：`containment: "processcontainer"`、`fallback.allowDaclMutation: false`、显式 cwd 和最小环境、`telemetry.enabled: false`、网络三向 deny、UI 禁用、`destroyOnExit: true`、`preservePolicy: false`。这组严格基线尚不能运行本机 Node，P3.5.0 的显式兼容诊断不能自动替换它。不启用 learningMode、audit、宽松 capture；不自动切换 IsolationSession（其网络要求全允许）、WSL、legacy 或 trusted-host。需要的能力不足时返回明确不支持，而不是增加宿主权限。

网络依据：[ProcessContainer networking](https://github.com/microsoft/mxc/blob/v1.0.1/docs/backends/process-container/networking.md)。进程完成依据：[Job 实现](https://github.com/microsoft/mxc/blob/v1.0.1/src/mxc-sdk/src/backends/process_container/common/job_object.rs)及本仓库 `windows-shell-job.ts` / `shell-execution.ts`。不将上游文档中的其他 Windows build 实验结果写成本机结果。

## 主流 agent 复核与实现取舍

2026-10-30 复核：Anthropic sandbox-runtime 最新稳定发布仍为 0.0.81，Windows Alpha 的现有拒选原因未被新稳定版本解除；Gemini CLI 0.66.0 的 Windows native 路径仍涉及持久低完整性标签，不据此替换 MXC；OpenCode 1.19.5 当前权限说明新增/描述 `--auto`，仅自动批准原本 ask 的请求，显式 deny 仍生效。这些属于各产品的实现或审批策略，不能直接当作可嵌入的 Windows 隔离后端。

保留本项目已实现的统一权限裁决、固定批量展示、动态子调用复核、部分完成与撤销。执行器只负责执行边界；不引入新的自动风险分类器，不以减少提示为由放宽显式 deny 或 Plan。证据：[Anthropic releases](https://github.com/anthropics/sandbox-runtime/releases)、[Gemini Windows sandbox](https://geminicli.com/docs/cli/sandbox/)、[Gemini 0.66.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.66.0)、[OpenCode permissions](https://opencode.ai/docs/permissions/)。

## P3.4 制品与审查记录

本次仅下载官方 npm `@microsoft/mxc-sdk@1.0.1` 压缩包 38,256,855 字节并校验 npm 发布的完整性；没有下载 542,051,775 字节的全平台 release zip，没有执行安装脚本。压缩包完整性为 `sha512-2cP925G5+lQyKzjBVha8uNtVd7XESgDBtgi1yCYYSo9M3xiFyZWtCO4SWPGTk509rdI6nqjyGcZxvEP3t6l8Hg==`。仅提取 Windows x64 执行器、许可和包描述；执行器 12,152,632 字节，SHA256 `090F5D1F7BB93104AB08DCD4E8034EF954AEEFCDAF6658DDE5F7DFF4CFC12F3A`，Authenticode 验证为 Valid。`--help` 已确认真实 CLI 参数；这些证据不代替实际隔离验收。

审查范围：对照稳定 schema、公开导出与源码，复核没有用私有 SDK raw 接口绕过缺失开关；区分本机 Node 条件与项目兼容性；确认 CLI 自动恢复必须指定独占状态目录；对照宿主文件 worker、shell 品牌校验和任务 owner 的真实接入缺口。无生产代码、依赖、默认权限和 CI 修改，不运行构建或全套测试。文档差异及 `git diff --check` 已通过，执行器文件版本亦为 `1.0.1+fda29ac6`；**P3.4 选择与审查完成**。下一项为 P3.5.0 的显式手工验证，验证脚本不纳入每次 CI 单元矩阵。

## P3.5.0 受限的本机验证与审查记录

新增手动入口 [windows-mxc-preflight.mjs](../scripts/acceptance/windows-mxc-preflight.mjs)。要求显式传入固定 SHA256 的 Windows x64 官方执行器和一个尚不存在的报告路径；不联网下载、不修改安装与配置，不加入 `tests/` 或 CI。错误制品在创建临时目录与进程之前被拒绝。每个调用输出合计上限 64 KiB、执行等待 15 秒、复用既有 Job 清理上限 5 秒；一个最终验证只执行 probe、可写、只读、取消四个调用。

调用链审查：手动入口 → 现有 `WindowsShellJob.spawn` → 先归入 Job 再收到命令的 helper → 微软 `wxc-exec` → 先挂起并归入上游 Job 再恢复的工作负载/后代 → 既有 `waitForChildProcess` / `WindowsShellJob.stop` → 查询活动进程数、关闭句柄 → 删除具名夹具。未改动这条链的生产实现；没有新增生产输出转发、轮询、每进度分配或对象池。本轮不宣称吞吐/分配优化，不重复运行热路径基准、全仓构建和测试。

| 对照 | 实际结果 | 结论 |
| - | - | - |
| 固定制品、严格禁用 Win32k、Node 文件入口 | probe 通过；Node 返回 STATUS_DLL_INIT_FAILED / 0xC0000142 | 该严格配置不可用；上游错误提示不是充分证据，继续单变量对照 |
| 仅显式允许 Win32k，保留剪贴板、注入、外部 UI 对象、桌面及系统设置限制 | 进入 Node 加载器，因 realpath/lstat `C:\` 返回 EPERM 退出 | 初始化限制与模块路径解析是不同问题；普通文件入口不能写成已支持 |
| 上述兼容诊断配置、改用受控内联模块，不增加盘符读取或枚举权限 | 6 组检查通过；写入、只读、拒绝路径、junction、argv/stdio、回环拒绝及取消事实见上表 | 证明限定策略的能力，不代替 UI 隔离、一般工具链、生产文件 owner 或会话验收 |
| 不匹配固定 SHA256 的本地文件 | 退出 1，Job 创建 0、无夹具目录 | 未审查制品不会被启动 |

最后一次完整运行：Node 26.13.0，6 组检查、4 个 Job、4 次清理查询，结束 Job 句柄 0、进程句柄 0，DACL 状态目录为空，夹具删除已确认；后代 ready 后取消，并记录其 PID。通过记录为 `C:\Users\Administrator\AppData\Local\SuperPi-maintenance\superpi-mxc-review-20261030-765865aa\preflight-final.json`。两次失败和错误制品拒绝记录一并保留，避免将诊断配置成功误报成严格配置成功。

复现限定兼容诊断（不改变生产设置）：`node scripts/acceptance/windows-mxc-preflight.mjs <已校验的官方执行器> <新的报告路径> --allow-win32k`。省略该标志保持严格禁用 Win32k，不会失败后自动重试放宽。上游实际 UI 映射依据 [ui_policy.rs](https://github.com/microsoft/mxc/blob/v1.0.1/src/mxc-sdk/src/core/mxc_common/ui_policy.rs)，稳定字段位置以 1.0.0 schema 为准，不照搬旧 UI 草案中的字段位置。

代码审查纠正了临时目录准备阶段失败的清理范围、UTF-8 分块解码、输出回调异常和制品指纹转录问题；执行前完成语法/静态复核，修订后仅复跑这一有限入口及制品拒绝检查。新增 1 个显式手动脚本，新增 CI 用例 0，无过期 CI 测试由本项替代，因此不删除仍有独立价值的故障/释放覆盖。**P3.5.0 的验证工具与证据审查完成，限定诊断通过；P3.5 生产验收尚未完成。**

资源收尾：按已记录的独占审核目录及解包成员核对路径、重解析点与文件身份后，删除压缩包、执行器副本、研究源码和被最终报告替代的中间成功记录，共 49.68 MiB。保留 8 份小型证据文件，合计约 15.21 KiB；确认记录的夹具目录均不存在，最终后代 PID 亦不存在。清理摘要位于同一审核目录的 `result.json`。仓库仅增加手动脚本并更新本说明；未修改 CI、依赖和生产默认值。

P3.5.0 当时确定的下一项为 Node 文件入口的最小目录元数据权限和兼容 Win32k 后的 UI 限制，进展见以下 P3.5.1 / P3.5.2。两项均验收后才接原生文件进程与 shell/argv 的真实调用链，再验证会话并发、撤销和 Plan。禁止以 `C:\` 全读、宽松 UI 或静默宿主回退代替修复，P3.6 及 P4 继续等待开放门槛。

## P3.5.1 Node 文件入口：避免增加祖先目录授权（2026-10-30）

已按“实现 → 有限检查 → 审查 → 记录”完成这一独立小项。继续沿用 `windows-mxc-preflight.mjs`，新增显式 `--file-entry`，未新建 CI 测试文件。真实磁盘入口包含中文/空格路径、相对 ESM 导入和 `createRequire` 加载 CommonJS；不再用内联成功代替文件入口成功。

第一候选是 MXC 的 `processContainer.filesystem.enumeratePaths`。实际发现：向入口的祖先链授予该权限虽能启动 Node，原本未授权的子目录也可以被列出；文件内容仍被拒绝，但目录名称边界已经扩大。因此拒绝该方案，移除对应授权生成代码，不把它当作仅限单个目录对象的元数据权限。

采用 Node 官方的 `--preserve-symlinks` 和 `--preserve-symlinks-main`，仅显式加到受控工作进程的 argv，避免 Node 加载器的祖先 realpath 遍历；`enumeratePaths=[]`，不增加盘符读取或枚举权限，不全局设置 NODE_OPTIONS，也不改写 Node 私有加载器。依据：[Node 官方 CLI 说明](https://github.com/nodejs/node/blob/main/doc/api/cli.md#--preserve-symlinks)。这些选项改变模块身份/缓存处理，链接到多个位置的原生模块可能重复加载；只适用于下一阶段由宿主固定入口和依赖身份的工作进程，不能据此宣称所有 npm/任意用户命令兼容。

最终 6 组检查通过：文件入口 ESM/CommonJS 均加载；可写与只读配置维持原有文件边界；未授权目录列出、内容读取、父目录内容、盘符根 lstat、junction 越界均返回 EPERM，loopback 返回 EACCES。夹具父目录的部分 stat 本来可用，已纠正“所有祖先元数据均应拒绝”的过强测试假设，不将此作为新增授权。4 个 Job、4 次收尾查询、最终 Job/进程句柄 0、DACL 状态空、夹具已删除。记录：`C:\Users\Administrator\AppData\Local\SuperPi-maintenance\superpi-mxc-boundaries-20261030-0165482e\metadata-final.json`；两个诊断失败按不同原因保留。

审查确认新增逻辑只在显式手动检查中执行，不改变生产热路径；安全性来自 OS 对实际目标的拒绝，不依赖加载器字符串路径。语法和文档差异检查通过。**P3.5.1 限定 Node 文件入口验收完成；生产接入仍等待 P3.5.2 的 UI 隔离验收。**

## P3.5.2 Win32k 兼容 UI 验收（当前候选失败，以下保留调查过程）

新增显式手动入口 `scripts/acceptance/windows-mxc-ui-preflight.mjs` 与配套 `windows-mxc-ui-host.cs`，没有加入 CI。复用微软 1.0.1 的 [wxc_ui_probe](https://github.com/microsoft/mxc/blob/v1.0.1/src/testing/wxc_ui_probe/src/main.rs)，原始源码 SHA256 固定为 `2E1735EC2E09F1E04AD569267C29DCF336606C9C37ACD1F3285C42B0C43F598D`。初版只加窗口站身份/可见性及四项允许测试检查；独立审查后另补固定测试文字写入失败即退出、持有剪贴板锁时核验 owner/sequence 的读取前保护。新增保护失败只输出 INCONCLUSIVE，不伪造上游 PASS；所有插入点须唯一匹配固定源码。未下载整个原生工具包，也没有新增 Rust 依赖缓存。

默认夹具在全新不可见窗口站与桌面中运行，名称带随机身份；通过原生 STARTUPINFO 显式指定桌面，在新线程上建立 UI 对象，仅把现有 UI 对象的访问规则复制到新建对象，不修改原对象。原生探针在任何剪贴板/输入操作前核对窗口站。所有子进程归入已有 WindowsShellJob；单次驱动等待上限 30 秒、输出 64 KiB，内部固定四项对照、单个子进程 10 秒，编译和探测也按具名 Job 收尾。

| 私有窗口站的项目 | 正对照 | 兼容限制配置 | 验收结论 |
| - | - | - | - |
| 外部窗口 HWND | 能读取夹具窗口的所属进程 | GetWindowThreadProcessId 被拒绝 | 通过；不访问用户窗口 |
| 剪贴板读取、写入 | 宿主对照可操作；但同一受限配置改为 clipboard=all 后仍在 OpenClipboard 被拒绝 | OpenClipboard 返回 access denied，上游为 INCONCLUSIVE | 未通过；缺少受限环境内有效允许对照，不能归因于配置中的读写限制 |
| 输入注入 | 无法取得前台窗口，上游 INCONCLUSIVE | 同样无法取得前台 | 未通过；没有真正触达输入注入限制，不能把非交互桌面的拒绝计为通过 |

最后的隐藏环境记录为 `C:\Users\Administrator\AppData\Local\SuperPi-maintenance\superpi-mxc-boundaries-20261030-0165482e\ui-8.json`。4 个外层 Job、4 次收尾查询，结束句柄均为 0，UI_RESOURCE_CLEANUP=CONFIRMED，夹具已删除。明确拒绝将 canBlock* 探测值或正对照也失败的操作记为验收成功。

夹具审查纠正了启动线程已有 UI 对象、普通 Process.Start 未继承测试桌面、输出文件写句柄未先关闭，以及把 CLR 引入受限探针导致的启动问题；受限端现只运行原生探针。记录区分夹具失败和实际后端结论。两个入口语法检查、C# 和带身份检查的 Rust 编译通过；窗口站身份不匹配时退出 125，未进入测试操作。

单独的 `--interactive` 路径在用户明确回复“允许；当前剪贴板可覆盖”后，已执行一次有限验收，结果见下一小节。默认路径绝不自动重试到交互桌面，不执行退出登录、显示设置或系统参数修改测试。**目前 P3.5.2 未验收，真实文件和命令执行路径仍未接入；当前缺口是有效验收条件，不再是等待这两项授权。**

前一轮资源审计确认 11 个记录中的临时夹具均已删除，Job/进程句柄均归零。压缩包、旧构建副本、PDB 和研究源码等已按具名路径清理 39.76 MiB；暂留约 11.68 MiB 的已固定执行器、许可、原始探针源码与小型记录供后续复用。完整资源摘要保存在同一审核目录的 `result.json`。没有增加 CI 用例、修改生产热路径或延长现有 CI 超时。

### 独立审查与已授权前台验证（2026-10-30）

按用户要求新建独立对话“Super Pi 执行边界解答与代码审查”（`01a18987-e943-7402-8cab-4ac19d72c6ab`），负责只读技术解答和代码审查，主对话负责核实、修改、验证和记录。双方遵守本方案最终目标及性能契约；后续问题沿此审核通道处理，不以审查建议扩大权限或跳过验收。

本轮修复以下已核实的夹具问题：

- 上游 FAIL 不总是有效正对照。按固定版本每项输出验证实际成功，读取必须回读固定文字，注入必须确认向已拥有的前台窗口注入成功；缺失 API、错误 owner、非测试内容、歧义状态均不计通过。`clipboardEntryDenied` 只保留诊断，任何 INCONCLUSIVE 均不进入 accepted。
- 去掉先写临时输出文件、退出后再查长度的路径。C# 仅复制可继承的 stdout/stderr 句柄并交给子进程，输出直达外层 Node 的 64 KiB 总上限；没有新增读取线程、轮询队列或磁盘输出缓存。句柄复制、关闭均检查结果。
- 原生读取探针在 seed 写入失败后立即返回；成功时在释放剪贴板锁前记录序列，重开并仍持锁时核验 owner/sequence，再读取。无法证明仍为本次内容时退出；不读入其他应用后来替换的文本。
- 将宿主句柄释放 `UI_HOST_HANDLES`、直接子进程退出 `UI_CHILD_EXIT` 和外层 Job 排空分开记录。超时不能提前声称所有 UI 使用者退出；完整进程族清理由已有 Job owner 查询确认。

语法与差异检查通过；小范围判定检查覆盖错误正对照、歧义结果及三种剪贴板前置失败。唯一一次前台运行同时完成 C#/Rust 编译和新管道路径验证，总运行约 2.86 秒，未跑全仓测试、未增加 CI 用例、未改生产热路径。报告为同一审核目录下 `ui-interactive-1.json`：外部 HWND 对照通过；剪贴板 all/none 均 OpenClipboard gle=5；输入控制未获得前台，限制侧前台 owner 为 0；总结果 false。4 个 Job、4 次清理查询，Job/进程句柄 0，宿主句柄释放、直接子进程退出、临时夹具删除均确认；没有遗留编译产物。

另一次只读环境诊断记录为 `ui-environment-1.json`：主 Node 处于 WinSta0/Default，最内层 Job UI mask=0，仅 OpenClipboard/CloseClipboard 成功，未读写剪贴板内容。这只能排除“主进程完全打不开剪贴板”；不能证明所有祖先 Job 或 MXC 子进程的窗口站权限。依据：[QueryInformationJobObject 的 NULL/嵌套语义](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)。Windows 本身限制后台进程取得前台，即使部分前提满足也可能拒绝：[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)。这些是下一步调查依据，不是已证实的本次拒绝根因。

下一步先建立实际有效的受限剪贴板允许对照与前台归属。官方固定版存在宿主预写、子进程读取的结构，可避免 clipboard=none 子进程自行准备文字的矛盾，但当前 all 对照连 OpenClipboard 都失败，不能仅改 seed 就宣称问题解决；不重复无变化试验，不放宽生产 UI 策略。P3.5.1 仍完成，P3.5.2 仍未通过，真实文件/命令及后续 Plan 接入继续等待。

独立审核已复核上述最新修复及两份运行记录，确认判定、读取前保护和清理语义修复通过；未发现需要为本轮修复继续增加测试的理由。本小项“夹具修复、审查与记录”完成；后续调查只比较同一启动链中宿主和 MXC 子进程的实际环境，不重跑整套 UI 验收。

随后一次只读原生比较（`ui-environment-compare-1.json`）已执行、审查并记录：宿主及 MXC all/container、none/container 均为 Session 1、WinSta0/Default；NtQueryObject 成功，宿主窗口站权限为 0xF037F、MXC 为 0x20327，两者都包含 WINSTA_ACCESSCLIPBOARD；桌面权限仅相差 DESKTOP_SWITCHDESKTOP。不能把缺少写 ACL、退出或切换桌面的权限当作剪贴板拒绝根因，未补授这些权限。宿主 OpenClipboard/Close 成功、两组 MXC 入口均拒绝；未读写内容或修改焦点，4 个 Job 排空且夹具删除。

独立审查确认此前“允许对照必须保留 container、只改 clipboard”的要求对组合边界过强。固定版 [Issue1246 回归](https://github.com/microsoft/mxc/blob/v1.0.1/tests/regression_tests/test_cases/Invoke-Issue1246-Tier1ClipboardRestrictions.ps1) 明确用 all/desktop 对照 none/container。下一步只读诊断可仅把 all 控制的 isolation 改为 desktop；这是固定夹具内的对照，生产 none/container 不变。正式验收须区分“组合边界阻止访问”和“单个 clipboard 位拒绝 Get/Set”，保留原始 INCONCLUSIVE；仅 Open/Close 成功不能代替合成文字读写正对照。

该单变量只读控制随后实际完成（`ui-environment-desktop-1.json`）：all/desktop 的 OpenClipboard 仍返回 5，Session/Station/Desktop 及 granted mask 与 all/container 相同。因此“只因 container UI 隔离导致入口拒绝”未得到支持；也没有证据证明单独缺失 clipboard 访问位。2 个 Job（编译和该对照）清理确认、句柄归零、夹具删除。按限定调查范围停止继续试探，不增加授权寻找成功，不扩大到 token/SID 或用户数据读取。本机 MXC 允许剪贴板控制失败原因仍未定位；输入注入的前台归属另有独立缺口。本轮只有一次前台验收和两次不同问题的只读原生诊断，没有反复运行完整矩阵。

最终独立复核确认上述证据与结论一致，本轮审查结束。新增 3 个具名临时目录全部删除，10 个 Job 的最终句柄计数均归零；累计 14 个记录中的夹具不存在。审核目录保留约 11.69 MiB，主要为固定官方执行器，另含许可、固定源文件、少量诊断源码和报告；不存在本轮生成的可执行文件/PDB 或输出落盘缓存。当前只完成夹具修复与限定调查，不将资源清理成功或诊断 completed=true 写成 UI 能力通过。继续推进需有能解释并改变前置阻断的新实现或环境证据；不重复同一试验、不修改生产默认策略。

### 输入注入单项完成及官方剪贴板语义复核（2026-10-30）

手动入口新增显式 `--interactive-injection`，只执行宿主与受限端输入对照；报告限定 `scope=input-injection-only`，不将局部 `passed=true` 计为完整 UI 通过。保留固定上游的前台归属、SendInput 和错误码判据，仅在该手动模式允许最多 20 秒的前台获取；内层进程、宿主和驱动的等待上限分别为 22、25、55 秒。独立审查发现原 8 秒内层超时会截断等待，已在运行前修正；其他模式与 CI 时限不变。

唯一一次该项运行 `injection-assisted-1.json` 已通过：宿主确认拥有前台后 SendInput 1/1、gle=0；受限端同样拥有前台，SendInput 0/1、gle=5。实际运行约 1.47 秒，主对话未进行外部激活或点击；不据此断言延长等待必然是前次失败的根因。4 个 Job 全部排空、4 次清理查询，最终 Job/进程句柄均为 0，宿主句柄释放、直接子进程退出及临时夹具删除确认。报告位于 `C:\Users\Administrator\AppData\Local\SuperPi-maintenance\superpi-mxc-ui-resolution-20261030-edcefee6`。独立审核已核对小 diff、输出判据、源文件哈希及夹具确实不存在；**输入注入这一小项实现、验收、审查与记录完成**。未新增 CI 用例或生产热路径改动。

官方固定版调用链已核对：JSON UI 配置经 `resolve_ui_restrictions` 写入 PSEC FlatBuffer，再通过 `SecurityEnvironmentStartupInfo` 启动子进程；生命周期 Job 不是该 PSEC 的替代物，因此最内层 Job UI mask=0 不能证明 UI 限制未生效。依据：[base_container_helpers.rs](https://github.com/microsoft/mxc/blob/v1.0.1/src/mxc-sdk/src/backends/process_container/common/base_container_helpers.rs)、[base_container_runner.rs](https://github.com/microsoft/mxc/blob/v1.0.1/src/mxc-sdk/src/backends/process_container/common/base_container_runner.rs)。

官方 [UI 策略说明](https://github.com/microsoft/mxc/blob/v1.0.1/docs/backends/process-container/UIPolicy_Schema.md) 明确：`clipboard=all` 仅不设置对应拒绝位，不主动授予访问；安全环境的其他部分仍可能拒绝。相关 [#1245](https://github.com/microsoft/mxc/issues/1245) 和 [#1246](https://github.com/microsoft/mxc/issues/1246) 虽已关闭，关联 [#1368](https://github.com/microsoft/mxc/pull/1368) 与 [#1338](https://github.com/microsoft/mxc/pull/1338) 为文档/测试修正，不能当作本机允许访问已修复的证据。当前稳定版仍为 1.0.1；不改策略试探更多权限。

下一小项只检查 all/desktop 配置在确实取得自身前台后能否 OpenClipboard(NULL)/CloseClipboard；不读取或写入数据、不注入输入。该诊断同时引入顶层窗口和消息处理，成功也不能单独归因于前台身份；失败则可排除“仅缺前台”这一解释。保留原始未决状态，P3.5.2 整体验收与真实执行接入继续等待剪贴板结论。

该入口诊断随后完成并获独立审查确认：`clipboard-foreground-1.json` 记录 all/desktop、具体自身 HWND/PID 的前台归属为 true，OpenClipboard(NULL)=1、错误码 0，CloseClipboard=1、错误码 0，窗口和窗口类均释放。未调用剪贴板数据 API 或 SendInput；2 个 Job 清理确认、最终句柄 0、夹具目录已不存在。沿用固定上游窗口实现，临时诊断移除了输入调用，编译仅另抑制因此留下的未使用声明警告；未扩大权限。**这一入口诊断的实现、运行、审查及记录完成**；它证明该配置存在可用入口，尚不证明数据读写或单独的前台因果关系。

下一步只补合成数据对照：复用已验证的前台窗口条件；宿主为 READ 预置并确认固定文字，子进程持锁核验 owner/sequence 后才取数据，禁止 none 子进程自行准备文字；WRITE 允许对照必须回读固定内容。all/desktop 与 none/container 结果按组合边界解释，不将原始 INCONCLUSIVE 改写成上游 PASS。

### 剪贴板数据对照完成，完整性单独保留门槛（2026-10-30）

新增显式 `--interactive-clipboard`，仅两项数据操作、各一允许/拒绝对照。宿主预置 READ 文字并保留 owner；子进程在自身前台窗口条件下取得剪贴板锁，校验 owner/sequence 后才读。WRITE 控制需子进程写入、固定内容回读，再由宿主持锁核验 owner/sequence 和固定长度内容；通过一个至多 128 字节元数据文件、完成标记及 8 字节确认文件完成有界握手，不新增通用传输框架。前台等待 15 秒、握手 3 秒、子进程 22 秒、宿主等待 25 秒、四项合计驱动 105 秒均只适用于手动入口，输出仍限 64 KiB，未改 CI。

两次失败定位并修复夹具前提，未放宽策略：`clipboard-interactive-1.json` 暴露受限进程在本夹具中重命名元数据文件返回 5，改为完整写入关闭后创建独立空完成标记；宿主确认文件仍原子重命名发布。此事实不代表 MXC 全部重命名场景都不支持，但真实文件提交接入必须先核对该能力。`clipboard-interactive-2.json` 记录 READ 两次及 WRITE 一次的 owner 不变，序列在首次 Close 前后分别 319→322、324→327、329→332。修复为发布关闭后重新加锁，先验证仍为本次 allocation 和固定内容，再取稳定序列；没有硬编码增量或绕过身份检查。官方说明仅保证序列随内容变化，不能据此假设发布关闭前的值一定稳定：[GetClipboardSequenceNumber](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardsequencenumber)。

最终 `clipboard-interactive-3.json` 约 6.93 秒完成：宿主稳定序列 337/337、342/342；all/desktop READ 读到固定文字，WRITE 写入后宿主回读确认；none/container READ 的 GetClipboardData 被拒绝，WRITE 在 EmptyClipboard 成功后由 SetClipboardData 返回 5。所有数据调用都具备自身前台证明；4 个 Job 清理确认、句柄 0、宿主句柄释放/直接子进程退出/夹具删除均确认。两文件语法及差异检查通过，另有 6 个不启动进程的有限判定检查；新增 CI 用例 0、未改生产热路径。

独立审查确认最终代码与报告一致，**数据读取/发布对照这一小项实现、验证、审查、记录完成**。报告的 `scope=clipboard-only` 和 `passed=true` 仅是当时的数据 API 对照判定，**不是 P3.5.2 整体通过**。EmptyClipboard 成功属于实质性的完整性疑点；下一项仅以宿主预置的合成数据核对一次清空影响，不重跑数据矩阵，不接真实文件或命令。

资源限制：第二次失败的外层 Job 已确认排空且句柄 0，但 Node 删除 `C:\Users\Administrator\AppData\Local\Temp\superpi-mxc-ui-o70EHL` 返回 EPERM。复核属性、ACL 及无重解析点后，对这一确切目录的清理被自动审批以 `blocked by policy` 拒绝，未提供细因；没有绕过，约 1.60 MiB 编译产物/具名夹具暂留并单独记录。最终成功运行及其他本轮夹具已删除，不能将该遗留写成清理完成。

### 当前 Win32k 兼容候选不合格：宿主剪贴板实际被清空（2026-10-30）

一次独立、有限的 `clipboard-clear-1.json` 诊断保持 none/container、网络全拒绝、无 DACL augmentation，沿用原生前台窗口及 WRITE 的 message-only owner 条件。宿主先预置并验证固定文字；子进程仅 Open/Empty/Close，不调用 Get/Set 数据 API 或输入注入；确认退出后宿主持锁读取 owner、sequence、文字格式可用性及格式数，不读取未知内容。

实际观察：宿主前态 owner=1771272、sequence=353、CF_UNICODETEXT=true、formats=4；受限进程拥有自身前台，Open=1、Empty=1、Close=1，均无错误；宿主后态 owner=0、sequence=354、CF_UNICODETEXT=false、formats=0。这是宿主剪贴板被修改的直接证据。该运行约 6.22 秒，3 个 Job 及清理查询、最终句柄 0，UI 句柄/子进程退出确认，夹具删除。依据：[EmptyClipboard 的清空及所有权语义](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-emptyclipboard)。

手动验收判定随之收紧：保留上游原始 PASS 和数据操作拒绝事实，但 WRITE 必须证明在 EmptyClipboard 阶段已经拒绝；“Empty 成功、Set 拒绝”以及缺失具体拒绝阶段的裸 PASS 均不再 accepted。使用已有成功报告进行纯内存复判，READ=true、WRITE 的 dataOperationDenied=true / clipboardMutationObserved=true / accepted=false；没有改写历史报告或重跑矩阵。

**P3.5.2 完整验收失败；当前固定后端/系统/兼容配置不合格。** 暂不判断缺陷归属 Windows 或 MXC，也不扩大为全部 MXC 后端均不安全。保留 P3.5.1、HWND、输入注入和数据 API 对照的已完成事实；真实文件、shell/argv、P3.6 与依赖该边界的旧实现退役均保持关闭。关闭工具入口、事后恢复剪贴板、盲加 UI 权限、私自降低验收要求或静默宿主回退均不能修复原生进程边界。后续需要维护方的修复或新的受维护候选证据，先验证此项，再续接生产路径；无新证据时不重复相同本机试验。

本轮资源汇总保存在 `C:\Users\Administrator\AppData\Local\SuperPi-maintenance\superpi-mxc-ui-resolution-20261030-edcefee6\result.json`：6 次有不同目的/修复的有限运行，合计 21 个 Job、21 次清理查询、最终句柄均为 0；6 个夹具中 5 个删除、1 个因上述拒绝保留。另有 6 个已记录的公开研究源文件共 214,760 字节，其具名文件清理也被自动审批拒绝，按现状保留，未绕过。没有新增 CI 用例、修改 CI 时限、下载新执行器或改动生产热路径；复用既有固定执行器。保留的诊断及报告规模较小，不用扩大全仓测试替代后端能力修复。

最终独立审查已完成：核对判定修复、宿主源文件身份、方案状态/矩阵、六份原始报告及具名资源，未发现阻断本轮修复和记录暂存的问题；纯判定复核、语法及差异检查通过。**本轮排查、判定修复、审查与记录完成；完整 UI 验收失败和清理待办继续保留。** 仅暂存两份手动验收文件及本方案，不提交或推进下一项生产接入。

### 官方修复与受维护替代路线复核（2026-10-30，剪贴板完整性后续）

本轮继续与独立审核对话“Super Pi 执行边界解答与代码审查”核对官方实现，只读研究优先，不重复已失败的本机矩阵。研究结论是：**已查候选中没有取得可直接替换且满足当前门槛的执行器证据**，不是断言所有 Windows 隔离方案都不可行。当前 P3.5.2 仍失败，真实文件/命令入口、P3.6 和后续退役继续等待；没有改动生产代码、权限、依赖或验收判据。

MXC 最新稳定发布仍为 1.0.1；本次开发源码固定 `b4c1007502835d958ab291d332b929187be00440`。其 UI 规则仍经 `resolve_ui_restrictions` 转成 PSEC UI 位，Win32k 开关取自 `policy.ui.disable`；所查启动链未增加独立窗口站。GitHub 官方仓库检索 `EmptyClipboard` 仅返回已合并的测试修正 [#1338](https://github.com/microsoft/mxc/pull/1338)，关联 [#1246](https://github.com/microsoft/mxc/issues/1246) 没有补充评论。结合固定版本的实际清空证据，**未找到能解除当前失败的官方发布、补丁或已核实策略配置**；已关闭 issue 和原探针 PASS 均不能替代宿主完整性证明。源码依据：[UI 映射](https://github.com/microsoft/mxc/blob/b4c1007502835d958ab291d332b929187be00440/src/mxc-sdk/src/core/mxc_common/ui_policy.rs)、[PSEC 构造](https://github.com/microsoft/mxc/blob/b4c1007502835d958ab291d332b929187be00440/src/mxc-sdk/src/backends/process_container/common/base_container_helpers.rs)。不据此归责于 Windows 或 MXC 的具体组件，也不声称检索覆盖了未公开修复。

收口时再次直接核对 [#1338 最终差异](https://github.com/microsoft/mxc/pull/1338/files)：`Issue1246-ClipboardProbe.cs` 的 `EmptyClipboard` 被拒绝分支返回 Blocked；Empty 成功后 `SetClipboardData` 返回 AccessDenied 的分支也返回 Blocked。外层 `Invoke-Issue1246-Tier1ClipboardRestrictions.ps1` 只在 ExpectAllowed 时进行宿主 write token 回读，restricted 分支只检查退出码和 readBlocked/writeBlocked。因此该测试能够在宿主内容已被清空时通过；它覆盖数据 API 拒绝，不证明宿主原有内容完整。这项静态证据与本机前后状态观测相互印证，不需要重跑同一矩阵。

| 候选与固定依据 | 与当前缺口有关的事实 | 当前决定 |
| - | - | - |
| Codex 稳定版 0.166.0；另核开发快照 `582a8812e023b08cbf10b4603ac41644b8d99261` | MXC 策略仍允许 Win32k、选择 desktop；旧执行器的私有桌面仍在 Winsta0，主进程正常退出后还会保留后代 | 不作为现成剪贴板修复或生命周期实现直接接入；这不是对 Codex 本机行为的复现结论。[MXC 策略](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/mxc-sandbox/src/policy.rs#L301)、[旧桌面实现](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/windows-sandbox-rs/src/desktop.rs#L216)、[后代保留](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/windows-sandbox-rs/src/bin/command_runner/win.rs#L657) |
| Chromium `f52c70bb998c0d5cb3608c6585be4f203565c7a5` | 有独立窗口站和 `SetFakeGdiInit()` 的维护实现；需要 broker 与 target 同时链接/初始化，broker 内的窗口站对象也不能自动视为每会话独立 | 保留为集成研究候选；Node 26.13.0、任意 shell/后代、文件代理及会话边界尚无通过证据，不能只移植创建窗口站或 DLL 兼容函数。[独立窗口站](https://chromium.googlesource.com/chromium/src/+/f52c70bb998c0d5cb3608c6585be4f203565c7a5/sandbox/win/src/alternate_desktop.cc)、[Win32k 接口](https://chromium.googlesource.com/chromium/src/+/f52c70bb998c0d5cb3608c6585be4f203565c7a5/sandbox/win/src/sandbox_policy.h)、[架构说明](https://chromium.googlesource.com/chromium/src/+/f52c70bb998c0d5cb3608c6585be4f203565c7a5/docs/design/sandbox.md) |
| MXC 的实验性 Windows Sandbox 后端，同一开发快照 | 生成 WSB XML 未写 ClipboardRedirection，Networking 明确 Enable；策略规划没有 UI 映射，文件映射也拒绝嵌套授权根和在共享根内挖出 deny 路径 | 当前封装不能直接满足本项目 UI/文件契约；不以底层 VM 的存在替代配置验收。[生成配置](https://github.com/microsoft/mxc/blob/b4c1007502835d958ab291d332b929187be00440/src/mxc-sdk/src/backends/windows_sandbox/lifecycle/vm.rs#L83)、[策略规划](https://github.com/microsoft/mxc/blob/b4c1007502835d958ab291d332b929187be00440/src/mxc-sdk/src/backends/windows_sandbox/lifecycle/policy.rs#L26) |
| Microsoft WinAppCli `161cae9cb7544121258da680788d044faae46233` | 无配置参数启动 Windows Sandbox，复用/接管唯一已有实例；通过 TCP 转发标准流，在 guest 配置 agent 入站规则；官方明确同实例内工作流共用用户、桌面和网络 | 不能直接作为互相隔离的会话/Plan 后端；未找到工作负载全拒绝网络与强制禁用宿主剪贴板的已验证组合，不安装或启动来重复已知不匹配。[启动实现](https://github.com/microsoft/WinAppCli/blob/161cae9cb7544121258da680788d044faae46233/src/winapp-CLI/WinApp.Cli/ExecutionTargets/WindowsSandbox/WindowsSandboxCli.cs#L249)、[实例接管](https://github.com/microsoft/WinAppCli/blob/161cae9cb7544121258da680788d044faae46233/src/winapp-CLI/WinApp.Cli/ExecutionTargets/WindowsSandbox/WindowsSandboxLifecycle.cs#L253)、[传输与规则](https://github.com/microsoft/WinAppCli/blob/161cae9cb7544121258da680788d044faae46233/src/winapp-CLI/WinApp.Cli/ExecutionTargets/WindowsSandbox/WindowsSandboxBackend.cs#L1187)、[官方边界](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/sandbox-execution) |
| Sandboxie Plus 1.18.8，2026-10-17 发布 | OpenClipboard=n 的 DLL 包装会拒绝 EmptyClipboard，但服务仍向目标复制含 WINSTA_ACCESSCLIPBOARD 的窗口站句柄；官网另列 Box Clipboard 能力，两者不能混同 | 普通开关尚不足以证明任意原生代码不能绕过包装。Box Clipboard 已完成有界只读核对：官网描述每箱独立剪贴板，但本轮未确认其在公开稳定版 1.18.8 中的对应实现、可配置入口和强制隔离边界；保留为未验证候选，不列为已证伪或已满足验收。[发布](https://github.com/sandboxie-plus/Sandboxie/releases/tag/v1.18.8)、[配置说明](https://sandboxie-plus.com/sandboxie/openclipboard/)、[包装函数](https://github.com/sandboxie-plus/Sandboxie/blob/v1.18.8/Sandboxie/core/dll/guimisc.c#L878)、[窗口站句柄](https://github.com/sandboxie-plus/Sandboxie/blob/v1.18.8/Sandboxie/core/svc/GuiServer.cpp#L1523)、[Box Clipboard](https://sandboxie-plus.com/box-clipboard/) |
| Anthropic sandbox-runtime 0.0.81 | Windows 发布说明仍列出特定 token 的网络拒绝及部分宽权限目录删除/移动边界缺口 | 保持拒选，不因其受维护而忽略明确能力缺口。[官方发布说明](https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.81) |

Windows 的剪贴板属于窗口站；同一窗口站内新建桌面不等于独立剪贴板，参见 [微软窗口站说明](https://learn.microsoft.com/en-us/windows/win32/winstation/window-stations)。官方 [WSB 配置](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) 支持显式 `ClipboardRedirection=Disable` 和 `Networking=Disable`，默认则启用剪贴板共享。这是可继续研究的 OS 原语，不是上述封装已实现的安全契约；只补一个 XML 开关也不能自动满足传输、文件 deny、独立会话、取消和性能要求。

本机只读确认 Windows 26H2 / ProfessionalWorkstation，`Containers-DisposableClientVM` 为 Disabled，PATH 中没有 wsb/winapp，未查到 WindowsSandbox Appx 包。没有启用功能、安装客户端/驱动或要求重启。[官方 wsb CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) 的 exec 不提供标准输入输出；winapp 补上的转发也不自动提供本项目的拒绝策略。VM 路线需先提出可复核的隔离与资源方案，再决定是否安装验证，不能为了一个已知缺口盲目升级或建立常驻 VM。

#### P3.5.2 收口、恢复与停止条件

P0 的用户图片粘贴读取修复与本项原生命令进程的宿主完整性隔离是不同契约：宿主 TUI 应按用户操作正常读取截图，受限命令进程不得擅自修改宿主剪贴板。P0/P1/P2 的已完成代码与审查结论、P3.5.1 的限定文件入口验收继续保留；P0 真实图片桌面回放仍按用户决定待办，不将本次隔离失败回写成这些项目失败。

下列任一路线取得具体实现证据后，才恢复最小验证；这只是恢复验证的条件，不是生产准入：

| 路线 | 恢复验证前必须提供的证据 |
| - | - |
| MXC 修复 | 固定发布或提交、适用系统与实际配置；能指出清空操作或宿主状态保护的具体改动，不能只引用 issue 关闭、探针 PASS 或测试名称 |
| 受维护的独立剪贴板 | 可用实现及固定版本，明确窗口站、访问权限、继承句柄和共享通道的隔离机制；仅换桌面或包装 API 不足以恢复完整验收 |
| Windows Sandbox 等 VM | 禁用宿主剪贴板共享后的命令传输、文件映射/deny、网络、独占实例归属、取消与资源上限方案；两个 XML 开关不替代完整执行契约 |

恢复后先证明宿主剪贴板的读取、发布和清空均受保护，再验证 Node 和命令所需的兼容性。若候选采用独立剪贴板，容器内部清空自己的内容可以是正常行为，但必须证明宿主合成内容未变、不能重连宿主窗口站/共享通道，并覆盖不同会话之间的边界。新的 UI 证据先独立审查、记录，再接真实文件/命令及其网络、取消和 Plan 验收；现有 ProcessContainer 判定保持不变。

停止条件：无上述新实现证据时不重复本机矩阵、不扩大无差别候选扫描、不轮询发布、不降低验收、不自动回退宿主；一次有界验证若仍证明宿主完整性失败，保留报告并继续阻塞，不靠重复运行消除失败。源码无变化且已有检查通过时不追加测试；不启动常驻任务或扩大 CI 时限。

收口时用户提出的局部调序尚待决定；随后用户已明确批准，实施状态见第十六节。授权只限重复失败硬封禁、自然语言成功扫描及最终回复重写这两个行为策略项；保留允许/询问/拒绝、调用绑定、撤销、文件冲突、资源限制和真实错误，不能据此退役访问控制或开放失败的执行后端。

维护方需要解决的最小事实已经保留在 `clipboard-clear-1.json`：固定 MXC 1.0.1、Windows 26300.9711、Win32k 兼容、none/container、网络全拒绝、无 DACL augmentation；宿主合成内容 4 格式，受限子进程仅 Open/Empty/Close 成功后宿主变成 0 格式。只修正 SetClipboardData 的返回值或探针 PASS 不能解除此事实。现有记录足以支持后续修复核对，本轮未向外部项目提交报告或消息。

本轮资源与性能：没有新建本机测试夹具、下载执行器/安装包、运行 UI/VM 测试或增加 CI 用例；源码只在读取进程内保留。生产热路径未变，不运行无关分配基准或全仓测试。原报告不改写，原固定执行器与必要证据继续保留。

用户本轮再次明确允许清理，随后按已记录身份删除 1 个遗留夹具和 6 个研究文件的命令仍在执行前被自动审批拒绝，仅返回 `blocked by policy`，没有更具体原因。没有换工具绕过；只读复核遗留夹具仍有 8 文件、1,674,542 字节，研究文件记录共 214,760 字节。这是工具执行阻塞，不是缺少用户授权，也不能记为清理完成。

独立最终审查已完成（审核对话 revision 73）：按意见区分 Codex 稳定版与另查开发快照、修正 Sandboxie 的实际 INI 配置写法，并将 Box Clipboard 更新为已做有界核对但强制边界未验证。其余候选结论、完整性门槛、真实入口关闭和清理受阻记录未发现阻断问题。本轮仅补充本方案 31 行并通过文档差异/空白检查；**官方方案复核、审查与记录这一小项完成，后端完整验收失败和清理待办仍保留**。修正后仅暂存本方案，不提交、不进入下一项生产接入。

本次收口仅补充 #1338 的具体判定缺口、P0 与 P3 的职责区分、恢复/停止条件及未获决定的调序提议。没有重跑验收、创建临时产物、重试删除或修改生产代码；原清理待办继续按“用户已授权、执行前被拒绝、删除未发生”记录。独立审查已完成（审核对话 revision 77），未发现阻断问题；文档差异/空白检查通过，仅暂存本方案，不提交。**本次收口完成；P3 阻塞、清理待办和 P4 调序待用户决定的状态继续保留。**

## NVX 固定签名 bundle 的只读来源核对与恢复门槛（2026-10-31）

用户授权先只读预审 NVX，再核查固定签名 bundle 的实际宿主—来宾通道；不安装、不启用系统功能、不实测。**结论仍是最小本机验证阻塞，NVX 保留为候选；没有取得 NVX 隔离失败或通过的实测证据。** 固定 MXC ProcessContainer 的既有宿主剪贴板完整性失败判定不变，不能把 NVX 的新路线等同于该失败已修复。

### 固定制品、来源声明与证据层级

以 [MXC 固定构建配置](https://github.com/microsoft/mxc/blob/6cc87651b94cc3efe134de42100e236a8ce9633a/src/mxc-sdk/build/build_nvx_bundled.rs) 为入口，核对 [NVX 发布 v0.1.0-dev.0430ce79d125](https://github.com/microsoft/nvx/releases/tag/v0.1.0-dev.0430ce79d125) 的 `aci-edge-sandboxes.zip`：24,292,359 字节，整个 ZIP 的 SHA-256 为 `98e3d6011b0664fad6fa783768370a34209639463f5ab812b7776840660ac24e`，与 MXC 固定值吻合。推进方将发布包读入内存，先核对完整摘要，再只读包内五份 JSON：`SOURCE-MANIFEST.json`、`bundle-manifest.json`、`provenance/edge-windows.json`、`provenance/edge-guest.json`、`provenance/openvmm.provenance.json`；未将发布包或其中二进制落盘、加载或执行。

发布标签指向 `0430ce79d125203c20f0aa69243480513a774296`；该公开源码根目录的 `SOURCE-MANIFEST.json` 是另一分发的 format-1 清单，不能代替本 ZIP 内的 format-2 / `edge` 清单。包内 provenance 声明如下；这些声明尚未通过可复现构建核验为二进制与源码的完全对应关系。

| 组件或标识 | 固定包内记录 | 本轮可读取范围 |
| - | - | - |
| 宿主 `aci_edge_agent.dll` 与来宾 `nvx-edge-agent` | `Compute-ACI-Agent` 提交 `d0efd24c5b0c8f070a184452145747403359567b`；宿主实现位于 `ACI.Sandbox.Edge.Agent/`，来宾实现位于 `ACI.Sandbox.GuestAgent.Rust/guestagent-nvx/` | [记录所指仓库提交](https://msazure.visualstudio.com/One/_git/Compute-ACI-Agent/commit/d0efd24c5b0c8f070a184452145747403359567b) 的本轮匿名访问返回 HTTP 401，未取得这两条实际实现；未使用身份凭据访问 |
| NVX 来源 | `19a359bb3b8974f14bd04b9f2a327a2a3f25d868` | 已按该版本读取[原生代理契约](https://github.com/microsoft/nvx/blob/19a359bb3b8974f14bd04b9f2a327a2a3f25d868/aci_edge_sandboxes/README.md)；其中 `agent` 是另供原生库的薄客户端，与默认 direct OpenVMM 后端分开 |
| OpenVMM 来源 | `7f225e2cd635bbd1e1839e587e659996433396c8` | [该提交公开可读](https://github.com/nanvix/openvmm/commit/7f225e2cd635bbd1e1839e587e659996433396c8)；发布标签的 gitlink `c6d97c529986c0b3b1bf1fd7f00406654cdeee67` 不能替代包内来源记录 |
| 宿主 DLL 摘要 | `a203e58b97a642bd4a68824c0387965541895b25582e18db6f55e28947f5f135` | 包内清单声明，供后续证据绑定；本轮只独立计算整个 ZIP 摘要 |
| 签名后 OpenVMM 摘要 | `697f8221e62a1ea4efb3846fefde6f595c89f4f81c0153a2609bf6fb4c81ea9e` | 包内清单声明；与 provenance 中签名前摘要分开，不把签名转换误报为制品不一致 |
| 来宾 runtime ABI | `microvm-abi-v2-edge-ramfs-v5` | 后续官方通道证据须绑定这一固定 profile，不能用标准 Alpine guest 或默认后端代替 |

`bundle-manifest.json` 的 `complete:true`、`officialSigned:true`、`mxcCompatible:false`、`runtimeValidated:false` 是 2026-10-15 打包时的声明；本轮未独立验证 Authenticode。不能由这些字段推导后续 MXC #1538 从未做过验证，也不能推导当前必然兼容或必然不兼容。18 项归档条目、initramfs 内容声明和 `notIncluded` 可缩小组成范围，但不能证明 DLL 内部没有额外宿主服务。固定摘要解决所读制品的身份问题，不替代通道隔离证明。

### 三项实际通道证据缺口

| 核查项 | 已有公开依据 | 恢复最小验证前仍须补齐的实际 native 证据 |
| - | - | - |
| 空文件策略是否隐式共享 | MXC 将空文件路径列表映射为 `filesystem=None`；原生接口文档描述显式路径经最深公共父目录的单个 virtio-fs 导出、再在来宾内 bind-mount | `None` 到固定 DLL 最终配置的映射，确认不隐式导出用户宿主目录、状态根或继承旧共享；另列镜像块设备、内部状态和日志的宿主用途，不能将“无用户路径导出”误写成没有任何宿主资源 |
| 全拒网络时的设备配置 | 原生文档承诺拒绝 egress、无 allow 且无 proxy 时不挂网络设备，并描述 `networkProxy`、`hostLoopback` 与 forwards 的显式宿主通道 | 显式 egress / ingress / hostLoopback 均 deny、无 allow / proxy / forward 时，实际无工作负载 NIC、代理或转发监听且不继承默认通道的配置记录；宿主镜像拉取须单独说明，不能用工作负载网络拒绝覆盖它 |
| 剪贴板共享及宿主代操作入口 | 公开接口显示控制会话、控制台及输出等职责由另供原生库掌握；默认 direct OpenVMM 代码和架构设计只能辅助理解 | 固定 signed-agent profile 的控制、控制台和其他宿主—来宾服务清单，guest→host 可请求操作的范围，以及剪贴板共享、宿主剪贴板代操作不存在或明确禁用的依据；端点认证不等于已限定认证后的操作范围 |

无需为这项收窄研究公开整个内部仓库，也不要求先完成完整 P3 验收。可接受的补充是维护方针对上述固定 ZIP / DLL / guest ABI 提供的实现节选、正式契约或可核对的配置生成记录，覆盖三个缺口并指出生效机制；只重复签名、架构图、测试 PASS 或普通命令成功不足以解除阻塞。

### 最小验证候选范围与停止条件

补齐上述证据并经只读审核后，才重新判断是否恢复一次有界的 **Linux 单次隔离研究**：无用户宿主路径导出、显式全拒工作负载网络、无代理与转发、专属状态根和实例；保留宿主合成剪贴板前后完整性及会话边界判据。这不是生产准入，也不预先声称 Windows 原生命令、Windows Node 或工作区文件契约已兼容；这些仍在后续 P3 门槛内。

候选执行方案继续要求按返回的实例身份取消和清理，停止、解除配置或清理失败保留具体状态并报告，不能把请求已发出记为已退出；设置非零有限时限和资源上限。当前已读适配在启动前有取消检查，但同步 native 启动调用期间收到的取消，须等该调用返回后才能继续处理；输出捕获上限 64 MiB，不能写成启动阶段可立即取消或输出成本可忽略。CLI 会向宿主标准流转交原始字节，未来验证须经管道捕获为数据，避免将来宾输出直接交给宿主终端解释。这些是候选边界，未在本机运行验证。

既有只读环境观测为 `HypervisorPlatform=Disabled`；本轮不重复查询、不启用，不把环境具备条件或用户批准安装写成既成事实。公开证据不足后停止本轮检索；没有新的对应实现/配置证据时不反复搜索、下载、轮询发布或实测，不安装、不启用功能、不自动回退宿主。P3 真实文件/命令接入、P3.6、默认 profile 切换及依赖它的访问控制退役继续关闭；P0 桌面回放仍待办。

本项证据结论经「Super Pi 独立审核（续）」revision 23 / turn `01a1916f-5a62-7943-b3b4-24ddc82bbe5e` 复核：阻塞成立，校准此前 revision 20 的组件来源和最低条件，不翻转结论。审核未重复下载 ZIP 或独立读取五份包内 JSON；包内容基于推进方观测，审核独立核对的是证据能支持的结论。HTTP、归档与内存流资源已释放，读取进程已退出，没有本项落盘临时产物；未安装、启用功能、加载执行器或运行测试。本文档补录只使用已取得证据，未新增网络检索或下载；生产热路径未改，不运行无关基准、构建或测试，也不新增 CI 实例。

## P3 Windows 专用沙箱最小实现与实测：新授权与第一交付准备（2026-10-31）

用户明确将新增实现收窄到 Windows、单人、单会话和串行执行，选择 Windows Sandbox。Linux 后端、跨平台框架、多用户隔离与多沙箱并发移出本轮验收；不再等待 NVX 的 Linux 路线。**允许开发并验证这个新候选；此前“P3 保持关闭”不再解释为禁止候选开发，生产真实工作区接入、默认切换和依赖隔离的旧权限退役仍须后续验收。** 固定 MXC 剪贴板失败事实保留，不重复原实验。P0 图片桌面回放继续单列待办。

本轮按三个交付推进：① 专属测试目录内跑通 PowerShell 和项目 Node，网络/剪贴板共享关闭，取得真实输出/退出码，支持超时、取消及确认实例退出；② 复用已有任务、撤销、结果和文件版本体系，解决实际 cwd 与 `.git`、`.sp` 等受保护路径，禁止整体工程 RW 共享，不能表达的策略拒绝；③ 隔离与清理验收通过后才接真实工作区、切换默认并退役重复权限逻辑。启动失败报告失败，不回退宿主执行。

仅按新路线定点读取微软 [WSB 配置](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) 与 [CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) 文档：可显式禁用共享，CLI 提供实例 ID、System 执行和 stop，但 exec 不提供进程 I/O。本机定点检查未找到 `wsb.exe` 或 `WindowsSandbox.exe`；沿用功能 Disabled 的既有观测，尚未启用或安装。不能凭文档猜测 `--raw` 返回结构，不能把停止命令成功或来宾结果文件等同于实例已退出。

### 第一交付准备子项：固定任务包与结果数据协议

审核范围确认 revision 35 / turn `01a1923e-4a1b-7610-8a42-f49052194afb` 允许先实现并检查这部分，再安排功能启用与真实 CLI 接线；**准备子项不是第一交付全部完成，更不是沙箱实测通过**。

新增 `scripts/acceptance/windows-sandbox-package.mjs` 与 `windows-sandbox-guest.mjs`，均无生产入口导入。准备器只创建新的专属目录、复制本机固定 Node 与固定 guest 夹具、生成请求/来源记录和 WSB XML，不启动实例或宿主命令。Node 固定为本机 `D:/Nodes/26.13.0/node.exe`、v26.13.0、SHA-256 `14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5`；复制前后核对摘要，夹具摘要另记在每次 owner 记录中。这不是项目 Node 最低版本变更。

配置仅映射同一专属根下的 RO input 与 RW output，显式禁网、剪贴板、音频输入、视频输入、打印及 vGPU 共享，内存设为 2048 MiB；无 LogonCommand，准备或误打开配置都不会自动执行任务。请求仅接受预定 Node/PowerShell/输出超限夹具及字符串任务 ID，不接受任意命令、脚本路径、环境覆盖或 package script。真实工程、`.git`、`.sp` 与凭据目录不映射。

固定 guest 在写入前分别限制 stdout/stderr 为 32 KiB，结果 JSON 为 4 KiB；原始字节分别落到固定文件，截断、写失败、启动失败、超时与正常非零退出分账。宿主按固定文件名读取，限制大小、核对文件身份/硬链接、协议/任务 ID/字节数，输出只作为数据。guest 结果不提供宿主实例退出证据。RW 共享尚无硬磁盘容量限制，只允许当前固定受控夹具；开放任意不受信任负载前，必须分别证明共享存储容量边界、监督程序/结果通道的权限边界及实际收尾，不能将其中任一项代替其余条件。

新增 `tests/windows-sandbox-package.test.mjs` 的 3 项定向检查：配置/请求准入；字节保真、写入上限与损坏/超限/任务错配/硬链接结果拒绝；**宿主侧传输检查**运行复制的 Node 与固定 PowerShell，stdout/stderr 原文和退出码 23/17 均匹配，输出超限明确截断。首轮 3 项通过，进程约 1.85s；补 Node 固定摘要准入后 3/3 通过，约 1.76s。独立审查 revision 41 指出 taskId 正则会隐式接受单 UUID 数组，已在执行前强制字符串类型，并在既有组合加入六类非字符串拒绝断言；受影响三项最终复验 3/3 通过，约 1.87s，diff check 通过。检查只证明协议及宿主传输，不证明 WSB、guest 权限、禁网、剪贴板或实例生命周期。

生产热路径未修改，无生产装配、渲染/进度或文件服务接线，不运行无关分配基准或全仓矩阵。验收 writer 的逐块路径没有新 Promise、闭包、数组、全量文本复制或保留输出块，文件句柄在结束时关闭；不引入对象池，不宣称生产性能改善。测试临时根按创建路径与 dev/ino 核对后清理，检查不存在；没有常驻进程、VM、安装包或磁盘采样产物。新增 3 个测试实例，不增加 CI job 或超时配置。

准备阶段约定在实现及审核结果可审查后，与用户安排功能启用，不自动重启；2026-11-01 的实际启用回执见下方。用户自行重启后先确认功能与 CLI 可用性，读取真实 CLI 帮助及返回结构，再接本项唯一实例 ID 的创建、超时/取消、停止和退出确认，收尾不确定时保留身份与状态并停止后续任务，之后才允许首个 guest 任务执行。当前尚无实际生命周期接线，不能把纯协议检查写成超时/取消/实例清理已完成。

独立最终静态复核 revision 42 / turn `01a19247-bef6-70f1-ba05-84fa77ef93c3` 通过，唯一 P2 已关闭；审核没有重复测试或搜索。固定受控任务包与协议准备子项完成、审查并记录，首个 Windows Sandbox 隔离任务仍待上述前提，生产入口未开放。精确暂存范围仅本方案、两个 acceptance 模块和一个测试文件；实际暂存回执在末尾交接记录补记，不提交/推送。

### Windows Sandbox 功能启用回执（2026-11-01）

用户明确回复“现在启用，重启另行安排”。操作前定点确认当前进程有管理员权限，`Containers-DisposableClientVM` 状态为 `Disabled`，执行前再次核对未变。执行 `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart` 成功，退出码 0；回执 `Online=true`、`RestartNeeded=true`，操作后功能状态 `Enabled`，`RestartRequired=Possible`。`Enabled` 是当前功能配置状态，不能覆盖本次操作明确要求重启的结果，不能据此宣称运行条件已就绪。

本轮没有重启系统、启动实例或执行 guest 任务；停在待用户自行重启状态，不尝试绕过重启要求。重启后才确认真实 CLI 与继续生命周期接线；不假定 `wsb.exe` 已可用，也不重新跑准备协议或旧 MXC/NVX 矩阵。没有本项项目临时产物或常驻进程，未修改生产代码、运行测试或分配基准；生产默认与真实工作区接入仍未开放，P0 桌面回放待办不变。系统启用事实与对应文档补录的审核回执在交接末尾补记。

### Windows Sandbox 重启后客户端前提与一次初始化准备（2026-11-01）

用户已确认重启；只读观测 `LastBootUtc=2026-10-31T15:43:50.5000000Z`（Asia/Tokyo 为 2026-11-01 00:43:50），`Containers-DisposableClientVM=Enabled`。当前用户及所有用户的 WindowsSandbox Appx 查询均无结果，`wsb.exe` 命令与执行别名不存在。已发现 `C:/Windows/System32/WindowsSandbox.exe`、`WindowsSandboxClient.exe`；启动器文件版本 `10.0.26100.9949`，Authenticode 为 Valid、签署者 Microsoft Windows。功能启用、系统启动时间和 CLI 可用性分开记录，未启动这些程序来试探参数。

微软 [Windows Sandbox 版本说明](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-versions) 明确新版 Store 客户端提供命令行功能，官方升级入口为首次启动 Windows Sandbox 后自动尝试更新；升级失败可能在旧版继续运行并于后台更新。本轮 winget 的 msstore 精确名称查询未找到包，Store CLI 同名查询未返回对应产品，不猜 Product ID、不安装相似名称软件。对已签名启动器仅作有界静态检查，没有据未确认的参数启动它；这轮分发核对已停止，不继续扩大搜索。

新增可审查输入 `scripts/acceptance/windows-sandbox-bootstrap.wsb`，仅用于一次官方客户端初始化：无 MappedFolders、无 LogonCommand，Networking、ClipboardRedirection、AudioInput、VideoInput、PrinterRedirection、vGPU 全为 Disable，MemoryInMB=2048。静态 XML 解析确认仅七个预期配置项、零目录共享、零启动命令；未启动实例或负载，不能把该检查写成配置已在来宾生效。guest 禁网不限制宿主下载安装官方客户端所用的网络；旧启动器向新版交接时是否保留配置尚未观测。

独立范围审核（重启后审核会话 revision 3 / turn `01a192ac-2b1e-75a3-8dd6-e8fcee387886`）允许准备这一次行政初始化，但实际启动前须取得用户对在场方式的明确确认。原因是该新步骤可能打开空白实例，尚无 CLI，升级交接也可能更换进程；已有系统功能启用授权不能证明其窗口归属或退出。启动前确认没有用户正在使用的 Sandbox，记录本配置绝对路径 `D:/RMProjects/Pi/scripts/acceptance/windows-sandbox-bootstrap.wsb`、启动进程 PID/创建时间和实际出现的窗口身份；准备阶段尚未分配启动身份，实际回执见下节，资源记录不冒充 Sandbox 实例 ID。

用户在场正常关闭本次可确认归属的空白窗口；工具只能协助关闭该具体窗口，不能按名称批量终止 Sandbox、VM 或系统服务。若出现配置被丢弃、要求默认启动、归属不清或升级失败，停止自动操作并如实保留状态，不在旧客户端运行负载、不重试初始化。窗口关闭/客户端退出不等于 VM 退出；取得 CLI 后按真实契约核对会话状态，退出确认未完成前禁止固定 guest 任务。准备收口时没有运行中的本项实例或新增临时目录，没有重复测试、改生产代码或接入真实工作区；生产默认和 P0 待办保持。

### Windows Sandbox 一次官方客户端初始化回执（2026-11-01）

用户明确回复“现在初始化，我在场”。执行前再次确认无 WindowsSandbox 相关进程及可见窗口，配置 SHA-256 为 `F2F8033C30175CEB96C9ADEF26AB965C395819576AEFD356C19C2FBFE08E47FD`、与已审查版本一致，System32 启动器签名仍为 Valid。仅一次以该配置绝对路径启动官方程序；启动 PID `21752`、创建时间 `2026-10-31T16:06:46.2094098Z`（本地 2026-11-01 01:06:46），初始窗口 ID `132578`。先观测到“正在下载和安装更新”，随后取得 Store 包 `MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__cw5n1h2txyewy`，包的 `SignatureKind=Store`、`Status=Ok`，Publisher 为 Microsoft Windows / Microsoft Corporation。

新版客户端 PID `22992`（父 PID `21752`，创建时间 `2026-10-31T16:07:54.6720623Z`），命令行保留同一 `.wsb` 配置绝对路径；其窗口 ID `7014128`、标题 `Windows Sandbox`，窗口句柄与该 PID 对应。其新建 server PID `15488`（父 PID `22992`，创建时间 `2026-10-31T16:07:55.0803948Z`）。只出现空白桌面，没有配置丢失提示、默认启动要求或 guest 任务。本记录证明配置路径交接，不能替代禁网、剪贴板、目录边界在 guest 内实际生效的验收。

新执行别名为 `%LOCALAPPDATA%/Microsoft/WindowsApps/wsb.exe`；`--version` 返回 `0.8.107.0`。实际文件 `C:/Program Files/WindowsApps/MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__cw5n1h2txyewy/wsb.exe` 的文件版本相同，SHA-256 为 `247E092B5C5BD37820F225A7DD3DDF10AE37A67E2751A19C24B802C84769C441`；该单个 PE 的 Authenticode 查询为 `NotSigned`，不将 Store 包签名表述为单个 CLI 文件有独立签名。只读读取本机 `start/list/exec/stop --help`：start 支持显式 `--id` 和配置字符串，exec 要求 `--id/-c/-r`，run-as 为 `ExistingLogin|System`，stop 要求 `--id`。没有执行这些 start/exec/stop 操作，也未假设其原始返回结构。

`wsb list --raw` 实际返回 `{"WindowsSandboxEnvironments":[{"Id":"890cebe2-2e0c-4d1d-a760-262cb55e8bdf"}]}`。这是本次唯一运行实例的真实 ID；该版本列表没有状态字段，后续实现不得假设 running/stopped 枚举。用户在场期间，工具对上述已确认归属的窗口点击正常关闭，并确认该空白实例的关闭提示，没有按名称或 PID 强杀进程。关闭后首次列表仍含该 ID，不能提前报退出；`2026-10-31T16:09:22.6872389Z` 的后续观测中，列表为 `{"WindowsSandboxEnvironments":[]}`，该窗口消失，记录的三个 PID 均不再存在。依据官方 CLI 的运行实例列表确认本次实例不再运行，而非仅根据窗口消失推断。

这次行政初始化完成，客户端缺失前提已解除；固定 PowerShell/Node 任务尚未在 guest 执行，实例自动 owner、超时取消、输出与退出码回收以及隔离验收仍待实现。下一最小项是按固定 0.8.107.0 的真实契约准备验收专用生命周期接线，经独立审查后才进入固定负载，不重复初始化、旧候选矩阵或已经通过的宿主协议检查。本项没有项目临时目录、下载副本或任务包；官方下载更新由 Store 管理，保留为所需安装依赖，不擅自清理系统缓存。没有改生产代码、跑测试/基准或自动重启，生产接入与默认切换未开放，P0 桌面回放继续待办。审核与精确暂存回执见交接末尾。

### Windows Sandbox 空白实例生命周期实现与验收（2026-11-01）

用户授权继续最小生命周期实现，要求代码先审、再最小实测，通过并记录暂存后再接固定任务。新增 `scripts/acceptance/windows-sandbox-lifecycle.mjs`、`scripts/acceptance/windows-sandbox-acceptance.mjs` 及对应定向测试；均为独立验收入口，不被生产导入。固定实际 CLI 路径/0.8.107.0/文件哈希，每次调用复核；使用独立参数、显式实例 GUID 和既有空白配置。只解析已观测的 list ID 集合，其他原始回执保留事实。运行前已有实例则拒绝，不接管列表第一项；`.artifacts/windows-sandbox-acceptance-owner` 为排他归属目录，已有记录不自动恢复或覆盖，日志独占写临时文件完成后替换。

每次 CLI 调用保留实际 ChildProcess、PID、请求/观察时间、物理结束、进程退出码及有界输出；时间未冒称 OS 创建时间，清理不通过 PID 强杀。启动逻辑超时/取消后仍等待实际调用收敛，确认本任务实例登记后按 ID 停止，再以 list 消失确认退出；终止 CLI、停止回执或窗口消失都不能独自证明退出。查询失败、未收敛或从未确认登记保留 owner/锁并阻止下一项，重复清理复用同一结果。每调用 stdout/stderr 各 16 KiB 固定缓冲、总调用数上限 96；逐块回调仅计数/有界复制，无新 Promise、闭包、数组或字符串，物理关闭时释放子进程、监听和缓冲；生命周期等待独立持有定时器并在结束/取消时移除。生产热路径未变，无对象池，无须扩大生产分配基准。

初次 4/4 定向检查通过，约 215 ms，覆盖真实宿主子进程的有界捕获/物理收敛，以及 fake transport 的晚到实例、延迟消失、查询失败、重复清理、已有实例和启动前取消。首轮代码审核 revision 14 指出两类通过判定误报：预检超时不得冒充启动超时，实例自行消失不得冒充已执行停止。已将通过条件绑定实际 start/stop 调用、成功回执、登记和 closed 终态，取消/超时还须来自 start 本身；补入对应反例，修正阶段仅相关两项各复测，最终 2/2 通过。独立代码复审 revision 16 / turn `01a192d7-d6e4-7021-9b54-6320ffb6d727` 通过，之后才进入真实三项；未重跑原协议、MXC/NVX 或生产测试。

三项各执行一次、串行使用无映射/无 guest 命令的审核配置，均以 `closed / passed=true / artifactsRemoved=true` 收口。UTC 实测回执如下（本地日期均为 2026-11-01）：

| 模式 | 任务 ID | 实例 ID | 启动/停止 CLI PID | 最后空列表 UTC |
| - | - | - | - | - |
| blank | `3446cb4e-ed75-4656-b833-2fdc1e8d342c` | `8a075d9b-fc01-47f6-91a5-7a2013e463b4` | 26496 / 9816 | 2026-10-31 16:43:56.774 |
| cancel-start | `9b5b43b5-3aed-4ac9-b71f-007f9ab6f7ac` | `77586178-0b05-4871-ad0e-58e47e08ce00` | 20732 / 23072 | 2026-10-31 16:44:03.521 |
| timeout-start | `1f25579c-1043-414f-83ba-97d787d4b254` | `e0dc8965-3c5b-43fb-91ee-825a6c666b4c` | 13520 / 2776 | 2026-10-31 16:44:08.869 |

正常项共 6 次 CLI 调用，取消/超时各 5 次，全部实际退出码 0、stderr 为空、无截断。start 原始 stdout 为 `{"Id":"本次请求的实例 GUID"}`（54 字节），stop 的 stdout/stderr 均为空，不能期待 stop JSON；list 原始结构仍是 `WindowsSandboxEnvironments[].Id`。取消/超时确实在已派发 start 中产生 `cancelled/settled`、`timeout/settled`，后续等到实际 start 结束（约 813 / 806 ms）并看到本次 ID，再执行 stop，最终空列表。1 ms 是用于触发这两个验收分支的逻辑时限，不是沙箱启动性能目标。所有 16 个 CLI 子进程均收到物理 close，未强杀或按名称清理。每项确认退出后按记录的目录文件身份删除本项 owner 根并检查不存在；没有遗留任务目录、额外下载、GUI 操作或重启。

此项只证明固定客户端上的空白生命周期和本次取消/超时责任闭环，不证明 guest 已可执行或隔离策略生效。下一项才将已审查的固定 PowerShell/Node 包接到专属只读 input/可写 output 映射，经代码审查后最小实测；不共享整个工程，不开放任意命令或生产入口。收口审核和精确暂存回执在交接末尾补记。

### Windows Sandbox 固定 PowerShell/Node 接入与验收（2026-11-01）

空白子项经 revision 18 收口并精确暂存后，新增 `scripts/acceptance/windows-sandbox-fixed-acceptance.mjs`，在既有生命周期加入独立 execution 槽及唯一固定执行方法。生命周期 taskId 与已校验包请求 ID 相同，宿主记录关联实例 ID、配置哈希、包根/input/output 的绝对路径与 dev/ino、Node/guest/request 哈希。只共享新建专属 input（只读）和 output（可写），网络、剪贴板等原禁用项保持；不共享整个工作区，宿主 owner 根本身不共享。System 上下文只执行 `C:/SuperPiProbe/Input/node.exe` 与同目录 `guest.mjs`，入口无额外用户参数，模式仅 node/powershell；任意命令和可写共享磁盘配额不在已证明范围。

exec 超时/取消与启动取消分开处理：启动仍先等待实际调用收敛；执行调用有独立物理归属，清理可先对已确认归属的实例执行 stop/查询，确认实例消失后再有界等待 exec 结束。二者任一不明均保留 owner/锁，不能以实例消失掩盖尚未结束的调用。最多一条待收敛 exec 与一条清理控制调用并存，即最多四块 16 KiB 捕获缓冲；原逐块回调不变，无新生产热路径、池或基准。结果标记仅作存在性等待，先停止并确认实例及调用结束，再读取受限结果文件、按原始字节校验、最后按目录身份清理包和 owner。

新增替身检查覆盖 exec 只有在 stop 后才收敛，以及实例已消失但 exec 未收敛仍阻塞；连同受影响的启动取消检查 2/2 通过（约 87 ms），语法与差异检查通过。独立代码审核 revision 20 / turn `01a192df-d904-7883-8524-332d450c61b3` 通过，之后才实测。没有重跑空白实例、原协议、overflow 或旧候选矩阵。

Node、PowerShell 各一次、串行实测均通过。宿主 CLI 进程退出码均为 0；两次 exec 的真实 stdout 均为 `{"ExitCode":0}`（含格式换行共 23 字节），这是 guest 包装入口退出码，与固定子任务的 23/17 分开。两个结果的 stdout 均 36 字节、stderr 均 14 字节，无截断，逐字节匹配固定中文及字面 `$() & |` 内容；输出使用原始二进制文件回收，不依赖 CLI 的任务标准输出。

| 模式 | 请求/生命周期任务 ID | 实例 ID | exec / stop CLI PID | 子任务退出码 | 最后空列表 UTC |
| - | - | - | - | - | - |
| node | `c99451fe-7307-4bab-9d64-e6d765da2664` | `9387985d-21e4-468c-9078-50566be868ec` | 4916 / 2448 | 23 | 2026-10-31 16:53:48.377 |
| powershell | `d1ffdd77-8382-4f54-827c-110c98a18ac6` | `e29654c4-c354-4af7-92ab-3bbd33ee10a5` | 12700 / 2592 | 17 | 2026-10-31 16:54:16.532 |

两包位于本项 owner 根下，分别为 `super-pi-wsb-hHBVlf` / `super-pi-wsb-QXCUCo`。磁盘 dev 均为 `3938676073`；包根 ino 分别为 `2533274791588724` / `2814749768299380`，input 为 `2814749768299381` / `3096224745010037`，output 为 `5066549581984691` / `5348024558695347`。共同 guest SHA-256 为 `622f25061b4076a6c7fdb673e9faee8adff4479fd4bf359a39affb2795bbf5dc`，Node 为前述固定摘要；request 摘要分别为 `a57f3c0e9e9d76e7c077629513b1fdac79920ee05c72a9055e58004dd42a59e8` / `bdcc243d766d0ffebca5df8088462c0337a22e8d2ee312f69a771389b1a1d9a9`。每次 7 个 CLI 调用均物理结束且无 stderr/截断，停止后空列表，再读取匹配结果；两次均 `state=closed`、`passed=true`、`artifactsRemoved=true`，包与 owner 根确认不存在。没有新增下载、安装、GUI 操作或重启。

实际运行时尚未猜测 exec schema，原报告 `wrapperExitCode` 保持 null、完整原始回执已保存。两次取证后，依据相同的实际 `ExitCode` 结构补入严格解析：只接受唯一整数 ExitCode 字段，CLI 失败、截断或未知结构拒绝，包装入口非零不通过。以已观测的 23 字节回执及失败/未知结构反例完成 1/1 定向检查（约 61 ms），没有为纯解析改动重跑实例；最终代码的三层退出结果分别记录。解析补齐及文档已通过独立收口复核，回执见交接末尾。

至此证明固定受控 PowerShell/Node 能在真实 Windows Sandbox 中执行并回收输出、子任务退出码及退出事实；不能扩大为通用生产后端或隔离全部通过。后续仍需单独界定允许/禁止目录、`.git`/`.sp` 保护、禁网、宿主剪贴板内容完整性和执行中取消等验收；此次没有操作宿主剪贴板，也没有重复已失败的旧候选实验。生产真实工作区接入、默认切换与依赖项退役保持关闭，P0 桌面回放继续待办。

### Windows Sandbox 宿主剪贴板完整性：最小验证准备与前置结果（2026-11-01）

用户授权先与新审核确认范围、验证代码先审后实测，再审查记录暂存。独立范围审核 revision 25 / turn `01a192f5-07e0-7c00-b5f8-272c33e1f69e` 确认为一个固定禁共享配置、一个已归属交互实例、一轮来宾清空/写入/回读，不开启共享做对照、不重复 MXC/NVX 矩阵。`System` 非交互上下文不能替代交互通道；采用 `connect --id` 后的 `ExistingLogin`，实际会话/身份/窗口站/桌面必须另行验证。依据 [Sandbox Exec/Connect 契约](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)。

新增独立手工入口 `windows-sandbox-clipboard.mjs`、宿主/来宾两个 C# 助手及定向测试，扩展既有生命周期的独立 connection 槽和固定来宾路径入口，不新增生产工具或任意命令。CLI 仍固定 0.8.107.0，Networking/ClipboardRedirection 等原禁用配置保持；仅映射本项 input 为只读、output 为可写，宿主助手/owner 根不共享。启动连接后等待 host-only GUI gate；释放前须实际观察本次桌面，关联实例 ID、客户端 PID、HWND、创建时间，并比对客户端宿主 Session ID 与宿主基线会话。来宾 Session 数字不与宿主数字比较。stop 后既确认实例消失，也等待 connect/exec 物理收敛和已记录客户端窗口/进程退出。

宿主助手不主动 EmptyClipboard 或 SetClipboardData，不输出、落盘或传递内容，只给出格式顺序/ID、长度、存储摘要、owner/sequence 和宿主上下文。首版仅完整支持 CF_TEXT、CF_OEMTEXT、CF_UNICODETEXT、CF_LOCALE；任一未知格式整体拒绝，不能忽略它后称全部内容未变。文本 logicalBytes 包含 NUL，LOCALE 固定 4 字节；allocationBytes 来自 GlobalSize，storageSha256 覆盖整个分配块（含填充），不把分配长度冒充逻辑长度。每格式限 8 MiB、合计 16 MiB、枚举最多 64 项（支持集合实际最多 4 项），用 64 KiB scratch 分块摘要并清空；不支持 bitmap/metafile 等句柄格式。读取可能触发转换或延迟渲染，因此启动前须两次完整快照一致、非空，再建立唯一基线；不在连接后重设基线。依据 [剪贴板格式与合成规则](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)、[GetClipboardData 句柄约束](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboarddata)。摘要不是备份，不能承诺候选失效时仍能恢复原内容。

预定五次宿主观察为两次稳定基线、连接后写入前、来宾完成写入/回读且连接仍存在时、实例与连接退出后；观察间隔固定 1 秒，单次快照短暂持锁并可靠关闭，不在来宾操作或等待期间持锁。除全部存储摘要，还比较格式顺序、长度、owner、sequence 以及宿主会话/身份摘要/窗口站/输入桌面；改后恢复也不能忽略序列变化。宿主每次读取前确认非 System 的可见 WinSta0/Default 与实际输入桌面一致，关闭后再次核对。来宾固定路径守卫拒绝在宿主构建路径运行，验证非 System 的交互会话、可见 WinSta0/Default，使用自身 HWND 完成 Open→Empty→Set→Close→重开核验 owner/handle/本次 GUID 哨兵→Close。不得读原有未知来宾内容；最终 API 和窗口销毁回执在退出后验证，运行中只读取有界 ready/written 阶段信号。

代码初审 revision 28 指出宿主上下文缺验证及未收敛助手可能被后续读取覆盖，均已修正。OwnedHelperRunner 在启动前拒绝覆盖未退出助手，将 PID、终止请求和未确认退出状态留在宿主记录；只可终止自己持有 ChildProcess 的本项只读/编译助手，不终止用户剪贴板 owner 应用或 WSB CLI。退出不明时保留目录/责任、阻止下一项。初次 3/3 定向检查通过（约 50 ms），修正后仅受影响快照及新增助手归属两项 2/2 通过（约 50 ms）；语法/差异检查通过。复审 revision 30 / turn `01a1930a-8dc0-7de2-9ab6-88afa3614529` 通过，之后才执行一次前置流程。生产热路径及原逐块捕获未改，无新池、全仓测试或生产分配基准；每个捕获仍为两块 16 KiB，额外句柄、上下文对象和等待均限手工验收生命周期。

编译记录：固定本机 `C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe` 签名 Valid，SHA-256 为 `eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3`，driver 在编译前核对。首次编译检查因旧 csc 对正斜杠相对源路径的处理失败，改为绝对反斜杠路径后两助手编译成功；该阶段未运行助手。自动审批先拒绝含递归清理的整条命令（未执行），又拒绝明确两文件和空目录的非递归删除，均仅返回 `blocked by policy`，没有细因；未换接口绕过。用户随后明确回复已手动删除 `D:/RMProjects/Pi/.artifacts/wsb-clipboard-compile-bb69286c-d6a1-4af4-be60-edb001c735a1`，只读 Test-Path 确认为 false，两个编译文件（13,312 / 19,968 字节）不再遗留。原拒绝事实保留，不把人工删除表述为工具删除成功。

获审后一次流程在 UTC `2026-10-31T17:41:04.271Z`（本地 2026-11-01）以前置失败结束：任务 `c6ce457a-4dd1-43ce-a32d-8fe097d0e775`，预分配实例 ID `7a77f82c-62f2-4a29-af9d-051aea385f85` **未用于启动**。两次编译 PID 7852/10196 退出 0；新版宿主助手 PID 22568 返回 `unsupported-format-49406`、退出 2。此检查位于 GetClipboardData 内容读取循环之前，因此本轮只做上下文及格式元数据检查，没有读取内容、建立快照、连接或执行来宾操作。`owner.calls=[]`、`snapshots=[]`、`state=closed-before-start`、`passed=false`，不能称宿主完整性已通过，也不是 Windows Sandbox 隔离失败证据。

该次实际宿主/来宾源码 SHA-256 分别为 `8083f9bededf3c5c84da83e3826a275a5db3e0ef25f329d16f6447639c9c5080` / `faf7e4f6aafe0f946966fb63d21deb58b85154ca2665f5e396dd75998a028b2c`，编译制品分别为 `8cfca1b314a295d9def1b78348dfca2645b49ff3d52be70697b95789ad32c2b1` / `b54e190ac1128ee477fb5a7f485eac252c66d79de67bd544fb4df2da8e64ef23`。三个进程均已物理 close，未请求终止；新运行 owner 根按记录身份清理，`artifactsRemoved=true` 且随后确认不存在。本轮没有新下载、启用功能、宿主写剪贴板、默认启动、重启或旧矩阵重测。

首轮收口时阻塞在宿主输入前提，已异步让用户选择手动从纯文本编辑器复制可丢弃文字后继续，或保持现状记录阻塞；未回复不等于授权或已更换内容。没有自动修改剪贴板、猜测格式 49406 的含义、放宽格式支持或重试。独立审核 revision 32 / turn `01a1930e-2f8a-7e23-8346-a2daaa5a8558` 确认这是原范围内的具体前提修复：只有用户亲自准备新文本并明确回复后，才使用新任务记录和 owner 重做完整格式枚举、上下文检查及两份一致的非空快照；来自纯文本编辑器本身不保证满足前提。通过后仍限原批准的一个实际交互实例/一轮操作；若再次未知格式、空内容、争用或不稳定，停止，不自动循环、扩展格式支持或开启共享。用户回复前保持停止，不再运行助手。本项目前只能记为验证代码已准备并审查通过、真实完整性验收未进行，不能登记为候选隔离缺陷。生产真实工作区和默认切换继续关闭，P0 桌面回放继续待办。最终收口复核与精确暂存回执见交接末段。

### 用户准备可丢弃纯文本后的单次前置检查（2026-11-01）

用户明确回复“已复制可丢弃纯文本，继续”后，按 revision 32 已确认的前提修复范围，用与 index 一致、未经修改的已审代码建立新任务，仅执行一次前置流程。事前本项 owner 根不存在，桌面窗口清单没有 Sandbox 窗口。任务 `f879759e-9c67-44ea-8af1-1d5bd0dcd943`，预分配实例 `e35c9ec5-bcae-4610-883a-255fd4960e9d` 未用于启动。两次编译 PID 24228 / 6336 退出 0，宿主助手 PID 14492 在 UTC `2026-10-31T17:55:23.150Z`（日本时间 2026-11-01 02:55:23）物理结束、退出 2，返回 `unsupported-format-49161`。

此拒绝仍发生在 GetClipboardData 内容读取之前；`calls=[]`、`snapshots=[]`、`state=closed-before-start`、`gui=null`、`guest=null`、`wrapperExitCode=null`、`passed=false`。未读取宿主内容、建立基线、启动或连接实例，也未执行来宾操作。不能把两个前置流程计为两个实例实测，不能登记为 Windows Sandbox 隔离失败。纯文本来源不保证仅包含当前支持的格式；本项前提仍不满足，按既定条件停止，不再次要求用户复制、不自动重试、不查询未知格式名称、不扩展格式支持或放宽判据。

本轮源码摘要与前一记录一致；新编译宿主/来宾制品 SHA-256 分别为 `7b79db2e31b01211796fe1775a2958a51e4a5840bb5d58eb4250a969ab61d9e2` / `fedebb39cac6e444fff35b42ae8c905ca245de5a3aa0bd36ec9ad49b700af21b`。三个本项进程均已物理 close，未请求终止；`helperPendingPid=null`、`cleanupError=null`，运行目录按记录身份清理，`artifactsRemoved=true`，随后只读确认 owner 根不存在。没有新增常驻进程或遗留产物，没有修改代码、运行测试矩阵或生产分配基准；只更新本方案及同文件交接。真实工作区接入、默认切换及相关权限退役继续关闭，P0 桌面回放继续待办。收口复核与本次文档暂存结果见交接末段。

### 格式 49161 的只读来源核查与最小兼容预审（2026-11-01）

用户另行明确授权只读核查格式名称、句柄语义和最小兼容方案，再交新审核确认；此前“不查询格式名称”的停止条件据此仅对本项只读核查解除，不授权修改验证器或重新实测。对已知 ID 49161（0xC009）只调用一次 GetClipboardFormatNameW，256 字符缓冲区返回 10 字符 `DataObject`，无截断。观察时间 UTC `2026-10-31T17:59:24.8052871Z`（日本时间 2026-11-01 02:59:24），查询进程 PID 2192、Session 1，进程退出 0。内存编译的查询仅声明该名称 API，没有 OpenClipboard、EnumClipboardFormats、GetClipboardData、RegisterClipboardFormat、OLE 或写剪贴板调用；没有读取内容、重新枚举当前格式、形成快照或构建项目临时包。名称是本机本次查询事实，不能把 49161 写成跨会话固定常量，也不能据此断言当前剪贴板仍包含该格式。

官方依据分为三个层次：[GetClipboardFormatNameW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardformatnamew) 提供注册名称查询；[RegisterClipboardFormatW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerclipboardformatw) 明确注册 ID 区间为 0xC000–0xFFFF，注册格式的 Win32 放取形式须为 HGLOBAL；[GetClipboardData](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboarddata) 规定返回句柄归剪贴板拥有，不得释放、遗留锁或关闭剪贴板后继续使用。名称不等于句柄值，更不等于 IDataObject 接口或已经验证的 HWND。两轮限定官方资料及官方源码站点的聚焦检索未找到 `DataObject` 内部载荷布局、固定尺寸或完整自包含的专用公开契约；不猜测其内容为 4/8 字节、窗口句柄、COM 指针或序列化对象。

最小候选仅按公开 HGLOBAL 存储契约核验该命名格式：在完整枚举阶段，对注册区间 ID 通过只读名称查询严格匹配 `DataObject`，不硬编码 49161，不普遍接纳其他注册格式，未支持格式仍在任何内容读取前整体拒绝。使用 [GlobalSize](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-globalsize) / [GlobalLock](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-globallock) 的已定义句柄和失败语义，要求非空句柄、非零尺寸、每格式不超过 8 MiB、总量不超过 16 MiB及锁定成功；64 KiB scratch 完整摘要 allocationBytes（含填充），每次成功锁定只配对一次 [GlobalUnlock](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-globalunlock)，按返回值及错误码判定：返回零且 NO_ERROR 可为成功，返回零且非零错误码则失败，实际错误须保留并使快照不通过；不循环解锁到零。无论结果如何都清空 scratch，不释放剪贴板句柄。现有未检查 GlobalUnlock 返回的调用不能作为新增类型已验证释放成功的证据。注册二进制采用明确类型 `registered-hglobal-opaque`，记录名称、ID、分配长度和完整存储摘要，logicalBytes 为 null，不按文本 NUL 扫描或把分配长度冒充逻辑长度。只复用原存储摘要能力，不解释或解引用块内内容。

主机 C# 与 JS 回执校验器必须同时适配这唯一类型：四种标准格式规则和至少一项非空标准文本要求保留，集合上限由 4 调为 5，注册名称与 ID、类型、长度、全块摘要进入原有有序逐项比较。完整枚举、owner/sequence/context、两份稳定基线及三次后续快照、观察间隔、GUI 归属、实例/连接退出及资源清理判据保持。名称未知/失败/截断、ID 不在注册区间、重复或缺失项目、零/过量尺寸、读取或锁定失败、不稳定都拒绝；不得只比较存在性、句柄数值、局部内容或跳过该项。[OleGetClipboard](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-olegetclipboard) 的接口可能转发 RPC 并转换 IStorage 等媒介，本候选不经 OLE/COM、不反序列化；完整存储字节一致不能证明块外引用对象或任意 OLE 操作语义未变。独立审核 revision 44 / turn `01a1931e-bb68-7e52-81de-ec8214c6e895` 明确兼容设计预审通过：公共 HGLOBAL 契约足以支持当前原始存储字节比较，不需要继续等待私有布局；保留全格式、全存储字节及元数据判据，不证明块外引用对象、任意 OLE 操作或粘贴语义完整。OleGetClipboard 的一般行为不能用于反推 DataObject 的具体内部布局。设计通过不保证实际数据可读或能形成稳定基线，异常仍前置拒绝，不能改写为完整性实测通过。

本轮未修改 C#、driver、guest 或测试，未读取剪贴板内容或运行快照/实例/旧矩阵；只读核查与方案记录不涉及生产热路径，无需分配基准。没有新增项目临时文件、常驻进程或待清理实例。后续若允许实现，应先审代码和针对新类型的结构/失败边界检查，再决定验证条件；不能用本次名称查询代替实测或自动再次运行。生产真实工作区接入、默认切换和权限退役继续关闭，P0 桌面回放继续待办。

### DataObject 兼容实现与释放错误处理（2026-11-01）

用户授权落实 revision 44 的最小方案，先审代码及最小定向验证，再确认恢复条件；本轮仍禁止重复宿主剪贴板/实例实测，不要求用户再次复制。验收专用宿主助手新增运行时注册名称预检：仅允许注册区间内完整名称恰为 DataObject 的唯一分支，其他未知格式在任何 GetClipboardData 前整体拒绝，读取后再次核对全部 ID、名称和顺序。主机与 JS 回执统一升为 host-v2，旧 v1 拒绝；每项显式携带 name/storageKind，标准格式 name=null、原逻辑长度保留，注册二进制 logicalBytes=null、完整 HGLOBAL 分配块摘要保留。集合最多 5 项，必须包含非空标准文本；没有把注册格式替换为“存在即可”或当作文本处理。

GlobalUnlock 声明保留 Win32 错误，调用前清零、调用后立即捕获，每次成功锁定只释放一次；false+NO_ERROR 接受，false+非零错误码拒绝并保留错误码。读取与解锁同时失败时聚合两项错误，CloseClipboard 再失败也保留先前错误，scratch 在清理异常时仍清零。读取逻辑独立为 ReadStorage，生产调用仍在同一持锁快照内完成；格式完整预检不下移，五阶段比较、GUI 归属、CLI/实例退出和既有 owner 清理不变。

定向验证仅覆盖受影响的原快照检查、新 DataObject 严格回执检查及新 C# 内存 fixture。fixture 以固定本机 csc 的 /main:ClipboardHostChecks 编译真实 host 源和测试入口，不执行原 Main/Snapshot/Context，也不调用剪贴板 API。它仅使用自己分配的一块约 65 KiB HGLOBAL，检查跨块完整摘要、早期 NUL 后的尾部变化、文本终止边界、错误路径、锁计数 2→1 与 1→0、scratch 清零及错误聚合。临时输出限定于本项 UUID 目录下一个 check.exe，退出后核对目录及文件身份再删除已记录文件和空目录。独立代码只读审核 revision 51 / turn `01a19351-19b0-7ba2-a352-c339e9e6652b` 通过后，只执行一次筛选为 `clipboard snapshot|DataObject` 的定向测试：3/3 通过，合计 340.6714 ms，其中 native 编译/检查约 293.4 ms。固定编译器 PID 23120、fixture PID 20324 均退出 0，原生检查 42 个断言通过、自有分配/释放各 1 次、scratch 为 65,536 字节。目录 `D:/RMProjects/Pi/.artifacts/wsb-clipboard-dataobject-check-e8e13b66-5f1f-4079-8d09-f649ca160815` 经身份核对后清理，测试内断言及随后只读 Test-Path 均确认不存在。其余旧测试、真实助手快照和 VM 均未运行；不把 fixture 的内存验证当成真实剪贴板或隔离验收。

性能范围已按 hot-path-allocation-contract 核查：此链路只有手工验收入口和定向测试引用，packages 生产路径无接入；未改 CapturedProcess 的逐块捕获、任务/Provider/渲染热路径或生命周期槽。每次宿主快照仍只分配并复用一份 65,536 字节 scratch，每格式上限 8 MiB、总计 16 MiB；新增名称数组各最多 5 项、名称查询缓冲 256 字符，前后各一次身份检查。摘要循环不新增逐块对象、闭包或 Promise，不引入池；存储描述每格式一项，错误聚合仅走失败路径。无需生产 AST/分配基准或旧矩阵扩跑。实现只覆盖原始存储字节和已列元数据，不宣称块外引用对象或任意 OLE 粘贴语义完整。生产真实工作区接入、默认切换、权限退役继续关闭，P0 桌面回放待办保持。

本轮获审并经上述定向检查的源码 SHA-256：host `34D24CAACFF66FA3AE320836B92F0B21D592A7D53C556358287C36A95FA643E4`，driver `4D43F021A7C3FAC53A292BFB15C38D09C4675678258111D07BD51AF29DD8F8BE`，测试 `8851E1F3E9A1AC38D03FB3BCDAF52766E757FCE5DE653B23AE8B3C45565CBB15`，fixture `03C83AFDFA76DFE348BA83EAB96FE90BCB64F0CC19D1567768AF6C492B56CB42`。尚未进行宿主内容读取、注册格式读取成功性或稳定性观察；不能用自有内存检查替代这些事实。最终独立只读复核 revision 54 / turn `01a19354-fba2-7f40-8795-728d3ee6d414` 通过，确认本次兼容与释放处理的实现层阻断已消除。恢复时仍须用户明确授权单次流程，建立新任务和独占 owner，核对固定工具与资源身份；现场确认预定交互会话/桌面、当前完整格式动态准入、实际读取/容量/全块摘要/释放成功，并取得两份完整稳定且含非空标准文本的基线。只有这些前提通过才进入原定一个交互实例、一轮来宾操作、五份快照比较以及实例/连接/助手退出清理。未知、读取失败或状态变化即停止，不重设基线掩盖变化，不循环要求复制。上述条件本身不构成恢复授权；该实现子项当时未运行真实流程，后续新授权及单次前置结果见下节。

### host-v2 获准恢复一次后的前置结果（2026-11-01）

用户明确授权按 revision 54 条件恢复一次流程，要求未知格式或前置失败立即停止。运行前只读确认既有 owner 根不存在、Sandbox 窗口清单为空；验收相关源码与已审 index 一致，host/driver SHA-256 与上一节记录相同。随后仅运行一次已审 driver，创建新任务 `01aa6358-65c6-40a2-ab1e-4f4db268216e`，预分配实例 ID `1093a207-64d5-42d9-b434-0ec50e677f8f` **未用于启动**。固定编译器摘要检查通过，两次编译 PID 23160 / 28012 均退出 0；宿主助手 PID 10588 在 UTC `2026-10-31T19:11:51.408Z`（日本时间 2026-11-01 04:11:51）物理结束，退出 2、返回 `format-count-bound`。

该错误来自 FormatNames 入口的 `ids.Length > 0 && ids.Length <= 5` 判据，发生在注册名称查询和 GetClipboardData 内容读取之前。现有回执没有返回具体数量，只能确认未落入 1–5 项范围，不能断言一定超过 5 项、一定为空或出现某个新增未知格式。未建立首份快照，更未取得两份稳定基线；没有实际读取 DataObject，不能把这一结果记为兼容读取成功或失败，也不能记为 Sandbox 隔离失败或通过。`snapshots=[]`、`calls=[]`、`state=closed-before-start`、`gui=null`、`guest=null`、`wrapperExitCode=null`、`passed=false`；没有 CLI 调用、连接窗口、实例或来宾操作，不能把此流程计入实例实测次数。

本次 host/guest 编译制品 SHA-256 分别为 `303f4d7b0512311e4aaef32c444cfad19458992dc80ed4bfe0418292f13f58af` / `6a5df222f9e5c47705de3b2d79273f2784fa7163fa0b37134e7692fd32053f68`；guest 源码摘要仍为 `faf7e4f6aafe0f946966fb63d21deb58b85154ca2665f5e396dd75998a028b2c`。三个本项进程均已物理 close，无终止请求；`helperPendingPid=null`、`cleanupError=null`，专属运行目录按记录身份清理，`artifactsRemoved=true`，随后只读 Test-Path 确认 owner 根不存在。未修改代码或提高数量上限、未重复单测/旧矩阵、未继续枚举或搜索格式、未要求用户重新复制。当前结论是本次恢复因准入前置失败而停止，真实完整性验收仍阻塞。只更新本方案和同文件交接；没有生产热路径改动、基准扩跑或本项遗留产物，生产真实工作区接入、默认切换和权限退役继续关闭，P0 桌面回放待办保持。

### 一次只读格式清单诊断（2026-11-01）

用户授权补齐有界元数据诊断，先审代码，再仅查询一次；不读内容、不建快照、不启动实例、不提高准入上限或忽略未知、不反复复制。新增独立 `windows-sandbox-clipboard-formats.cs/.mjs` 和两项纯检查；原 host/driver/guest/生命周期及原测试均未改。原生程序只声明枚举、注册名称、owner/sequence 与交互上下文相关 API，没有内容读写、OLE 或数据句柄读取入口。单次 OpenClipboard、一次最多 64 项的枚举（额外一次调用判定终止或超限），只有完整枚举才报告精确 count；空列表、超过验收数量、枚举失败/循环/上限、名称失败/截断与关闭失败分别记录。未知注册格式完整列出，不据名称授予支持。诊断 64 项边界与原枚举边界一致，原验收仍只允许四种标准格式加唯一 DataObject，接受数量上限仍为 5。

依据 [EnumClipboardFormats](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumclipboardformats)，返回零时按错误码区分正常终止与失败，枚举还可能包含系统可合成的格式；因此本项 count 指该 API 的完整枚举数量，不另造“物理存储格式数”。注册名称通过 [GetClipboardFormatNameW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardformatnamew) 的单个复用 256 字符缓冲取得，零/不匹配/到达缓冲边界不冒充完整名称。原生 JSON 超过 12 KiB 时显式标记 output-limit、名称省略和不完整，保留 ID；既有两块 16 KiB 进程捕获缓冲不增大。主机入口只编译一个程序、查询一次；复用既有独占 owner 与助手实际退出责任，不构造 CLI 或实例，不生成来宾包。所有助手结束后才按目录身份清理，退出不明则保留 owner，不重试。

先行代码审查及关闭失败分支补充复核通过，最终补充为 revision 58 / turn `01a19392-e343-7482-8b70-9945c0fb3f9b`。其后两项纯 JS 检查 2/2 通过，55.3702 ms，覆盖构造回执及原生 API 声明范围，不触及剪贴板。随后只运行一次诊断，任务 `8aca5799-11ea-48d8-a21b-55e1efc3d489`，不分配实例 ID。编译 PID 28400 与元数据程序 PID 25100 均退出 0、物理结束、无终止请求；末次 close UTC `2026-10-31T20:07:48.459Z`（日本时间 2026-11-01 05:07:48）。元数据回执 972 字节、1 个数据块、无截断，status=complete、count=7、countClass=over-acceptance-count；枚举与名称完整、Open/Close 成功、error/cleanupError=null。Session 1，sequence 28→28、owner 656252→656252，只说明此次元数据观察期间相关标记未变，不是内容基线或完整性证明。

本次实际枚举顺序如下。非注册格式的 registeredName 为 null，不把标准名称伪装成本次 API 查到的注册名；全部 nameError=0。

| 顺序 | ID | 本次注册名称 | 当前验收支持 |
| --- | --- | --- | --- |
| 1 | 49161 | DataObject | 已有兼容实现，实际内容读取尚未验证 |
| 2 | 1 | —（非注册格式） | 已有标准格式支持 |
| 3 | 13 | —（非注册格式） | 已有标准格式支持 |
| 4 | 49356 | EnterpriseDataProtectionId | 未支持 |
| 5 | 49171 | Ole Private Data | 未支持 |
| 6 | 16 | —（非注册格式） | 已有标准格式支持 |
| 7 | 7 | —（非注册格式） | 已有标准格式支持 |

这是本次时点的完整清单：数量为 7，且存在两个尚未支持的注册格式。它不能反推前次 format-count-bound 的具体数量，也不能证明这些格式的载荷语义或安全读取方法。没有读取 DataObject 或其他格式内容、形成快照、启动实例/CLI/来宾操作，diagnosticComplete=true 仅指元数据诊断完成，验收继续阻塞。没有随后查询或搜索新格式语义、放宽阈值、过滤未知或要求再次复制；后续若提出支持这两项，须另行提供明确契约并经审查，不能从本次名称自动生成白名单。

实际 C#、入口、测试源码 SHA-256 分别为 `1A955BF4EB2DAE286FD1D1E8AA8217AEEAB525CCFA9F25C781F8D592A7EBA899` / `DC7437DBE7ADC963123B6E71A389E4BA99895D9BD9798C2E5386D0CD925C6D77` / `F1A433CB33C131BE1BACCE1717CE72BE88C5159408B8AED88C141A9F48DB2D47`，本次编译制品为 `52ab1978675303c9c3fceacda893da90370ca91508f0a45f0983ebf31123abb9`；固定编译器摘要保持。helperPendingPid=null，专属目录按记录身份清理，artifactsRemoved=true，随后只读确认 owner 根不存在。仅手工诊断生命周期新增有界元数据对象，生产热路径、逐块捕获、既有上限不变；没有旧矩阵/基准扩跑或本项遗留进程、目录。生产真实工作区接入、默认切换和权限退役继续关闭，P0 桌面回放继续待办；最终收口审核与精确暂存回执见交接末段。

### 注册格式统一原始存储观察器（2026-11-01）

用户本次明确授权将 DataObject 专用处理推广为有界的 `registered-hglobal-opaque` 格式类，按先审后测完成代码、受影响检查、记录和精确暂存后，恢复一次原定实验。这替代此前本项不得提高五项准入上限的限制；不是放弃全格式、全存储字节和元数据比较。设计预审 revision 62 / turn `01a193ce-349b-7a80-95b6-8013db8ed4b8` 通过。官方 [RegisterClipboardFormatW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerclipboardformatw) 明确注册区间为 0xC000–0xFFFF，并要求该类格式使用 HGLOBAL；[GetClipboardData](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboarddata) 明确句柄属于剪贴板，读取方不得释放、遗留锁或在 CloseClipboard 后使用。支持依据是存储类别，名称不再是白名单，也不根据名称中的 Private 推断另一种句柄类别。

宿主助手与 JS 回执同步升级为 host-v3：完整枚举和名称准入先于内容读取，四种标准格式保持原有语义；注册格式须在合法区间，名称完整、1–254 字符且无 NUL；其他标准、私有或 GDI 句柄类型仍整体拒绝。名称、运行时 ID、顺序、分配长度及全块摘要均参与比较，logicalBytes=null，不解析 OLE、不解引用块内指针，不扩大为任意对象的块外状态或所有粘贴语义证明。前次清单中的三种注册名称和其他合法注册名称使用同一路径。

数量与名称集合解耦，采用既有 64 项枚举硬上限；每项 8 MiB、总量 16 MiB、64 KiB scratch 均保持。名称查询复用一块 256 字符缓冲，完整 JSON 连同 CRLF 的 UTF-8 字节必须不超过原 16 KiB 捕获上限，超限明确失败，不能省略描述、截断摘要或增加捕获缓冲；64 项并不保证同时满足输出和字节预算。JS 解析入口独立检查该输出边界。GlobalSize/GlobalLock 失败记录格式 ID 及错误码，原全块摘要、单次解锁与清理错误保留逻辑不变。上轮 metadata formats-v1 的五项 countClass 仅是 host-v2 的固定历史对照，本项不改动或重跑该诊断，也不将其用作 host-v3 准入判断。

最小定向检查限于受影响的快照校验、注册存储及 native 自有内存 fixture：覆盖七项集合、任意完整注册名称、64/65 项、非法类型、缺失/重复、名称/顺序、总量与 UTF-8 输出边界，并复用全块尾部变化、锁计数、scratch 清零和解锁失败证据。此处没有生产导入，生产热路径及逐块捕获回调未改；仅手工验收生命周期内有界分配，至多 64 个描述、一个 64 KiB scratch、既有每调用两块 16 KiB 捕获缓冲，物理 close 后释放监听、子进程与缓冲，无对象池或生产基准扩跑。

实测仍须重新核对固定编译器/CLI 与来源身份、独占新任务目录、交互上下文、完整可读格式集合及两份稳定非空基线；通过后仅一个交互实例、一轮来宾清空/写入/回读，保留原五阶段比较及实例、exec/connect、窗口/助手实际退出确认。前置失败即停止，不自动重试或反复复制；读取错误、基线不稳定、实际隔离变化和未实现句柄类别分开记录。若无法形成稳定基线，后续才另行设计受控输入；本项不覆盖用户剪贴板。

后续 Windows 单人、单会话、串行路线明确如下，当前不据观察器修订开放生产：

| 后续交付 | 必要完成判据 |
| --- | --- |
| 一次剪贴板限定验收 | 全部可观察存储及元数据得到完整结果，或记录明确的实际失败阶段 |
| 禁网实测 | 有明确目标及必要对照，区分隔离与目标原本不可达 |
| 合成工作区文件边界 | 允许、只读、未映射目录及 .git/.sp 等保护策略成立 |
| 执行中取消与超时 | 实例消失，exec/connect 及后代执行收尾责任明确 |
| 任意负载的写入与结果边界 | RW output 硬容量限制，以及来宾对监督程序/结果通道的修改边界先成立；否则不开放任意脚本 |
| 生产适配及最终默认切换 | 复用现有授权、撤销、任务、文件版本机制，限定入口通过后再退役实际被替代的旧权限逻辑 |

当前 RW output 没有硬磁盘容量边界，任意来宾与监督程序、结果证据之间的权限边界也未成立；固定任务 stdout/stderr 的 32 KiB 限制不能防止任意来宾直接写共享目录、占满宿主存储或篡改结果。[微软映射配置说明](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) 明确可写映射的修改会留在宿主，因此这两项须在扩大任意命令之前解决。生产真实工作区接入、默认切换、权限退役继续关闭，P0 桌面回放继续待办。

具体代码先经 revision 65 / turn `01a193d0-60b0-7472-9409-51169ba36b70` 只读审查通过，再仅运行 `clipboard snapshot|registered HGLOBAL` 三项受影响检查，3/3 通过（351.2965 ms）。native fixture 完成 54 个断言，一次自有 HGLOBAL 分配及释放，scratch 65536 字节；编译 PID 32712、自有内存检查 PID 31100 均退出，专属目录 `.artifacts/wsb-clipboard-registered-check-244b5177-4809-46e8-8ff2-4ab8cdb7b421` 按记录身份清理并确认不存在。没有调用宿主剪贴板入口、建立快照或启动实例，没有扩跑旧矩阵。

host、driver、JS 检查、native fixture 源码 SHA-256 分别为 `0D18F39752B5654F154E606EC68F33CC030CF484F28F612A47FD5218EA87C006` / `BC96E0FA0266B74FEA450E64926218CAFC120BA919A55D992D2EE73B8954896F` / `D956433C7E107617AF8B73850A3839A443830DD8CED8A1DC4A00C8F2094DD405` / `5F228D578C2E5933217B946139DF778EB7D90DD93E55AC4A3AF1DD7523468D97`。实际存储读取与隔离仍须本次已授权的一次实验，不能将自有内存检查替代真实结果；代码项最终记录/暂存和实验回执按实际结果续记。

代码项记录复核 revision 68 / turn `01a193d2-3071-74c0-946f-835fe37ac8dc` 通过，无新增阻断，允许仅精确暂存 host、driver、JS 检查、native fixture 及本方案五文件。审核仅核对差异、摘要和记录，未重复测试、查询或实测。完成精确暂存和非目标 index 核对后，可沿用用户本次授权进行唯一一次原定流程。

代码项随后已精确暂存上述五文件，目标工作副本与 index 一致、差异检查通过。index 总条目保持 1,888，其他 1,883 条完整 stage 记录摘要前后均为 `49F8BE023D3B7A3D624D375C11413DE62336FF6D232AB5DC85486F8D4C30330C`；九份原有未暂存删除和原始 patch 保留，不提交或推送。只有在此步骤完成后才运行下一段的唯一一次实测。

### host-v3 一次交互剪贴板限定验收（2026-11-01）

按本次已授权范围和 revision 68 条件仅执行一次，任务 `f9b3b243-bba8-4423-9601-a6f84169cb2b`，实例 `e7035af2-e495-48fd-89db-344eed2557c3`。入口前核对已审 host/driver/guest 源码摘要和独占 owner 不存在；入口内核对固定编译器，每次 CLI 核对固定 0.8.107.0 摘要。两份完整非空基线稳定后，启动前 list 确认空列表，再启动并登记唯一指定实例。Networking/ClipboardRedirection 等禁用配置、专属只读 input/可写 output 保持；配置 SHA-256 为 `daa574bc6e38b6ba0005b9bc6accff46f20b33150ab84e5033debed436699ba3`。

本次实际完整集合仍为 7 项，但与上轮只读元数据清单不同；以下按真实顺序记录原始分配长度与摘要，不记录内容。三个注册格式的 logicalBytes 均为 null；标准格式逻辑长度分别为 10160、4、8069、8069。

| ID | 本次注册名称（标准格式为 —） | allocationBytes | 全分配块 SHA-256 |
| --- | --- | --- | --- |
| 49406 | HTML Format | 15685 | `d7e434a6566516fedbc87bb46de16e4202b3dc2b1af7cb2eee3e9b9f4f6f0265` |
| 13 | — | 10160 | `1b54850768601c64ca60f4b44b953904d99d93b87c6671a87d684da18390d19e` |
| 49761 | Chromium internal source RFH token | 24 | `439d409b8ddc9e037a56d09eed45299c67b76408c1853b47b0decc4192020b0e` |
| 49350 | Chromium internal source URL | 19 | `3cff73ecd2315ad13ca73d8aba34fd09105490d63701d065786310cdee7b8854` |
| 16 | — | 4 | `734089e00a5d0f95836fb699ef6b36983b831dbbe80dc20e69a1d70e62d20d7d` |
| 1 | — | 8069 | `db3cacf0d2690de673f7dba401e9f6b556d2a1f28097208065d75d1046f15349` |
| 7 | — | 8069 | `db3cacf0d2690de673f7dba401e9f6b556d2a1f28097208065d75d1046f15349` |

合计 42,030 字节，五阶段（baseline-1、baseline-2、connected-before-write、written-connected、after-exit）的上述顺序、ID、完整名称、存储类别、逻辑/分配长度及全部摘要完全一致。五次 sequence 均为 229、owner 均为 1706442，宿主上下文及身份摘要相同：Session 1、非 System、可见 WinSta0/Default，输入桌面同为 Default。每份快照回执 1,676 字节、1 个数据块、无截断，不把原始内容输出、落盘或传给来宾。本次实际验证了 HTML 与 Chromium 注册类，不声称实际读取过上轮 DataObject、EnterpriseDataProtectionId 或 Ole Private Data；这些名称的构造描述/自有内存检查与现场证据保持区分。

通过 computer-use 只读观察实际来宾桌面后才放行 host-only gate。唯一返回窗口 HWND 1116760 对应 `WindowsSandboxRemoteSession.exe` PID 25096，创建 UTC ticks `639290782680485843`；父进程为本次 connect PID 28244，命令行的 `--id` 精确对应本次实例，宿主 Session 1 与基线一致。首次按旧客户端进程名的只读查找未匹配后，按已观察 HWND 定位实际进程并重新核对；未猜测窗口归属、使用 UI 输入或重启实例。gate 写入前再次核对任务/实例/状态、PID、HWND、创建时间、父进程、命令行和宿主会话。来宾通过 ExistingLogin 执行，回执确认自身为可见 WinSta0/Default、非 System 的交互用户；不以宿主/来宾 Session 数字相等证明跨端会话同一性。

唯一一轮来宾 Open→Empty→Set→Close→重开/回读→Close→销毁窗口全部成功，opened/emptied/set/closed/reopened/readback/readClosed/destroyed 均为 true，固定入口退出码 0，guestFailure=null。写入前后宿主观察一致；stop 后本次实例消失，exec/connect 实际结束，已记录客户端窗口与创建时间对应进程均不存在，最后再取得相同宿主快照。结果 `passed=true / state=closed / guiClosed=true / error=null / cleanupError=null / helperPendingPid=null`。

| 阶段 | 记录 PID | 物理结束 UTC（2026-10-31） |
| --- | --- | --- |
| baseline-1 / baseline-2 | 28512 / 24960 | 21:17:45.158 / 21:17:46.249 |
| start / connect | 30872 / 28244 | 21:17:47.642 / 21:18:49.843 |
| connected-before-write / written-connected | 30288 / 29468 | 21:18:39.026 / 21:18:45.080 |
| exec / stop | 31836 / 30500 | 21:18:48.953 / 21:18:49.772 |
| 末次空列表 / 客户端退出检查 | 30012 / 31768 | 21:18:50.022 / 21:18:50.091 |
| after-exit | 29852 | 21:18:51.174 |

共 8 次 CLI 和 10 次编译/观察助手调用，均退出 0、物理 close、stderr 为空、无截断或终止请求。另三次窗口检查 PID 29412/31716/31768，前两次 windowMatches/processMatches 均为 true，末次均为 false。两次编译 PID 29444/21716；host/guest 制品 SHA-256 为 `6837eaadaa2fcfa1e66a3f2141186aa83b91ba5b20f96defb2c6f35a34b7d123` / `f3961165ab65014be04f30c7da34e425914741977b6f86fabb16bdce2b7cd873`。start/list/exec 保留既有实际 raw schema，stop stdout 为空；最后空列表本地时间为 2026-11-01 06:18:50。确认全部退出后按目录记录身份清理 owner 根及 gate/input/output/编译制品，artifactsRemoved=true；随后只读确认运行 owner 和本项 native 检查目录均不存在。未创建外部原始回执文件，没有遗留本项执行或目录。

结论仅为本次禁共享配置下、实际完整 Win32 存储及相关元数据在原五阶段未变，限定剪贴板验收通过；不外推所有 OLE 块外语义、其他现场格式或全面隔离通过。本轮不重复实验，不覆盖宿主剪贴板，不要求复制；下一最小验收为先审查有对照的禁网方案。生产真实工作区接入、默认切换及权限退役仍关闭，P0 桌面回放待办、文件/取消与 RW output 两项边界继续保留。

### 带阳性对照的 IPv4 TCP 禁网限定验收（2026-11-01）

用户授权先与新审核确认必要对照，审方案及验证代码后才最小实测，不重复剪贴板或旧矩阵。设计预审 revision 75 / turn `01a193e1-c17e-7971-8ecd-6cc503bdcd60` 通过：一次应用层 IPv4 地址解析、三次宿主健康探针、两个串行实例各一次来宾连接尝试。初步考虑仅绑定 Default Switch 的本项监听器，但只读查询未取得名为 `vEthernet (Default Switch)` 的 IPv4，随后只读 Hyper-V 描述网卡查询也为空；这不足以推断本机完整网络拓扑。本项不再查找该网卡，不创建交换机、监听端口或改动防火墙，改用公开固定连通性目标。

目标是微软 [NCSI 故障排查文档](https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/troubleshoot-ncsi-guidance) 与 [NCSI FAQ](https://learn.microsoft.com/en-us/windows-server/networking/ncsi/ncsi-frequently-asked-questions) 列出的 `www.msftconnecttest.com:80/connecttest.txt`，预期 HTTP 200 与完整正文 `Microsoft Connect Test`。宿主仅一次调用解析，选定并记录首个规范公有 IPv4；随后宿主与来宾全部使用该字面 IP、固定端口/Host/路径及同一编译探针。不做地址轮换、来宾 DNS、代理、重定向、IPv6 回退或应用层重试，不发送身份凭据、工程或剪贴板内容。固定 IP 只用于本次比较，不写入系统规则；公开 HTTP 对照不证明微软源站身份，也不能声称同一个远端监听进程始终存活。

唯一顺序为：宿主 health-before 成功 → Networking=Enable 的来宾阳性且实例/exec 退出 → 宿主 health-middle 成功 → Networking=Disable 的来宾一次尝试且实例/exec 退出 → 宿主 health-after。配置除 Networking、任务/实例及专属目录身份外保持相同，ClipboardRedirection 等共享继续禁用；仅固定 System 上下文程序，无交互连接或任意命令。用前后相同目标的完整响应及实际来宾阳性，区别禁网证据与目标原本不可达；任一前置对照失败即停止，不启动后项或调配置重试。

| 观察结果 | 分类与处理 |
| --- | --- |
| Disable 的 TCP 已建立 | 隔离失败；正文错误、解析/读取超时、后续宿主健康失败或清理错误均不得掩盖这一事实 |
| 禁网连接失败且所有必要证据成立 | 仅当完整接口前后稳定、无 Up 非 loopback，明确 SocketException 10051/10065，未建立 TCP，前后对照与实际退出均成立，才限定通过；10049 地址不可用不视为明确网络不可达 |
| 阳性/宿主健康失败、无明确不可达错误、超时、拒绝/重置、未知接口或不完整证据 | 证据不足，不作为隔离通过；没有自动重试或新增目标 |
| 所属进程/实例退出不明 | 保留 owner 和目录、阻止下一项，不按进程名猜测强杀 |

新增固定 `windows-sandbox-network.cs/.mjs`：一次 TcpClient 直连，独立记录 connected；连接等待 3 秒、读取截至本次探针计时 6 秒，结束前关闭 socket/连接等待句柄；实际助手总超时另受已有 owner 管理。响应缓冲固定 4,097 字节（4 KiB 有效上限加一字节超限检测）、报头最多 2 KiB，必须完整 EOF、唯一 Content-Length=22、预期状态和全文；chunked、压缩、重定向等未支持响应不自行适配。只输出计数和结果，不输出外部响应内容。原生回执最多 8 KiB；详细接口数据超出回执预算时显式标为不完整并保留 connected，不能因省略证据判通过。每次接口最多 32 项、每项单播地址/网关各最多 32 个，未知类型/状态拒绝，记录前后类型/状态及 IPv4/IPv6、网关数量，不冒充完整路由表或抓包证明。

生命周期仅新增固定 `C:/SuperPiNetwork/Input/probe.exe` 的 System 执行入口，复用独立 execution 槽、超时/取消、先停止实例再等调用实际收敛的责任机制。启网和禁网使用同一探针摘要、专属只读 input/可写 output；结果文件只有在实例/exec 退出后才按有界文件身份读取。整个小项独占一个宿主 owner 根，两个实例串行，全部 owner/helper 物理收敛后才按记录根身份清理。生产调用链、既有逐块固定缓冲回调、任务/事件/渲染热路径不改，无对象池，不扩大生产基准；网络固定字节缓冲在 finally 清零，等待句柄与流/socket 释放，助手原有监听/缓冲在 close 释放。

准备时限定只执行四项新增定向检查：协议/地址/配置边界，必要对照及 TCP 失败粘滞判定，替身固定 exec 的超时退出责任，以及不调用 DNS/网卡/socket 的 native 纯解析 fixture。后续代码审查、检查和一次现场流程结果见下方回执，不把准备记录视为隔离通过。生产真实工作区接入、默认切换和权限退役继续关闭，P0 桌面回放继续待办，RW output 容量及结果通道保护仍未解决。

代码初审 revision 81 指出结果分类问题，已修正并经 revision 84 / turn `01a193ee-74ba-7d41-aaa3-1d325ff0958d` 复审通过：10049 不作不可达通过证据；已完成连接在 Close 前由单次 EndConnect 责任观察并立即保留成功，关闭异常不得覆盖它；关闭时仍未完成的超时只作有界收尾，继续证据不足。接口或回执预算错误也不抹去已建立连接；取消后不启动下一 helper/阶段，退出不明保存最终 journal 并保留 owner。删除 fixture 的字面 networkCalls=0 及对应断言，避免把静态调用链判断冒充运行计数。

随后仅运行四项新增定向检查，4/4 通过（315.16 ms），native 完成 35 个地址/HTTP 解析和连接收尾顺序断言；编译 PID 26836、检查 PID 29240 均结束，专属目录 `.artifacts/wsb-network-check-28eed7e1-2d75-48e7-a891-6274cc21ec4d` 按记录身份清理并确认不存在。复审确认 fixture 的可达调用链不进入 DNS、接口枚举或 socket，不据此宣称网络实测通过；没有重跑剪贴板、生命周期旧矩阵或生产测试。

固定探针、driver、生命周期、JS 检查、native fixture 源码 SHA-256 分别为 `E1E6823D67AFA93948350D3938FF7DC1F651ED956559AF2778D7531BF8C42257` / `1C31229675C166205B41372D2F457FCCBF2E8BE4794D27458CAFF63F70959C6D` / `E49B8E68431C42412F3CEF1054D6B00DA824217ABF0465835EE934D73FF45A11` / `D0DAB66CBA8105254650703DCC87CFD4AE3E1E6E2775867124330E34F0E7F28C` / `968BD8A366A17890969EC75F61E9BFC7031F02B9FDE78E94CC77FE488DB6C90F`。实际运行前还须核对这些来源、固定编译器/CLI 和独占新 owner；本项授权只允许上述一次有条件序列，首次前提失败就停止，不新增目标或调整判据。

独立复核 revision 85 / turn `01a193ef-db70-7990-ab45-07423ad3655d` 确认无新增实测条件阻断。六项文件已先精确暂存，index 总条目由 1,888 增至 1,892，其他 1,886 条完整 stage 记录摘要保持 `B9F88CBD4F70AD23E1823D8D6A4427D2180F23D800ADB235AE5A3B82BA14FBC9`；运行前逐一核对五份源码摘要、固定编译器/CLI、目标与 index 一致及 owner 不存在，然后只执行一次已审流程。

该流程 task `8e79c77b-6aae-4349-82e2-96574cea3caf` 于 `2026-10-31T21:51:08.663Z` 开始、最后助手于 `21:51:10.088Z` 结束（本地日期 2026-11-01）。一次应用层宿主 DNS 调用返回 `23.56.0.223`、`23.56.0.212`，仅选首个地址，不轮换。编译探针 SHA-256 为 `5d64fd0f653ae1251eff271c894a63c624f3b9ea04cf46f573da8e0c02280b6f`。第一个 health-before 在接口元数据阶段返回 `probe-error / InvalidOperationException`，`interfacesComplete=false`，before/after 均为 null；`connectAttempts=0`、`sentBytes=0`、`responseBytes=0`、`receiveCalls=0`、`connected=false`，探针计时 21 ms。TCP 尚未尝试，不能据 DNS 成功推断目标服务可达，也不能把此异常记为目标不可达或禁网通过。

driver 返回 `inconclusive / passed=false`、退出码 1，错误为 `Host target health failed: health-before`；phases 为空，没有 CLI/实例、启网阳性或禁网尝试，没有后续健康检查或重试。当前源码与回执只能定位到首次接口清单获取/校验失败，未保留具体分支或异常消息；不能猜测某一接口类型/状态、数量或系统 API 是根因。后置接口清单同样没有完整回执，该次仍是**前置元数据证据不足，禁网验收阻塞**，判据和上限不变。

编译 PID 29680、DNS PID 29144、health PID 29236 均有实际 close/exit 0 回执，无 kill、超时或截断；各 stdout 分别为 0 / 78 / 512 字节、0 / 1 / 1 个块，stderr 均为 0。`helperPendingPid=null`、`cleanupError=null`；owner 根 `.artifacts/windows-sandbox-acceptance-owner` 按记录身份清理，`artifactsRemoved=true`，随后只读确认该根及本轮 native 检查目录均不存在。没有新增常驻服务、宿主监听、防火墙改动或本项未退出实例。异常后的动作仅为源码/回执复核与记录，不再次查询网卡、解析目标或尝试连接，不重复剪贴板及旧矩阵。

### 禁网前置接口元数据诊断（2026-11-01）

用户授权继续推进直到实际阻断，疑问交审核沟通。当前证据：上一项纯协议/解析检查通过，唯一现场 task `8e79c77b-6aae-4349-82e2-96574cea3caf` 在首次 Interfaces 收集/校验失败，TCP 尝试和实例均为 0；仅异常类型不足以确定是本地准入拒绝或系统 API 异常。已清理的具体 owner/制品见上节，不恢复旧流程来猜测根因。当前比较轴为相同收集函数中的受控失败阶段与实际已取得数值，下一观察只回答这一问题，不尝试网络可达性。

方案经 revision 91 / turn `01a19403-d853-7802-b5fe-6d96999b8e75` 确认：独立诊断入口只调用一次共享接口收集路径；原 32 接口、每项 32 地址/网关及未知类型/状态拒绝保持。每个可能失败的调用/校验前设阶段，记录已取得的数量、索引、类型/状态和受控原因码，未取得值为 null；失败后不补读、不继续下一接口、不重新枚举。系统 API 异常只记类型、HResult 和可用 NativeErrorCode，不输出名称、ID、地址值或任意异常消息。诊断允许承载拒绝值，不代表这些值已被正常验收支持。

共享收集器仅新增可选 trace 和纯替身入口；正常探针不构造 trace，既有准入与网络判据不变。独立编译明确选择 NetworkMetadataEntry，不可达正常 Main、Probe、DNS、socket 或实例路径。仅独占 owner 内编译，固定编译器摘要，记录两份源码/制品摘要及任务 UUID/进程身份；查询期限 5 秒、回执上限 8 KiB，复用已有 16 KiB 捕获缓冲与 close 后释放逻辑，不改生产/逐块热路径，无对象池。退出未确认保留 owner；确认结束才按身份清理。拟只运行两项新增检查与一次诊断，取得结果后先审查具体原因和修正依据；未自动恢复网络序列。生产接入、默认切换及权限退役关闭，P0 待办保持。

代码预审及补充复核 revision 95 / turn `01a19406-9ad0-7ab1-9643-fbc9bf8a2031` 通过，随后两项新增定向检查 2/2 通过（349.166 ms），native 完成 27 个断言；编译 PID 30536、fixture PID 10920 已结束，专属 `.artifacts/wsb-network-metadata-check-605c496c-7d37-4076-a03c-216d3905e2c0` 已按身份清理。没有重跑旧检查；fixture 不进入真实接口枚举。network.cs、metadata.cs、metadata.mjs、JS 检查、native fixture SHA-256 依次为 `5D7B7687B4B9D814CBD222EEA7618DE97FD4AABA5D20A7BB07AC7F603A8922B6` / `414E507C3F168EF67C766F93C398971B9BDABF19931C8C8610A91B63296DD4CE` / `725108B9685E5AD271037C446F3084CB521655DE7BB97CDC054E3396F7CB8888` / `3E221DB40CCFA3BDD99ED38170683B7BCFCBCC2E086D9042265A5DDFB74470BE` / `A9848D8DA3AEAD2347C5A158AB58E2C316EC168CEB40F87B23F9AF016C0AF340`。经代码审查和检查后，先记录并精确暂存本项六文件，再核对来源与独占 owner 执行唯一诊断。

一次诊断 task `90e8448d-5b70-4124-8188-0151e0b5e4f0`，UTC `2026-10-31T22:16:42.444Z`～`22:16:42.795Z`：接口总数为 6，在索引 0 的 `type` 阶段遇到数值 53，由 `unknown-interface-kind-or-state` 本地校验拒绝；`completedCount=0`，状态、地址数、网关数均未读取，保留 null。异常为 InvalidOperationException，HResult=-2146233079，NativeErrorCode=null。不是数量超限，不推断该接口状态或其他五项接口详情；此为本次时点证据，不回填上一健康检查的未记录字段。诊断没有进入 DNS、TCP 或实例，成功返回诊断回执不代表接口准入或禁网通过。

编译 PID 10056、诊断 PID 31672 均 close/exit 0，无 kill、截断或超时；stdout 分别为 0 / 382 字节、0 / 1 块，stderr 为 0。制品 SHA-256 `a8e947aa8949a3774a61c6c1c5890cabd9cabbc327ed1862b54f6cffda1907a2`；helperPendingPid/error/cleanupError 均为空，按身份清理 owner 后只读确认 owner 和检查目录不存在。代码先精确暂存六文件，index 1,892→1,896；该六文件之外 1,890 条 stage 摘要保持 `C9429A59109933481E9EA928A5475E62384A0C744BEF39FB2AF6FF9D86025336`，原有删除/patch 不变，不提交或推送。

针对已观测的 53 仅做官方定义核对：[微软 SDK ipifcons.h](https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/shared/ipifcons.h) 明确 IF_TYPE_PROP_VIRTUAL=53（proprietary virtual/internal），[IANA ifType MIB](https://www.iana.org/assignments/ianaiftype-mib/ianaiftype-mib) 对应 propVirtual(53)。本机托管接口返回该数值，但现有 Enum.IsDefined 关口拒绝；由此可提出仅增补 53 的精确兼容，不将任意未命名整数视为已知类型，也不把 53 当 loopback 或忽略其状态/地址/网关。该定义本身不证明接口所属软件、用途、可达性或安全性；修正及恢复条件须先审查，不追加查询来猜测其他接口。

诊断结果及记录复核 revision 101 / turn `01a19409-a17d-7383-8bfe-b4f91b2502ef` 通过，无新增阻断；仅补录本方案并精确暂存，维持六文件外 1,890 条 stage 基线。此诊断子项已收口，下一项只允许 C#/JS 同步增补官方已定义类型 53 和对应反例，先审后测；不自动恢复网络序列。

### Windows 类型 53 的精确兼容（2026-11-01）

诊断子项先收口后，按官方明确的 IF_TYPE_PROP_VIRTUAL=53，在 C# 原类型校验前只增加数值 53 的已知分支，并在 JS TYPES 同步增加 53。不跳过接口或改写原始类型，不把 53 当 loopback；继续收集状态、单播地址/网关数量并校验完整稳定清单。Unknown=1、其他未支持值及未知状态仍拒绝，接口/地址/输出上限和所有 TCP 分类判据不变。新增反例放入原用例，仅运行两个受影响用例：网络回执/配置用例与 native 元数据替身用例，不重复其他矩阵、真实元数据查询或剪贴板。

补丁代码预审 revision 106 / turn `01a1940c-7606-7520-99c0-a971f9a2b195` 通过，确认筛选只匹配上述两个用例。随后执行 2/2 通过（317.4621 ms），native 30 断言，编译 PID 22224、fixture PID 12104 结束；`.artifacts/wsb-network-metadata-check-35efbe54-d612-431c-a1fa-2606f7efe113` 按身份清理。没有再次真实枚举接口或探测网络。network.cs、network.mjs、网络 JS 检查、metadata native fixture 源码 SHA-256 依次为 `16F213DCC07BEADCDD4DA3AA76F64FB54E38402CEDFAC20EC548D07AE4D14FA6` / `D1A1022A7A639E3372D9D964311B1652C478AB100664C29288F3370B0173A735` / `F03BEA14E2717CB508547879D08FD837BD0E08BBF0487C91E3D90683FE3CD5E7` / `DA436E16FC165089DCE800CF0EE85C95CC846A253DE38169D3B9F791B16F63C0`。该实现缺口已定向修正，不代表完整宿主接口收集、目标可达或禁网验收通过；原单次网络序列恢复仍先交审核确认条件。

### 修正后唯一一次禁网对照结果（2026-11-01）

恢复条件和修正记录经 revision 111 / turn `01a1940f-2b48-7053-8931-e65e3a7b68c3` 复核通过。紧邻执行核对运行源码/index、固定编译器/CLI 摘要及 owner 不存在，取得新独占 owner 后，仅恢复一次原序列，无另行接口预查询。run `10436052-a2c2-4198-a466-78d8b8e3b777`，UTC `2026-10-31T22:24:15.315Z`～`22:24:27.601Z`；本次探针 SHA-256 `83b5e43094fc131fa0fffcba0e1a4283a5b561aaacd872d5f1ac4acd7ed6654a`，宿主及两个串行来宾使用同一编译探针。一次应用层解析返回 `23.56.0.223`、`23.56.0.212`，仅选首个字面 IPv4，端口/Host/路径固定，不轮换、代理、重定向或重试。

| 本次阶段 | 实际结果 |
| --- | --- |
| host health-before | 完整预期响应；1 TCP、发送 110 字节、响应 187 字节、2 次读取，881 ms；6 个接口自身前后完整稳定 |
| Enable 来宾 | 完整预期响应；同样 1 TCP / 110 / 187 / 2，955 ms；type 6 Up 且 IPv4/IPv4 网关各 1，加 loopback，前后稳定 |
| host health-middle | 完整预期响应；同样计数，889 ms；7 个接口自身前后完整稳定 |
| Disable 来宾 | 1 TCP 尝试、connected=false、SocketException / 10051，54 ms；发送/响应/读取均 0，前后仅同一 loopback，无 Up 非 loopback |
| host health-after | 完整预期响应；同样计数，859 ms；7 个接口自身前后完整稳定 |

四份阳性均为 HTTP 200、唯一 Content-Length=22、完整 `Microsoft Connect Test` 正文及 EOF，connected/connectSettled/socketClosed/matched/interfacesComplete 全部成立，无探针/收尾错误；禁网尝试也已 settle/close，接口完整且稳定。由实际启网阳性和前/中/后宿主对照排除“目标本来不可达”作为本次禁网失败的解释。driver 退出 0，`verdict=limited-pass / passed=true`。该结论只覆盖此固定 IPv4 TCP 与接口观察范围，不是全部协议、完整路由/设备审计、微软源站身份认证或整体隔离通过。

宿主接口数量跨阶段实际为 6→7→7，新增项为 type 6 / Up；只声称每一探针自身前后清单稳定，不声称整个流程宿主接口数量不变，也不据此认定新增接口的归属。类型 53 的真实宿主接口为 Up，已完整保留其 IPv4/IPv6 及网关数量，未跳过该接口。没有为保持旧数量而调整或删除系统网络设备。

Enable task `740e6598-f118-4936-8285-611aafc2774c` / instance `b4a17ebe-9890-4aa1-bd55-e978fb417c7c` / guest PID 2228；Disable task `d4ccde20-d81e-41fb-a3b3-05192be7e9c4` / instance `f03aa4e8-c121-43f0-beda-681b61c6c242` / guest PID 1472。两者均为 System/session 0，固定 wrapper exit 0；配置 SHA-256 依次为 `577601ee63e222e25bc3d60717d8a637175bd2040d36dc15b27e1df11234016d`、`24d119241fdb3431e35b2303d0a3b9389e1526847daacb161700e476f9ea93cd`。专属 input 只读/output 可写，除 Networking 和各任务目录/身份外沿用相同配置，剪贴板等共享禁用，无 GUI 连接或生产目录映射。

两实例各 7 个 CLI 调用实际 close/exit 0、stopAttempted=true，最终 list 为空，control/execution/connectionPending 全 false；对应 PID 分别为 `28128,29284,9880,13948,21008,32352,4392` 与 `10740,30268,28772,31828,32704,21476,28296`。宿主编译/DNS/三健康助手 PID 为 `12572,33680,32804,7332,28320`，全部 close/exit 0。19 个调用 stdout 合计 6,906 字节，stderr 0、无截断；helperPendingPid/error/cleanupError 为空，运行根按记录身份清理，artifactsRemoved=true，随后确认 `.artifacts/windows-sandbox-acceptance-owner` 不存在。未重复诊断、剪贴板、旧矩阵或网络序列。

最终结果与文档复核 revision 113 / turn `01a19411-7fbb-7c41-bbe7-2379ec1d2d0a` 通过，无收口阻断，允许仅精确暂存本方案记录。下一最小项确定为一个固定等待负载执行中的主动取消：先证明已运行、任务/进程身份一致且 exec 尚未结束，再触发一次取消；分别确认停止、实例消失与 exec 物理 close，不以收到 abort 或非零退出码单独判通过。先审代码/最小反例，再单实例实测；独立超时、后代进程树、允许/禁止目录、受保护路径、RW output 容量与结果证据保护仍未完成。生产真实工作区接入、默认切换和权限退役继续关闭，P0 桌面回放继续待办。

### 固定等待负载执行中主动取消（2026-11-01）

网络验收收口后，下一范围经 revision 114 / turn `01a19414-fc9f-74d2-a764-8ae4ea9a87f8` 确认：一个固定单进程 C# 等待负载、一个实例、一次主动取消，不含后代进程树或独立超时。沿用禁网/禁共享、input 只读/output 专属可写；不修改旧 10 秒固定任务或其输出回调。生命周期仅增固定 `C:/SuperPiCancel/Input/probe.exe` 的 System 执行入口，复用取消与停止后 pending exec 物理收尾责任。

负载核对固定路径、System/session 0 与请求 UUID，先完整关闭最长 1 KiB 的 ready.json，再 CreateNew 发布空 ready.complete，随后固定等待 60 秒，自然返回 73。宿主只在完成标记后解析一次，分配前校验大小、目录身份、非链接单链接文件及打开前后身份；10 秒轮询期限，检查同一 exec 仍由 owner 持有且未物理结束，随后在无 await 的同步段记录计划取消并 abort 一次。就绪中的 guest PID 与宿主 CLI PID 分开；此受控 fixture 通道不证明不可信来宾结果不可伪造，也不改变正常最终结果需实例退出后读取的约束。

独立记录计划取消与外部 SIGINT/SIGTERM，后者包括收尾期到达情况，不能被已设置的计划标记吞掉。通过需有效就绪、计划取消时 exec 未结束、逻辑 cancelled、成功停止所属实例、最终 list 空、exec 物理 close、全部 pending 槽清空和产物清理同时成立；从 exec 派发前的宿主单调计时至收尾须小于 30 秒，与 60 秒自然寿命保留间隔，能解析的自然退出 73 一律拒绝。超窗仍履行清理责任但不判通过，退出不明保留 owner/journal/目录。取消后 exec 原始退出回执独立记录，不以任意非零退出判成功。

拟三项定向检查覆盖有效就绪与提前/外部/自然退出和时序反例、替身取消后延迟 close 及未收敛保留 owner、仅编译固定来宾程序而不在宿主运行。查询/输出有既有有界捕获，文件/计时器在各分支释放，无生产/逐块热路径改动、无对象池；先审后测，通过并记录暂存后再复核一次实测条件。生产工作区、默认切换、权限退役关闭，P0 待办保持。

预审 revision 117 指出退出码及完整收尾计时缺口，已修正：两个 CLI 结果分支统一去除 BOM，明确拒绝固定程序自行返回的 73/125/126；物理 close 必须含有效整数 CLI 退出码和字符串输出，不能以未知状态通过。驱动实际调用的 finishCancellationArtifacts 在产物清理完成后记录总时长，定向替身使清理将单调时间从 29,900 推进到 30,100 ms，确认仍完成清理但验收不通过。复审 revision 122 / turn `01a19419-ef9f-7831-ae2f-7256da92101f` 通过，无新增阻断。

随后仅运行该项三项检查，3/3 通过（189.9175 ms）。编译 PID 27112 实际退出；固定来宾未在宿主运行，检查制品 SHA-256 `1dd11c450c4c2ef0c6b9e260b3744a43bbade0414e8570384168f5a653b6ec5f`，专属 `.artifacts/wsb-cancel-compile-feb9b2ef-1a20-4c49-8289-3892bbb99a1c` 按身份清理。生命周期、cancel.cs、cancel.mjs、检查源码 SHA-256 分别为 `C2BA8AAB44A62ACCD9FD7B709873FD0E01C001B88473F9946DEE51CB45348716` / `8C5CE684449972BAA4231279D24B32C883ABA3DA3E069A1285A46E934D24DA70` / `70608890FCD1209560F38299BA33C8AE964BC5666CBD293343DE958AA2526B94` / `89440F8DD557DA3F3C479FFEE10F9454F9D2B88881162383DBB57FAD025A6195`。先记录并精确暂存本项五文件，集合外 1,894 条 stage 基线为 `632C876F9CF4564BA10BB387A7BC01F5AE4102EFDA59B7BB6A280376AC9861CB`；单次实测条件仍先复核，未把替身检查或编译视为真实取消通过。

单次实测条件经 revision 123 / turn `01a1941b-2c03-7142-b1f8-e496eebca712` 确认。紧邻执行核对已审源码/index、固定编译器/CLI、新 owner 独占前提后，仅运行一次 task `2d450b13-baa1-432f-aa59-b623cb774b19` / instance `0fa4710e-aea8-4ac0-a0de-da6eb8f8d689`。实际探针 SHA-256 为 `a5bf6bb7027271bca1021f240f9d03247b733064c722ab5697afbd2a18ecaef0`，配置为 `2f64784ccec8c8e2e72ae770f023ea18462f22ccbd2f09ccbb502b29dd6eb305`。就绪回执 task 匹配，guest PID 1484、System/session 0、固定寿命 60,000 ms；该 PID 是受控来宾自报，与宿主 exec PID 30240 分开。

从 exec 派发前的单调计时起，就绪为 893.1245 ms，计划取消为 893.1304 ms，包含产物移除的完整收尾为 1,731.2528 ms，小于 30 秒且远早于 60 秒自然结束。取消 UTC `2026-10-31T22:36:51.719Z`，plannedCancel=true、externalCancelled=false、executionPendingAtCancel=true、logicalCancelled=true；逻辑回执 `CLI exec: cancelled; ownership retained` 后仍保留并履行物理收尾责任。

exec PID 30240 于 `22:36:52.217Z` 实际 close，原始 CLI 退出码为 `2151088391 (0x80370107)`、stdout 空、stderr 73 字节、无 signal/launchError/truncated；该非零码仅作为物理结束事实，不能解释为正常任务返回或单独作为取消成功。stderr 的现有 UTF-8 解码含替代字符，因此只保留数字与计数，不声称准确还原中文错误信息，也不为此扩大输出捕获改动或重复实验。固定程序自行返回的 73/125/126 均未观测到。

stop PID 11016 派发 `22:36:51.962Z`、成功 close `22:36:52.321Z`；最终 list PID 12660 于 `22:36:52.556Z` close/exit 0 且列表为空。其余 list/start/list/list PID 为 `596,28704,17460,30768`，全部实际 close/exit 0。七个 CLI 中只有 exec 为上述非零结果；编译 PID 6004 于 `22:36:49.090Z` 派发、`22:36:49.194Z` close/exit 0。八个调用 stdout 合计 362 字节、stderr 73 字节，无截断。

最终 state=closed、stopAttempted=true、全部 pending=false，helperPendingPid/error/cleanupError 为空；运行根按记录身份移除，artifactsRemoved=true，随后只读确认 owner 不存在。driver exit 0 / passed=true，证据支持本次固定单进程主动取消限定通过；不包含独立超时、后代树、任意负载或不可信结果通道。无外部取消、重试、新网络探测或剪贴板操作。最终结果与文档复核 revision 126 / turn `01a1941c-bfb5-7da2-bfa0-ecd0b8836d80` 通过，无收口阻断，仅精确暂存方案记录。下一项限定为专属目录的 RO/RW 与未映射哨兵路径对照，先审固定探针/驱动/反例再确认一次实测；不是可写工程根内部排除 .git/.sp 策略。

### 专属可丢弃目录文件边界对照（2026-11-01）

前项收口后，独立范围审核 revision 127 / turn `01a19420-ae84-7040-bd8e-038bfe1814aa` 同意一个固定实例、固定 System C# 探针：只映射专属 input 为 RO、output 为 RW，继续禁网/禁剪贴板与其他共享。不共享实际工程，也不把合成 `.git`/`.sp` 哨兵解释为可写工程内部排除策略。宿主在 owner 根下 private、neighbor、.git、.sp 各创建独立随机 32 字节哨兵，及 input 中公开小对照；基线核对普通文件、单链接、身份、长度与摘要后关闭全部句柄。私有内容及摘要不放入来宾 request，只给协议及任务 UUID。

来宾先成功读取并关闭公开 input 对照，再对同文件尝试原生 CreateFileW 的 FILE_APPEND_DATA / OPEN_EXISTING，只接受打开被拒且 Win32 错误 5；任何成功写句柄本身就是边界失败，不再写入。随后 output CreateNew 写入并回读固定小文件。六个负例为固定宿主绝对 private/.git/.sp 路径和 input 父级 neighbor/.git/.sp 路径，只尝试 GENERIC_READ 打开并立即关闭，不读取私有内容。原生调用后立即记录 Win32 错误，只接受失败的 2/3/5；分享冲突、磁盘不足、未知错误或前置失败均为证据不足并停止。成功句柄先写入报告对象，后续关闭/探针异常不能抹去该失败事实。

宿主仅在实例/exec 物理退出后读取结果，先独立复核全部五个哨兵，结果缺失也不跳过；身份/类型/长度异常先判已知变化，不做摘要或按异常长度分配。读取上限 request 1 KiB、result 4 KiB、output 256 字节。已知变更或成功负例打开为 sticky boundary-failure，未知 I/O 为 inconclusive；全部正反对照、已知拒绝码、宿主未变、退出和清理同时成立才是限定通过。固定六路径不覆盖任意路径、链接、硬配额或恶意结果伪造。

预审 revision 129 / turn `01a19425-d4b8-70d0-8751-c0cbe0d60986` 指出复核读取过程中已知变更被统归不可用的问题。已以明确错误类型保留打开/读取中观察到的身份、长度、提前 EOF 变化和文件消失；后续 close 错误不覆盖主异常。第三个检查内增加受控反例：外层长度正常、打开/读取发现变化，经过实际 verifyFixture 与最终判定仍为边界失败，即使来宾结果缺失；真正未知 I/O 仍为证据不足。拟仅三项检查：严格回执/分类、替身固定入口/收尾、宿主自有小文件有界复核加仅编译来宾（不在宿主执行）。生命周期只增加固定入口，不改生产、逐块捕获或热路径；无对象池或扩大基准。代码复审通过后才运行检查，再单独核对一次实测条件。生产工作区接入、默认切换、权限退役保持关闭，P0 桌面回放继续待办。

代码复审 revision 131 / turn `01a19428-8d09-7472-b3ff-a7c405a7a84c` 通过，随后仅运行上述三项检查，3/3 通过（186.1299 ms）。编译 PID 10408 退出 0，来宾未在宿主运行；检查制品 SHA-256 `c565e6c4971a89245fa31752189443261a5c12791c4fda96f668853b91c8ed3c`，专属 `.artifacts/wsb-files-check-3743c65b-9938-47c2-962e-ce9abe4e3ad3` 及其两文件按身份清理并确认不存在。生命周期、files.cs、files.mjs、检查源码 SHA-256 分别为 `96C7927218AC16F08419D616A155F8FA75BA3DDD03C609DF3E16381A04B83364` / `C6318365BD98D5F1339C3B779427A202B46F1E4DC9035C9D7D1B4CB86225D639` / `EC0787251F5D6E6E9735180C97C545C8979381C7D4F50F2606A009F29C41D7D8` / `460697F68D1EDE25B0CAB7BD59594DFE372250854C03FF2BBB51D195D2419DE0`。仅精确暂存此四文件与方案，集合外 1,897 条 stage 基线为 `A3816251CB2F5D52E4841A698E7D9FD92C11F584E213F1FE057B1C4D7476980A`；一次实测条件仍待复核，尚无本项真实实例结果。

单次实测条件经 revision 133 / turn `01a19429-9dc9-7a82-96c1-ec6cb1ded42a` 确认，紧邻核对已审源码/index、固定编译器/CLI 和独占 owner 后，仅运行一次 task `cf5a41ce-3839-4414-8db5-599cecae71a6` / instance `1fbf4b5f-d960-4ae2-a5e7-1f9314020a3e`。实际探针 SHA-256 `f2b98a864d160119f48502f5973852bf0eec1d7da1738a64f95127d0678bb510`、配置 `971d903d247608241a4c801600029b4849d308bd4b8d11f9ea82fee3c40e39a2`；guest PID 1444、System/session 0、任务 UUID 匹配，wrapper 与 CLI exec 均退出 0。

公开 input 正读成功且关闭后，RO append 打开失败，原生错误 5；专属 output CreateNew 写入/回读匹配。六个固定路径全部 opened=false、原生错误 3，无 closeError；报告 complete=true/error=null。实例退出后宿主复核 input 58 字节与四个私有 32 字节哨兵，五项身份、长度、有界摘要全部未变，宿主输出对照也匹配；私有内容从未送入来宾请求，负例没有读取私有数据。

编译 PID 23220 于 UTC `2026-10-31T22:52:37.736Z` 派发、`22:52:37.830Z` close/exit 0。7 个 CLI PID `27028,30172,23844,30008,31000,3548,8864` 全部 close/exit 0；exec 于 `22:52:40.280Z` close，stop 于 `22:52:40.889Z` close，最终 list 于 `22:52:41.118Z` close 且实例列表为空。8 个调用 stdout 合计 385 字节、stderr 0，无截断；state=closed/stopAttempted=true，三个 pending=false、helperPendingPid/error/cleanupError=null。owner 按记录身份移除，artifactsRemoved=true，并只读确认不存在。

本次 driver exit 0/verdict=limited-pass：只证明固定可丢弃 RO/RW 与六种未映射路径的对照，不能外推可写真实工程内部排除、任意路径/链接、输出硬容量或恶意结果通道保护。没有重试、重跑网络/剪贴板或旧矩阵；生产热路径未改，检查和现场产物均清理。结果及记录交独立审核复核，下一最小候选为同固定单进程负载的独立执行时限触发，仍先审后测；生产接入、默认切换、权限退役关闭，P0 待办保持。

### 固定等待负载独立执行超时（2026-11-01）

文件项最终复核及下一范围经 revision 142 / turn `01a1942a-8240-77e1-a61e-04cd8407169e` 确认。复用不变的 60 秒固定等待 C#、ready 协议及 System 入口；仅本次 owner 设置 execMs=10,000，全局默认不变，正常流程不主动 abort。readiness 完整读取并校验后记录单调时刻，须小于 10 秒、同一 exec 仍被持有且未物理结束、entry 仍 launching、逻辑结果尚未出现，不能用超时后尚存的 pending 槽冒充先就绪。

随后等待实际 CapturedProcess.wait 计时器产生 timeout，确认同一 entry 的 outcome=timeout、执行仍 pending、单调 elapsed 不早于配置预算，再执行 stop 和物理收尾。单独记录外部取消（包括清理期），它不能通过。独立判定拒绝 ready 超时、非执行 timeout、自然/自拒退出 73/125/126、未知退出、未收敛与完整清理达到 30 秒；非零 CLI 只作物理 close 事实。最终实例列表为空、全部 pending 清空、产物移除同时成立才可限定通过，清理超窗仍继续履行责任，退出不明保留 owner/journal。

新手工驱动与两个定向检查共用 observeExecutionTimeout 接线。检查一覆盖判定及时序/自然退出/外部取消/完整清理跨窗反例；检查二通过实际 wait 定时器（仅替身预算缩短），覆盖 stop 后延迟 close、未 close 时保留归属，以及逻辑已 timeout 但提供看似早到单调 ready 的拒绝。C# 未改，不重复独立编译或旧主动取消检查；实测时仍按原流程准备并记录实际制品。既有 cancel.mjs 仅导出 awaitReady，生命周期及生产热路径/输出捕获无改动，无对象池、全量测试或基准扩跑。先审代码再运行两个检查，记录并精确暂存后再核对一次实测条件。真实工作区、默认切换、权限退役保持关闭，P0 桌面回放继续待办。

代码预审 revision 144 / turn `01a1942e-de63-7cf2-badb-e71bd38ac36c` 通过，随后仅运行两个新检查，2/2 通过（152.0955 ms）。检查没有宿主子进程、编译器、VM 或临时文件；三个替身序列均使用真实 wait 计时器，延迟 close 与未收敛分支的监听器均释放，未收敛 owner 按预期保留逻辑归属，随后仅结束内存替身。cancel.mjs、timeout.mjs、检查源码 SHA-256 分别为 `49D56C865EC01A55D62A4CF2EC3D41710C5C63314F3FD6E34B0AA4F525B64464` / `6C8220400458E03EC9610200D82B501D7D0FB0D6457737E0E5AC05980743B0C5` / `0356953C4975BED074964E0BAA5F0AFB8DE84522E708F15052017742B092907D`。仅精确暂存此三文件与方案，集合外 1,900 条 stage 基线为 `82CA77E4A81BACD2C8465ED0A34A73958C674D69322D2D1CA709B6B7B8FE7EBA`。尚无本项现场结果，一次实测仍需先核对已审来源、固定工具与独占归属并复核条件。

一次实测条件经 revision 147 / turn `01a19430-6172-7a13-98b5-c177111407c3` 确认。紧邻核对后仅运行 task `a13c69bf-c933-45c2-b365-38433fd86dd5` / instance `412e47cc-fcae-4bb5-aa81-9d21978cac60`；实际探针 SHA-256 `9dd71f7b00026b7e904423d6ae92dc733718f0219ffb9d2fcc6ca9af45a3eb37`，配置仍为 `2f64784ccec8c8e2e72ae770f023ea18462f22ccbd2f09ccbb502b29dd6eb305`。guest PID 2056、System/session 0、UUID 与 60,000 ms 固定寿命一致。

从 exec 派发前单调时刻起，ready=904.3937 ms、实际逻辑 timeout=10,030.1813 ms、包含产物移除的完整收尾=10,912.5175 ms；readyBeforeTimeout=true、logicalTimeout=true、executionPendingAtTimeout=true，externalCancelled=false。执行时限配置 10,000 ms，成功流程没有主动 abort；超时原始逻辑回执为 `CLI exec: timeout; ownership retained`，不是启动/就绪超时或自然退出。

exec PID 27960 于 UTC `2026-10-31T23:00:07.428Z` 物理 close，CLI 原始退出码 `2151088391 (0x80370107)`、stdout 0、stderr 73 字节，无 signal/launchError/truncated；stderr 原有有损解码不作准确文本还原，非零码仅作物理结束事实。stop PID 29828 于 `23:00:07.602Z` close/exit 0；末 list PID 30404 于 `23:00:07.832Z` close/exit 0 且列表为空。其他 control PID `29500,23100,28108,31552` 全部 close/exit 0。编译 PID 31360 从 `22:59:55.192Z` 派发至 `22:59:55.285Z` close/exit 0；八个调用 stdout 合计 362 字节、stderr 73 字节，无截断。

最终 state=closed、stopAttempted=true、全部 pending=false、helperPendingPid/error/cleanupError=null，owner 按身份移除且随后确认不存在，driver exit 0/passed=true。结论只限固定单进程的独立执行超时和完整收尾，后代树仍未验收；无重复实测、旧矩阵或剪贴板/网络操作，无本项遗留进程、实例或产物。结果交独立审核复核后仅精确暂存记录，生产工作区、默认切换、权限退役关闭，P0 待办保持。

### 固定后代进程树取消（2026-11-01）

前项最终复核 revision 150 / turn `01a19431-739f-7710-b617-39e0f796987d` 确认下一最小范围为一个实例内 parent→child→grandchild 三个固定等待进程、一次计划取消。新 C# 仅直接启动固定可执行文件及 child/grandchild 固定角色，各级创建一次、不经 shell、不接受任意命令、不重试。所有角色核对固定路径、System/session 0、任务 UUID，自报实际 PID 与创建时间；parent/child 分别记录实际 Process.Start 返回的子 PID/创建时间并交叉核对，未传入或伪造系统父 PID 查询。

parent 对 child 及其创建记录中的 grandchild 取得进程对象，核对自报与实际 PID、创建时间、程序路径、session 及未退出事实；创建时间用于防止误认复用 PID。汇总前刷新检查 grandchild、child、自身存活，三 PID 必须不同，发布上限 4 KiB 的树回执后才发布通用 ready 完成标记；部分创建、子级提前退出、5 秒协调期限失败均不产生完整树就绪。每角色在自己的就绪发布后固定等待 60 秒，自行结束返回 73；失败返回 125。所有已创建角色仍属于该实例的清理责任。

宿主完整校验独立 tree 协议、三个角色、两条实际启动边、创建时序、固定路径、System/session 与 alive 后，检查原 exec 仍活动、ready 小于 10 秒，才同步记录一次计划取消并 abort。复用已有独立外部取消、已知自然/自拒码拒绝、stop/物理 close/末 list 空/pending 清空和包含产物清理小于 30 秒的判据。新 observeTreeCancellation 由实际驱动与替身共用；三个检查只覆盖树身份/部分证据反例、完整/部分就绪及不收敛收尾、仅编译新 C#（不在宿主运行）。既有生命周期、取消与超时入口均不改，无生产热路径或输出回调变化。

结论范围固定为“已确认存在的这棵受控来宾进程树，经停止所属 VM 完成边界收尾”，不声称各个后代正常退出或收到独立取消通知，不把来宾 PID 当宿主归属。先审后运行三项检查，再记录精确暂存并复核一次实测条件。实际工程保护、RW 硬容量及结果权限边界尚未成立；生产工作区、默认切换、权限退役关闭，P0 桌面回放继续待办。

代码预审 revision 152 / turn `01a19436-a0a6-7a50-81c9-b8a319f95006` 通过，随后仅运行三项新检查，3/3 通过（236.5445 ms）。编译 PID 19888 实际退出 0，检查制品 SHA-256 `5e7351e21449a439ff24c8ba994daaa1b3231ed662a8fd3b7314dd81e8f096a8`；guest 未在宿主执行，未创建任何真实后代。专属 `.artifacts/wsb-tree-check-9b6fcc82-b751-4afb-8010-1896979c74eb` 按记录身份清理并确认不存在，替身监听器释放，无本项检查遗留。tree.cs、tree.mjs、检查源码 SHA-256 分别为 `7782CF36C5ECEE996ACB4856DAB50AEF52143DBE0BFCCD4C46CEB5FCB370E463` / `67FCE565E105B432BAD9E015631EFD64189D3FC9A6E822ADE7D0684A10F73516` / `075118783CA939348DC32E92FDF10C55A958DB2A2E8A350B020D441EBAD4A138`。仅精确暂存此三文件与方案，集合外 1,903 条 stage 基线为 `7840F9506B30608E1A6D0AD0A1DD5924BC823D8A8C290D083D64806AE46FBFF6`；尚无树现场结果，一次实测条件仍先复核。

一次实测条件经 revision 153 / turn `01a19439-0068-7950-9781-ba14df8714bd` 确认。紧邻已审源码/index、复用模块、固定工具与独占归属核对后，仅运行 task `80cf80cb-d165-40e2-a7ae-93e0635f9d48` / instance `75b162b8-46b7-4cf5-8576-ff98c3315816`。实际探针 SHA-256 `2d5066eb3eff09b085c881b7934581fee6514241faa69fc17f7ddc806e0095d0`，配置仍为 `2f64784ccec8c8e2e72ae770f023ea18462f22ccbd2f09ccbb502b29dd6eb305`。

完整树回执三个来宾 PID 为 parent 1820、child 1960、grandchild 2060；对应创建时间 ticks 为 `639290850127828055` / `639290850133427570` / `639290850137400075`。各角色固定程序路径、System/session 0、alive=true，任务 UUID 和两个实际启动边及子创建时间全部匹配。通用 ready 的 parent PID 一致、固定寿命 60,000 ms；这些 PID 不用于宿主进程终止。

从 exec 派发前单调时刻起，完整就绪 1,763.8303 ms，计划取消 1,763.8366 ms，包含产物移除全程 2,616.2291 ms，小于 30 秒。plannedCancel/executionPendingAtCancel/logicalCancelled=true，externalCancelled=false。取消 UTC `2026-10-31T23:10:14.285Z`，原逻辑回执 `CLI exec: cancelled; ownership retained`；没有把收到 abort 单独算作完成。

exec PID 32220 于 `23:10:14.762Z` 物理 close，原始退出码 `2151088391 (0x80370107)`、stdout 0/stderr 73 字节，无 signal/launchError/truncated；有损解码仅保留计数和数字，不解释为正常任务退出。stop PID 24128 于 `23:10:14.905Z` close/exit 0；末 list PID 31168 于 `23:10:15.136Z` close/exit 0 且列表为空。其余 control PID `29612,24568,31944,32340` 全部 close/exit 0；编译 PID 31716 从 `23:10:10.773Z` 派发至 `23:10:10.877Z` close/exit 0。八个调用 stdout 合计 362 字节、stderr 73 字节，无截断。

最终 state=closed/stopAttempted=true、三个 pending=false、helperPendingPid/error/cleanupError=null，owner 按身份移除并随后确认不存在，driver exit 0/passed=true。证据支持已确认存在的固定三进程来宾树经停止所属 VM 完成边界收尾；未取得逐个后代正常退出或独立取消通知证据，不作该类宣称。没有重试、旧矩阵、额外网络或剪贴板操作，无本项遗留。结果交审核复核，并核对下一项是否已有明确实现依据；RW 硬容量、监督/结果权限及真实工程适配仍是开放任意任务前的未完成门槛，生产工作区、默认切换、权限退役继续关闭，P0 待办保持。

### 固定范围收口与扩大任务的架构阻断（2026-11-01）

独立最终复核 revision 158 / turn `01a1943a-d632-7933-8f23-2f162c32f204` 确认固定树结果及交接准确，没有收口阻断；同时对照验收配置、驱动与原生文件模块，未发现当前还必须补跑且已有明确实现依据的同类固定夹具实测项。按用户“持续执行直到遇到阻断项需要停下”的要求，本轮在扩大任务范围所需的架构门槛处停止，不追加 VM、重复矩阵或无依据的系统操作。此处不是把已通过的固定范围重新判为失败，也不是宣称 Windows Sandbox 已是生产可用后端。

| 未完成门槛 | 当前明确依据 | 恢复实现/实测前必须确定的契约 |
| - | - | - |
| 可写存储硬容量 | 验收包明确 `writableShareQuota:false`，配置直接映射 RW output；32 KiB 输出限制只约束合作程序自身的写入 | 选定任务绕过监督程序也无法突破的容量机制；明确容量作用对象、所有旁路写入、资源创建/释放与异常收尾。若候选需要新磁盘、挂载或系统功能，先列清具体系统改动，不自动实施 |
| 任务、监督者及结果通道权限分离 | 当前固定程序以 System 执行，任务数据与结果使用可写映射；宿主 journal 在未共享根，但这不使来宾结果自动可信 | 明确各主体的身份和可访问对象、状态/结果的可信产生者及传输方式，证明任务不能修改监督程序或冒充其回执；给出通道预算、取消和失败处理 |
| 真实工程保护与变更回接 | 现有受保护路径策略、文件服务和提交核心可复用，但不是 Sandbox 映射内部的拦截器，也尚无连接两端的协议 | 明确来宾工程视图/实际 cwd/暴露文件/`.git` 与 `.sp` 策略；定义候选变更、来源版本、冲突拒绝、删除/移动及宿主提交规则，不直接可写共享整个工程 |

下一项应先做只读架构选型与契约预审：为硬容量和可信结果通道各给出有官方机制依据的具体候选，标明新存储、安全主体、挂载/功能依赖；明确任务→监督者→可写存储→宿主文件服务的数据流及权限；列出能区分候选是否成立的关键反例和每项资源、退出、清理责任。契约确定并通过审查后，才能选择下一个有区分力的实现和最小实验。直接接入工程回传会先假定尚未确定的存储与信任边界，重复已有固定矩阵、加字节限制或轮询均不解除阻断。

本轮各已执行小项均先审代码、做最小检查、复核一次现场条件并记录实际结果，没有重跑剪贴板/旧矩阵或全量测试，没有生产热路径变更及基准扩跑。检查产物和所有本项运行根均按归属清理，无待退出实例或本项进程。生产真实工作区接入、P3.6、默认切换、相关权限退役保持关闭，P0 桌面回放仍为独立待办。

### 只读架构选型与契约预审（2026-11-01）

用户继续授权只读选型，明确不安装、挂载、启用功能或实测。本轮范围经独立审核 revision 165 / turn `01a195c5-0c99-7fc3-a9e3-5c14532a4f28` 确认：每道门槛一个主候选及必要否决替代，形成 [Windows Sandbox 存储与执行契约预审](Windows%20Sandbox%20存储与执行契约预审.md)，本方案和交接仅留结论索引。官方定义、现有代码事实、设计要求和待验证项明确分账，最新官方页面不等于固定 0.8.107.0 客户端现场通过。

首项核对已形成明确阻断：预分配固定 VHD 有官方机制依据，但只覆盖专属数据卷；未取得整个 Sandbox 系统可写层、服务代写和平台开销的任务级硬上限/全面重定向依据。容量指同时占用空间，不是累计 I/O；不把未知平台开销省略。NTFS 配额按文件所有者 SID 计费且不覆盖部分元数据，不能只给来宾 Task SID 设限就算宿主共享容量成立。到此停止扩搜存储路线，没有转向其他虚拟化平台或用真实磁盘耗尽探索。

结果通道保留“来宾 System 监督者＋一次性非管理 Task SID/显式对象权限＋固定 RW 交换区上的有界 HMAC 认证信封”局部候选。revision 166 / turn `01a195c9-1231-76e0-8cdf-215fa9d23961` 确认：HMAC 原语不补齐宿主/监督者共同密钥的可信建立；nonce、普通摘要、JSON 或完成标记均不能代替认证；Task 不能请求监督者代签自报状态。访问矩阵、密钥交付、实际映射语义与代操作入口仍未闭合。Job 文档不能证明 WMI 代创建进程归入本任务 Job，不能凭 Job 空认定全部活动静止；不将其扩大为 WMI 进程不受任何 Job 限制。VM 停止后仍核对实际产物与认证清单，结论只是一份候选变更集，不宣称完整最终工作区快照。

工程候选采用选择性只读快照→隔离工作副本→宿主来源版本/授权校验应用，区分读取暴露和写回保护，明确 `.git/.sp`、链接/别名、源文件变化、冲突与部分提交语义。最小版本只接纳有界普通文件新增/修改，删除/移动明确 not_supported 并在预检拒绝整包；不伪装原子跨文件回滚。具体权限矩阵、数据流、系统改动、按资源清理顺序及恢复验证条件均在契约文档；前两道门槛未成立，不提前接真实工作区。

本轮没有实现代码、系统或账户改动，没有运行查询探针、编译、测试、实例或基准，也没有新增运行/临时制品。只做文档差异与链接/范围核对，生产热路径未变；两份文档复核后精确暂存，原有删除/patch 保留，不提交推送。扩大实现和实测继续阻断；生产真实工作区接入、默认切换、权限退役关闭，P0 桌面回放继续待办。

### 用户批准首版范围收敛与离线候选检查（2026-11-01）

用户分别批准两项保障调整：首版不承诺 WSB 系统可写层及所有平台开销的任务级磁盘硬上限，并接受它们可能耗尽宿主磁盘的剩余风险；整台来宾视为不可信，不认证来宾监督结果、具体子进程来源、完整性或命令归属。专属 RW 共享硬容量和宿主快照/候选/输出/记录预算仍须完成；空间预检、监测和超时不能算硬上限。宿主独占授权、任务/实例归属、来源版本、实际收尾与提交事实，网络、剪贴板等外层限制保持。旧 G0/G1/G2 未因此通过，已完成的固定验收结论也不改成失败。具体当前契约见 [存储与执行契约第 0 节](Windows%20Sandbox%20存储与执行契约预审.md)；其第 1–9 节保留历史预审依据，不能再整体作为当前首版门槛。

审核 revision 171 澄清范围差异，批准后 revision 172 / turn `01a195f7-930b-7063-a145-35c233472a67` 同意先做独立离线模块：宿主复制/固定上下文、来宾清单严格小 schema、目标/操作/来源基线绑定、有界文件读取及身份检查，输出仅 candidate-checked/rejected。检查后的私有字节绑定摘要，禁止路径重读沿用结论；来宾字段不能覆盖授权/提交/收尾，取消、超时、平台失败或未知状态均不接纳。最小路径语法和 Windows 检查的能力范围写明，不宣称完整 reparse tag 或并发宿主文件攻击边界通过。

本次仅新模块和合成文件检查及两文档。代码先审的三项问题已在运行前修正，revision 177 / turn `01a19601-f49b-7be2-8344-65db4ac31dc1` 复核通过后，仅运行 `node --test --test-reporter=tap --test-concurrency=1 tests/windows-sandbox-candidates.test.mjs` 一次：11 组通过，0 失败、取消、跳过，846.8779 ms、进程退出 0。正常样例显式句柄 opened/closed=3/3、峰值1、读取/分配306字节，内部保留两候选39字节在dispose后归零；关闭失败注入诚实返回unknown，测试随后按已知故障阶段关闭所记录句柄。11 个临时根按身份清理并断言不存在，无本项遗留。源码摘要、预算/链接/变更/撤销反例和限定计数见契约第0.4节；仅测试引用新模块，无生产调用链变化，不扩跑生产基准或旧矩阵。

容量及真实适配仍留待下一独立审查；本次不连接现有 WSB 运行入口/生产、不启动实例或挂载、不创建账户/密钥、不执行真实工程提交。生产工作区接入、默认切换、相关权限退役关闭，P0 桌面回放待办。四文件结果与记录经 revision 178 / turn `01a19603-b9ce-7b31-9254-dabf7855f2a9` 最终复核通过后精确暂存，不提交推送。

### 任务专属固定 VHD：创建、身份绑定、共享准入与释放生命周期（2026-11-01）

离线候选项收口后，用户授权本项实现与方案/代码预审。沿用当前契约第0节，不重新讨论平台总硬上限、来宾可信监督者或HMAC。范围与路径方案经独立审核 turn `01a19610-cd28-78f2-925b-f92281773ca1`、revision 183 / turn `01a19615-0d0a-7a42-b82e-42c4537d3efb` 确认。形成 [固定共享卷实现方案](Windows%20Sandbox%20固定共享卷实现方案.md)：单一持续持句柄助手、128MiB固定预分配VHD、精确镜像/设备/分区/卷身份链、唯一GUID/exchange路径、无盘符/目录挂载和路径回退；实际shareAdmission固定false。

宿主卷owner分开管理磁盘使用、候选字节与真实撤销；VM/调用/读取未结束或close-unknown均阻止正常释放，助手异常或身份变化请求取消、撤销并保留归属，不因逻辑超时kill导致隐式脱卷。Node/C#/PowerShell实现已代码复审；revision190两项P2（日志失败后仍可继续、File.Exists误当不存在）及回执null/跨语言参数等均修正。revision194放行后首轮7组通过，第8组PS解析失败；revision196修正三处跨行语法后，仅第8组发现替身故障注入循环变量被重置，revision199复审修正后第8组及20项分支通过，最终报告872.181ms。前7组未重跑，完整失败与源码摘要见实现方案第7节。累计4个临时根全部按身份清理；未构造真实NativeDisk、运行Storage或实际管理助手，未创建、附加、初始化、格式化磁盘或启动实例。当前仅生命周期代码/替身通过，真实硬容量、GUID共享/失效行为及候选读取适配仍未通过；生产接入、默认切换、相关权限退役关闭，P0桌面回放继续待办。

### 原生单盘现场入口与正常生命周期（2026-11-01）

用户继续下一阶段，revision205/206确认先做一块128MiB固定VHD的原生GUID小文件正例与正常释放，再单独审WSB兼容、硬容量和异常失效。只读前置确认管理员令牌、所需权限存在但禁用、NTFS空间与七个Storage命令元数据，记录首次PS7偏差及后续显式PS5查询。入口复用独占owner、单个持续管理助手与固定32字节CreateNew写/Flush/关闭/同GUID重开读/比较/关闭；主流程不调用WSB，不接工程或扩大容量。revision210三项P2已修正：原生身份异常分类保持到宿主、外层journal持续阻断、整体输出8KiB限额与摘要；revision214代码复审后唯一5组新检查全通过，PS七项替身realStorageOperations=0，894.0717ms，单个临时根及编译/替身进程清理确认。revision218放行后，精确暂存九文件并核对摘要，唯一现场入口在管理助手stderr处停止，前置/编译退出0，入口退出1，prepared/probe=null、released/passed=false；revision221确认未进入VHD创建，stderr正文未留存使具体根因未知。精确PID已退出，两文件和空根因自动审批拒绝后由用户手动删除，并只读确认不存在，不将收尾改写为release成功。revision221/222限定的有界stderr、实际退出码/信号和清理后最终快照修正已完成；revision226两项意见修正、revision228复审后仅两组纯内存检查一次通过（53.2702ms），无新文件产物，不再启动助手或现场入口。源码、预算、失败/清理和后续诊断记录见[固定共享卷实现方案第8节](Windows%20Sandbox%20固定共享卷实现方案.md#8-当前阶段原生单盘入口与正常生命周期)。没有磁盘创建或实例，不重跑旧矩阵；生产默认、真实工程、共享准入与权限退役关闭，P0桌面回放待办。
# 十六、用户批准的 P4 局部调序（2026-10-30）

用户明确选择“小幅调序：先处理 P4 的重复失败硬封禁、自然语言成功扫描及回复重写”。前节待决定是确认前的历史状态。本次只提前两项行为策略：P4.1 移除重复失败硬封禁，独立审查记录后再进入 P4.2 自然语言成功扫描/回复重写。P3.5.2 继续等待新实现证据，真实执行、P3.6、默认切换及其他旧权限退役均不开放。

## P4.1 重复失败硬封禁

普通同参数失败记录只提供有限提示，不再因累计两次失败拒绝第三次调用。明确权限、确定性输入/文件验证、真实工具错误、同批次/嵌套并发去重保持。瞬态网络重试仍限 5 次总尝试、15 秒累计计划等待、64 个预算 owner；重试表溢出原先借用普通失败拒绝，现单独报告 `GUARD_CAPACITY`，保留原两次未追踪恢复上限，且释放槽位不能重新发放整套预算。修正误标为 repeated_call_blocked 的预算拒绝元数据；旧结果分类仅为兼容保留，不再生成普通失败硬拒绝。

性能审查覆盖 Agent 参数准备/最终授权 → AgentSession 的 before/afterToolCall → ExtensionRunner 调用链 → 实际 tool_call/prepare/完整身份/batch/retry → tool_result/classification/advice → CallLedger finish/end/clear。保留一次准入哈希、结果阶段无再次哈希，普通准入不再遍历失败签名表；未增加回调、Promise、数组、缓存或对象池。工具准入/结果拦截原有异步边界保持，未触及逐输出/渲染通路。失败表及提示仍有既有容量，正常、失败、父取消、准备取消、重试结束的释放均由原 owner 承担。

验证：39 项定向行为/精确 AST 检查通过，42 项实际 hook、CodeMode allowFailure、明确拒绝、文件校验、资源限制及结果事实检查通过，类型检查通过。删除/合并仅证明第三次封禁、先修改成功才解封的过期断言，测试实例净减 7，不增加 CI 矩阵。第三次失败现在到达原验证器/工具，仍保留真实错误；显式拒绝仍阻止执行，文件冲突及输入错误不产生额外提交。

现有分配基准首次因旧 fake API 缺少事件接口而未启动；仅补齐测试/基准 fixture 后，生产修改前与修改后各测一次，同机 Node 26.13.0。每档 256 调用：64 字符采样 7077.03→6535.09 B/调用、p95 0.0179→0.0185 ms；1 Mi 字符采样 21977.88→21972.88 B/调用、p95 1.1287→1.1828 ms。采样是本机观测，不据此宣称性能提升。两档分别扫描 50,688 / 536,890,112 字节，准入 digest 均 256，结果扫描字节/digest 均 0；原 288 个弱引用在保留 64 hook owner、32 retry ledger 后 GC 全部释放。现有容量与取消测试通过；无新磁盘报告、后台任务或安装包。

后续自查发现硬封禁移除后原有失败提示会每次重复，已收敛为每个仍保留的失败签名在第二次失败时提醒一次；原第 3/5/8 次连续调用提醒保留。实际 hook 连续 12 次失败验证失败提示 1 条、连续调用提醒 3 条，第三次及以后仍返回原工具错误。对应 5 项定向复核通过。基准补充 64 字符失败路径（256 次计量、32 次预热），稳态新增提醒 0，结果扫描/哈希 0，采样 5867.97 B/调用、p95 0.0190 ms；修正后成功两档采样 6070.16 / 22133.00 B/调用、p95 0.0177 / 1.1216 ms，确定性计数不变，288 个弱引用仍全部释放。旧 checkout 对比只跑原成功路径，避免对已有硬封禁强行执行连续失败基准。

独立审查指出溢出恢复额度耗尽仍被标记可重试，已修正为 `retryable:false`，普通容量不足保留 `true`，在既有测试补断言而不增加测试实例；对应 4 项定向复核、类型及差异空白检查通过。独立最终复核通过（审核对话 revision 84），未发现阻断问题；**P4.1 完成并记录**，仅暂存本项文件，不提交。至此才允许进入已获授权的 P4.2，P3 与其他权限退役状态不变。

## P4.2 自然语言成功扫描与最终回复重写

范围审查通过（审核对话 revision 87）后，删除 false-success-guard 的 `message_end` 注册、成功/未完成措辞正则、草稿收集与替换专用代码及新回复干预审计。最终回复的语言、措辞、文本长度不再触发此扩展改写。失败工具结果的 8 KiB 分类、后台任务结果订阅、文件 intent/result 配对、结构化 `goal_complete` 拒绝与审计保留；此扩展暂保留默认注册，不把局部策略移除记为整包退役。历史审计与旧 FSG 注释仍按原兼容规则可读，通用消息扩展接口不变。

完整审计链：provider 最终响应 → Agent streamAssistantResponse/processEvents 的原消息状态 → AgentSession `_handleAgentEvent`/`_emitExtensionEvent` → ExtensionRunner `emitMessageEnd`/`invokeHook` → 原 FSG 收集/扫描/替换 → Session 的原位消息同步、事件交付与持久化。本项只删除 FSG 消费者，不修改上游共享接口；最终回复不再为它分配事件/替换对象或复制草稿，其他扩展及共享分发仍有既有分配，不能声称整个通路零分配。无新生产回调、Promise、缓存或对象池。

现有 18 项实际 Agent/batch 用例改为验证原回复完整保留，并继续验证失败/部分变更/取消/参数修复及结构化 goal 拒绝。超过旧 1,000,000 字符上限的中英文多文本块及 thinking 元数据在 Agent 状态、会话事件和持久化记录完全一致；没有产生回复改写审计。N4 原有综合用例同时确认措辞及预览不会改变 `succeeded/failed_no_change/not_started` 文件事实，保留真实 shell 错误、输出上限、预算续接和重开记录。相关后台终态与分支切换、真实 shell 事实/明确拒绝共 24 项检查通过；另外 N4 和精确 AST 检查等 5 项通过（含已计入前组的一项 preflight），即 28 个不同定向用例。类型与差异空白检查通过。

测试修正过程如实记录：首次增加第二条连续 assistant 测试回复触发 fixture 不允许从 assistant 直接 continue，已合并成一次多块大回复；随后类型检查发现仓库目标库不支持 `findLast`，改用原有兼容遍历，没有改生产行为或提升目标库。仅在修正后复跑受影响用例。没有新增 CI 测试实例；替换过期回复拦截断言，保留仍有效的文件/任务/权限事实验证。两项合计测试实例净减 7，未运行全仓测试或扩大超时。

手工基准 `scripts/bench/false-success-finalization.ts` 直接调用真实 ExtensionRunner，生产修改前后各一次，同机 Node 26.13.0；64 字符/1 Mi 字符各预热 16、计量 128 次。FSG 终态 handler 1→0、文本 getter 读取 256→0、替换与审计各 128→0；采样分配 9685.00→6190.75 / 2009717.94→5373.88 B/调用，p95 0.0155→0.0066 / 2.2541→0.0094 ms。采样不是跨机器性能保证；确定性减少来自删除该消费者。保留 runner 后，864 个消息/内容/文本块弱引用在关闭和 GC 后全部释放。基准不创建磁盘夹具、子进程或报告；会话用例按自身创建身份清理，N4 本次夹具 `sp-n4-session-vTJhGE` 已确认不存在。没有触碰此前被审批拒绝的 P3 遗留清理。

最终审查要求补齐主要分配位置，已在同一手工基准输出前 6 个位置并仅复测当前实现一次：64/1 Mi 字符分别 5974.75 / 5548.00 B/调用，p95 0.0083 / 0.0072 ms，零读取/替换/审计与 864 引用释放计数不变。剩余生产采样主要来自共享 `ExtensionRunner.createContext`（每档合计 436,472 / 395,608 字节）和 `emitMessageEnd`（75,760 / 59,264 字节）；其余主要是基准自身的消息、WeakRef 与采样容器。未据此扩大优化共享分发器。删除注册也取消原 FSG 每事件的 hook 包装与异步调用、草稿字符串和替换数组/对象；新增加的生产闭包、Promise、AbortController、包装对象及数组均为 0，无对象池。

独立最终复核通过（审核对话 revision 91），性能报告缺项已补齐，无剩余阻断问题；**P4.2 完成并记录**。本轮提前处理的两项均已按实现→定向验证→独立审查→记录顺序完成，仅精确暂存本项文件，不提交、不推送。P3 真实执行接入继续关闭，其他 P4/P5/P6/P7 未调序；没有将局部策略删除记为整体权限迁移完成。

# 十七、下一项选择与 P3 VM 路线预审（2026-10-30）

用户要求继续并判断从哪里开始。本轮先回到 P3 的既有恢复路线，范围审查（审核对话 revision 93）建议先核对 VM 的命令/结果传输和文件 deny；任一缺少可复用实现就停止完整适配，不安装后端或新建通用 VM 框架。P4.1/P4.2 的完成状态保留，这次“继续”不自动扩大此前只批准两项的调序范围。

## 固定 MXC Windows Sandbox 实现的契约预审

继续使用第十五节已记录的固定提交 `b4c1007502835d958ab291d332b929187be00440`，不是再次扫描候选或将其当作最新发布。此前已确认 UI 配置缺口；本轮补查它背后的传输机制和明确拒绝条件。

| 契约 | 核实的实现事实与限制 | 对 Super Pi 的决定 |
| - | - | - |
| 命令与结果传输 | `bridge.rs` 使用四条 TCP 连接传控制、stdin、stdout、stderr，以 nonce/角色及协议前导握手；`vm.rs` 显式开启 VM 网卡 | 不能仅改 `<Networking>Disable</Networking>` 就保留原桥。控制通道与工作负载禁网须分别证明，未证明前不接入口。[桥实现](https://github.com/microsoft/mxc/blob/b4c1007502835d958ab291d332b929187be00440/src/mxc-sdk/src/backends/windows_sandbox/lifecycle/bridge.rs#L73) |
| 工作负载网络 | `policy.rs` 声明由 guest 防火墙实施网络隔离；启用 proxy、`network_mode_specified=true`、egress 默认允许或非空 allow/deny 列表、ingress 默认允许或允许 host_loopback 时拒绝。仅有空的默认 deny 配置且 presence 标志为 false，不会因字段存在就被拒绝 | “VM 网卡开启”不能等同“工作负载可任意联网”。本轮未审查或实测 guest 防火墙的完整强制边界，不能宣称其失效；也不能删除用户显式网络配置或伪改 presence 标志来掩盖接口不支持。[策略验证](https://github.com/microsoft/mxc/blob/b4c1007502835d958ab291d332b929187be00440/src/mxc-sdk/src/backends/windows_sandbox/lifecycle/policy.rs#L25) |
| 文件授权 | 仅映射已存在目录；单文件、嵌套映射、与共享根相等/内部/祖先相交的 deny 都明确拒绝；完全不相交的 deny 可由不共享满足 | 只能接受其可表达的分离目录策略。若要求工作区可写而内部目录只读/拒绝，不能改成整个工作区可写；本机原生 `.git`/`.sp` 保护不能靠宿主工具层替代 guest 任意命令边界。[路径与 deny](https://github.com/microsoft/mxc/blob/b4c1007502835d958ab291d332b929187be00440/src/mxc-sdk/src/backends/windows_sandbox/lifecycle/policy.rs#L102) |
| 工作区与共享 | 当前使用实时目录映射，guest 二进制只读；rendezvous 目录可写，含 bootstrap/握手文件；未写禁用剪贴板共享配置 | 可写共享及 bootstrap 都须纳入威胁边界与磁盘预算。改为复制工作区将新增 revision、外部修改、回写冲突及部分提交语义，不能视为 P2 已覆盖。本轮不另造复制/回写协议。[WSB 配置](https://github.com/microsoft/mxc/blob/b4c1007502835d958ab291d332b929187be00440/src/mxc-sdk/src/backends/windows_sandbox/lifecycle/vm.rs#L83) |
| 实例归属与清理 | `capture_launch_proof` 取得按 WindowsSandbox 前缀枚举的 PID/创建时间；空证明分支的注释明确保留枚举清理/force-reclaim 途径 | 这不单独证明实例由当前会话创建。并发、外部已有实例和空证明时的完整归属仍需审计；不得直接复用前缀枚举作为本项目停止或接管依据。保留现有 SessionExecutionBoundary，不另建任务 owner |
| 资源与终态 | bridge 的一次性捕获每流上限 64 MiB；host watchdog 为 guest timeout 加 30 秒，特殊无限值没有该 deadline；VM 停止另有等待与冷却 | 这些不等于本项目输出、磁盘和完整收尾预算。无法确认子进程/VM/共享释放时保持准入关闭；不把命令退出当作整体清理成功。前两项已显示接口缺口，本轮不继续展开整套资源适配 |

官方原生 `wsb exec` 仍明确不支持进程标准输入输出，虽然 `start` 支持配置和实例 ID，不能单独替代上述桥；[官方 CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) 与 [配置说明](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) 只作为接口证据，不作为本机验收。WinAppCli 的已有实例/网络共享缺口沿用第十五节，不再次安装或重复探测。

**预审结论：当前固定封装仍不可直接接入；本轮没有产生能解除 P3 阻塞的新实现。** 若后续获得改进实现，先证明关闭宿主剪贴板共享后的控制通道和工作负载网络边界，并能表达实际请求的文件策略；不支持时明确报告“未执行/不支持”，运行失败保留真实退出与错误，清理未确认继续封闭准入。不得通过忽略网络字段、扩大目录共享或接管已有实例来取得成功。

本项只有文档与只读源码核对：浏览工具未取得固定源码后改用原始源码 URL；GitHub API 限流后没有重试、读取凭据或扩大检索。源码只保存在读取进程内，无安装包/夹具/VM/后台任务，无生产热路径改动及 CI 新用例；不运行无关测试、分配基准或重试旧清理。文档差异检查通过；独立最终复核通过（审核对话 revision 102），已收窄网络拒绝条件并补全 P5.1 状态失效条件。**本项 VM 契约预审与下一项建议完成、审查、记录**，仅暂存本方案，不提交；P3 阻塞和 P5.1 待决定的状态不变。

## 可供决定的下一代码小项（提议时尚未调序，后续决定见第十八节）

若希望继续交付独立代码，建议仅提前 **P5.1 工具目录与可用状态的单一来源**，先统一目录读取，暂不退役权限入口或重做整个提示词系统。已只读定位 AgentSession 的 `_toolDefinitions/getAllTools`、现有 ToolSelection、tool-classification 的 `tool_search` 以及 MCP 的目录更新/激活意图；没有开始实现。

拟定首项范围：复用会话现有注册和选择机制，明确“已注册、配置允许、当前激活”三种状态及变更时的失效规则，让目录查询与搜索消费同一来源。工具可被搜索到不等于执行已授权。保留 ToolSelection 的 exclude、Browser 审批暂停、Plan 状态、MCP 身份/激活记录和最终调用检查；先不改变它们的策略。不得给每次输出或进度新增目录扫描、缓存失效或提示词重建；状态更新覆盖真实目录、选择配置、激活集合、模式和实际可用性变化，不能只按注册表版本缓存。具体实现按完整调用链执行最小 AST、分配及引用释放检查，改写现有覆盖而不扩张矩阵。

这只是可审查的调序建议，仍须用户明确将 P5.1 加入例外后才开始生产修改；若保持原顺序，则 P3 等待具体修复证据，不重复同一实验。P5.1 完成也不使 P3/P4 其余退役获得准入。

# 十八、P5.1 工具目录与状态读取（2026-10-30）

用户明确选择“提前推进 P5.1”。范围审查通过（审核对话 revision 104）：先统一目录读取，复用 AgentSession 已有注册、选择和激活 owner；不新增目录服务、全局缓存或权限裁决器。本项不扩大到 P5.2 或其他阶段，P3 真实文件/命令执行接入继续关闭。

## 实现与契约

新增 `AgentSession.getToolCatalog()` 和可选扩展 API，返回同步快照 `{ tools, activeTools }`。`tools` 沿用 `_toolDefinitions/getAllTools` 的配置筛选结果及原定义顺序，配置允许由 SDK allow/exclude、ToolSelection 和现有 noMcp/requiresMcp 机制决定；被排除工具及其 schema 不进入公开目录。`activeTools` 来自实际 `agent.state.tools`，保留顺序。`ToolInfo.available` 仍只表达宿主/探测可用性，不能据此推导调用已授权，也不阻止现有显式 PowerShell 恢复入口。

tool-classification 的启动选择和 `tool_search` 读取同一快照；老宿主继续通过旧的两个读取接口兼容。搜索提交激活后仍重新读取宿主实际接受的集合，保留 added/rejected 结果。Browser 审批暂停在目录读取前返回；Plan 的选择与调用检查、MCP 身份和激活意图、CodeMode 同脚本激活及 ALL_TOOLS 初始快照语义不变。

不缓存意味着注册/移除/同名换定义、reload、手动/搜索/MCP/Plan 激活和 PowerShell 状态变化均在下一次显式读取时可见，不需要新增版本号或失效监听。数组与目录条目属于调用者，可独立修改；schema、guidelines 和来源元数据继续共享原定义身份，不承诺深复制。扩展 API 继续先检查会话有效性，reload 后旧扩展不能读取新会话目录；读取本身不发布工具或改变状态。

完整审计链：注册入口 → `_refreshToolRegistry` 配置筛选/同名覆盖 → `_toolDefinitions` 与 `_toolRegistry` → `setActiveToolsByName`/CodeMode 描述与提示词 → 新快照 → 扩展 runtime/loader → tool-classification 启动与显式搜索 → 宿主接受后的激活状态。另核对 PowerShell unavailable 回调、reload/dispose、Plan 和 MCP 消费路径，以及 Agent/CodeMode 输出到会话事件交付；没有在 provider delta、输出、进度、渲染或 Evidence Ledger 查询加入目录读取。

分配变化限定在显式目录读取：`getAllTools` 去掉一个中间数组和 map 闭包，`getActiveToolNames` 去掉 map 闭包；保留调用者所需目录数组、每工具条目及激活名称数组。新快照增加一个返回对象，绑定时增加一个生命周期回调，无每输出事件的新闭包、Promise、AbortController、包装对象或数组；不复制 schema/大字符串，不使用对象池，不保留共享可变快照。

## 定向验证与资源

复用现有用例，14 个不同定向检查通过：11 项 SDK/CodeMode/Plan/PowerShell/Browser/精确 AST 检查，以及 3 项 MCP 移除、同规范化名换身份、仅记录宿主接受的激活。覆盖配置过滤、目录条目/数组隔离、晚到注册、reload 旧 API 失效、同名 schema/sourceInfo 更新、available 与 active 分离、旧宿主兼容及同脚本搜索。首次类型检查发现测试直接读取通用 TSchema 的 required 字段，补字段存在性收窄后通过；自审将 Browser 暂停判断移到快照读取前并补零枚举断言，随后只复跑受影响的 5 项，全部通过。没有新增 CI 测试实例、全仓测试、完整构建或提高超时。

复用 `scripts/bench/codemode-session.ts --catalog` 手工基准，8/512 个自定义工具两档（配置可见工具含宿主内置共 22/526 个），每档显式读取 32 次。生产修改前后均通过：目录读取 schema 属性计数 0、提示词重建 0；有输出的脚本期间额外目录扫描/提示词重建均为 0；两次激活变更复用注册定义；未变更时 descriptor/Worker snapshot/catalog 身份复用。每档 Worker 启停各 1，关闭后执行、映射、描述、schema 保留计数均为 0；总计 18 个弱引用受控 GC 后全部释放，其中每档 3 个返回对象/数组在会话仍存活时即释放。移除和迟到回调检查通过。

同机 Node 26.13.0/Windows 的整段宿主采样为 24,377,704 → 26,334,616 字节，包含 SDK/Worker 启动、断言和夹具分配；结果没有证明整段分配下降，不作为提速结论。修改后目录读取主要采样位置 `getAllTools` 合计 1,406,672 字节，`getToolCatalog` 4,144 字节；其余主要位置为基准 readDirectory、工具名转换与 schema 夹具。主要分配位置随结果输出，不保存大报告。这里的确定性收益仅限删除上述中间数组/闭包和阻断无意义的暂停后目录读取，不改变生产性能门槛。

基准更新同时修正三处陈旧夹具约定：noTools builtin 控制初始激活而非过滤整个目录；停用工具返回既有 TOOL_UNAVAILABLE 说明；每档使用 reload 后的新执行边界，不能复用前档关闭的 runtime。只在这些明确失败修正后重跑，没有扩大实验。所有本轮夹具按自身 mkdtemp 身份在 finally 清理；MCP 输出的 OCJV37/kHhWfH/XziYCe 三个目录已逐项确认不存在。未生成安装包、研究文件或新后台服务，未重试此前被自动审批拒绝的 P3 清理。

独立最终复核通过（审核对话 revision 108），未发现阻断问题；**P5.1 完成并记录**。已按实现→定向验证→独立审查→记录顺序收尾，仅精确暂存本项 11 个文件，不提交、不推送。P3 阻塞与真实执行接入关闭状态不变；P5.2 及其他尚未批准调序的工作不自动启动。此前 9 份用户文档删除和原始补丁文件保持原状态。

# 十九、P5.2 显式工具选择模式（2026-10-30）

用户明确允许提前 P5.2，并要求先与审核对话确认范围。范围审查通过（revision 113）：P5.2 限定为显式工具选择模式读取，分为 P5.2.1 原生目录暴露模式、P5.2.2 分类扩展消费模式，前一项完成审查与记录才进入后一项。不包含结构化 prompt segments/dynamic-instructions 迁移、发现/激活仲裁重写、Plan 历史分支恢复语义调整、P4 访问控制退役或 P6；P3 真实执行接入保持关闭。

## P5.2.1 原生目录暴露显式模式

复用 SessionExecutionBoundary 现有最多 16 个服务 participant，增加可选同步、无副作用 `toolSelectionMode()` 声明，返回 plan 或 undefined；原生显式读取遍历现有集合，任一有效 plan 返回 plan，否则 default，非法返回值报错。该字段只协调工具选择，不改变准入或 allow/ask/deny；暂停中读取不会调用 assertCurrent 或重新开放执行，已 dispose 的边界不再调用旧声明。

PlanExecutionOwner 将一个生命周期函数直接指向现有 `state.enabled`，无宿主 setter、第二份状态、缓存、事件总线或新 registry。模式直接反映现有 Plan 状态；等待清理或发布前清理失败时仍反映原状态。本项不增加发布回调的状态回滚语义；若发布回调抛错，执行准入保持关闭。`getToolCatalog()` 总是输出 selectionMode，兼容类型允许旧宿主缺字段。扩展失效检查、加载失败撤销注册和边界关闭释放沿用原机制。本小项尚未改变 tool-classification 的模式判断。

审计链：Plan 启动恢复/用户切换 → changeMode → 原生 revoke/drain/publish → 原 Plan 状态 → 已注册 Plan participant 的同步读取 → getToolCatalog → runtime/loader。另审计加载失败注销、reload/new session/dispose，以及目录到 CodeMode 输出/事件链。新增模式函数仅每 Plan owner 一份；显式读取无新数组/包装对象/闭包/Promise/AbortController，复用现有快照并加一个字符串字段。无进度或输出扫描、无 schema/大字符串复制、无对象池。

8 个不同定向检查通过：SDK 默认/空工具、真实 Plan 调用与退出/reload、原生切换顺序、扩展加载失败回滚、真实 Plan 等待/失败退出/成功退出与保存/导出/实现动作、regular 新建/fork/resume、目录 AST 与边界准入/Plan transition 源码不变量。首次 reload 断言错误地假定无持久绑定的 SDK 会自动发 session_start；按现有生命周期补未恢复时 default 与 bindExtensions 后 plan 的断言后通过，未改生产 reload 语义。类型检查通过；无新增测试实例、全仓测试、完整构建或提高超时。

复用 8/512 工具目录基准，生产修改前后各一次：每档 32 次目录读取，新模式声明调用为 32，前 16 次 default、后 16 次 plan；输出期间额外模式读取 0，schema 属性读取/提示词重建仍为 0。新增读取函数、participant 与捕获状态纳入弱引用，总计 24 个引用在关闭与受控 GC 后全部释放；每档 Worker 启停各 1，participant 关闭后为 0，目录原有身份复用和释放断言继续通过。整段采样 26,810,896 → 26,671,264 字节，仅作本机证据，不宣称提速；修改后 getToolSelectionMode 采样 4,112 字节，getToolCatalog 12,480 字节，主要分配仍为夹具和目录条目。真实 Plan 切换用例另记录 14 次切换、1 次拒绝清理、2 次 UI 等待、3 次 ready 动作、1 次实现交接、4 个弱引用全部释放，采样 3,849,688 字节，未超过原 16 MiB 门槛。

本轮目录/会话夹具均由已有 finally 按创建身份清理，没有下载、安装、额外报告或常驻服务，也未重试旧 P3 清理。独立最终复核通过（revision 114），并按审查意见明确发布回调不具备新增回滚保证；无需改生产或增加测试。**P5.2.1 完成、审查并记录**，仅精确暂存本项 13 个文件，不提交、不推送；至此才进入已授权的 P5.2.2。

## P5.2.2 分类扩展消费显式模式

在 P5.2.1 完成记录与暂存后，tool-classification 的 session_start 改为使用模块同步函数 `planOwnsToolSelection`：selectionMode 为 plan/default 时以明确字段为准；仅字段缺失时运行原来的两个工具名推断，兼容既无新 API 的旧宿主，也兼容 P5.1 已有目录 API 但尚无模式字段的宿主。原显式配置选择的优先级、Plan 工具投影、Browser 审批暂停、搜索激活后宿主接受检查及最终执行检查不变。

修改前先验证两个可观察回归：普通模式注册两个 Plan 同名控制工具会被误认并保留错误的条件工具集合；真实 Plan 被配置排除一个控制工具后，分类扩展会覆盖其选择，连仍允许的 plan_mode_complete 也被移除。两项均在旧实现上失败；实现后通过，同时覆盖明确 default 与旧缺字段目录的切换、Plan/分类两种加载顺序、旧快照与重新加载行为。

6 项定向检查通过：上述显式/旧目录兼容、真实 Plan、真实 tool_search、完全旧 API 的精确名称搜索、Browser 暂停与严格零分配 AST。类型及差异空白检查通过。只新增 1 个针对此前未覆盖误判的测试实例，在已有 Plan 用例内增加一个反向加载顺序夹具；没有另建组合矩阵、放宽超时或运行全仓测试。

审计链继续为 session_start → P5.1 目录 → P5.2.1 同步模式声明 → 模块判断 → 原选择保留/默认工具投影。新判断不分配闭包、数组、对象、Promise 或 AbortController，不增加目录或 participant 读取；明确字段只比较一次，旧兼容分支最多查询两个名称。它不参与 provider delta、工具输出/进度或渲染。精确 AST 将该模块函数纳入既有零分配门禁；目录读取、owner 生命周期与 24 引用释放实现未改，复用本节上一小项同机基准，不无故重复完整目录采样。新函数无捕获引用和待清理资源；会话夹具继续按创建身份在 finally 清理。

独立最终复核通过（revision 116），未发现阻塞问题，并确认严格 AST 与上一小项的分配/生命周期证据覆盖本次纯同步判断，无需重复基准。**P5.2.2 完成、审查并记录，revision 113 限定的 P5.2 整体完成**；精确暂存本项四个文件，不提交、不推送。两个小项均按实现→定向验证→独立审查→记录顺序推进；提示词结构化及其余未调序工作不自动启动，P3 真实执行接入保持关闭。此前用户文档删除和原始补丁文件保持原状态。

# 二十、P5.3 提示词结构化（2026-10-30）

用户明确允许提前推进提示词结构化。先由审核对话确认最小范围（revision 120）：P5.3.1 原生构造与 before_agent_start 来源传递；完成审查、记录后进入 P5.3.2 dynamic-instructions 原生片段消费与旧宿主兼容。不扩展到通用提示词编辑协议、P6、其他工具仲裁或 P3 真实执行接入；P3 继续关闭。旧节中的未授权描述保留为当时状态，本节记录本次新增授权。

## P5.3.1 原生构造与来源传递

原生 builder 输出 version 1 的不可变 composition，包含五个固定聚合片段：default/custom base、append、workspace、skills、cwd。每个片段含来源与格式版本；原 string API 保留，默认/自定义的空值判断、序列、空行、结尾换行及技能 XML 转义均沿用原字节。迁移所需的 context 数量、可见 skills 数量和最长路径字符数在构造时固定为标量，不复制资源列表，不给原生 builder 增加迁移预算限制，也不读取技能正文。

AgentSession 在原有资源/工具/模型重建点保存当前 composition，重建即替换，dispose 清除新增引用。Runner 将与初始字符串配对的产物贯穿整次异步 handler 链，不在 await 后读取最新会话构造结果。消息贡献保持来源；任何完整 systemPrompt 返回值（包括相同文本和空字符串）使后续来源不可逆变为 null。旧四参调用最初仍为 undefined，字符串不匹配则为 null。该字段只表示来源，不是权限凭据，provider 仍只收到字符串，竞争 prompt 的准入语义不变。本小项未改变 dynamic-instructions 消费逻辑。

审计链：资源加载/模型能力/工具选择 → `_rebuildSystemPrompt` → 原生格式化 → 会话当前产物 → `emitBeforeAgentStart` 及其 createContext/invokeHook/异步 handler → 原有 custom message 归集/准入 → Agent/provider；另核对 reload、dispose 和进度/输出链。新增 5 片段记录、1 数组、1 标量对象和 1 composition，仅在重建边界分配；会话持有一个当前产物，事件链在调用期间持有配对旧产物，扩展可自行持有公开不可变值。未增加逐 delta、工具进度、渲染或 Evidence Ledger 扫描、对象池或常驻服务。现有回合级 hook 的 context、Promise 和消息对象分配仍存在。

10 项定向检查通过：四组修改前 golden（仅归一化安装位置的 README 路径）、片段冻结和元数据配对、raw override/消息贡献/旧四参/异步重建、精确 AST 构造调用点、真实 SDK 两次 prompt 身份复用与 provider 字符串、模型工具能力，以及竞争 prompt 准入。类型与差异空白检查通过。只新增 3 个测试实例并复用已有离线 SDK 测试，不运行全套或完整构建，不增加超时。

手工 `scripts/bench/prompt-composition.ts` 使用真实 builder → Runner → dynamic-instructions，128 KiB workspace、16 次变化、64 次未变回合，不写磁盘。修改前后：原生构造/技能格式化各 16；扩展旧重复格式化各 16、SHA-256 32、唯一片段移除 32、旧文档扫描 16；未变回合上述调用均 0。改后新 composition 构造为 16。采样 bytes/call：变化 1,356,833 → 1,359,996.5，未变 12,664.375 → 13,009.875；短样本 p95 变化 0.779 → 0.929 ms、未变 0.0192 → 0.0381 ms，不作提速结论。主要分配为旧 indexOf/byteLength/join、Runner context，下一小项才移除旧重复工作。受控 GC 时 Runner 保持存活：修改前 17 个 options 弱引用余 1；改后 17 options + 17 composition 共 34 引用余 1，旧扩展仍保留最后 options。真实会话 dispose 已验证新增 slot 为 undefined；本项不宣称旧扩展缓存已清理。

独立审查 revision 122 发现迟到模型认证可在 dispose 后重新保存 composition。已在 `_rebuildSystemPrompt` 入口阻止关闭后的重建；原有模型切换用例追加“挂起认证 → dispose → 认证完成”断言，改前失败、改后通过。仅复跑该用例及精确 AST 共 2 项，类型检查通过；未扩大到模型切换语义重构。基准为补齐释放证据拆分弱引用并复测：17 options 余 1、17 composition 余 0，Runner 保持存活；变化/未变确定性计数保持，采样分别 1,361,233 / 12,626.625 bytes/call，不作提速结论。

修复后的独立最终审查通过（审核 turn `01a18c8d-197b-7550-9a91-fbed2be3e706`），未发现剩余阻塞。**P5.3.1 完成、审查并记录**；精确暂存本项 12 个文件后才进入 P5.3.2，不提交、不推送。新增基准不加入 CI 矩阵，不下载/安装，不生成大型报告；已有测试临时目录继续由 finally 按 mkdtemp 身份清理。不重试此前被自动审批拒绝的 P3 清理，保留既有 9 份用户文档删除及原始补丁状态。

## P5.3.2 动态指令消费原生片段

P5.3.1 完成审查、记录及暂存后实施。dynamic-instructions 对支持的冻结 composition 直接消费 workspace/skills，并组合原有 base/custom、append、cwd；不重复格式化、不搜索/裁剪最终字符串，不改自定义或追加内容中的相同片段、XML 标签和旧 Pi 文档标题。原生实际技能可见性是唯一依据，修复 CodeMode 嵌套 read 已生成技能目录但旧扩展遗漏迁移的不一致；该回归用例在改前实测失败，改后通过。

三态契约：有效原生 composition 走新路径；null（先前整体覆盖）不产生替换/空替换；仅 undefined（旧宿主未提供协议）走原严格唯一匹配/旧文档压缩兼容路径。未知版本、来源或无效结构清空当前投影并保持原文，不降级为文本猜测。原生校验最多检查五个固定片段和四个标量，迁移沿用 64 context / 256 visible skills / 2048 路径字符 / 合计 256 KiB 原预算；超限保持完整提示词，不截断、不影响原生 builder。前序扩展修改 systemPromptOptions 不改变已构造片段及预算。

持久化协议仍为 dynamic-instructions-v1。当前分支的 durable SHA-256 是唯一已发送依据；首次非空、独立 workspace/skill 变更、完整替换、清空 tombstone、reload/resume/branch 与写入失败后的重试保持原语义，不预先推进进程内状态。缓存仅持有一个当前原生 composition/投影或一个旧宿主 options/投影，不建立全局历史缓存。session_start、来源失效/无效和 session_shutdown 清除投影与缓存结果，正常替换释放旧引用。

审核对话 revision 125 明确同步 dispose 边界：AgentSession.dispose 保证自己的 composition 槽清空并使旧 API 失效，但不会自动发 session_shutdown；未收到 shutdown 的扩展当前缓存可随旧 Runner 保留到回收。不为本扩展增加通用 dispose API 或执行 participant，也不把正常 shutdown 的零保留结论扩大到该路径。

7 项定向检查通过（新增 5 个实例及复用 2 个真实 SDK 前缀用例）：native/nested read 与重复自定义内容、不可变迁移预算、来源三态及预算超限无 tombstone、durable hash/失败 append/独立变更/清空/分支恢复、旧宿主严格匹配与旧文档压缩、精确 AST 原生路径禁止全串搜索/格式化/序列化/回调分配。真实 SDK 连续两次 prompt 验证 composition 身份复用、技能只产生一次持久化消息、provider 仍是字符串且没有 composition 字段。首次类型检查发现测试 session_start 缺 reason，补 reload 后类型通过；差异空白检查通过。没有创建组合矩阵、放宽超时或运行全仓测试/完整构建。

同一手工基准扩展显式 first 1 / change 16 / warm 64 阶段，128 KiB workspace：首次原生构造/原生技能格式化/native projection 各 1，哈希 2；变化阶段各 16、哈希 32；未变阶段这些调用均 0。新路径 formatContextFiles、formatSkills、removeUniqueSection、compactPiDocs 调用全部为 0；原生 full prompt 和稳定 prompt 各仅在构造/投影变化点组合，未变回合不构造新片段、完整字符串或哈希。结构计数来自 V8 精确函数覆盖；没有把旧分支扫描、回合 context/Promise/消息成本隐藏成零分配。

本机采样 bytes/call：变化由上一小项 1,361,233 降至 564,138（约 58.6%），未变 12,626.625 → 12,240.25；改后 p95 为 0.750 / 0.0181 ms。首次包含冷启动采样 764,256 bytes、1.486 ms，不与热值混用。移除的主要位置是旧 indexOf 和重复 byteLength；保留的主要位置是 replacementContent 的 join、原生片段字节检查和 Runner/createContext。该短样本是本机证据，不承诺跨机器时延改善，也未使用对象池。

正常 shutdown 后 Runner 仍存活：17 options、17 composition、119 片段记录/数组/标量对象共 153 个弱引用，受控 GC 后均为 0。另单独验证仅 invalidate、不派发 shutdown：当前 composition 随 Runner 保留 1；释放 Runner 后为 0。持久化消息字节是会话历史的预期所有权，不计为临时投影泄漏。基准只用内存，不写夹具/报告或启动服务；SDK 测试继续按原 finally 清理已知临时目录。README 已去除指向不存在 maintenance/pi-core-compat 的旧测试命令，替换为真实的小规模验证入口；本轮新增测试总数为两个文件 8 个实例，无新增大型或过期重复测试需删除。

独立最终实现审查通过（revision 127），文档最终核对通过（revision 129）；未发现阻塞，也未发现需要重复测试或扩大基准的缺口。**P5.3.2 完成、审查并记录，本次授权的 P5.3 提示词结构化整体完成**；精确暂存本项 6 个文件，不提交、不推送。两个小项均先完成代码、验证、独立审查和记录才进入下一项。P3 真实文件/命令接入保持关闭，其余未授权调序项不启动；此前 9 份用户文档删除和原始补丁保持原状态。

# 二十一、P5 剩余工作与逐项收口（2026-10-30）

用户继续授权先与审核对话核对 P5 剩余内容及最小范围，再逐项实现、审查、记录。范围审查 revision 132 确认：P5.1/2/3 已完成各自约定，但不等于原 P5 整体完成。后续按下表逐项处理，不打开 P3，也不进入 P6/P7。

| 小项 | 经源码核实的剩余内容 | 范围与状态 |
| - | - | - |
| P5.4 Chrome 自动恢复使用显式模式 | Chrome 原先靠两个工具名判断 Plan，与现有原生 selectionMode 不一致 | 已完成、审查并记录，仅迁移自动恢复判断 |
| P5.5 MCP 候选与宿主目录一致 | 远端前 8 项及 schema 预算在宿主筛选之前决定，被配置排除项可占额度 | 已完成、审查并记录；前置资格筛选，保留激活后复读宿主接受结果及只记录接受项 |
| P5.6 默认装配与启停契约核对 | 项目配置含 dynamic-instructions，源码启动器默认装配与普通 SDK 自有资源配置不同 | 已完成、审查并记录，参数装配与实际文件入口分别验证，未修改生产默认行为 |
| P5.7 MCP 自动恢复与 Plan 协调核对 | 分支恢复及原生新工具注册会重新扩大 Plan 已发布的选择，真实 SDK 夹具已复现两层原因 | 已修复、审查并记录；自动恢复和原生注册尊重显式 Plan，保留定义更新、默认模式及显式选择 |

## P5.4 Chrome 自动恢复使用显式模式

只修改 active-tool-policy 的模式判断和 tool-selector 的自动恢复调用。显式 plan 保留现有选择，显式 default 正常应用 Chrome 选择；仅 selectionMode 缺失才使用旧控制工具名推断。每次自动恢复从一次可选 getToolCatalog 快照同时读取 activeTools 和 selectionMode；无目录 API 的旧宿主仍用 getActiveTools。真实 session_start 在读取设置前后分别调用，第二次重新读取当前模式，原会话代际取消继续生效。

显式 enable/disable/选择及设置保存失败后的回滚不增加目录读取，沿用原 setActiveTools 与宿主接受结果。连接审批、暂停解除回执、浏览器启动/收尾、设置队列及模块状态所有权均未变；发现/激活不授予执行权限。完整审计链为 session_start → 两次 apply（中间 settings I/O）→ 原生目录/模式声明 → 纯模式判断 → reconcile → 原有工具选择/提示词重建；另核对显式设置事务及回滚、BrowserRoutingGuard 回执、Plan owner 和输出/进度链。

新增 1 个真实 SDK 定向用例，普通模式同名工具冲突在改前实测失败，改后通过；同例覆盖显式 Plan 缺控制名、两种旧宿主兼容、手动选择零额外目录读、真实 Chrome 启动与设置 I/O 两方向模式切换、会话代际取消。复用实际 Plan、显式 Chrome 选择及审批暂停、严格零分配 AST 三项，共 4 个不同定向检查通过。类型和差异空白检查通过。测试修正：移除与 fixture dispose 重复的 participant 注销；Jiti 测试使用与生产内部相同的 runtime.js 导入身份后，代际取消断言通过。未因此修改生产生命周期、增加矩阵或超时，也未启动真实浏览器。

复用 `codemode-session.ts --catalog --chrome-selection` 手工基准，8/512 自定义工具两档（配置可见 22/526），每档模拟真实启动的两次自动应用并复用原输出/Worker 收尾验证。改前误判 Plan：目录读 0、提示词重建 2、schema 属性读取 12/384；改后目录读 2、提示词重建与 schema 读取均 0，手动选择额外目录读 0。输出/进度新增目录读、模式读、提示词重建均 0。每档 6 个快照/数组弱引用在会话仍存活时释放；总计 36 个引用在关闭及受控 GC 后全部释放，每档 Worker 启停各 1。首次基准将原有显式激活的 schema 读取误当目录读取，修正观测边界后才记录配对结果，未改变生产实现。

新增成本是每次自动恢复的完整目录快照（一个快照、目录/活动数组及每工具条目），不能称整链零分配；快照只在同步调用栈持有。纯模式判断仍零闭包、Promise、对象、数组分配，无新增长期缓存、计时器或对象池。整段宿主采样 33,866,352 → 29,446,672 字节，主要位置为夹具 readDirectory、标识符转换和 getAllTools，不据短样本承诺生产时延改善。目录读取沿用 P5.1 机制，不读取 schema 正文；本轮基准未扩展 CI。测试/基准临时目录继续由 finally 按创建身份清理，没有下载、安装或后台服务。

独立最终审查通过（revision 133），未发现阻塞；采样下降包含避免误判后多余重建的收益，不推广为一般性目录读取提速。**P5.4 完成、审查并记录**；精确暂存本项 6 个文件，不提交、不推送，此后才进入 P5.5。已有暂存工作、9 份用户文档删除和原始补丁保持原状态。

## P5.5 MCP 候选与宿主目录一致

P5.4 完成记录与暂存后，由审核对话确认最小范围（revision 134）。mcp_search_tools 在 discovery 等待和生命周期/代际校验之后读取一次可选 getToolCatalog；从配置可见且 available 不为 false 的条目建立调用内资格 Set。runtime 在计入前八个候选之前过滤，随后才进入既有 schema 预算。现代空目录为权威空集合，available 缺字段按原兼容可用处理；仅无目录 API 的旧宿主保留原行为。

索引顺序、toolConfig 校验、八项上限、schema 字节预算及首项特例不变。激活前集合来自同一次目录快照，激活后仍重新读取宿主实际接受结果，仅接受项写入身份记录；配置可见不等于执行授权。未改 OAuth、远端身份、执行 owner、取消、noMcp 或审批边界，未建立缓存、新注册表或排序机制。审计链包括真实宿主动态注册刷新配置过滤后的工具定义 → discovery/代际 → 单次目录读取 → runtime 搜索 → schema 预算 → setActiveTools → 最终接受复读 → activationIntent 持久化；另核对执行 owner 收尾与输出/进度链。

新增 1 个真实扩展/本地 HTTP 夹具用例：旧实现的前八个排除项会遮住后面的合格项，改前实测失败、改后通过。覆盖 unavailable 不消耗候选/预算读取、缺字段兼容、等待期间零目录读取、等待完成一次读取、空目录及恢复，以及现代目录可见但最终被宿主拒绝时不记录成功。复用旧宿主拒绝记录、执行 owner 收尾/重连、精确 AST 三项，共 4 个不同定向检查通过；类型与差异空白检查通过。没有扩大测试矩阵、运行全仓测试、完整构建、提高超时或调用真实远端/浏览器/OAuth。

新增独立手工 `scripts/bench/mcp-search.ts`，不加入 CI，也不重复无关的分页基准。实际经过扩展与 McpBridgeRuntime，使用一个本地 HTTP 夹具，32 次搜索。修改前后：目录读取 0 → 32、活动工具读取 64 → 32、schema 预算读取均 256，其中被排除项读取 256 → 0、资格 Set 参数 0 → 32。目录 API 由夹具提供，此采样不是完整原生 AgentSession.getToolCatalog 的每次搜索成本；原生目录分配已在 P5.1 单独记录。128 个快照、数组及 Set 弱引用在 runtime 仍存活时受控 GC 全部释放，无新增长期状态。

采样分配 294,776 → 624,496 字节，即每次 9,211.75 → 19,515.5。增加包括资格 Set/快照及正确处理合格候选后执行的身份哈希，不能宣称提速；新版本主要采样位置为迭代 next、内部错误包装、digest/Hash 和 Set.add。新增开销仅发生于显式搜索，输出/进度不触发目录读取；searchTools 的既有 AST 检查禁止循环内闭包等，但不代表整条搜索链零分配。无对象池、全局缓存或 schema 正文复制。

基准首版未拒绝 HTTP GET，空请求体在事件回调 JSON.parse 时异常退出；已补 POST 限定并输出夹具身份。正常运行的两个基准目录及三个测试目录均按自身身份清理并确认不存在。异常遗留 `C:/Users/Administrator/AppData/Local/Temp/sp-mcp-search-bench-T8zbk7` 仍含两个夹具文件共 138 字节：config/mcp.json 106 字节、mcp-activation.key 32 字节。用户已授权清理，但删除命令被自动审批在执行前拒绝，唯一原因是 `blocked by policy`；删除未发生，未换方法重试，也不推测 ACL 或占用原因。该目录单列清理待办，不计为生命周期引用泄漏，也不宣称全部临时产物已清理。

独立最终审查通过（revision 135），未发现阻止收口的问题；审核同时核实真实宿主动态注册链及遗留目录。**P5.5 完成、审查并记录**；精确暂存本项 6 个文件，不提交、不推送，此后才进入 P5.6。P3 真实执行接入继续关闭，旧用户删除与原始补丁保持不变。

## P5.6 默认装配与启停契约核对

范围审查 revision 140 确认只补装配验收和文档。实际链路为 `.sp/config/settings.json` → dynamic-instructions 的 package manifest → `scripts/superpi.mjs` 生成扩展参数 → DefaultResourceLoader 解析并加载文件入口。源码启动器默认包含此扩展，noExtensions 跳过默认资源但保留显式扩展；普通 SDK 只消费自身资源配置，不自动继承源码启动器的整套包清单。不向 SDK 强行添加默认扩展，也不改变生产加载顺序。

复用三个既有检查且首轮全过：启动器参数测试拦截最终 CLI 导入，验证 dynamic 参数默认一次、禁用零次、禁用加显式声明一次；它只证明参数装配。真实离线 SDK 测试改用同一 manifest 的文件入口，验证无加载错误且 resolvedPath 唯一，在真实 dynamic hook 入口观察并原样调用原 handler，连续两轮 composition 身份复用且动态消息只有一条。默认/自定义基础提示词及追加内容保留，workspace 与 skills 目录转入动态消息。无扩展的既有原因定位用例确认完整原生字符串未变、仍含 workspace/skills 且无动态消息，原因定位断言继续通过。

本项补齐装配、启停和内容放置，完整段落字节保真沿用 P5.3 的既有精确断言；本轮 skills 的新增检查主要是目录标记和迁移位置，不单独宣称重新完成全部字节验证。类型和差异空白检查通过。新增测试实例为 0；一个现有启动器子进程内多一组参数，现有 SDK 用例增加一个自定义提示词捕获，不建立全量默认资源矩阵。无生产热路径改动、新缓存或生命周期机制，故不重跑旧分配基准或无关测试。SDK 两个根目录由 finally 清理并检查不存在，启动器夹具由既有 t.after 清理；无下载、安装、外部模型或后台服务。

独立最终审查通过（revision 143），未发现阻塞。**P5.6 完成、审查并记录**；精确暂存两份测试、扩展 README 和本方案共 4 个文件，不提交、不推送。审核同时指出原 P5 的自动激活协调尚需取证，故本项不等于 P5 整体完成；此后只进入 P5.7 的 MCP 自动恢复/Plan 情形核对。P3 真实执行接入保持关闭，138 字节清理待办及此前用户变更均保留。

## P5.7 MCP 自动恢复及原生注册与 Plan 协调

先以真实 SDK、Plan、MCP 和已有持久化搜索意图取证：Plan 只保留 read、必要控制项及 codemode，session_tree 后却新增 lookup 和 mcp_search_tools。范围审查 revision 145 同意限定修复自动同步。加入真实新工具注册后又复现第二层原因：AgentSession 自动刷新注册表时重新应用显式工具名单/selection.adds，连先前未选的旧工具也恢复；仅清除 MCP 本次新注册名称不足以处理此行为。revision 147 同意将同一缺陷的原生根因修正并入本项，不新建仲裁层，也不把活动集合扩大定性为已证明的执行权限绕过。

MCP syncRemoteTools 每次使用一次可选目录快照，同时读取活动序列和显式模式。只有明确 plan 才不从持久意图补入名称、不自动补入搜索入口；当前已选中的搜索和有效远端工具仍保留，包括 reset=true。新注册导致的自动激活与已失效远端仍移除；注册标记在提前返回前清空。Plan 分支只按原顺序保留当前项，完全未变才跳过 setActiveTools。default、缺字段及无 API 沿用原语义，不推断 Plan 控制工具名。持久化意图不删除，退出 Plan 后由下一次已有同步恢复，不新增即时恢复事件；显式搜索和最终宿主接受检查保持不变。

原生 `_refreshToolRegistry` 在修改注册表前，仅当 options.activeToolNames 为 undefined 时读取现有 executionBoundary 的模式一次。Plan 下自动刷新只保留先前已发布的有效配置项，跳过 selection.adds、允许名单和新名称自动补入。注册表、配置筛选、同名定义及执行包装、CodeMode 描述和提示词仍正常刷新；不能因名称未变而保留旧定义。显式 activeToolNames（包括空数组）、默认模式及显式 setActiveTools 不改。没有第二份模式状态、完整目录读取、缓存或新控制器。

审计完整链：扩展 loader.registerTool → runtime.refreshTools → 原生注册表的配置/定义/包装/选择 → setActiveToolsByName → CodeMode 与提示词；以及 MCP 启动、目录更新、分支恢复 → syncRemoteTools → 宿主接受集合。原生新增一个布尔值及最多一次现有 participant 遍历，无新增闭包、Promise、AbortController、包装对象或数组；但整个注册刷新保留原有定义/包装/提示词分配，模式遍历也有既有迭代成本。MCP 每次自动同步新增调用内完整目录快照，复用原 Set，不缓存；输出/进度路径不新增读取或扫描，无新对象池及大 schema 正文复制。

9 个不同定向检查最终通过：新增的单一真实集成用例，P5.5 资格搜索，旧身份恢复、手动激活保持、远端移除，精确 AST，以及原有选择表达式、晚注册/reload、实际 Plan 三项。真实集成验证分支/后台同步、新注册当下均不扩大集合；远端必须配置可见；已选远端及搜索工具保留，同名 schema 更新实际活动包装；失效远端仍清除，退出 Plan 后下一次同步恢复意图，默认注册保留自动激活正对照。P5.5 用 waitForDiscovery 完成边界区分自动同步与搜索：等待中的搜索自身读 0 次，完成后自身读 1 次，没有把修改总数冒充旧语义。

测试取证过程修正了两个夹具前提：关闭的 runtime 保留状态壳，验收应检查 callback 与工具数据释放而非 states.size 为 0；SDK tools=[read] 会先过滤远端，最初的通过不能证明协调正确，故改为允许远端并显式断言配置可见后才记录真实失败。首轮同步修复下的新注册断言失败，推动上述原生修复；修复后只复跑受影响的新例、三个 SDK 用例及 AST，没有扩大矩阵或超时。类型、差异空白检查通过。本项新增 1 个测试实例，本轮 P5.4–P5.7 合计新增 3 个，其余为复用；没有重复的大型或过期矩阵需要删除。

两份手工基准分别对应实际改动链，不加入 CI：

| 观测 | MCP runtime 自动同步（32 次） | 原生 SDK 注册刷新（8 名称，32 次注册/替换） |
| - | - | - |
| 模式/目录读取 | 目录 0 → 32，活动序列另读 32 → 0 | 模式读取 0 → 32，不为判断读取完整目录 |
| 意外扩大活动集合 | 32 → 0 | 32 → 0 |
| 宿主选择写入/提示词 | 选择写入 32 → 0 | 提示词重建 64 → 64，含 32 次夹具显式缩小及 32 次原生刷新 |
| schema 属性处理 | 预算读取始终 0，Plan 不再运行恢复意图的身份哈希 | 684 → 0，未选工具不再进入活动描述处理 |
| 生命周期 | runtime 存活时，96 个快照/数组弱引用全部释放 | 会话存活时 64 个旧注册表/composition 释放；关闭后总计 70 引用全部释放，Worker 启动 0 |
| 配对采样字节 | 287,288 → 86,296 | 7,147,480 → 5,949,040 |

MCP 基准为 `mcp-search.ts --sync-plan` 的真实 runtime.onToolsChanged，目录 API 仍由夹具提供，不能当作完整 AgentSession 快照成本；每次同步采样 8,977.75 → 2,696.75 字节。新增原生基准为既有 `codemode-session.ts --registration-plan` 分支，走实际 registerTool、注册表、CodeMode、提示词，无 Worker/外部模型。原生主要分配仍是 wrapRegisteredTool、wrapToolDefinition 和声明处理，不宣称整条链零分配或一般性提速。随后修正基准重复创建未使用 loader 的问题，复用已有 loader 并清除 API 引用；一次最终复测计数与释放不变，采样 5,644,640 字节，模式读取位置采样 4,136 字节。该复测与旧夹具不直接计算提升比例。

所有本项已记录测试/基准目录均已按创建身份清理并逐项确认不存在，最后的 `sp-codemode-session-bench-f49E11` 也已确认不存在。无新增安装包、研究输出或后台服务。P5.5 的 138 字节目录仍因先前自动审批拒绝而保留，未重试；更早 P3 清理待办亦未改写为完成。

独立最终代码审查通过（revision 150），未发现阻塞。**P5.7 完成、审查并记录**；精确暂存本项 8 个文件，不提交、不推送。P5 现按已核对的具体契约收口：共同目录及宿主接受结果、现代宿主显式模式协调、结构化提示词与实际装配验收、已复现 Plan 自动激活冲突修复均完成。保留旧宿主兼容、扩展显式内容贡献与选择接口；不声称所有扩展策略合并为一个全局策略，也不扩大成原生化计划全部完成。P3 真实执行接入继续关闭，P4 其余访问控制退役及 P6/P7 不自动启动；9 份用户文档删除和原始补丁保持原状态。

# 二十二、P6 Provider 请求与压缩整合（2026-10-30）

用户本轮明确批准提前推进 P6，继续要求先与既有审核对话确认最小范围，逐项完成、审查、记录后才进入下一项。范围审查 revision 157 认可先补认证快照贯通。P3 的固定 MXC 候选仍未通过宿主剪贴板完整性验收，真实文件/命令执行接入、默认切换及依赖此边界的旧权限退役继续关闭。

后续独立拆项：认证来源的 header 保真、同模型摘要复用；Fast/serviceTier；Codex capability 全局 Symbol；Provider 重注册退役；已有压缩 owner 的策略接入与显式配置；最终装配验收。每项先核对实际调用链，不因为首项完成而将 P6 整体标为完成。特定代理、跨 Provider 摘要与模型选择仍需现有显式配置和数据边界，不扩大为通用默认。

## P6.1 已有压缩认证快照贯通请求预览

原生 manual/auto compaction 已捕获认证，server-compaction 也已接收，但其请求预览没有传入该快照，导致 dry-run before_provider_request 再次查询认证。现为 ProviderRequestPayloadInput 增加可选 auth；server-compaction 传入已捕获值。原生预览校验 provider、model id、API 一致，使用 auth.model（允许认证解析后的 endpoint）构造请求，并把同一个 auth 引用交给 payload hook。不匹配明确拒绝，不重新认证或回退账户；无 auth 的旧调用保持兼容。

异步等待前捕获原 model、runner、sessionId 和现有执行 generation；context 与 payload hook 返回后校验，不返回已切换模型、会话或执行边界的旧预览。使用现有生命周期，不引入新 owner/signal/缓存。tools、thinking 沿用原采样时机，因此仅保证认证、模型与会话身份一致，不宣称整份 Provider 请求已统一快照。输入已包含的 null header 原样传递；原生摘要 helper 在生成快照前丢弃删除标记的问题仍归下一项。

独立首轮审查指出 reload 期间旧 generation 数值可能恰好等于新 runtime 的初始值，不能只向当前资源加载器查 boundary。已补调用捕获 runner 的 assertExecutionCurrent，先验证原 runner/边界未失效。原合并例增加真实 session.reload，并拦在 loader 发布新 runtime、尚未替换 runner 的窗口；明确观察到 generation 相等且 runner 仍旧，再验证挂起预览被拒绝。修正后只复跑该合并例、类型、精确 AST 和同一 32 次基准，全部通过；没有增加 CI 实例。

完整审计链：manual/auto auth 捕获 → session_before_compact → server-compaction → loader 委托 → AgentSession 预览 → context runner → SDK body builder/convertToLlm → payload runner → server scope hash → 返回调用者及已有外层取消检查。预览是每次压缩/显式请求级异步边界，不在 delta、进度或渲染循环。新增只保留调用局部引用与整数检查，不复制 auth、headers、env 或历史，不新增 Promise、闭包、AbortController、数组、对象池或全局保存。既有链仍有 context structuredClone、hook 上下文与 deadline、请求 body 与 scope hash 分配，不宣称全链零分配。新增同步有效性 helper 纳入既有 AST 无正常路径分配检查。

四个不同定向契约最终通过：复用普通认证例，增加实际模拟压缩后总计查询 2 次（请求、压缩各 1）；新增一个合并例覆盖 auth 引用与有效 endpoint、null header、三个身份不匹配、无 auth 旧调用，以及 context/payload 等待时模型与 generation 失效；复用 API/Codex 各一条成功压缩后 opaque history 回放。未调用外部 Provider。新例最初误用了不存在的 Agent.setModel，类型检查同步指出；改为真实 session.setModel 后仅复跑该例和类型检查，通过。AST 门禁及 git diff --check 通过。仅新增 1 个 CI 测试实例，不新增矩阵、不增加超时或全量套件。

手工 `scripts/bench/provider-request-preview.ts` 在同一实际 SDK/server hook 链做 32 次预览：额外认证查询 32 → 0，同一 auth 引用交付 0 → 32；会话和 runner 存活时，160 个 auth/model/header/env/payload 弱引用全部释放。配对采样 112,866.75 → 110,660.75 字节/预览，p95 0.4022 → 0.4381 ms，主要分配仍来自 structuredClone、排序与路径配置，不据此宣称普遍提速。手工基准不接入 CI。

重载修正后的最终基准计数和释放保持不变；采样 115,032.5 字节/预览、p95 0.4224 ms。新增原 runner 检查本身是同步身份/数值判断；采样差异不能当作分配优化结论。最终 `sp-provider-preview-Azfp5j` 夹具已确认清理。

基准首次收尾误用不存在的 shutdownExtensions，已修正为 runner shutdown 与 finally dispose/清理；该轮样本完成但进程以收尾错误退出。最后一轮 `sp-provider-preview-v8RN7Z` 已确认删除。旧 `C:\Users\Administrator\AppData\Local\Temp\sp-provider-preview-ztIgwV` 为已核实空目录，用户已授权清理，但定点 PowerShell 删除被自动审批以 `blocked by policy` 拒绝，未删除、不绕过。此前 P5.5 的 138 字节夹具与更早 P3 清理待办维持原状态。

独立最终代码审查通过（revision 167），重载竞态修正后无剩余阻断问题。**P6.1 完成、审查并记录**；精确暂存 7 个文件，不提交、不推送。随后才进入范围已确认的 P6.2a 原生摘要 header 保真；provider-aware self 复用和底层再次认证解析分别留待后续小项。

## P6.2a 原生摘要 header 删除标记保真

复用已有真实认证用例，先观察到普通请求正确删除 OpenAI-Project，但 remote compact 重新发送模型配置的 old-model-project，明确失败。根因是两个原生认证 helper 在构造摘要请求前过滤 null；最终 Provider 再合并 model.headers 时缺少删除意图。现将 helper 的 headers 类型保持为已有 ProviderHeaders，原引用返回；删除过滤 helper。compaction 的五个参数签名和 branch summary options 同步贯通 ProviderHeaders，最终传输沿用既有大小写不敏感合并与删除处理。

审计范围为两 auth helper → manual/auto 冻结快照及 session hook → remote/native compaction，以及 compact/generateSummary/turn-prefix/branch-summary → completeSummarization → 已有 stream/最终 headers 合并。业务流程、重试、取消与 Provider 选择不变；不能据此宣称 ModelRuntime.prepareRequest 已停止再次解析认证。自定义 stream 的无认证兼容和原先失败语义保留，provider-aware self 的读取仍待 P6.2b。

本项仅移除每次 helper 的 Object.entries/filter/fromEntries、筛选闭包与重复 header 对象；请求级原有结果对象、endpoint model 副本、manual/auto 的冻结 header/env 副本仍保留。delta/进度/渲染和摘要流事件路径无变动，摘要调用数组及上下文生命周期沿用原 owner；没有新增 cache、池、Promise 或 AbortController。

5 个不同定向检查通过：扩展原有认证用例，覆盖普通请求、remote compact、严格认证 helper、原生 generateSummary 与 generateBranchSummary 的真实合成 wire；保留组织头且旧项目头始终不复活。Codex opaque 回放、手工摘要/分支取消与过期结果不提交、自动压缩取消、既有 AST 分配门禁通过；类型及差异检查通过。新增 CI 测试实例为 0。取消检查实际观察 3 次 transition、Provider 调用 0、旧分支提交 0、待准备数 0、3 个 owner/context 弱引用释放，采样 459,536 字节。

既有手工基准增加 --auth-headers 小分支，32 轮各调用两个真实 helper，删除标记保留 0 → 64，认证查询维持 64；活会话下 192 个结果/model/header 弱引用全释放。采样每轮 8,228.5 → 7,425.25 字节（每轮含两个入口），主要为已有 helper、夹具及 Inspector/WeakRef 开销，不据此宣称普遍提速。基准目录 JAi0R5、VKjujv 均已确认删除。没有新增下载、后台进程或 CI 矩阵，旧审批拒绝清理项保持待办。

独立最终代码审查通过（revision 169），未发现阻断问题。**P6.2a 完成、审查并记录**；精确暂存本项 6 个文件，不提交、不推送。随后才进入已确认范围的 P6.2b：仅 self 策略复用已有快照，非 self 和旧调用继续各自认证，不改变跨 Provider 同意检查或请求形状选择。

## P6.2b provider-aware 的 self 摘要复用已有认证

只在 policy.summaryModel 为 self 且 event.auth 存在时复用快照。provider/id/api 任一不匹配即取消并记录 auth_snapshot_mismatch，不回退认证查询；已提供快照但 key/headers 都不存在时取消，和旧调用完全没有快照的情况区分。匹配后使用快照的有效 model（包含 endpoint）、apiKey、headers、env；允许仅 key 或仅 headers，保留 null 删除标记，不复制、缓存或持久化凭证。

无快照的旧调用及非 self 分支保留独立认证；自定义 fallback 即使配置为相同模型，也不自动复用快照。跨 Provider 同意检查保留，未获同意时不查询摘要服务。两个认证分支汇合后的取消检查保留，查询失败且同时取消仍使用原取消语义。原始前缀/独立摘要的选择、Kimi reserveTokens、DeepSeek 路径、stringHeaders 及默认策略均不改变。旧查询分支尚未采用返回 baseUrl 的已有问题不顺手纳入本项；底层 ModelRuntime 再次解析认证继续单列。

完整链审计为 native manual/auto auth/event → runner session_before_compact → policy/data-boundary → self 快照或 registry 认证 → header 删除标记形状选择 → 原有摘要回调 → 原生取消/提交边界。修改发生在每次压缩的低频 hook；正常 self 分支新增条件与局部引用，移除一次 registry 异步查询，不新增闭包、数组、Promise、AbortController、cache 或对象池。现有请求 shape、上下文转换、工具 schema 和结果对象分配仍存在，未修改流式摘要事件路径。凭证只在调用期间传递，事件/结果持久化不新增认证字段。

新增 1 个合并 CI 用例，复用现有 SDK 夹具并允许替换 compaction 扩展：旧码实测真实 session.compact 查询 2 次失败；修复后只有原生准备的 1 次，self 扩展 0 次。用例先通过真实原生事件验证 header-only、null、有效 endpoint 与 model/headers/env 引用，再检查 standalone、key-only、三字段失配、空认证、已有取消、无快照兼容、查询完成前取消、跨 Provider 拒绝与允许后的独立凭证。摘要生成由本地回调提供，外部请求为 0，不冒充完整第三方摘要 transport 验收。最终 4 项检查通过：该例、已有真实认证/摘要 wire 例、Codex opaque 回放、既有 AST 门禁；类型和差异检查通过。没有重复矩阵或新全量测试入口。

既有手工基准增加 --provider-aware，32 次真实 runner/策略/shape/本地摘要回调。首次旧样本错误地让查询结果不含 null，落入不同 shape，因此不参与性能配对；修正夹具让两侧都走 original-prefix 后，认证查询 32 → 0，model/headers/env 同一引用交付 0 → 32，160 个 auth/model/header/env/result 弱引用在活会话下全部释放。配对采样 14,113.75 → 11,446.25 字节/调用，p95 0.0550 → 0.0579 ms，主要仍为 runner 上下文和原有 hook 分配；不据此宣称整体摘要性能提升。YqUYkd、Y2mBYs、AvrgG1 均已确认清理，无新遗留临时产物。

独立最终代码审查通过（revision 171），未发现阻断问题。**P6.2b 完成、审查并记录**；最终四项复跑及类型检查均通过，精确暂存本项 4 个文件，不提交、不推送。下一项先用实际失败复现并审定原生 SDK 摘要完整认证快照的传递方式；尚不修改 Fast/serviceTier、capability Symbol 或 Provider 装配。P3 真实执行接入继续关闭。

## P6.2c 原生 SDK 摘要消费完整认证快照

范围审查 revision 173 确认采用第四个内部参数 ProviderRequestContext { auth, assertCurrent }，不用 apiKey 的存在代替快照标记，不把认证控制信息放进通用 Provider options。先在没有 remote/provider-aware 接管的真实 SDK 原生摘要中复现：第一次认证为 A，发送前第二次认证为 B；查询 2 次，合成 wire 实际走 /B/responses。16 次真实请求装配基线同时观察到地址、额外 header 和 env 均混入 B，各 16 次。这是当前修复的具体失败证据。

SDK 原 streamFn 原样提为共用局部 streamRequest，普通 Agent 请求继续使用它；新增可选摘要 stream factory 只在 Agent 的 streamFunction 仍为此原函数时启用。ModelRuntime.streamSimple 的第四内部参数带完整认证及有效性检查；prepareRequest 只有明确存在快照才跳过认证，核对 provider/id/api 后使用快照的 model、key、headers、env，不引入第二次查询或旧 options 的认证字段。普通请求及 deferred 的未传快照分支沿用原逻辑；deferred 本项仅做调用链/源码核对，不声称新增完整执行验收。

manual/auto/branch 在认证前捕获原 model、runner、session、原 boundary/generation 和外层 signal，返回后立即验证。每个原生逻辑摘要创建一次内部 request context 与 stream wrapper，多段摘要和既有重试共用；header 转换后和 await prepareRequest 返回后、同步调用具体 provider.streamSimple 前再次校验。headers 使用原合并函数产生每次尝试的可变副本，env 也保留请求副本；来自同一快照的认证值不与 B 混合。原 SDK 请求头转换、归属标记、超时、重试、取消保持。无 factory 的构造者及用户替换的自定义 stream 保留旧路径，不能把自定义 stream 的再次认证算作本项已退役。

独立首轮审查识别了新增 SDK 入口 guard 的重试收尾问题：若重试开始前模型失效，直接抛出会绕过现有 retry_finished。实测该通知为 0，修正为只在 ModelRuntime.lazyStream setup 内处理这项新 guard，使其进入已有错误流和终止逻辑；header 后及最终 dispatch 检查仍在。修复后重试结束通知 1 次，仅首次失败请求派发、后续旧请求 0、摘要提交 0。没有扩大修改通用重试实现。

完整审计链为原生三摘要入口 → auth helper/冻结快照 → 低频 guard/factory → compact/generateSummary/turn-prefix/branch-summary/completeSummarization → retryAssistantCall → SDK streamRequest（manifest、归属头、header hook、超时）→ ModelRuntime.prepareRequest/lazyStream → 原 Provider → 流结果/取消/失败 → 原生释放和提交边界。每个逻辑摘要新增 guard 闭包 1；默认原生传输再新增 wrapper 闭包 1 和内部 context 对象 1，重试不重新创建这三者。branch 额外采用与 manual/auto 一致的冻结外层及按需 headers/env 副本。已有 lazy setup Promise、header transform、请求 body/SDK/client、每尝试 header/env 分配保留；没有增加每 delta/进度/渲染的回调、Promise、AbortController 或完整字符串副本，没有新池或缓存。既有 per-event 转发实现未在本项重构，不将整条 Provider 链宣称为零分配。

8 个不同定向检查最终通过：新增两个合并 CI 例（真实 summary 重试，以及身份失效/custom/auto/branch 入口），复用普通认证与原生摘要 wire、provider-aware self、Codex opaque 回放、manual/tree 取消、auto 取消、AST 分配门禁。新例核对 Provider 的 env 为 A 的独立副本，options 无 auth/assertCurrent，header 转换每次生效且不改冻结快照，历史不写入认证；auth 等待、header 等待、prepare 返回到 dispatch 空隙内换模型均不派发和提交。auto 通过内部摘要入口检查真实 compaction 记录；原自动触发取消用例继续验证触发链。分支通过真实 navigateTree 检查单次认证/请求。auto 测试最初误将返回的“应否继续队列”当成功布尔值，核对源码后改为实际记录验收，仅复跑受影响例。类型与差异检查通过，无新增矩阵或 CI 超时放宽。

既有 AST 用例新增检查 _createSummarizationGuard 返回的回调主体，回调执行内不分配；工厂创建单一闭包仅限逻辑摘要边界。此项对应独立审查 revision 175 的最终收口条件，已通过，不增加测试实例。P6.1–P6.2c 本轮合计新增 4 个 CI 测试实例，其余复用已有检查；未发现需要删除的过期重复矩阵，未为清理数量而移除仍有效的拒绝/生命周期检查。

新增手工 `scripts/bench/native-summary-auth.ts`，不接入 CI。它走真实原生 SDK 摘要、实际 Provider 参数与 HTTP 请求装配，fetch 严格替换为本地合成 SSE。正常 16 次摘要：认证查询 32 → 16，实际请求和 header hook 均维持 16；错误地址/混入 header/env 各 16 → 0。配对采样 406,335 → 400,087 字节/摘要、p95 1.998 → 2.1527 ms，仅作记录，不宣称提速。后续增加取消/HTTP 失败及 wrapper/context 跟踪后，最终正常样本 407,752.5 字节/摘要、p95 2.1943 ms；该扩展观测不与旧夹具计算改善比例。

最终观测包括正常 16、取消 1、HTTP 失败 1：取消派发 0、失败派发 1、二者新摘要提交 0，控制器释放；126 个 auth/model/header/env/requestContext/guard/stream 弱引用在活会话下全部释放，历史无认证字段。8n3dMv、Tz6beS、WUS6SS、TnQ6Qy 均按本次创建身份清理并确认不存在，没有下载包、真实服务或新残留文件。此前自动审批拒绝的空目录及 P5/P3 清理待办仍保留，不冒充已删除。

P6.2c 生产代码独立复核通过（revision 175）；最后约定的回调 AST 检查补齐通过后，独立最终确认通过（revision 176），无剩余阻断问题。**P6.2c 完成、审查并记录**；精确暂存本项 7 个文件，不提交、不推送。后续 Fast/serviceTier、Codex capability 全局 Symbol、Provider 重注册退役、压缩 owner 与显式策略装配尚未完成；下一小项先核对 serviceTier 在普通请求、压缩与连续性状态间的统一传递。P6 不整体收口，P3 真实执行接入保持关闭。9 份用户文档删除与原始补丁维持原状态。

## P6.3a Fast 会话归属与请求 tier 权威来源（完成）

用户授权继续统一 Fast/serviceTier；先与审核对话核定范围（revision 179）。核对生产调用链后确认：Codex 普通请求在全部 payload hooks 后读取最终 tier，路由、成功请求 commitment 及压缩核验已经使用它；压缩实际读取 canonical preview，两个旧 effective-tier helper 无生产调用。故先保留现有实例内会话 Map，移除两份 Fast 全局 Symbol 发布/读取模块及无调用 helper，并修正文档中“Fast override 优先、observed tier 回退”的旧说明。

Fast intent 仅决定是否注入 priority；off 仅停止注入，不删除其他来源设置的 tier。最终 payload 决定请求、路由和压缩连续性，响应 tier 仅参与既有计价规则。配置保存成功后才改当前会话，兄弟会话不互改，shutdown 仅删除所属会话状态。没有扩大 Fast 默认、适用 Provider、费用倍率或 Codex capability 门槛。

沿 SDK onPayload → ExtensionRunner 顺序 hook → Fast/server-compaction → Provider 发送及 canonical preview → native compactor 审查；改动均在请求/会话边界，未增加 delta、渲染或进度回调。新增 1 个合并 CI 实例验证两种注册顺序、priority 普通请求/压缩/路由一致、成功请求后 off 导致派发前拒绝、新普通请求重建边界、后置 flex 覆盖及会话/非 Codex/shutdown 隔离。复用 Codex opaque 回放及 execution-boundary AST；3 个不同目标检查与 npm run check 通过。夹具修正了真实 routing header 名称和 Already compacted 前置条件，未放宽验收。

复用手工 provider-request-preview 基准增加 --fast-mode，不增加 CI 任务。32 次实际 SDK 预览：hook 32、auth identity 32、额外认证查询 0；160 个请求弱引用全部释放；1 个 Fast 状态在 runner 仍存活时 shutdown 后释放。所测生命周期全局 Symbol 总访问 4 → 0。采样 86,772.5 → 89,297.5 字节/预览、p95 0.274 → 0.339 ms（后测与检查并行），不据此宣称加速。无对象池、网络请求或下载。基准 hmqqb9、XPoeb8、lHbrnu 和各契约夹具均按创建身份 finally 清理；原有清理待办未重试。

独立审查 revision 182 通过，无阻断发现。**P6.3a 完成、审查并记录**，精确暂存 11 个文件，不提交/推送。下一项拆为 P6.3b 最终请求 tier 的计价回退，再单独处理 P6.3c 连续性及输入边界；不能删除 previous_response_id 却继续发送 delta，不能重跑 hook 或丢失原地修改。P6 未整体完成，P3 真实执行接入保持关闭。

## P6.3b 最终请求 tier 的计价回退（完成）

审核确认最小范围（revision 183）：direct Responses WebSocket 和原生 HTTP/SSE 在 onPayload 完成后、派发前，各捕获一次最终请求 tier 原始值；响应未报告 tier 时使用该值，响应明确报告时仍优先使用响应值。未调整倍率、Fast 配置、连续性键或输入选择。先复现 hook 设置 priority 后实际已发送 priority、成本估计却仍为默认值的错误。

沿现有 WS request → send/JSON → manager message → 成功终态/计价 → event stream 释放，以及 HTTP native params → retry/stream parser → 完成计价链审查；两条链仅新增请求级 primitive 捕获，未增加 delta closure、Promise、包装对象、全输入副本或池。复用既有测试实例覆盖 WS、WS 的 HTTP 路径及直接 native HTTP 的设置/删除/响应覆盖，包含返回新对象、原地修改、派发后再改可变 payload 的反例。既有 AST 新增检查三个计价 helper 主体，无新增 CI 实例。该用例和 AST、npm run check 均通过。

中途 SSE 仍使用旧逻辑，已定位为 compat 包导出加载旧 dist；只用 tsgo 编译受影响 AI 包后重验通过，未运行联网 generate-models 或全仓构建。原生 SimpleStreamOptions 本身不含 serviceTier，HTTP fallback 通过 payload hook 设置；直接 native stream 用明确存在的 option 验证删除，未用空前置条件代替验证。

新增手工 responses-service-tier 基准，不进入 CI：32 请求、32 hooks、256 deltas 保持不变，错误计价 32 → 0；96 个 payload/stream/result 弱引用全部释放，所属连接监听器归零。采样 206,439 → 190,282.25 字节/请求、p95 0.8125 → 0.8642 ms，仅记录不宣称提速。合成 SSE/Socket 不访问真实服务、不创建文件或下载；按固定所属会话清理连接及 continuation/transport 状态。

独立 P6.3b 专项审阅通过，无阻断问题。**P6.3b 完成、审查并记录**，精确暂存 6 个文件，不提交/推送。P6.3c 采用 revision 189 核定的最小方向：把 tier 与成功 responseId 绑定，最终仍带 prev 的请求在发送前严格核验；不以本地历史拼接服务器前缀，不透明重跑 hook。P3 真实执行接入保持关闭。

## P6.3c 最终请求 tier 与成功连续性证据（完成，限定边界）

先与审核对话确认输入语义（revision 189）。拒绝“本地 prefix + hook 后 delta”的近似恢复：服务器前缀可能包含先前 hook 注入或修改的内容，客户端 context 未必保存；hook 删除 prev 并提交独立输入也不意味着应补回历史。本项采用成功证据与派发前校验，不声称完成透明重放。

WsSession 保留原 options requestKey 作为保守前置筛选，增加两个稳定 primitive 字段：成功 responseId 与最终请求 tier。key 从发送后改为仅在可继续的成功终态与 ID/tier 一起更新。prev 选择使用 owner 保存的成功 ID，避开 manager 在通知响应 listener 前就可能更新 ID 的问题。已知请求省略 tier 由有效成功 ID 与 undefined tier 表示，区别于无成功证据；响应报告的 fast 等值不回写请求基线。

onPayload 后在发送前检查取消及剩余 prev：必须对应本 owner 的成功 ID 且 tier 原值相同，否则明确拒绝。hook 删除 prev 时保留最终输入，不补历史、不重跑 hook。冷连接或 HTTP 介入的未知 continuation 在 hook 前清理；同时清该 WS 的 key/ID/tier/length，防止用较旧的 WS ID 替代 HTTP 状态。清理仅作用于临时 continuation/transport，不删除 remote opaque 状态或持久历史。级别失配后下一次冷请求可按现有完整输入路径建立边界，不会反复复用同一未知状态。

failed completed 帧、无有效 ID 和取消不推进成功边界；既有 content-filter/未知 incomplete 拒绝保留。失败分支保留 response.error.message，其次 incomplete reason/固定说明，避免空错误；未改费用倍率或默认传输。现有取消结果 stopReason=error、事件 reason=aborted 的分类保持原状，本项只验证零派发及不推进证据。

新增 1 个合并 CI 实例覆盖：冷状态清理发生在 hook 前、明确省略 tier 与未知证据的区别、同 tier 单项增量、tier 失配/外国 ID/取消零派发、hook 仅调用一次、失配后恢复、warm WS 被 HTTP 状态替换、失败帧不更新成功 key/ID/tier、真实错误保留、删 prev 后独立输入不被重写。复用 P6.3b 传输用例及既有 AST，新增 guard 主体正常路径无分配；3 个目标检查及最终 npm run check、diff --check 通过。最初冷状态断言证伪旧行为；中途一次 import 位置错误已修正，未降低断言标准。

沿请求串行 owner → shape/input 选择 → hook → guard/send → manager 解析 → 终态/计价/成功证据 → stream/连接释放审查；正常路径仅增加 primitive 比较/赋值，不新增 delta 包装、闭包、Promise 或完整输入复制，不使用对象池。复用 responses-service-tier 手工基准增加 --continuity：32 请求、32 hooks、256 deltas、32 个发送输入项保持不变；采样 45,299.25 → 50,401 字节/请求、p95 0.2077 → 0.1976 ms，仅记录，不宣称优化。关闭所属会话、清理 continuation/transport 并清空基准消息后，96 个弱引用和连接监听器全部释放。无新文件夹、下载或真实服务，未扩大 CI。

独立主体审阅通过，错误信息补充最终复核也通过（revision 196），无阻断问题。**P6.3c 完成、审查并记录**，精确暂存 6 个文件。本轮 P6.3a–c 共新增 2 个合并 CI 实例，5 个不同目标检查，其余复用；没有增加 CI job/超时或重复大矩阵，也未发现应删除的过期检查。已有 30 分钟 job/24 分钟调查阈值不变。Fast/serviceTier 本轮约定范围收口；透明重放、Codex capability Symbol、Provider 注册退役与 owner 装配、P6 最终验收仍待后续小项。P3 真实执行接入保持关闭。9 份用户文档删除和原始补丁未改，先前被自动审批拒绝的清理项继续按原记录保留。

## P6.4a Codex 显式请求能力意图（完成）

审核 revision 201 确认拆分：先显式请求选项，独立审查记录后再迁移 runtime 并退役 Symbol。配置 enabled 意图、模型 remoteCompaction 能力、请求有效开关分开记账；前者不代表服务端已确认。普通请求 StreamOptions → buildBaseOptions → Codex stream 增加 codexRemoteCompaction primitive。过渡期仅 undefined 回退 legacy；显式 false/true 覆盖，不用逻辑或。true 仍要求模型能力与非空、未裁剪的有效缓存会话 ID，保留 none/无 ID/长 ID 的原有禁用边界。false 只关闭自动注入，不删除 caller 显式请求头。SSE、WS 和 fallback 共用一次解析，最终 payload tier 路由及 caller 头优先级不变；preview、compact 的显式调用语义与成功请求一致性校验未改。

沿 simple options → final payload hook → header → SSE/WS/fallback → 成功记录 → compact parity → session cleanup 审查。生产增量只有既有 options 字段及 primitive 判断；新增逐 delta 闭包/Promise/数组/包装对象/完整输入副本均为 0，不使用对象池。既有 AST 加入判断表达式检查。新增 1 个综合 CI 实例，复用原 2 个 compact 和 fallback/header 用例；25/25 header、指定 AST、npm run check 与 diff check 通过。未新增 job 或扩大传输矩阵。审查发现空字符串和长 ID 夹具清理问题，已分别补 gate/反例，并按成功记录实际原始 ID 精确清理，未使用全局清空。

新增手工 codex-capability 基准，不进入 CI，无网络/下载/临时文件：32 请求、32 hooks、256 deltas；错误自动头 16→0，legacy 读取 32→0。另失败与 abort 各 1 次，136 个 payload/options/stream/result 弱引用在所属会话清理后全部释放。采样 174442.5→183567.75 字节/请求、p95 0.6242→0.9156 ms，如实记录短样本波动，不宣称优化；主要采样点为 inspector post、parseSSE、sort。

独立最终复核 revision 210 通过，两个发现均关闭。**P6.4a 完成、审查并记录**；精确暂存 7 个文件，不提交/推送。下一项仅运行时归属及 Symbol 退役；既有扩展配置默认 true 不变，无发布 runtime 默认 false。P6 未整体完成，P3 真实执行接入保持关闭。用户原有 9 份文档删除和原始补丁未改，历史自动审批拒绝的清理待办未重试。

## P6.4b Codex runtime 意图统一与 capability Symbol 退役（完成）

先完成 P6.4a 的审查、记录、精确暂存，再实施本项。沿既有 ExtensionRuntime 保存默认 false 的 primitive，pi.setCodexRemoteCompactionEnabled(boolean) 检查 API/runtime 有效性和参数类型；加载期间明确拒绝，要求 session_start 等加载完成后的调用，避免失败加载污染共享 runtime。invalidate 归零，不新增 ExtensionActions、中转 registry、会话 Map 或 pending 队列。扩展保留 cfg.enabled 默认 true，在 start/tree 发布，before-switch/fork/tree 与 shutdown 撤销；旧 capabilitySessionIds 改 ownedSessionIds，只记录资源清理归属，关闭配置的会话也纳入，避免漏掉已保存的配置等状态。

SDK 从本次 headerRunner 同步捕获一次布尔值，经既有 ModelRuntime options 复制、streamSimple/buildBaseOptions 送至 Codex transport；异步 header hook 改值只影响下一请求。AI 最终要求模型能力、显式 true、非空且未裁剪的缓存 ID。两边 Symbol 常量、发布/读取函数和 AI 导出 setter 均删除，不保留通配或 legacy 回退。省略值最终为 false；调用方显式头规则、preview 无发布副作用、compact 的显式调用及成功请求 parity 不变。底层直接调用方改用 codexRemoteCompaction 请求选项；两份包 README 已记录迁移。扩展在任何 Provider/command/hook 注册前检查新 API，旧宿主仅收到升级提示并停用，不能部分初始化或恢复全局状态。

新增 1 个综合原生 SDK CI 实例：配置启用与无发布默认关闭、类型边界、preview 不派发/不发布、异步前捕获、双 SDK 隔离、tree/reload/switch/fork/关闭、旧 API stale 与无 shutdown 发布者的 invalidate 归零。复用既有 header/fallback/compact、成功 Codex opaque 回放、AST、失败加载、GPT/non-GPT auth 用例。过渡期 legacy 断言已替换为 poisoned-Symbol 禁读写与默认 false，未保留过期回退测试。重载初次失败定位为夹具仅 bindExtensions({})，不满足宿主 reload 的 mode-binding 条件；补实际 onError 绑定后原生 session_start 恢复，未更改生产生命周期。独立审查发现的加载期污染和旧宿主部分注册已分别修正，并复用既有实例覆盖。10 个不同指定检查、npm run check、AI 包 tsgo 编译及 diff check 通过，不跑全仓构建或大矩阵，不联网生成模型。

完整审查链：扩展生命周期 → runtime/runner → SDK streamRequest → ModelRuntime prepareRequest → simple options → payload hook/header → SSE/WS/fallback → 成功记录/compact parity → 请求及 session 清理。每个扩展 API 对象新增一个 setter 方法，runtime 增一个布尔字段；正常请求只有 primitive 捕获、转发及比较，新增逐 delta 闭包、Promise、容器、完整输入字符串物化/复制均为 0，无对象池。保留的 options spread、模型/header 构造、event stream 等既有分配未扩大为新 wrapper。

复用手工 codex-capability 增 --sdk：同机 Node v26.13.0，32 请求/32 hooks/256 deltas；错误自动头 16→0、legacy 读取 32→0，另外失败与 abort 各 1 次。136 个 payload/options/stream/result 弱引用在 SDK session 仍存活、所属 transport 记录清理后全部释放。SDK 基线采样 248586.75 字节/请求、p95 0.8703 ms；初次后测 250671.75/0.7974，补采样位置标识后 247812.25/0.8988。主要位置为既有 event-stream async iterator 和 sort，不据短样本波动宣称提速。基准初次使用不存在的 session.shutdown 已改为现有 shutdown 事件及 dispose；RfgelQ、20AINi、FsDuiG、LJ83T0 四个记录身份的夹具均 finally 清理，集成夹具同样按自身根目录释放。无真实服务、凭证读取、下载或持续日志。

最终独立静态复核 revision 214 通过，无剩余阻断项；审查没有重复执行测试。**P6.4b 完成、审查并记录**，精确暂存 16 个文件，不提交/推送。本轮 P6.4a–b 共新增 2 个综合 CI 实例、复用其余检查，31 个不同指定检查；未增加 job/超时，无需再扩大测试，也未发现应移除的其他过期用例。30 分钟 job/24 分钟调查阈值继续不变。下一候选为 Provider 注册退役及 owner 装配，需另行确认最小范围；P6 最终验收未完成，P3 真实执行接入继续关闭。用户原有 9 份文档删除、原始 patch 和历史自动审批拒绝的清理待办均保持原状。

## P6.5a Provider 注册退役与显式派发装配（完成，限定边界）

2026-10-31，用户授权后与审核对话确认 A 派发/注册退役 → B 状态及 WS owner 迁移顺序。原注册进入 ModelRuntime 实例 extensionProviders，并非全局 API registry；它除了 WS，还承担 HTTP fallback 历史替换、增量裁剪、上下文基线，不能直接删除功能。A 保留既有 transport 与 hooks，只改变装配方式。

ExtensionRuntime 持有不可变派发 token，经加载完成后的 setOpenAIResponsesStream 发布/撤销；token 绑定 API/runtime、执行边界和安装身份，失效不能落到新 owner。SDK 从所属 runner 捕获一次，作为 host-only 参数传给 ModelRuntime.streamSimple。prepareRequest 在 auth/header await 前，随选定 Provider 捕获来源：native 自定义 Provider、匹配 API 的 legacy custom stream 优先，metadata-only 注册继续使用现有有效请求配置。准备完成后仅在选中内置 Responses adapter 时验证 token 并派发，不重新查询认证、跑 header hook 或重建请求。审查发现验证 token 过早会阻挡未使用它的 custom Provider，已收窄分支并补反例。

扩展不再 registerProvider('openai')；start/tree 装配、before-change/shutdown 撤销，runtime.invalidate 清引用。旧宿主缺新 API 时在任何注册前明确停用。未装配的 SDK 保持普通 Provider。兼容变化已写 README/架构：低层 ModelRuntime.stream()/complete() 不再隐式继承扩展 override，走内置或用户选择的 Provider；本项不宣称所有低层入口完全等价。模块共享 state/WS registry/tails 暂保留，不能以派发引用归属替代完整 owner 隔离结论。

新增 1 个综合 CI 实例，覆盖实际 SDK 单次 auth/header、prepared endpoint/header、metadata-only 与两种 custom Provider 优先级/安装顺序、auth 等待期间双向注册变化、选中 token 撤销零派发/未选中 token 不阻挡 custom、无发布者普通路径。复用 direct WS、SSE、成功 API/Codex opaque 回放、tier 连续性、Codex 生命周期、加载失败和 AST，共 8 个不同指定检查通过；npm run check/diff check 通过。两个测试数值控制流推导报错已显式标注 number，未削弱断言。没有扩大 CI job/矩阵或全仓构建。

审查 SDK → ModelRuntime prepare/source/auth/header → runtime dispatch → custom-stream/config → WS/HTTP fallback → payload hook/成功连续性 → event stream/清理。每次发布新增一个 token 与 guard 方法（生命周期边界）；请求源检查和捕获只用 primitive，复用既有准备对象和 lazyStream；新增逐 delta 包装、闭包、Promise、全量输入副本均为 0，不使用对象池。AST 覆盖 source gate、getter、token guard。复用 codex-capability --responses-dispatch 手工基准：32 请求/32 hooks/256 deltas，Provider 注册数 1→0，136 个请求引用在完成、失败、abort 后全部释放；363369.5→369777.75 字节/请求，p95 1.1908→1.2173 ms，仅记录不宣称提速。主要既有 event-stream/OpenAI streaming Promise 分配未扩到新事件层。MvQhlo/rAeaEu 夹具及测试根均按创建身份 finally 清理，无真实服务/下载。

独立最终复核（审核 turn 01a18d71-d6f8-7cc2-bd11-4ce5de1c4233）通过，无剩余阻断项。**P6.5a 完成、审查并记录**，精确暂存 15 个文件，不提交/推送，再进入 B。P3 真实执行接入继续关闭；9 份用户文档删除、原始 patch 与历史清理待办不变。

## P6.5b 状态、直接 Responses 传输与宿主 owner 装配（完成，限定边界）

2026-10-31，A 审查记录后进入 B。审核确认六个退出条件：宿主真实等待、原子绑定同一 owner、同步入队捕获撤销 epoch、revoke/drain 分工、最后写入后清理、同 ID 证明范围不扩大到 AI Codex 全局缓存。

七组缓存迁入 CompactionState；direct Responses 的 WS registry、session tails、pending 集合迁入同一 factory owner，不再有模块共享 Map。每个 runtime 在 start/tree 发布 dispatch 时显式携带同一个 owner，先完成边界注册再发布；不能替换，也不能在再次安装 stream 时省略 owner 绕过身份检查。撤销 dispatch 保留 cleanup owner。SDK 已有 token/boundary 验证后才可恢复 owner，pending/draining 未归零不能恢复，终态 dispose 不能恢复。请求在异步执行前同步登记 pending 和捕获取消信号；容量为每 owner 128 个未完成请求，使用请求级 abort subscriptions 并在 finally 显式释放。

revoke 关闭入场、abort 再关闭连接；drain 等待队列、连接工厂、预热、payload hook、活动 WS 与 HTTP/SSE 真正结算，再清 live state。取消不能转入 SSE。dispose 在触发 abort 回调前发布共享 Promise，最后清空七组状态并禁止晚写重新填充。普通 shutdown、replacement、reload 经宿主 emitSessionShutdownEvent 等待同一个终态操作，10 秒 deadline；错误或超时不报清理成功，保留首个错误，sync invalidate 启动同一清理作为兜底。无 owner 的退出不创建清理定时器。/provider-refresh 等待 live flow 收尾，保留 remote history 与配置。

独立审查发现 model_select 若在 payload hook 内等待 drain，会与当前请求相互等待，记为 P2，未提前宣布完成。修复为模型切换同步 revoke 并启动 owner 持有的 drain，以一个 boolean 标记请求形状需清理，当前 hook 可以返回；所有请求结束后清 live/shape，drain 失败写入粘性失败，后续 resume/dispose 均报告。无需新增异步上下文、全局队列或状态 Map。既有按 session ID 关闭 Codex 连接的行为保留。SDK 反例覆盖 hook 内 await pi.setModel 返回、旧请求零派发、旧 shape/continuation 清空、新请求使用 gpt-5.2。测试同时发现取消事件与最终消息分类不一致，已统一为 aborted 并替换旧的 error 断言。

B 新增 2 个综合 CI 实例：同 ID 两 owner、待连接及排队、hook、预热、活动 WS、SSE、取消重入与监听器释放；真实 AgentSessionRuntime.dispose 等待绑定 owner 并传播失败、身份不可替换/省略。复用 A 的 dispatch 用例加入模型切换反例；原工厂/全局 state 测试迁移为 owner，不保留旧适配器。B 共 13 个不同指定检查通过，含现有 API/Codex opaque 回放、退出首错与替换、AST；本轮 A+B 共新增 3 个综合实例、14 个不同指定检查，未添加 CI job、扩大矩阵或运行全仓构建。npm run check、diff check 通过。测试替身同步补入 owner cleanup 方法；失败测试夹具也在 finally 清理，未删除差异化故障覆盖。30 分钟 job/24 分钟调查阈值不变。

完整调用链核对 SDK/source/auth/header → token/owner admission → queue → config/WS connect/warmup/hook → WS event 或 HTTP fallback → final state → host cleanup。新增分配只在 owner、请求和生命周期边界：请求取消控制、选项包装、pending Promise；逐 delta 新增闭包/对象/Promise/全输入复制均为 0，无池。AST 检查读状态与终态 guard 不分配，并禁止状态及 WS 模块顶层 Map/Set。

复用两个 32 请求手工基准，每个均为 32 hooks/256 deltas；direct 的 96 个引用、SDK 完成/失败/abort 的 136 个引用均释放，direct 监听器/pending/queue/connection/state entries 均为 0，错计价/重复 hook 为 0，SDK Provider 注册为 0。direct 基线 190414 字节/请求、p95 1.1346 ms；加入取消/owner 后测 202304.75/0.9075，终态保护后 204654.5/0.9040，模型重入修复后 202213.25/0.8701。约 6.2% 采样增量对应请求级生命周期成本，不宣称分配优化或短样本提速。SDK A 后测 369777.75/1.2173，B 后测 368515/1.0746，终态保护后 356055.25/1.0787；主要分配仍为既有 event-stream、Promise 等。Mp6A1T、Q6ZD0L 及所有集成夹具根均按创建身份 finally 清理，无真实服务、下载、常驻进程或新日志。

最终独立源码复核 revision 229 / turn 01a18d8d-15e0-7c32-bc7a-4089573266d5 通过，P2 已关闭，无剩余必要阻断；审核未重复跑测试。**P6.5b 完成、审查并记录**，精确暂存 16 个文件，不提交/推送。同 ID 隔离结论仅涵盖本包状态及 direct Responses 传输；AI Codex WS 缓存及 successful commitments 仍按 session ID，不计为已完成。P6 整体验收未收口，P3 真实执行接入保持关闭。9 份用户文档删除、原始 patch、历史自动审批拒绝的清理待办均保持原状。

## P6.6a AI Codex 传输与成功请求 owner（完成，宿主接线待 B）

2026-10-31，用户授权后审核 revision 231 确认 A：AI 层 owner 与生命周期 → B：宿主普通请求/压缩/清理完整接线。保留独立 legacyDefaultOwner，以免无 owner 的低层调用失去连接复用、continuation、SSE fallback 记忆和后续 compaction 成功凭据；这是明确共享兼容域，不宣称同 ID 隔离。旧导出与全局 session cleanup 只指向 legacy，显式 owner 从不注册到裸 ID 广播。

五组缓存、成功/已消费记录、所有 socket、pending 移入 CodexTransportOwner；所有有状态 helper 显式携带 owner。普通 stream 与 compact 在首次异步执行前登记请求，合并 owner/caller 取消并最终释放订阅；缓存忙时的临时连接、未入缓存的连接及无 ID 请求均纳管。revoke 关闭入场并 abort/close，drain 等真实操作完成后清状态；dispose 先发布共享 Promise 再触发 abort，终态不能恢复，reset 不等待包含自身的 hook。迟到 connect 不插入缓存，旧租约不重建 timer，撤销后不记 fallback/debug/commitment，compaction finally 只消费它捕获的同一条记录，不能删除并发新请求的记录。pending/debug/异步解码各限 128，原连接容量、TTL 和 16 条 commitment 限额保留。构造器等无会话内容的缓存不迁移。

审查发现并修复两类 P2：onResponse 取消/抛错前尚未读取的 SSE body 必须显式等待取消；已启动的 Blob-like 解码必须纳入 drain。普通请求及 SSE compaction 共用取消 helper，先观察 reader.closed 再 await reader.cancel，区分已 errored 的正常 fetch 取消与底层 cancel 真正失败，finally 释放锁，后者仍为粘性 cleanup failure。WS 文本/ArrayBuffer 同步解码；异步 Blob 每个 idle-to-busy 周期只持有一个 deferred，finally 标记 closed、移除监听器、清 queue，再等待所有已启动解码。迟到结果不再 parse/写队列，不用逻辑清零冒充真正结束。

新增 2 个综合 CI 实例，覆盖同 ID/account/model 的双 owner、legacy 全量清理双向隔离、fallback/debug/compaction、等待 hook/连接、忙缓存临时连接/无 ID、WS compaction 的迟到解码、SSE body 的取消结算、已 errored body 与真实 cancel 失败、新请求不被旧 compaction 消费。复用既有 WS header 复用、WS/SSE compaction parity、effective dispatch 和 AST，合计 8 个不同定向检查；npm run check/diff check 通过，仅重建受影响 AI 包供集成使用，无全仓构建或 CI 扩容。没有可继续保留的旧全局状态测试副本；兼容入口测试仍有独立价值。

审计入口 → payload hook → connect/lease/headers → WS/SSE parser → success commitment/compact parity → lease/timer/body/decode → drain/dispose。请求级增加 owner admission/取消和 pending；普通文本 delta 新增 closure/Promise/options wrapper 为 0，移除了原逐 message async decode IIFE，binary beginDecodeCycle 是明确的 idle-to-busy 例外，AST 覆盖稳定 callbacks 及 owner guards。无对象池或全输入复制。复用 codex-capability 32 请求手工基准：SDK 基线 243530.5 字节/请求、p95 2.5751 ms，owner 提取后 247886/1.0663；显式 SSE owner 176260.5/0.6506。针对解码修复增加同一脚本的 WS 模式，修复前 202017.5/0.7999，后 197961.25/0.6518。每组32 hooks/256 deltas，136个完成/失败/abort引用全部释放；显式 owner 的 pending/socket/cache/timer/commitment/consumed/debug/fallback 与 WS listener 均为0。不同模式不横向宣称优化，短样本只记录；主要既有分配为 event-stream Promise 与 sort。96q6aj、4tB9F0 基准夹具均 finally 删除，新 AI 用例无磁盘夹具/真实服务。

最终独立源码审查 revision 235 / turn 01a18db0-e7b1-7223-a748-979c0943f3f5 通过，三个报告的 P2（含 body 已 errored 的误判修正）均关闭，审核未重复测试。**P6.6a 完成、审查并记录**，精确暂存 6 个文件，不提交/推送，再进入 B。当前宿主仍待迁出 legacy 域，不提前宣布 SDK 同 ID 隔离；P3 真实执行接入保持关闭。

## P6.6b 宿主 Codex owner 装配与生命周期统一（完成）

2026-10-31，在 A 审查记录后，审核 revision 236 确认最小 B 范围。每个原生 extension runtime 在无扩展时也创建 Codex owner，并注册到 execution boundary；SDK 普通请求、原生摘要与 native compaction 都使用该实例。内建 Provider 来源在请求准备时与 Provider 一起捕获，只有实际选中内建 Codex 才验证 binding，自定义 Provider 保持优先。宿主及 server-compaction 的裸 session ID 全局 cleanup/close 已移除；低层 legacy API、通用 cleanup registry 保留，宿主 dispose 不影响同 ID legacy 调用。

每次逻辑 revoke 都增加 generation，即使此前已关闭；resume(expectedGeneration) 在 accepting 提前返回前核对。普通请求在 auth/header 前捕获 owner/代数，compaction 在最早的 auth await 前捕获并复查 model/session/runner/boundary，SDK header 返回后继续核对同一 binding/代数。自查补齐原生摘要更早的 auth 窗口：SDK 仅在原始 stream 和内建 Codex 下返回稳定 binding，现有 summary guard 在 auth 前保存 owner/代数，手工、自动、分支摘要及其重试共用；自定义 Agent stream 和自定义 Provider 不受未使用 owner 的限制。

模型切换同步 reset，不等待触发它的 payload hook；树导航在摘要后、分支修改前定向 revoke/drain，并重新检查原 model/session/runner、执行边界、owner 代数和取消。provider-refresh 在 idle 后仅等待当前 runtime 的 Codex 与 direct Responses owner，保留本地历史与持久 remote/config 状态。统一 disposeProviderOwners 先发布共享 operation，再同步撤销两者；即使一方抛错仍启动两份真实 dispose，通过 allSettled 汇合、保留首错并共享 10 秒 deadline。shutdown/reload 等待此操作，invalidate 复用它；没有增加后台线程、周期扫描或全局实例登记。

B 新增 2 个综合 CI 实例：无扩展同 ID 双 runtime 的成功记录/模型 reset/销毁/压缩、legacy cleanup 双向隔离；普通/compact/summary 的 auth/header 等待中 owner-only reset、重复 revoke、header 等待跨真实 boundary transition、custom Provider 与 custom Agent 摘要正对照、模型 hook 重入。已有退出用例增加真实 Codex payload hook：Responses dispose 成功或失败后 shutdown 仍须等待 Codex hook 归还；最终 pending/socket/cache/timer/commitment/consumed/debug/fallback 均为 0。复用 capability/reload、Codex opaque compaction、refresh/tree/model、初始化回滚、alpha 并发/首错、TUI 替换与旧 host 兼容门禁等检查，连同 AST 合计 15 个不同定向检查通过；npm run check 和 diff check 通过。新增夹具测试最初的 signal/type 与局部 token 遮蔽已修正，仅复跑受影响检查，不扩大矩阵。旧裸全局入口测试仍验证兼容域，不能作为过期测试删除；改名替身直接更新原例，不保留双份覆盖。A+B 共增加 4 个综合实例，没有新增 CI job、全仓构建、超时放宽，30 分钟 job/24 分钟调查阈值保持原约束。

完整审计 SDK source/auth/header → captured binding/generation → ModelRuntime lazy stream → A 的 admission/connect/parser/success commitment → summary/compact → model/tree/refresh/shutdown/reload/invalidate。新增 owner 与 cleanup 数组/Promise 只在 runtime/退出边界；summary 复用既有一次逻辑请求 guard 闭包。逐 delta 新增 closure/Promise/AbortController/wrapper/array/全输入复制均为 0，无对象池；AST 覆盖 source gates、两个 binding guards、getter 和 summary guard。复用 32 请求 SDK 分配基准（Node v26.13.0）：A 基线 247886 字节/请求、p95 1.0663 ms，B 236815.75/0.8149；短样本不宣称提速，主要分配仍为既有 event-stream、parseSSE 与 sort。32 requests/32 hooks/256 deltas，错 header/旧 Symbol 读取/Provider 注册均为 0；完成、失败、abort 的 136 个跟踪引用全释放，宿主 owner 八计数和监听器为 0。Sw0X2w 基准根以及本轮集成夹具均按创建身份 finally 删除，无真实服务调用或新下载/进程/日志。

最终独立源码审查 revision 240 / turn 01a18dc3-54b9-7f20-81ba-c508a6db1ddb 通过，无必要阻断；审核只读，未重复执行测试。其结论所待的增强退出用例已通过，最终类型/差异检查也已补齐。**P6.6b 完成、审查并记录**，精确暂存 17 个文件，不提交/推送。本轮 AI Codex 传输缓存与成功请求状态 owner 统一范围收口，P6 整体验收仍待后续；P3 真实执行接入保持关闭。9 份用户文档删除、原始 patch 和历史自动审批拒绝的清理待办保持原状。

## P6 剩余契约复核与 P6.7a 唯一压缩策略选择（完成）

2026-10-31，用户继续授权核对 P6 剩余项。独立范围审查 revision 246/247 确认：认证快照、Fast/serviceTier、capability Symbol、Provider 注册退役和两个传输 owner 的已完成契约直接复用。剩余顺序为 P6.7a 唯一策略预选 → P6.7b 特定规则显式配置 → 连续性拒绝/恢复边界界定 → 实际装配验收。透明重放不是原始 P6 已明确承诺的自动恢复功能；证据不足时拒绝派发不能直接算作缺陷，也不为绕过拒绝缓存完整请求历史。P3 真实执行接入继续关闭。

具体冲突仅在配置重叠时成立：server-compaction 和 provider-aware 原来都注册 session_before_compact，runner 遇首个 compaction/cancel 即返回；显式 targetProvider=openai 可让两者同时命中。旧码以真实宿主/两个包复现：应拒绝冲突却成功压缩。三条默认模型规则不与 OpenAI 路径重叠，未声称默认配置必然失败。

新增加载期 registerCompactionStrategy({id, prepare})。runtime 最多保存 16 个独立注册记录，拒绝重复 ID、保存稳定 id/prepare/path，factory 失败按身份回滚，invalidate 清空。prepare 同步只读配置/模型并返回固定本次参数的执行闭包；不得查询认证、预览请求或外发。hasHandlers 纳入新入口，manual/auto 均进入。宿主先处理 legacy hooks 的明确兼容优先，再对原生候选统一预选：零命中原生摘要，单命中只执行一次，多命中明确冲突且候选执行数为 0。选择/执行异常直接传播，cancel 终结；仅 undefined 表示明确请求原生回退，非法空结果不能静默回退。

进入异步 legacy hook 前捕获 model/执行代数；预选前、每个 prepare 后、执行前及执行后复查原身份和取消。违规异步 prepare 由已有 actualHooks/hook deferred 跟踪到实际结束，错误有观察者，drain 不会提前完成。两个包现代宿主只注册新入口，旧宿主 feature detection 保留原 hook；匹配闭包固定配置与模型，执行体保留各自认证、数据边界和非 GPT 原生回退语义。没有新传输 owner、全局策略注册或后台任务。

兼容范围明确：legacy hook 的取消/自定义结果先终结调用，是新约定的优先级，不等于原历史相对顺序完全不变；其自身仍可能有副作用。零候选外发不代表宿主活动模型认证查询为零，也不代表此前第三方 hook 没执行。未宣称所有第三方扩展消除顺序依赖，策略启用不授予跨 Provider 权限。

新增 2 个综合 CI 实例，复用真实 SDK 夹具：两个包交换顺序后的 manual/auto 重叠拒绝，候选摘要/边界查询为 0、宿主认证每次 1；单命中一次、跨 Provider 未授权取消、native-only 入口、固定配置不被后续选择器改写、legacy 接管/等待中模型失效、prepare/执行异常和非法返回不降级、违规 async 的真实 drain、reload 清注册。原 self auth 检查迁至新注册捕获，原初始化回滚检查追加策略回滚/重复 ID，保留旧宿主覆盖。连同既有 Codex opaque/capability/认证与摘要竞态/旧 host 和 AST，共 10 个不同定向检查通过；npm run check/diff check 通过。无全仓测试、CI 扩容或超时放宽，也没有可删除的过期副本测试。

审计 manual/auto 认证与 preparation → legacy hooks → native registry/prepare → 唯一 handler/owned hook → 两包已有摘要/remote 请求 → 宿主取消/提交 → reload/invalidate/drain。注册 Map 只在 runtime 创建，最多 16 项，invalidate 释放；准备闭包只在每次命中压缩时创建，选择器与执行函数复用现有 hook 生命周期 deferred。逐 delta 新增 closure/Promise/AbortController/wrapper/array/完整输入复制均为 0，无对象池；AST 覆盖 hasHandlers 和原身份检查。沿用 32 次 provider-aware 手工分配基准：基线 10736 字节/次、p95 .0682 ms，首后测 12870/.0510，执行后校验及完整释放探针后的最终样本 15092/.0569。新增成本属于低频选择/生命周期和测量探针，样本存在抖动，不宣称分配优化或提速。32 hooks/32 同一认证引用/0额外查询；正常、摘要失败、前置 abort、冲突、违规 async 后，177 个认证/结果引用、36 个准备闭包和 1 个非法 Promise 均释放，dispose 注册为 0。olPLli、1U0rRu、0CaqXl 及集成夹具均按创建身份 finally 清理，无下载、真实服务或常驻进程。

独立最终源码审查 turn 01a18ddb-8abc-7811-8b09-cc5f23e11b46 通过，无阻断；审核未重复测试。**P6.7a 完成、审查并记录**，精确暂存 14 个文件，不提交/推送，再进入 P6.7b 范围确认。P6 整体尚未完成，P3 保持关闭；原有 9 份文档删除、原始 patch 和历史受阻清理待办维持原状。

## P6.7b 特定 Provider 规则显式配置（完成）

2026-10-31，A 完成记录后，独立范围审查 revision 252 确认本项仅处理 provider-aware 三条 preset。新增 policies 数组：claude-deepseek-fallback-v1、deepseek-self-preserve-v1、kimi-self-preserve-32k-v1，默认均不启用；保留原模型映射与执行算法。全局 provider-aware-compaction.json 复用 getConfigDir()，受信项目同名文件的 policies 覆盖全局；字段缺失继承，[] 明确关闭。不受信项目文件不读取。仅缺文件是正常缺省；坏 JSON、非对象、非数组、未知/重复 ID、超出三项或读取失败明确报错，绝不回退旧硬编码规则。

优先级固定为 master FALLBACK=0 → 显式 targetProvider → options.policies → 受信项目 → 全局 → 无 preset。单独提供 fallbackModel 或 FALLBACK=1 不启用规则。factory options 转成数值快照，文件在每次 prepare 中解析一次并固定选择；没有文件监听、缓存或新的策略 owner。策略启用与 allowCrossProviderSummary 独立，项目/进程授权仍按原入口检查，全局同名授权字段不授予项目许可。旧宿主的新增配置错误转为明确 cancel+诊断，以免旧 hook runner 吞异常后进入原生摘要。README 已同步默认关闭、显式启用示例、优先级与旧宿主限制；没有写入或自动迁移用户配置。

独立审查发现并修复一处 P2：最初在返回的 extension factory 中读取 options.policies，虽然已加载实例的选择是 bitmask，存活 factory 仍持有 caller options/数组。受控 GC 实测旧码保留 2 个引用；现于 factory 创建时解析成 primitive mask，返回闭包不再读取 options，非法配置也仅保存固定诊断字符串，加载时按 master 开关再创建错误。factory 存活且已加载后两个输入引用均释放；这一门禁加入原手工基准，没有增加 CI 实例。

仅新增 1 个配置组合 CI 实例：缺省/permission-only/master1/fallback-only不启用、三条显式 preset、继承/覆盖/[]、全部非法配置与读失败、不受信项目、调用方数组后续变更、prepare 后文件变更、启用 Claude 但无项目许可仍取消、原进程显式许可、旧宿主配置错误取消。复用 A 两真实包冲突与 self 认证用例，并更新后者为显式 Kimi preset；连同 AST 共 4 个不同定向检查通过。npm run check/diff check 通过；没有追加全仓测试、组合矩阵或新 CI job，A+B 本轮合计只新增 3 个综合实例，无可清理的过期测试副本。

审计 config/选项 → prepare bitmask/匹配闭包 → A 统一选择 → 原认证与数据边界 → 原摘要/结果 → 宿主生命周期。新增 IO/JSON 解析仅在压缩 prepare；每次最多两个配置文件、三个 policy id，解析对象/字符串不缓存，只有 primitive mask 进入选中闭包；逐 delta 新增 closure/Promise/AbortController/wrapper/array/完整内容复制为 0，无对象池。相同 32 次手工基准：显式 options 14227.5 字节/次、p95 .0599 ms；文件来源模式 30421.25/.4573，主要 path.join/readFileSync/既有 context，来源不同不横向宣称优化。引用修复后 options 样本 15543.25/.1036，记录短样本抖动，不据此声称提速。各模式32 hooks/32同一认证引用/0额外查询；177认证/结果引用、36准备闭包、1非法Promise均释放，退出注册0；最终 options 模式另验证2个factory输入引用全释放。1ZeK5v、Xw4rKB、rQUIw8及配置组合夹具均按创建身份 finally 清理，无真实服务、下载或新常驻任务。

独立最终源码审查 revision 256 / turn 01a18de9-2e06-7163-b462-7fa99d610e7f 通过，P2 已关闭，最终增量类型/配置检查与引用门禁通过。**P6.7b 完成、审查并记录**，精确暂存 7 个文件，不提交/推送；P3 真实执行接入保持关闭，原有用户删除和原始 patch 不动。

P6 剩余范围经独立只读复核 revision 257 / turn 01a18deb-5672-7d42-b158-5b62baa97cb2 确认，按以下顺序推进；本次未修改或测试这些后续路径：

1. **补充摘要认证保真。** server 的 portableSummaryModel 当前只查同 Provider，默认 current，不能扩大成跨 Provider 外发问题。源码可确认当前模型路径未使用有效 auth.model/env，另选同 Provider 模型时仅取新认证 key/headers，未应用 baseUrl/env；实际请求影响仍需显式 portableSummaryMode=always 的离线复现。最小验收是当前模型复用已有认证、额外查询为 0；有效地址、nullable headers、env 完整到达请求；另选模型只解析一次对应认证，不可用时完整回到活动快照，不混用字段。
2. **补充摘要派发与普通请求状态隔离。** 首次 portable 请求走 compat.complete，模型摘要回退的 compact 未传 SDK stream；简单替换为现有 SDK stream 不等于接入全部请求 hook/Fast。需明确摘要 tier、Provider/自定义入口和 hook 契约，且不能覆盖或消费普通请求 commitment、previous response ID、成功 tier 和上下文基线。关键正对照为普通请求成功 → portable 摘要 → 原生远端压缩 → 下一次普通请求，分别检查 Codex commitment 和 direct Responses continuation。取消、模型切换、reload、shutdown 应阻止失效派发并等待实际结束；复用少量组合用例覆盖首次失败回退、认证/header 等待中失效与退出释放，保留 header 删除标记限制和自定义指令失败语义。新增状态时补相应计数、引用释放及分配证据；具体隔离方式待复现固定后选择，另造 session ID 本身不证明生命周期正确。
3. **连续性契约与实际装配验收。** 透明自动恢复不属于本轮保证，可按已有证据不足时派发前拒绝收口；hook 明确删除 previous ID 后尊重独立输入，不拼接未经证明的本地前缀或重复执行 hook 来近似恢复。最终从真实资源加载入口核对三包装配、启停、两种顺序、显式 preset、旧 hook 优先、原生回退及 portable 可选路径；复用既有局部证据，不铺开大矩阵。

P6.7a/b 保持已完成范围，以上缺口解决并验收前不宣布 P6 整体完成。P3 真实执行接入保持关闭。

## P6.8a 可选补充摘要完整认证传递（完成）

2026-10-31，按用户本轮授权，独立范围审查 revision 260 / turn 01a18df6-b6a3-71b3-840e-768f0545df5a 确认：仅补齐 portable 摘要的有效 model、apiKey、nullable headers、env，不接 SDK owner/Fast，不改变连续性状态、模型选择政策或摘要失败语义。保留同 Provider、文本能力及容量检查；区分候选认证不可用时回到活动模型，与 portable 请求失败后仍用所选模型进入 compact 算法回退。

先用真实 SDK 夹具、显式 portableSummaryMode=always 和本地合成 SSE 复现：活动认证的有效地址为 /effective-active，首次 portable 实际仍用模型目录 /v1。修复前 16 次手工采样亦记录 wrongEndpoints=16、mixedEnv=16，nullable header 已能正确传递；没有将地址/env 缺口扩大为跨 Provider 泄漏。

生产改动仅 index.ts 与 remote-compaction.ts：localSummaryInput 直接保留已验证 apiKey 的完整活动 auth；current 不重复查询或组装字段。另选模型成功解析认证一次后，创建完整候选快照并应用其 baseUrl；失败或无 key 保留原活动快照。候选未提供 headers/env 时保持 undefined，未覆盖 baseUrl 时使用候选目录地址，不继承活动字段。generatePortableSummary 向 complete 的现有 options 传 env；generateBestEffortLocalSummary 向 compact 的既有第九参数传同一 env，第八 stream 参数仍为空，没有顺带新增 sessionId 路由。nullable header 的旧回退限制、取消、自定义指令禁止原始历史应急摘要均保留。README 已说明完成范围与仍待接线部分。

仅新增 1 个综合 CI 实例，复用现有 SDK 夹具：current、显式候选、候选 sparse 字段、候选认证缺失/异常、首次 portable 失败后的 compact 回退，以及 nullable header + 自定义指令/取消边界；观察实际适配器 model/options 和本地出站 URL/headers，并核对认证次数。复用原 native auth 重试、GPT remote/summary 失败、非 GPT 回退和 AST，共 6 个不同定向检查通过；tsgo --noEmit 与 diff check 通过。未运行全仓测试、增设 CI job、放宽超时或增加参数矩阵，无可删除的过期测试副本。

完整审计宿主 _compact/_getSummarizationRequestAuth → 冻结活动认证 → 策略预选/executeCompaction → generateConfiguredLocalSummary/ModelRegistry → generateBestEffortLocalSummary → portable context/compat.complete/实际适配器，以及 compact → generateSummaryWithUsage/completeSummarization/completeSimple 的回退链；再核对取消、错误、结果提交和宿主退出。current 减少一个原有认证裁剪对象；仅候选认证成功的低频边界新增一个快照对象，有地址覆盖时复制一次 model。headers/env 按选定快照传递，不新增缓存、监听器、后台任务或对象池。逐 delta 新增 closure/Promise/AbortController/wrapper/array/完整内容复制均为 0；既有上下文数组、序列化、token 计算和传输分配未改动。

复用 scripts/bench/native-summary-auth.ts 增加 --portable 手工模式，固定 16 摘要/16 活动认证/16 portable + 16 remote 请求，未新增认证查询；正常 wrongEndpoints/mixedHeaders/mixedEnv 均为 0。该兼容路径 headerHooks=0，与尚未完成宿主接线的边界一致，不宣称已走统一 header/Fast hook。前置取消派发 0，受控失败派发 1，失败/取消不新增提交；采样外两个候选成功/失败探针各仅查询一次候选认证。活动快照、候选解析结果/有效模型/options 等 110 个跟踪引用，在会话仍存活时经受控 GC 全释放，随后实际宿主 dispose 与夹具清理完成。

Node v26.13.0 同机短样本：旧码 1,255,212.5 字节/摘要、p95 10.9229 ms；首次修后 1,277,130.5/10.8895；补齐候选释放探针后的最终 1,243,972/11.5884。主要分配仍在既有迭代、编码、join、token 编码和远端请求装配；不据短样本声称分配优化或提速。aT8i7D、3vMXuv、hJohzu、PG1iuw 基准目录与综合用例夹具均按创建身份 finally 清理，四个记录目录复查不存在，无真实服务调用、下载或新常驻进程。

独立最终源码审查 revision 264 / turn 01a18dfd-9552-7332-9d7b-d537051d875b 通过，无新增阻断；审核只读，未重复测试。**P6.8a 完成、审查并记录**，精确暂存本项 6 个文件，不提交/推送。下一项仍是补充摘要宿主派发、Fast 契约及与普通请求的状态隔离，之后才做连续性契约与真实装配验收；P6 整体未完成，P3 真实执行接入保持关闭。原有 9 份文档删除、原始 patch 和历史受阻清理待办维持原状。

## P6.8b1 补充摘要宿主管理范围（完成）

2026-10-31，独立范围审查 revision 269 / turn 01a18e13-b45d-70a1-8b52-2b9e92133e3e 确认拆为 A 宿主管理范围、B 实际接线与 Fast/状态隔离；A 审查记录后才进入 B。本节仅记录 A。P3 真实执行接入保持关闭。

新增可选 withSupplementalSummary callback API；在候选认证查询前捕获活动模型、runner、session、执行边界和派发来源。范围只允许一个未结束请求，合并范围/单请求取消信号，通过既有 ModelRuntime.prepareRequest 复用完整认证、请求头归属、超时与重试设置。headers/payload hook 增加 supplemental-summary purpose，ctx.model 指向所选摘要模型，等待前后校验有效性，hook 错误不能被应急摘要吞掉。没有接入普通请求的 prefix/tool-budget/response 观察写入。

原生 Codex 复用原 owner，强制 cacheRetention=none、SSE、remote intent=false；direct Responses 绕过普通 continuation dispatch，server payload hook 不注入普通历史。匹配的自定义 Provider 和 Agent stream 保持入口；只有实际选择原生 Codex 时检查其 captured generation。范围退出不重置、revoke、dispose 或 drain 共享 owner。

范围取消并等待自身宿主可见迭代器退出；lazyStream 增加可选一次请求 settled 通知，覆盖 setup、转发、尾部收尾和错误处理。终止事件不等于 iterator return；done 后抛错、callback 吞错或提前返回也不得提交成功。普通调用未传 observer，原协议不变。shutdown/reload 同时等待执行边界与 Provider owners；旧 preview/reload 测试改为先释放旧 hook 再等待新 runtime 发布，避免循环等待。

新增仅 2 个组合 CI 实例，复用现有离线 SDK 夹具；覆盖 Codex/direct 状态不变、选定模型 hook、请求取消、hook 错误、活动模型切换、无关 Codex reset、并发请求拒绝、逃逸入口关闭、done 后尾部等待/错误、callback 提前返回及真实 shutdown join。连同既有 preview/reload、SDK shutdown、2 个 owner mock、真实 quit/会话替换、AST 共 9 个不同定向检查通过。修正陈旧 alpha fixture 缺少原生能力声明及合成认证的问题，无生产权限/超时放宽。tsgo --noEmit、AI 包本地最小编译与 diff check 通过；未新增依赖、CI job、全仓测试或参数矩阵。

完整审计 API/AgentSession → preparation → SupplementalSummaryScope → ModelRuntime.prepareRequest/selected provider → lazyStream/事件流 → request settle → scope join/引用释放及 shutdown/reload。新增对象与闭包限于低频范围/请求/退出边界；每个范围一个 controller，每次请求最多一个 pending deferred，仅完成时通知一次，无逐 delta observer。逐 delta 新增 closure/Promise/AbortController/wrapper/array/全量复制均为 0；原有事件队列和编码分配不在本项重写，不引入对象池。

复用 native-summary-auth 手工基准 --host-scope：16 摘要/16 认证/16 请求/16 header hook，错误地址、混合 headers/env、失效提交均为 0；前置取消 0 派发，受控失败 1 派发。162 个 scope/dependencies/stream/auth/options 引用在会话存活时受控 GC 全释放。最终 Node v26.13.0 样本 379589 B/摘要、p95 2.2192ms；主要分配仍在既有 OpenAI 编码、headers 和 hook context。此模式没有 remote 请求，不能与旧 portable 的 32 请求样本作提速比较。中间迭代只因修复后再次验证；最终无需重复全量测试。

本轮 IjBJPg、31iv2E、xsunnu、sCitJV、zw9EFj、j8l3Ee 基准目录均 finally 按身份清理；失败的会话替换夹具 g2s-session-RJ4xGN 核实仅空 agent 目录后按精确路径非递归删除，其余夹具自行清理。没有真实网络调用、下载或新增常驻进程。

独立最终审查 revision 278 / turn 01a18e31-29b3-7320-92c4-5b569831e70e 通过，无剩余阻断，审核只读且未重复运行测试。P6.8b1 完成、审查并记录，精确暂存本项文件，不提交或推送。下一小项 B 才将真实 portable/compact 回退接入该范围，验收 Fast 与普通请求→摘要→原生远端压缩→下一普通请求；P6 整体仍未完成。原有 9 份文档删除、原始 patch、历史受阻清理待办保留。

## P6.8b2 实际补充摘要接线、Fast 与普通请求隔离（完成）

2026-10-31，在 A 通过独立审查并记录、暂存后执行同一已确认范围中的 B。generateConfiguredLocalSummary 的四个调用入口均经可选宿主 withSupplementalSummary，在候选认证查询前捕获范围；所选完整认证随 streamFn 传至首次 portable 请求和 compact 第八参数，env 第九参数不变。无该 API 的旧宿主保留兼容入口及原有保证范围。portable error/aborted 即使有部分文本也不算有效摘要；nullable header 回退限制、取消、自定义指令失败和非 GPT 既有策略回退保持原义。

实际摘要经过选定模型的 headers/payload hook，因此 Codex Fast 生效，后续 hook 可改写摘要自己的 service_tier。普通 canonical preview 先于摘要生成，远端压缩沿用普通请求的最终 tier；摘要不覆盖或消费其成功 commitment、previous response ID、直接 Responses continuation、prefix 和工具预算状态。复用已有 owner 和正常 Provider/custom 选择，不新增摘要 transport owner、缓存或全局状态。非 GPT 并行分支在 remote 返回后观察到取消时，先 join 已启动的 localResultPromise，再报告退出。

新增仅 2 个组合 CI 实例：Codex/direct 各一次真实 SDK 普通请求→选定摘要模型→原生远端压缩→下一普通请求，观察摘要 hook 先取得 Fast priority（direct 不自动附加），再独立改为 flex；普通/远端/下一普通仍保持原 tier，摘要结束前后核对普通状态引用及 owner diagnostics。另一实例覆盖候选认证等候中切模型、摘要 header 等候中 reload、非 GPT 并行取消；后者双 gate 固定为 remote 已派发未返回→取消→放行 remote→摘要仍等待→放行摘要，验证压缩不提前完成，无额外摘要请求或成功提交。

原 P6.8a 完整认证及算法回退综合实例迁移到实际 native Provider 观测，替代旧 compat 截获；加入有部分文本的失败结果，仍应进入回退。连同既有 native auth 重试、Fast/最终 tier、GPT remote/summary 失败、非 GPT 回退与 AST，本小项共 9 个不同定向检查通过；最后的双 gate 用例及 tsgo --noEmit/diff check 均通过。未运行全仓测试、增加 CI job、提高超时或保留重复旧测试。A/B 合计新增 4 个短组合实例，手工采样仍复用同一脚本，不纳入 CI。

完整复核 A 的宿主范围、候选认证、配置模型选择、portable context/结果判断、compact 原生摘要回退、Provider/传输转发、Fast 与 server payload hook、普通 commitment/continuation、远端压缩、取消及结果提交链。B 仅在低频摘要入口增加一个 scope callback；普通逐 delta 路径新增 closure/Promise/AbortController/wrapper/array/完整内容复制均为 0，无对象池。已有序列化、token 编码、消息转换及 hooks 的请求级分配保持显式可观察。

同机 Node v26.13.0 的 --portable 手工采样固定 16 轮：16 活动认证、16 summary + 16 remote 请求、16 header hook，错误地址/混合 headers/env/失效提交均为 0；前置取消 0 派发，受控失败 1 派发；采样外候选成功/失败各一次认证。209 个范围、认证、请求、选定模型与 options 引用在会话仍存活时受控 GC 全释放。旧接线样本 1260377.5 B/摘要、p95 11.2695ms；新接线 1359894.5 B/摘要、p95 12.0778ms，增加了宿主 scope 与 16 次真实 hook 管理，不声称性能提升。主要分配仍为既有迭代、编码、join、slice 和 token 编码；无新逐事件分配或请求缓存残留。

7ZsZFh 基准目录已 finally 删除并复查不存在；本项 Fast 配置、SDK 组合测试目录均按 mkdtemp 创建身份 finally 清理，双 gate 与 fetch/env 替换均在 finally 释放/还原。未下载、发起真实服务请求或创建后台常驻进程。README 说明现代/旧宿主的边界、摘要 tier 与普通 tier 的区分，并修正旧的 GPT 并行与 prompt-cache 复用表述。

独立最终审查 revision 282 / turn 01a18e36-a0cd-7c22-a2f0-a15e2bd30704 通过，无剩余阻断；审核只读且未重复执行测试。P6.8b2 完成、审查并记录，精确暂存 6 个本项文件，不提交/推送。P6.8b 本轮范围收口；下一最小范围为此前确认的连续性验收边界与真实资源装配收口，需要先复核范围再实施，尚未宣布 P6 整体完成。P3 真实执行接入继续关闭；原有 9 份文档删除、原始 patch 及历史受阻清理记录未改动。

## P6.9a 连续性拒绝与恢复边界（完成）

2026-10-31，用户授权继续连续性验收与实际资源装配收口。独立范围确认 revision 286 / turn 01a18e47-63f7-7702-b3c4-f84078a52ef9：先 a 连续性边界、审查记录后再 b 三包真实入口装配；只补证据缺口或最小修复，不实现透明自动恢复、不另存完整历史、不重复 hook 推断恢复。P3 真实执行接入继续关闭。

既有证据直接复用：direct WS 综合实例覆盖冷/HTTP 未知证据、暖连接、最终 tier 改变/外部 ID 零派发、失败不推进、拒绝后下一冷请求、hook 删除 ID 后独立输入及取消；真实 headers/身份用例覆盖最终头的注入/改变/null 删除；opaque 与 Codex 普通流的生命周期实例覆盖 refresh、resume、模型、endpoint、身份、token 轮换和本地历史变化。没有为这些因素新增笛卡尔积。

唯一新增 CI 组合实例使用现有真实 SDK 夹具和合成 WebSocket：普通请求→native WS compact 返回 compact-boundary 和 artifact→payload hook 分别删除、重复 artifact。两次均返回明确边界错误，各只执行一次 hook，WS 保持此前 2 次请求、SSE 0 次，owner diagnostics 保持。撤销破坏后第 3 次实际请求使用 compact-boundary 发送增量；显式 provider-refresh 后第 4 次实际请求无 previous ID，只含一个兼容 opaque artifact。本地 compaction 记录仍为 1，结束后 owner 所有诊断计数归零，夹具目录及全局 fake socket 引用 finally 释放。

README/ARCHITECTURE 明确区别：direct WS 在 hook 前形成候选 ID/input，删除 ID 后尊重 hook 独立输入；Codex hook 先处理完整逻辑请求，再选择缓存增量，普通失配可发全量，但压缩后缺失/歧义必须拒绝并保留证据。有条件恢复是后续有效输入或显式刷新，不保证任意 hook 变化透明恢复。同步修正文档中旧的默认 legacy hook、GPT 并行摘要及第二 Codex 传输暗示。

仅运行新增 Codex 组合和已有 direct WS 组合共 2 个定向实例，均通过；tsgo --noEmit、diff check 通过。未改任何生产函数，完整复核 SDK→ModelRuntime/原生 owner→最终 hook→缓存比较→发送/协议错误→恢复/刷新/退出链，不新增热路径 closure/Promise/AbortController/wrapper/array/内容复制，不引入缓存或池。因此按已确认范围复用 P6.3/P6.6/P6.8 的 AST、分配与引用释放证据，不重复跑基准、全仓测试或增加 CI job。

独立最终审查 revision 288 / turn 01a18e4b-fa12-7680-b12c-7388bf70ec9a 通过，无阻断；审核只读未重复测试。P6.9a 完成、审查并记录，精确暂存 4 个文件，不提交/推送。下一项 b 才验证真实 manifest/资源加载后的三包选择行为；P6 整体尚未收口，原有 9 份文档删除、原始 patch 与历史清理待办保留。

## P6.9b 三包真实装配与 P6 约定范围收口（完成）

2026-10-31，P6.9a 审查、记录、暂存完成后，按 revision 286 确认的最小范围进入 b。仅新增 1 个组合 CI 实例，从仓库 .sp/config/settings.json 和各 package.json 获取 server-compaction、provider-aware、Fast 的实际入口，经 DefaultResourceLoader.additionalExtensionPaths 加载；inline factory 仅提供观察/legacy 取消探针，不替代三包实现。限制自动发现，未擅自让普通 SDK 注入启动器全部资源。

真实入口首先复现 Fast 缺陷：discoverActivePiVersion 从 process.argv[1] 向上查宿主包；SDK/测试入口不在该包目录时返回 unknown，整个扩展禁用，/fast on 变成普通模型输入，预期 5 次请求实际为 6。修复路线经独立确认 revision 289 / turn 01a18e50-b056-72b3-970f-69faa5d34b18：默认读取宿主已公开的 VERSION，与另两包和 virtualModules 来源一致，保留显式版本参数与既有 0.84.x 检查。删除无剩余引用的 runtime-version.ts，不再额外扫描最多 12 层父目录/读取 package.json。未放宽兼容范围，未改变 Fast hook、tier 或生命周期。

组合实例在默认顺序及反序下各验 7 个本地合成请求：三入口各一次、加载无错误、原生策略恰为 2；默认 server 启用、Fast 不加 tier、provider-aware 无默认 preset；/fast on 本身零模型请求；普通请求→portable→remote 均取得 priority；写入 server disabled 后真实 reload，零策略匹配进入原生摘要回退；切换实际 openai-completions API 的 DeepSeek 模型，显式配置 self preset 后记录正确 policy 和 original-prefix shape；legacy cancel 优先，零额外请求且无新压缩记录。合成 transport 只返回离线 Responses/Chat SSE，没有替换策略实现或访问真实服务。

测试中一次 Already compacted 源于连续验收前没有新增历史，已仅给夹具加入有界合成历史；findLast 不符合项目当前 TypeScript lib，改用既有 filter/at 写法，没有提高 Node/lib 最低要求。最终新装配、既有 Fast session/tier 综合及真实 launcher 路径/隔离参数共 3 个定向实例通过；装配实例约 6.38s，使用原设定 10s 上限，未加重试或提高超时。类型与 diff check 通过。A/b 本轮合计仅新增 2 个组合实例，未运行全仓测试或增加 CI job。

审计生产调用链为真实 manifest→资源路径解析→模块/宿主虚拟模块加载→Fast 初始化版本检查→既有配置与注册；请求链的 SDK/ModelRuntime→headers/payload/Fast→所选 owner→continuation/压缩/退出沿用既有实现。生产仅初始化版本来源变化，逐 delta、进度、渲染新增 closure/Promise/AbortController/wrapper/array/全量复制均为 0，无新状态、缓存、池、后台任务或依赖。复用 P6.3/P6.6/P6.8 已有 AST、分配/引用释放证据，不为文档/测试与初始化修正重复基准，也不声称测得启动或吞吐提速。

本项临时配置根由 mkdtemp 创建，配置和 manifest 准备也包含在 finally 保护内；各 SDK 夹具分别 dispose 后按创建路径删除，根目录删除后确认不存在，环境和 fetch 恢复。失败迭代使用相同清理结构，没有保留研究脚本、复制测试或大型临时产物。原有受自动审批拒绝的历史清理仍只保留原记录，不借本项清理扩大删除范围。

独立最终只读审查 revision 292 / turn 01a18e54-14a6-7df0-8df6-0c3be23085fc 通过，无阻断，审核未重复执行测试。P6.9b 完成、审查并记录，精确暂存本项 5 个文件，不提交/推送。

**P6 按已核对的约定契约收口。** 宿主拥有请求状态与生命周期；认证快照、最终 tier、capability、Provider 装配与传输缓存归属、唯一压缩策略/显式 preset、补充摘要管理与普通状态隔离、连续性拒绝/恢复边界、三包真实入口选择均已有对应证据。保留低层 legacy 共享兼容域、旧宿主降级、legacy hook 优先及非 GPT 原回退；不宣称任意第三方 hook 都顺序无关，不承诺透明重放，不为恢复拼接未经证明的历史。普通 SDK 不自动继承源码启动器的整套资源，provider-aware preset 仍须显式启用。

P6 收口不代表整个权限/原生化方案完成：P3 真实文件/命令执行接入仍关闭，依赖该边界的 P4 访问控制退役仍待；P0 真实图片桌面验收按用户决定保留待办，P7 尚未启动。9 份原有文档删除和原始 patch 保持原状态。

## P7 范围复核与依赖分账

2026-10-31，用户授权先与审核对话核对 P7 剩余及 P3 依赖，再独立推进最小项。只读范围审查 revision 294 / turn 01a18e62-7e9f-7e71-82b2-7e965f215cb1 确认如下边界；本节是范围记录，不是实现通过记录。

| 分类 | 当前范围 |
| --- | --- |
| 首项 P7.1 | 原生活跃会话 lease：逐 AgentSession 归属、零扩展 SDK 接线、reload 连续保护、目标预留与交接、实际 drain 后释放；复用 v1 磁盘协议，不依赖 Memory 索引 |
| 后续独立小项 | 原生选择器删除入口的 lease 检查、遗留附件桥接、MCP/LSP 装配归属，以及确认消费者已迁移后的个别 shim 退役；每项先界定范围 |
| 已有成果复用 | 原生任务/文件 owner、MCP/LSP/Browser drain、附件草稿与失败重试、P5/P6 已验契约，不重复迁移或堆叠测试矩阵 |
| 必须等待 P3 | 真实文件/命令及子进程隔离接入、默认执行边界切换，以及依赖该边界的访问控制退役；继续关闭 |
| 用户保留待办 | P0 Windows 图片粘贴与发送桌面回放；合成 SDK 测试不能代替 |

P7.1 现有缺口：可选 session-memory-manager 用进程级 Symbol 保存一个 lease，多 SDK 会话会替换 getters，任一 shutdown 可能停止另一会话的保护；零扩展没有该保护。只对活跃 AgentSession 建立 owner，历史读取或候选 SessionManager 不自动变成活跃会话。同步 dispose 请求与真实 drain 分开；超时/失败不得宣布释放。原生 session-selector 的直接 trash/unlink 尚未检查 lease，因此本项完成后也不能声称全部删除入口已经统一。Memory/Hermes 索引和删除 UI 留在扩展，不改变用户数据删除策略。

验收预算为两个组合实例，覆盖多会话/零扩展/历史读取、reload/切换/取消失败/实际退出及资源释放；复用现有替换检查，不新增模式矩阵、CI job 或超时。只在生命周期边界更新 lease，不向消息/delta 路径加入磁盘刷新；如触及热路径须补契约要求的 AST、分配和释放证据。每项实现、独立审查、记录后才进入下一项。

## P7.1 原生活跃会话保护（完成）

2026-10-31，按 revision 294/296 确认的范围实施。lease 原语迁到 coding-agent 内部，扩展原路径只转发；v1 格式、规范路径、PID 检查、原子发布及与删除消费者共用的锁保持兼容。独立 internal export、源码加载别名与二进制 virtualModules 同步接线，没有从宿主反向导入 Memory。Memory 管理/索引 UI 保留，移除扩展进程级 Symbol 和第二份 owner。

SDK 的实际 agentDir 传入 AgentSession，初始化末端建立逐实例保护；只持有路径和 ID 字符串，不捕获 ctx/SessionManager。历史 SessionManager.open 不产生活跃 owner；reload 保留原 lease。Runtime 在旧会话 teardown 前发布目标 lease，直到新 AgentSession 已发布自己的记录才交接；至多一个在途 replacement，取消/创建失败完成收尾后移除预留，不用旧 30 秒预留超时冒充交接成功。print/RPC 沿用同一 runtime.dispose 链。

同步 AgentSession.dispose 是停止请求，waitForSessionLeaseRelease 返回同一个实际释放操作。宿主先登记 shutdown Promise，再派发可能重入的 hooks/撤销；等待已登记执行与 Provider owner 都确认结束后才能删记录。已有 shutdown 结果传到 invalidate，避免原实现再次调用失败的 boundary 清理。失败结果不会被隐式重试覆盖；drain/unlink 失败留下保守的存活 PID 保护，停止 timer、清空 getter/owner 引用，并向等待者传播失败。任意仅依赖 session_shutdown 的第三方后台活动不因此获得新的 raw SDK 收尾保证。

独立审查发现并修复在途退出竞态：最终退出必须在 await teardown 前捕获 replacement Promise，随后等待同一操作；否则预留删除失败并清空槽后，退出可能错报成功。最终退出沿用现有 5000ms 生命周期上限；超时保留尚未完成的目标保护并报错，候选实际返回后再按失效 generation 收尾。未加请求/消息热路径定时器，也未扩大 CI timeout。

仅新增 tests/session-lease-lifecycle.test.ts 的两个组合实例：两个真实零扩展 SDK 会话互不覆盖；历史读取零新增记录；真实 agent_end settlement 门控期间 raw dispose 立即返回但记录保留，实际结束后 A 释放而 B 仍保护；reload 同 owner；切换旧 drain 中 2 记录、创建前 1 个目标预留、接管后 1 个新 owner；取消零工厂调用；工厂激活前失败清零；工厂在途退出等待后取消候选；共享 teardown 的预留 unlink 失败同时传给切换和退出；boundary 拒绝仅执行 1 次，失败保护仍有效；unlink 拒绝不报告释放。正常释放与保守失败均检查 heartbeat/reservation timer、getters 和 owner/在途槽的释放。

最终两个新增实例总进程约 0.91s；受审查修正影响的第二实例按需重跑，约 0.16s 用例时间。既有 runtime 单 owner/失败组合 11 个、regular new/fork/resume 1 个、Memory 兼容转发/选择器相关 3 个定向实例通过；合计 17 个不同实例，没有全套模式矩阵、全仓测试、新 CI job 或超时增加。root tsgo --noEmit、coding-agent 定向编译及 diff check 通过。所有夹具目录以 mkdtemp 返回身份在 finally 清理，并确认不存在；失败分支保留的仅是这些合成目录内记录，未触及用户会话或历史清理待办。

完整审计链为 SDK/资源装配→AgentSession owner→reload/原生执行与 Provider drain→Runtime 替换/退出→lease 原子发布/检查/释放；变更均为初始化、显式切换、停止和失败清理。逐 delta/进度/渲染新增 closure、Promise、AbortController、wrapper、array 和内容复制均为 0。每活跃 owner 一个既有 30 秒 heartbeat、每 runtime 至多一个目标预留/替换操作，终态无 timer/getter/owner 引用；不引入对象池、全局注册表或扫描任务。沿用此前热路径 AST/分配证据，本项不改热函数、不为生命周期迁移重复吞吐基准，也不声称测得吞吐提升。

最终独立只读审查 revision 302 / turn 01a18e72-2e38-7842-a7e4-7868aa879df1 通过，无剩余阻断；审核没有重复测试。P7.1 完成并记录，精确暂存本项文件，不提交/推送。完整 P7 尚未收口；原生选择器的直接 trash/unlink 消费者尚未接入 lease，后续须单独限定范围。P3 真实执行接入继续关闭，P0 桌面待办、9 份既有文档删除和原始 patch 保持原状态。

## P7.2 原生会话选择器删除保护（完成）

用户授权本项独立推进。只读范围审查 revision 309 / turn 01a19061-587e-79a0-b125-e0be270b6672 确认：启动 --resume 与运行中 /resume 共用原生删除入口；将 canonical path 活跃保护检查与 trash/同步 unlink 放在同一把 lease 发布锁内，不能在返回 Promise 后提前释放锁。运行中的选择器传入 runtime 实际 agentDir，启动入口在实例创建时取默认目录；保护仅限该配置域，不额外读取会话头，不宣称跨任意 agentDir 保护。

维持用户确认和原 trash→unlink 策略，仅对异常终止停止兜底：trash 增加 2 秒超时终止配置、64 KiB 输出上限、SIGKILL 与隐藏窗口；ETIMEDOUT/ENOBUFS/非空 signal 必须先判失败，不能被文件消失或矛盾成功状态覆盖。spawnSync 的 timeout 不是整个进程树的严格返回/清理时限，本项不另建执行后端。最多两个组合测试，使用合成文件和受控 trash 结果，复用既有 selector 迟到结果/释放检查；不调用真实系统 trash 或用户数据。Memory 索引、批量删除、其他消费者及 P3 接入均不在本项范围。

2026-10-31，实现按上述范围完成。共用删除实现移入 core/session-deletion.ts，withSessionLeaseLock 回调内依次执行最终路径占用检查、同步 trash 和必要的同步 unlink。检查/锁失败在任何删除调用前返回错误；正常和异常分支均经过锁的 finally 释放。selector 在构造时绑定 options.agentDir ?? getAgentDir()，运行中入口显式传入 runtimeHost.services.agentDir；没有在模块加载时缓存默认目录，也没有为缺省参数跳过检查。Memory README 同步标明两个原生入口已经接入、配置域限制和异常终止不兜底语义。

新增 tests/session-selector-deletion.test.ts 的两个组合实例，约 0.33s 总进程时间：真实 selector 确认框打开后才发布 lease，分别覆盖默认和显式配置域（后者故意与默认域不同）；拒绝时 trash=0、unlink=0，文件内容、current/all 列表保留且不刷新；释放 lease 后正常删除并刷新。原生 helper 组合覆盖 canonical 路径、锁获取失败、trash/unlink 调用期间锁仍存在、普通失败兜底、ETIMEDOUT/ENOBUFS/signal 优先失败（包括 status=0 与文件已经消失的反例）、trash 成功及 unlink 失败后的文件保留/锁释放。系统 trash 全部被受控替换，没有调用真实垃圾箱或删除用户会话。

既有 async-owner 生命周期源码 gate、selector 删除迟到结果及 InteractiveMode stop 释放 selector 三个定向实例通过，约 0.76s 总进程时间；本项合计 5 个不同实例，未跑全仓或扩大模式矩阵。夹具计数变量补显式 number 后 root tsgo --noEmit 通过，coding-agent 定向编译和 diff check 通过；没有提高测试 timeout、增加 CI job 或留下重复研究测试。两个 mkdtemp 根均按返回身份在 finally 删除并确认不存在，mocks、环境与按键配置恢复；没有本项新增临时产物待清理。

性能审计完整链为启动/运行中的 selector 装配→确认后的删除回调→原生锁/lease 查询→trash/unlink→结果与列表刷新→selector dispose。只改变初始化绑定和显式删除动作，保留现有用户确认、成功过滤刷新、失败提示与 generation 迟到结果检查；不改渲染、搜索、逐消息/进度路径。新增每 delta/frame/progress 的 closure、Promise、AbortController、wrapper、array、扫描及内容复制均为 0；初始化仅增加一个捕获目录字符串的绑定函数，删除临界段无 await/Promise 逃逸，无新队列、缓存、池或后台任务。既有 source gate 和释放检查通过；未改热路径，因此复用既有分配基线，不为此项重复吞吐基准或宣称性能提升。

独立最终只读审查 revision 311 / turn 01a19067-6d71-7351-b37f-52b20d1c5da4 通过，无阻断；审核未重复测试，主线程已补确认最终类型与定向编译均通过。P7.2 完成、审查、记录并精确暂存本项 6 个文件，不提交/推送。完整 P7 尚未收口；本项不宣称跨任意 agentDir 或第三方删除入口保护。P3 真实文件/命令接入仍关闭，P0 桌面待办、9 份既有文档删除、原始 patch 与历史清理待办保持原状态。

## P7 剩余复核与 P7.3 MCP 宿主版本接线（完成）

2026-10-31，按用户授权先与独立审核核对剩余附件桥接、MCP/LSP 装配和兼容层退役。范围确认 revision 314 / turn 01a190e5-55f3-7ce3-91a1-bd1c581e72db：先推进 MCP 实际宿主版本识别，保留其余独立项；P3 真实文件/命令执行接入继续关闭。

- 附件：现代宿主已有原生图片入口，但 auxiliary-vision 仍安装全局 clipboard lifecycle 并在加载时扫临时目录。旧路径读取、历史摘要去重、失败重试和基准消费者仍存在，需另行拆分现代装配与旧数据读取，不能直接删除整个 lifecycle。
- MCP/LSP：P3.3.5g/f 已完成各自服务 owner、撤销和 drain；剩余默认资源装配、禁用与重复注册需分别验收。MCP 当前从 process.argv[1] 父目录猜宿主版本，普通 SDK 入口因此错误禁用，是可独立修复的最小缺口。LSP 现有服务归属不在本项重写。
- 兼容层：仅退役本项无剩余消费者的 MCP 启动脚本版本扫描；typed-source 能力检查、旧宿主明确禁用、附件旧数据读取及依赖 P3 的访问控制继续保留。

P7.3 使用宿主 namespace 的 VERSION，保持同步 extension factory；不使用强制命名导入，以兼容只有空 root exports 的旧宿主。缺版本、非 0.84.x 或缺 typed-source adapter 都应加载入口后明确禁用，不能提前导入桥接运行时。optional peer 不额外承诺完全没有宿主包时运行扩展。

验收最多两个组合：实际 manifest→DefaultResourceLoader→SDK 普通入口→空配置工具调用→reload→关闭，及旧宿主缺版本/版本不符/缺 adapter；复用既有 --no-mcp 定向实例。空配置仅证明入口、空闲 owner 和 lease 释放，不替代既有真实 transport drain 证据。新增测试先复现普通 SDK 未注册 mcp_search_tools（约 0.77s），修复后再验证；不新增 CI job、不跑全仓或扩展后端矩阵。

P7.3 实现与验证：入口改读 PiHost.VERSION，删除 discoverPiVersion 及 fs/path 父目录扫描；没有放宽支持版本或 adapter 检查，未改变同步 factory、配置/鉴权、工具执行、服务生命周期。README 标明显式选入扩展的普通 SDK 现在使用实际宿主版本，未将扩展自动注入所有 SDK。

既有 tests/mcp-host-compatibility.test.ts 增加 1 个真实 SDK 组合实例，并扩展原旧宿主实例；与原能力单元共 3 个实例通过，约 1.00s 总进程时间。SDK 组合从真实 manifest 加载且不伪装 CLI 入口，空配置 search 返回 unconfigured，reload 前后各一个 MCP owner，旧 boundary 最终 0 参与者且无 deadline；宿主关闭后新 boundary 同样归零，lease 目录为空，网络请求为 0、无 activation key。旧宿主三种条件只注册 session_start 警告，工具/owner 均为 0，夹具故意没有 bridge.js 以防提前加载运行时。中间一次失败来自夹具漏掉真实 owner 名的 extension:path: 前缀，已修正断言，不改生产注册逻辑。

既有 built CLI --no-mcp 实例通过，约 0.82s：即使显式 MCP allowlist 也不启动 stdio，不写 schema cache/activation key、不改配置。本项合计 4 个不同定向实例；root tsgo --noEmit 和 diff check 通过。只新增 1 个 CI 实例、扩展 1 个原实例，没有增设测试文件、提高超时、运行全仓或追加研究脚本。SDK/旧宿主两个测试根在 finally 校验已记录绝对路径和专属前缀后删除并断言不存在；环境、argv、fetch 还原，既有 CLI 临时根也按其创建身份清理。无本项新增待清理产物。

性能审计覆盖 manifest/资源路径解析→宿主 alias/virtual module→扩展版本与能力 gate→session_start 空配置→工具调用→reload/owner drain→宿主 dispose/lease 释放。生产只改初始化版本来源，逐 delta、进度、事件、渲染新增 closure/Promise/AbortController/wrapper/array/扫描/全量复制均为 0，无新缓存、池、依赖或后台任务。保留既有能力门槛和服务关闭路径，复用 P3.3.5g 与 P6.9b 已有热路径/释放证据，不为初始化修正重复分配基准，也不宣称测得性能提升。完整 P7、附件桥接退役及 MCP/LSP 默认装配尚未收口，P3 接入保持关闭。

独立最终只读审查 revision 316 / turn 01a190ed-dde3-7f72-8318-b5d561f4a003 通过，无剩余阻断；审核未重复测试或修改文件。P7.3 完成、审查、记录并精确暂存上述 5 个文件，不提交/推送。下一独立候选为附件桥接的现代入口与旧数据兼容分离，实施前仍先限定范围；本项未提前删除旧附件路径或重写 MCP/LSP 服务归属。P0 桌面待办、9 份既有文档删除、原始 patch 和历史清理待办保持原状态。

## P7.4 附件现代入口与旧数据兼容分离（完成）

2026-10-31，用户授权继续此项。独立范围确认 turn 01a190f7-cce1-7ce1-9a58-07ea468607ee：仅改 auxiliary-vision 初始化装配，使用宿主 namespace 的正安全整数 IMAGE_ATTACHMENT_VERSION >= 1 标记识别原生附件生命周期；不据此宣称理解未来 submission 格式。现代默认不安装全局 clipboard owner、不构造 consumer、不注册确认用 message_start hook，不清扫临时目录、不替换或关闭其他全局 owner。缺能力标记的 legacy 宿主继续原安装，显式注入 clipboardLifecycle 优先。

旧路径提取、受限读取、大小/MIME/文件身份检查、不可读路径保留、v1/无版本摘要及 v2 去重、辅助视觉失败后的显式重试全部保留。现代宿主仅只读物化旧路径，成功消费也不自动删除历史文件；原确认消费后的清理仍适用于 legacy/显式注入 owner。本项不是历史孤儿文件清理，不修改 lifecycle 类、旧 benchmark、原生草稿/输入/渲染链或 P3 关闭状态。

最多新增两个组合：实际 manifest/SDK 现代装配跨图片输入、旧路径读取、reload/退出的零全局安装/清扫与文件保留；legacy fallback/显式 owner 的 stage、成功确认、身份变化/其他 owner 保护及退出。复用既有 post-submit retry、旧 digest 恢复与生命周期源码 gate；不复制图片矩阵、不重复未受影响的分配基准。

实现仅改 auxiliary-vision/index.ts：初始化时选择可选 consumer；现代路径不注册确认 hook，input/inspect/退出使用可选调用，不为图片或退出补建 owner；legacy/显式注入走原实现。原生图片、历史 materialize、摘要键计算及请求/错误/重试逻辑未修改，clipboard-lifecycle/consumer 和直接 benchmark 消费者保留。README 删除已过时的 pi-core-compat 生产者说明，明确现代只读旧数据与 legacy 确认清理的区别。

两个新增组合位于既有 interactive-control-images.test.ts，不新增测试文件。现代实际 manifest→ResourceLoader→SDK 在修复前复现全局 sentinel 被关闭/替换；修复后 typed 图片与旧路径两次普通模型调用成功，旧文件从消息内容核实已物化，跨 reload/退出仍保留 48 小时 aged 文件和原 sentinel。确认 hook 数 0、sentinel shutdown 数 0、网络请求 0、legacy lease 目录不存在；结合初始化分支核对 lifecycle/consumer 构造与 cold sweep 均不可达，不将静态证明冒充全文件系统扫描计数。

legacy 组合通过缺能力标记的宿主虚拟模块加载真实扩展入口，并在标记为 2 的对照验证未来有效标记不重装桥接、显式 owner 仍优先。真实旧路径 stage 后文件保留，受控辅助视觉失败保留图片，显式再次输入成功仍等用户消息确认才删除；assistant 消息不确认，inspect 成功后实际删除，身份变化/其他活跃 owner 文件保留，关闭只释放自身文件/登记。canonical 夹具修正后，同一进程合跑两个新增组合通过，约 1.20s；复用 post-submit 显式重试与旧 digest 保存/恢复两例约 1.18s，生命周期 source gate 一例约 0.66s。本项合计 5 个不同实例；root tsgo --noEmit、diff check 通过，未跑全仓或增加 CI job/超时。

发现并另记的既有边界：Windows TEMP 的 ADMINI~1 短路径与 async realpath 返回的 Administrator 完整路径不同，可能使 legacy inspect 的身份范围检查保守跳过清理。主线程已复现，文件保留；本项未改相关 lifecycle/image-io 代码。独立审核 revision 325 / turn 01a190fb-a53e-7b83-9f55-f2c013192a50 确认不阻塞装配分离：legacy 组合使用 realpathSync.native(tmpdir()) 的 canonical 根，仍严格走真实 inspect→stage→confirm 并断言删除，不 mock 路径转换、不将未抛错视为清理成功。短/长别名统一留为独立待办，P7.4 不宣称所有路径别名均覆盖。

审计完整链：原生草稿/typed submission→资源装配能力选择→普通/图片 input→有界历史读取/派生结果复用→可选确认→reload/shutdown。现代只减少初始化 owner/consumer 与确认 handler；既有图片请求级数组/哈希/认证和受限读取不变，逐 delta/frame/progress 新增 closure、Promise、AbortController、wrapper、array、全量复制均为 0，无新池、缓存、后台任务或依赖。按范围确认复用未改动链的分配/引用释放基线，不重复 interactive-image-input 文本截断基准，不声称量测到吞吐提升。

本项两个 mkdtemp 根以记录的绝对路径和对应 temp 根/专属前缀在 finally 校验后清理并断言不存在；环境、fetch、全局 sentinel 恢复，legacy owner 在 finally shutdown。失败迭代也沿用清理；无本项遗留临时产物、下载或真实辅助模型请求。现代历史文件保留是产品语义，测试中的合成文件已随专属夹具根清理；不借本项清理其他用户目录。

最终审查指出现代夹具仅设置 TEMP/TMP 会漏掉 Unix/macOS 的 TMPDIR 优先级，已补三者同时设置/分别恢复，并断言 tmpdir() 指向专属根；受影响现代组合定向重跑通过（约 1.24s），类型检查再次通过。当前运行证据来自 Windows，不将夹具修正称为已执行跨平台验收；生产实现未因此扩大范围。

独立最终只读复核 revision 331 / turn 01a190ff-4b29-7da3-9c71-594a4b10882c 通过，无剩余阻断；审核未重复测试。P7.4 完成、审查、记录并精确暂存本项 4 个文件，不提交/推送。完整 P7 尚未收口，旧路径别名清理、MCP/LSP 剩余装配与其他兼容层退役仍需逐项限定范围。P3 真实文件/命令接入继续关闭；P0 桌面待办、9 份原有文档删除、原始 patch 与历史清理待办保持原状态。

## P7.5 Windows 旧附件清理路径别名（完成）

2026-10-31，用户授权修复短/长路径混用。独立范围确认 turn 01a19111-efe3-74e3-9876-d5957a633abf：保留 tempDir、records key/record.path、v1 manifest 与 created/editor/submitted/release 原流程，仅在 materialized、存活 manifest 保护集合、过期 manifest 清理三个低频入口统一别名。精确 UUID 图片名先过滤，本 owner 原根与已解析 native 根可直接匹配；其他 Windows parent 先比较配置根的卷/UNC 根，再 native 解析并严格要求同一临时根。失败不认领，不把解析失败当成文件消失。校验和最终删除必须使用同一映射路径，保留文件类型/非 symlink、MIME、扩展名、age 与 dev/ino/size/mtimeMs 检查。

本机 Node v26.13.0 实测 tmpdir 与 realpathSync 为 ADMINI~1 短路径，realpathSync.native/异步 realpath 为 Administrator 完整路径，目录 dev/ino 相同。扩展既有 P7.4 legacy 组合，改回原 tmpdir 根，foreign owner 使用 native 长根，加入旧 producer→inspect 失败→显式 retry 与外部同名文件拒绝；最多新增一个真实 Windows alias 的 active/stale manifest 组合。不存在真实别名时明确跳过，不用模拟代替验收。P7.4 现代只读、历史摘要/读取/重试与 P3 关闭状态不变。

审计和夹具进一步复现 dead 旧 manifest 与 live 新 manifest 指向同一文件时，stale 清理会越过存活 owner。独立补充范围确认 revision 337 / turn 01a1911b-3e71-7bf1-9971-441990bfe567：coldStartSweep 只取一次 activeOwnedPaths 快照，以同一 ReadonlySet 保护 stale 和 orphan 两入口，命中则保留文件及 dead manifest；不新增集合或扫描总次数。此快照只保护扫描时可见的存活 lease，不提供跨进程并发注册原子性，不扩展成锁协议。

实现仅改变 clipboard-lifecycle 的上述低频入口与初始化缓存。normalizeClipboardAlias 将已证明同根的 Windows parent 映射回本 owner 原路径写法；同根缓存直接命中，其他同卷/同 UNC 根变体才执行 native parent 解析。保留精确 UUID 文件名和最终 lstat 检查，不解析最终文件以绕开 symlink 判断。materialized 映射后沿用原 verify 与四项 identity 比较；activeOwnedPaths 使用同一映射；stale 校验和 unlink 使用同一 filePath。没有修改原生图片链、P7.4 能力选择或失败重试逻辑。

既有 legacy 组合改回实际短 TEMP 根，foreign owner 刻意用长根，修复前复现 foreign 文件被误认领并删除（均为隔离夹具），修复后保留；同一组合验证无 owner 的 inspect 消费、旧 producer 创建/编辑/提交→inspect 失败保留→显式重试删除、相同 UUID 名的外部文件不认领，以及原有身份变化、退出与注入 owner 行为。新增唯一 Windows alias 组合在本机实际执行、未跳过：长/短根互读 live lease、双向 stale 清理、dead/live 同 identity 重叠保护、变化文件/外部根/不可解析 parent/junction 均保留，关闭后每个 owner records=0、pendingEditorText 为空、无待排队 editor reconcile。overlap 反例先失败后通过；不能将该反例隐去或只保留正常清理正例。

最终 legacy+Windows alias 两组合合跑通过约 1.32s；现代实际 manifest/SDK 历史文件只读组合通过约 1.06s，既有生命周期 source gate 通过约 0.78s，共 4 个不同定向实例。root tsgo --noEmit 通过，仅新增 1 个 CI 实例并扩展 1 个已有实例；不跑全仓、不增加 job/timeout，不改 Node 最低要求。无可用真实 Windows 别名的平台会明确跳过专属组合，不冒充完成该平台验收。

性能复核完整链为 creator→editorChanged/reconcile→submitted→inspect/受限读取→materialized/确认→release，以及初始化 lease 扫描→live snapshot→stale/orphan 清理。一次 AST 比对 index 暂存基线与工作树，证明 created、editorChanged、submitted、confirmMaterialized、shutdown、reconcileEditor、releaseRecord、verifyClipboardFile、pruneExpiredOwnedEditorFiles、persistManifest、globalCapacityAllows 共 11 个方法及 10 个模块函数原样保留；新 helper 调用者恰为 materialized、activeOwnedPaths、removeStaleManifestRecord。新增热链调用/closure/Promise/AbortController/wrapper/array/完整内容复制均为 0，无新池或集合缓存；每 owner 只增加两个目录字符串，native 路径解析限初始化/别名消费/启动扫描。现有有界扫描上限未增加，startup 的 active Set 仍一份并在调用结束释放。按确认范围不重复未改变热链的分配基准，不把旧文本截断采样作为路径解析性能证据。

两个任务夹具根均在 finally 关闭记录的 owner、恢复全局登记，并校验记录的绝对根/专属前缀后删除、断言不存在；junction 及其目标均为该根内的合成数据。失败迭代也经过同一清理。没有扫描清理真实用户附件、访问网络、下载或保留研究脚本；P0 桌面待办和历史清理记录未借机更改。

最终审查修正一处跨平台夹具回退：只有 win32 保留原 tmpdir 拼写以覆盖真实短路径，其他平台恢复 native canonical 根，避免符号链接临时根与 owner 路径不一致。受影响 legacy 组合重跑通过约 1.26s，类型检查再次通过；未声称运行过非 Windows 验收。复用的现代 SDK 组合也已按原 finally 清理并恢复环境。README 将过强的活跃 owner 保护表述收窄为 startup snapshot 中可见的 live lease，保留并发限制。

独立最终只读复核 revision 341 / turn 01a19120-1b3a-78b0-9526-975cc690cb1b 通过，无剩余阻断；审核未重复测试。P7.5 完成、审查、记录并精确暂存本项 4 个文件，不提交/推送；P7.4 所记的 Windows inspect 路径别名清理待办在上述范围内解决。完整 P7 尚未收口，MCP/LSP 剩余装配及其他兼容层退役继续按小项确认范围。P3 真实文件/命令接入仍关闭，P0 桌面待办、9 份既有文档删除、原始 patch 与其余历史清理记录保持原状态。

## P7.6 MCP/LSP 实际装配验收（完成）

2026-10-31，用户授权继续核对默认加载、禁用与重复注册。独立范围确认 revision 344 / turn 01a19122-392c-7e83-bc86-574604e06775：先补两个真实装配组合，未确认生产缺陷，不新增宿主内建注入、noLsp、按工具名静默合并或全局路径规范化。源码启动器从 .sp/config/settings.json 读取两包 manifest 并追加显式入口；普通 SDK 仍需选择资源。LSP index.ts 是 manifest 入口，不是无消费者废弃层。

扩展 P7.3 的既有 SDK 组合：共享既有真实 launcher 参数采集 helper，只拦截最终 CLI import；从实际输出选取 MCP/LSP manifest entry，先证明只有 package 配置也可加载两包，再在普通 SDK argv 下合并重复显式路径和同包配置，断言恰有两个扩展、四个扩展工具、无重复 command，以及 mcp/lsp owner 各一个。实际 session.reload 后旧 boundary participants=0、deadline=false，新 boundary 不同且注册数不变；空 MCP search 在重载前后均返回 unconfigured，最终 runtime.dispose 后新 boundary 归零、会话 lease 目录为空。没有执行 LSP 诊断、模型请求或新一轮服务 drain 矩阵。

新增一个禁用组合，顺序检查五个有界状态而非配置笛卡尔积：不提供 resourceLoader 的空 SDK 默认分支不注入两包；noExtensions 关闭自动 package 来源；package extensions: [] 单独关闭 package 来源；后二者分别保留重复显式 entry 且只注册一次。显式装配同时开启 noMcp 时，MCP-required 工具不在配置目录和执行 registry，LSP 三工具仍激活，闲置 MCP/LSP owner 仍受统一释放管理。首次夹具错误地要求 noTools: builtin 从配置目录删除内建定义，失败后按 P5 的配置/激活区别修正为比较扩展来源；未改生产逻辑或弱化 MCP/LSP 断言。

两个组合修正后合跑通过，总进程约 1.05s；复用真实 launcher 既有九组参数断言与 built CLI --no-mcp 的配置 stdio 不启动用例，两例合跑约 0.95s。当前合计 4 个不同定向实例，只增加 1 个 CI 实例，旧单包 SDK 用例已扩展而非保留重复副本，启动器脚本提取为共享测试 helper；不新增 job、超时、全仓测试或大矩阵。每个 SDK 组合仅运行一个有界 launcher 采集子进程，随后拦截并计数全部七个 child_process 启动入口、同步 ESM 绑定，实际装配/重载/关闭期间 spawn=0、fetch=0；这不替代既有非空服务 drain 的验收。

兼容审计保留 MCP runtime-compat.js（入口仍调用，typed-source 探测对应 result.js 实际内部导入）、LSP index.ts（manifest 仍引用）、旧 lsp.json 配置读取（实际可达旧数据通道）。本项没有确认消费者已迁移的可删 shim；不把“本地兼容 fork”整体当成废弃层。两包 README 补充默认来源、显式入口优先、noMcp 与 LSP 的边界。P3 真实文件/命令接入及依赖隔离的访问控制退役继续关闭。

性能审查链为 source launcher→PackageManager 资源收集/canonical 去重→ResourceLoader 合并→实际扩展 factory/owner→SDK session bind→reload/dispose。生产文件、依赖和热路径均未修改；每 delta/进度/帧新增 closure、Promise、AbortController、wrapper、array、全量复制为 0，无新池、缓存或常驻任务。因此不重复未变热链的 AST/分配基准，不宣称吞吐或内存优化。新夹具在 after 中等待当前宿主释放、恢复 argv/环境/fetch/进程 API，再校验记录的绝对临时根及专属前缀后删除、断言不存在；失败迭代走同一清理。没有本项下载或遗留研究产物，用户原有删除、原始 patch 和历史清理待办不变。

初审 revision 346 / turn 01a1912a-af46-7951-a806-2314726664cf 指出两个验收缺口：原先正例总有显式路径，不能单独证明 package 来源有效；原先空 SDK 仍传自建 loader，未走 SDK 默认分支。已在既有两个组合中补齐，无新增测试实例；close 也增加每次完成后的 lease 空目录断言。受影响两组合定向重跑通过，总进程约 1.17s，root tsgo --noEmit 再次通过。共享 helper 抽取后的原 launcher 九组已与 noMcp CLI 用例一起实跑通过，未因记录更新重复执行。

独立最终只读复核 revision 350 / turn 01a1912d-1aa3-74f2-981a-31855dccac45 通过，两个 P2 关闭、无剩余阻断；非阻断文档建议已落实，将 README 的释放保证明确限定为 session.reload()，不扩大为裸 ResourceLoader.reload() 等待完整 drain。P7.6 完成、审查、记录并精确暂存本项 6 个文件，不提交/推送。后续独立最小候选为 statusline 宿主版本入口：公开 VERSION 替换 argv 位置探测，保留兼容拒绝与加载失败处理，不改状态栏渲染；该项另行审查和记账。P7 整体及依赖 P3 的退役未宣告完成。

## P7.7 Statusline 宿主版本入口与旧探测退役（完成）

在 P7.6 完成、审查、记录后进入本项。独立范围确认 revision 353 / turn 01a1912f-5cc2-7753-af64-a6f0e36f859b：只迁移初始化版本来源与无其他消费者的 argv/祖先 package.json 探测，保留 0.84.x gate、不支持/未知版本提示及实现加载失败的 catch/sanitize。文档已声称使用 VERSION，但旧源码实际根据 process.argv[1] 向上找宿主包。新增单一组合先加载真实 manifest 指向的既有 dist/index.js，在普通 SDK argv 下复现只注册 warning、缺少 session_shutdown 等实现事件的失败。

入口改为 namespace 导入 PiHost 并读取公开 VERSION；缺少该导出仍走未知版本降级，整个 peer 模块不存在不属于此保证。退役 discoverPiRuntimeVersion 与两个 fs/path 导入，不改变 checkRuntimeCompatibility、终端文本清洗或状态栏实现。加载器审计确认 built Node 以别名定位当前宿主，源码/Bun 以 virtualModules 复用宿主；COMPATIBILITY 明确这一装配前提，不承诺任意裸 import 都不会加载包内依赖。不增加宿主默认注入、公共 API、依赖、缓存或 global Symbol。

采用包内定向 tsc 更新实际 manifest 的 dist 产物，无递归清空或全仓构建。dist 仍按原规则被 Git 忽略，暂存范围只有源码和验收记录；产物在本机实际加载验证。新组合用构建后的真实宿主 loader 和 Node aliases 加载完整状态栏入口，断言实际 session_start/session_shutdown/message_end/agent_settled 注册；没有挂载 footer、调用模型或执行渲染。组合内复制必要的四个已编译入口依赖到三个隔离目录，分别验证缺失 VERSION、不支持 VERSION 时不加载实现，以及实现抛错时只注册清洗且限长的 UI warning；无 UI 不提示，伪造有效 CLI argv 不能覆盖实际宿主版本。

生产调用链复核为扩展 loader→版本 gate→一次动态实现导入→既有注册；其后的事件→状态更新→渲染/计时器链保持原样。修改前记录并在定向编译后比对 48 个未涉及入口变更的源码/产物 SHA256，全部一致；热链每事件 closure、Promise、AbortController、wrapper、array、全量复制增量为 0，无新增池、常驻任务或计时器。复用加载器延迟初始化 source invariant，不重复未改动的 footer 分配基准或渲染矩阵。

新增组合和上述 source invariant 合跑通过，总进程约 0.85s。首次 root 类型检查指出测试在断言 warnings=[] 后被缩窄为 never，已改为长度断言，生产代码不受影响；最终复核随后记入。仅新增一个 CI 实例，无新增 job/超时。新夹具 after 等待 runtime boundary/Provider owner 释放并检查 participants=0、deadline=false，恢复 argv/fetch，按记录的绝对临时根与专属前缀清理并断言不存在；fetch=0，无研究脚本或下载遗留。P3 真实执行接入、P0 桌面待办、用户原有删除和原始 patch 保持原状态。

最终受影响唯一组合重跑通过，总进程约 0.71s，root tsgo --noEmit、定向编译与 diff check 均通过。独立最终只读复核 revision 357 / turn 01a19133-2062-7ab3-afa3-fb9f45c089fd 通过，无剩余阻断，审核未重复测试。P7.7 完成、审查、记录并精确暂存本项 5 个文件，不提交/推送；实际 dist 已本地更新但继续被忽略。仅验证本机 built Node 的入口装配和降级，不宣称实际 footer 渲染、源码/Bun 各运行时均已实测。

本轮 P7.6–P7.7 可独立范围收口：MCP/LSP 默认加载、来源禁用、重复注册及重载释放验收补齐；statusline 已迁移的旧版本探测退役。共新增两个 CI 实例、扩展一个既有实例，6 个不同定向检查；未增加 job/超时或保留重复单包测试。仍有消费者的 MCP typed-source 适配、LSP manifest/旧配置与历史附件兼容继续保留；默认执行边界切换、真实文件/命令接入及依赖其安全保证的访问控制退役仍等待 P3，完整 P7 不宣告完成。P0 真实桌面回放与历史清理待办沿用原记录。

## P7.8 剩余范围、整体验收索引与对话交接（完成，交接已接收）

2026-10-31，用户要求先核对 P7 剩余和整体验收缺口，本轮结束后创建新的推进/审核两个对话，再归档旧对话。独立范围复核 revision 360 / turn 01a19138-ec1d-7371-9aec-a654c4844b81 确认：当前状态表仍停留 P7.1/P7.2，与 P7.3–P7.7 完成记录冲突；尚未取得新的生产缺陷或可直接删除 shim 的证据。下一最小项只校准当前状态、为第十一节十二组要求建立证据索引并交接，不为继续推进新增生产改动或重复测试。原章节中的阶段性状态保留为历史记录，以第十三节当前状态表和本节分账为当前入口。

### 十二组验收的当前证据与缺口

下表引用的是各原实施记录的限定验收，**本轮未重新执行这些测试，也不将记录汇总升级为整套方案通过**。源码位置、仍在使用的入口与记录一致性另作只读核对；时序、平台、性能数字仍属于原记录。

| 组别 | 已有证据索引 | 当前结论与剩余边界 |
| - | - | - |
| 装配 | P1.2、P1.3b.2b、P2.3b.7、P5.6、P6.9b、P7.6/P7.7 | 零扩展基础工具/任务、显式 child 资源、选定真实 manifest、owner 唯一和重载已有证据。普通 SDK 不自动注入启动器全集；选定组合通过不等于任意第三方扩展组合或新执行后端通过。 |
| 文本传输 | P0.2、P1.1 的真实 PowerShell/Git Bash 及既有传输检查 | 已验证的编码、原文、反斜杠与桥接契约保留；不泛化为任意解释器、平台或命令写法。 |
| 图片输入 | P0.1 自动检查；P7.4 现代/历史路径与显式重试；P7.5 真实 Windows 短/长目录别名 | 代码与限定合成验收完成。真实 Ctrl+V/Alt+V、截图/应用/Explorer、附件标签与实际发送、普通文本回放仍是用户明确保留的 P0 桌面待办。 |
| CodeMode 结果 | P0.2、P1.3a 的失败归集、计算预算与外部等待记录 | 保留解析失败零子调用、allowFailure、取消/超时和结果处理边界；部分结果不改写为全成功，未覆盖的第三方结果路径需独立证据。 |
| 文件一致性 | P2.1–P2.3b.7 的原生提交、revision、身份和调用绑定记录 | 原生 correctness/owner 范围完成；过期 revision、外部变化和冲突仍按既定契约拒绝。文件正确性不能代替系统级隔离或授权。 |
| 部分变更 | P2.3b.4 原生操作、P2.3b.5 批量、P2.3b.6 changes | 保留逐项真实结果、提交之后的取消与未知状态；不宣称整批原子提交或完全回滚。 |
| 授权与批量 | P2.3b.1、P3.3.1/P3.3.2 及后续最终复核、撤销记录 | 当前已审查的调用绑定与授权契约继续有效；新后端覆盖尚未成立，旧 controller、grant 总线和访问控制不得据此退役。 |
| 任务生命周期 | P1.3b、P3.3.5b/d，以及 Browser/MCP/LSP 各自实际收尾记录 | 已登记 owner、子任务/进程实际结束、等待/取消及失败保留已有证据；不扩大为任意未登记的第三方后台活动。 |
| 实际隔离 | P3.4、P3.5.1、P3.5.2 与第十五节新候选记录 | **整体未完成，Windows Sandbox 多项固定范围验收通过**：空白生命周期、固定 Node/PowerShell 任务、宿主剪贴板 Win32 存储完整性、带阳性对照的固定 IPv4 TCP 禁网、专属 RO/RW 与六个未映射路径、固定单进程主动取消/独立超时、固定三进程树的 VM 边界收尾已分别取得一次通过证据，具体限制、失败前置及清理事实见第十五节。固定 MXC 兼容候选剪贴板失败不变，Linux/NVX 不在本轮。RW output 硬磁盘容量边界、任务与监督/结果权限分离、实际工程受保护路径及变更回接仍未完成，不开放任意任务；生产工作区接入、P3.6、默认切换及相关权限退役继续关闭。 |
| 模式与撤销 | P3.3.5a–h11、P5.2/P5.4/P5.7、P7.1/P7.6 | 已登记能力的暂停、撤销、实际 drain 与显式选择模式已有证据；只读工具目录、Plan 和服务收尾不等于 OS 隔离或远端副作用授权。 |
| 配置迁移 | 第三/十/十五节约束，以及 P3.3、P5/P6/P7 的旧宿主、失效上下文和兼容记录 | 当前兼容含义不扩大；新执行 profile 的完整迁移与默认切换仍等待 P3。旧 full-access/never-ask 不自动映射为无限制宿主执行。 |
| 原生协议 | P5.1–P5.7、P6.1–P6.9、P7.1–P7.7 | 工具目录、提示词、请求/压缩、会话 lease 与附件约定按各项范围完成；保留历史数据、旧宿主与低层兼容域，不承诺任意第三方 hook 顺序无关、透明重放或所有运行时均已实测。 |

### 剩余工作按依赖分开

- **可独立完成，本项执行：** 更新过期状态行、以上十二组证据索引、兼容消费者清单与两新对话交接。零新增测试、零构建、零分配基准；本轮未修改生产文件，热路径分配增量为零。
- **有条件可独立推进，当前不自动启动：** 用户决定恢复的 P0 真实桌面回放；针对未来明确支持的平台/宿主补充源码或 Bun 等入口验收；或由可复现缺陷、新实现、已完成消费者迁移明确触发的小项。现有缺口不能通过无目标地反复跑组合消除。
- **必须等待 P3：** 合格后端上的真实文件/命令和子进程接入、全部开放入口的隔离覆盖、P3.6 与默认 profile 切换，以及以此为前提的 P4/P7 controller、危险推断、grant/permission 总线和访问控制退役。已登记服务的 drain 通过不能替代这道门槛。
- **兼容保留不等于待删缺陷：** session-memory-manager 的 lease.ts 仍由 core.ts/index.ts 使用；subagent 的任务转发仍被实际入口使用，机制已属原生，角色/provider 工作流可以扩展化；MCP typed-source 适配、LSP manifest/旧配置和历史附件读取仍有用途；subagent/Browser 仍消费 permission-contract。project-context 已优先读取公开版本，其 fallback 与 optional peer 契约有关，不能机械套用 statusline 删除结论。

P3 恢复验证需要能改变失败结果的新实现证据：固定发布或提交、适用系统与实际配置，并能指出对 EmptyClipboard/宿主状态保护或独立窗口站边界的有效改变；若选择 VM 方案，先明确剪贴板共享关闭、传输、文件映射、网络、实例归属及取消契约。新证据先经只读范围审查，再运行最小有区分力的验证；原始宿主前后内容完整性判据保留。不把 issue 关闭、测试 PASS、同窗口站的不同 desktop 或重复同一矩阵当作恢复条件。P7.8 原收口仅引用当时既有固定候选调查，未作新一轮官方发布检索；其后 NVX 只读核对及停止条件见第十五节新增记录和下方交接补记。

### 新对话交接边界

旧推进对话为「检查补丁并简化权限说明」（01a17997-5f5c-71c1-96e2-06da39d5ab48），旧审核对话为「Super Pi 执行边界解答与代码审查」（01a18987-e943-7402-8cab-4ac19d72c6ab）。本项审查、记录后，新建两个本地 Pi 项目对话，分别承担推进和独立审核；沿用同一工作目录，不复制大历史、不创建另一套测试/构建产物。确认新对话建立且交接已接收，再归档两个旧对话。创建/归档结果以应用操作回执为准，本段不提前声称已完成。

交接必须携带：D:/RMProjects/Pi、根 AGENTS.md 与 docs/performance/hot-path-allocation-contract.md；先最小范围确认再执行，每项实现→独立审查→记录→精确暂存后才进入下一项；工作树相对 index 才是新一项增量，相对 HEAD 的差异会包含全部尚未提交的前序暂存改动。禁止无授权提交/推送、reset/clean 或清理用户更改。保留九份原有文档删除（interactive-control-image-input、native-batch-cwd-integration、native-files-next-phase、next-phase-n1/n2/n3/n4-evidence、next-phase-usability-reliability-efficiency、upstream-pi-0.99.1-diff-assessment，均在 docs/）、未跟踪的 super-pi-clipboard-fix.patch，以及已更新且按原规则忽略的 statusline dist。历史审批拒绝清理只沿用原记录；新任务产物按记录的绝对身份清理，不扫描/删除用户会话。新对话先核对交接与当前状态，等待下一项明确输入或有效证据，不自动重开 P3、不添加无证据清理项。

独立最终只读审查 revision 362 / turn 01a1913c-f455-7ec2-85c7-5701f284a51d 通过，无阻断。本轮只修改本方案，静态核对十二组名称及顺序与第十一节一致，diff check 通过；零测试、零构建、零新增 CI 实例，未创建临时目录、下载或研究产物，无新增清理负担。P7.8 文档工作已审查、记录并精确暂存，不提交/推送；对话创建、交接接收与旧对话归档另以其后的实际应用回执确认。

应用已创建同一 Pi 本地项目中的「Super Pi 推进与验收（续）」(01a1913e-febe-7282-9fed-15e2dfae6eed) 与「Super Pi 独立审核（续）」(01a1913e-86e1-7822-a7f1-7fcbf5082ff4)，hostId 均为 local。两者已完成只读交接确认，核对 AGENTS、性能合同、当前状态表与本节，并明确接收 P3/P0、Git 和小项审查边界；推进方收到新审核 ID，审核方也收到推进 ID。两者未启动代码、测试或额外审查，当前 idle 等待下一明确请求或有效证据。接收回执分别为新推进 revision 3 / turn 01a1913e-ffe0-7dc1-81b2-b2e36f6e1618、新审核 revision 2 / turn 01a1913f-2e38-7420-843c-75ef8f586517。交接记录已完成；随后归档两个旧对话，归档成功与否以应用回执为准。

### 续对话交接补记：NVX 固定 bundle 证据边界（2026-10-31）

新推进/审核对话已完成 NVX 的有界只读预审与固定包来源核对，详细来源、摘要、三项缺口及恢复条件统一记在第十五节「NVX 固定签名 bundle 的只读来源核对与恢复门槛」。当前结论为：固定签名包是候选，实际 native 宿主/guest agent 的空文件策略、全拒网络拓扑和剪贴板/宿主代操作范围未闭环，**最小本机验证继续阻塞**。发布标签不能代表包内全部组件来源，包内 provenance 与签名状态属于声明；不要改写为已独立构建复验、已证明隔离失败或已满足最小验证条件。

本段为 NVX 轮次的历史交接：该路线恢复研究仍须先补齐绑定固定制品的三项通道证据；当时未获安装、启用功能或实测授权。随后用户已改选 Windows Sandbox 并允许开发/实测新候选，Linux/NVX 移出本轮验收，以第十五节新授权和下方交接为当前入口，不再将 NVX 的缺口当成 Windows 专用实现的启动前提。P0 桌面回放继续待办，完整 P7 不宣告完成。

证据结论复核回执为新审核 revision 23 / turn `01a1916f-5a62-7943-b3b4-24ddc82bbe5e`；该次审核没有重复读取发布包，明确区分推进方制品观测与审核方证据判断。本次用户另授权将结论补入方案/交接并经文档复核后精确暂存。独立文档审查 revision 27 / turn `01a19175-7873-7601-968a-24db72eb9c86` 通过，无阻断；按其建议将取消限制精确为同步 native 启动调用期间，而非遗漏既有启动前检查。审核仅看相对 index 的本项增量，未重审前序暂存改动，未重复取证或测试。本项文档补录、审查与记录完成，差异/空白检查通过；精确暂存后已核对仅本文件 index 条目变化，其余 1,871 项不变，原有工作树状态与本项开始一致。新增内容仅限本方案，保留原暂存改动、九份原有文档删除和未跟踪原始 patch，不提交/推送；无本项临时文件需要清理，历史清理受阻记录不变。

### 续对话交接补记：Windows 专用沙箱恢复开发（2026-10-31）

当前用户授权以第十五节「P3 Windows 专用沙箱最小实现与实测」为准：开发单人、单会话、串行 Windows Sandbox 候选，Linux/NVX 不在本轮验收内；旧的“没有独立最小项”停止结论已被这项明确新范围替代。生产真实工作区接入、默认切换与权限退役仍须验收，P0 桌面回放待办不变。

本项已完成固定 PowerShell/Node 任务包及受限输出协议，最终 3/3 定向检查和 diff check 通过，独立审查 revision 42 / turn `01a19247-bef6-70f1-ba05-84fa77ef93c3` 通过，无剩余阻断；已精确暂存本项四个文件，其余 1,871 个原有 index 条目不变，九份原有文档删除和原始 patch 保留，不提交/推送。准备子项收口时未启动 WSB 或启用功能；其后用户授权的启用回执见下一段。实际 CLI schema、实例归属、超时取消和退出确认尚未验证，不得直接执行 guest 负载或开放任意命令。只运行因新实现而必要的检查，失败按事实修正，不重复原 MXC/NVX 矩阵。

2026-11-01，用户已批准立即启用、重启另行安排。Windows Sandbox 功能启用成功，状态 `Enabled`，操作回执明确 `RestartNeeded=true`；使用 `-NoRestart`，该次操作没有重启系统或启动实例。启用回执收口时等待用户自行重启，重启后状态见下段。不要再次询问同一次功能启用授权，也不要将该授权扩大为自动重启。独立文档审核 revision 46 / turn `01a19292-f70a-7d03-9cd5-5a7a8cd62edd` 通过，无阻断；系统事实依据推进方操作回执，审核未重复查询或执行。差异/空白检查通过，本项仅精确暂存本方案，不提交/推送；P0 待办、生产入口未开放和原有 Git 边界保持。

用户随后已重启，功能 Enabled，但该次查询尚未发现新版客户端包与 wsb CLI。当时最小前提是一次用户在场的官方客户端初始化，不是重跑功能启用或等待 NVX 新证据。空白禁网/禁剪贴板、无映射/无命令的初始化配置完成准备时尚未执行；具体步骤、窗口归属和退出证据限制见第十五节记录。重启后独立审核 revision 7 / turn `01a192af-5846-7943-999a-1d83d4502f02` 通过，无阻断，审核未重复查询、测试或启动。XML 静态核对及差异/空白检查通过，准备子项仅精确暂存初始化配置和本方案，不提交/推送；无本项临时产物，不自动重启，P0 桌面回放继续待办。

用户继而明确授权“现在初始化，我在场”，已完成一次官方初始化，Store 客户端和 CLI 为 0.8.107.0。配置路径已传递到新版客户端，但隔离生效尚未实测；实际 list 原始结构仅有 `WindowsSandboxEnvironments[].Id`，不能套用假定状态枚举。启动进程、后续客户端/server、唯一窗口和实际实例 ID 已记录于第十五节；工具仅正常关闭本次空白窗口，随后 CLI 运行列表为空且三个记录 PID 均已退出。未执行 guest 负载、CLI start/exec/stop 或强杀进程，无项目临时产物。当前入口转为验收专用生命周期实现，不再等待初始化授权或重复启动；生产工作区、默认切换、权限退役与 P0 桌面回放边界不变。

本轮独立只读审核 revision 11 / turn `01a192ba-c7f8-7283-9f97-86aa940aae30` 通过，无阻断；审核依据推进方回执核对文档增量，未重复系统查询或实测。其确认下一最小范围为：固定 CLI 路径/版本/哈希及有界输出调用层，独立实例 GUID 和启动前空列表检查，分别记录任务/实例/进程身份；查询失败不等于空列表，实例已登记不等于 guest 已就绪。启动超时或取消须保留晚到实例责任，只有启动操作收敛且本任务实例确认消失才释放串行入口；清理不明则保留记录并阻止下一任务。先以最小检查覆盖启动中取消、停止后延迟消失、查询失败和重复清理，经代码审查后以空白实例取得真实 start/stop 回执并确认退出，才进入固定负载。本轮只补录初始化结果与交接，差异/空白检查通过，按此回执精确暂存本方案；其余 1,875 个 index 条目及原有工作树状态保持，不提交/推送。

用户继续授权后，空白生命周期代码先经 revision 16 复审通过，再对 blank、cancel-start、timeout-start 各实测一次，三项全部通过并确认各自实例退出、目录清理；详细 ID、UTC、原始回执形状及性能边界见第十五节新增记录。两个通过判定误报已经修正并有反例，不以预检超时或未执行停止冒充验收。收口独立审核 revision 18 / turn `01a192db-0041-7153-b640-1fd10983e836` 通过，无阻断；仅据本轮回执审查文档，未重复实测。差异检查通过，精确暂存三个新增代码/测试文件及本方案，其余 1,875 个既有 index 条目保持，原九份删除及 patch 保留，不提交/推送。至此才进入固定 PowerShell/Node 子项：绑定包请求、任务与实例 ID、目录身份/哈希；exec 仅固定入口，分别记录三层退出事实；执行超时须先允许停止实例，再确认执行调用收敛，两个条件都满足后才读取结果和清理。生产真实工作区、默认切换、权限退役仍未开放，P0 桌面回放继续待办。

固定任务接线已先经 revision 20 代码审查，再以 Node、PowerShell 各一次取得真实输出和 23/17 子任务退出码；两次都确认实例退出、7 个 CLI 调用物理结束并按身份清理任务包/owner。exec 实际回执 `{"ExitCode":0}` 已用于补齐严格解析，三层退出码保持分开，解析只做基于已取回执的定向检查，没有重复实测。详细任务/实例/目录身份和剩余隔离缺口见第十五节新记录。最终独立只读复核 revision 22 / turn `01a192e4-808c-70c2-81a5-6f29b252cee2` 通过，无阻断，确认无需重跑实例；审核依据回执检查代码/文档，没有再次实测。差异检查通过，本项仅精确暂存生命周期、定向测试、新固定入口及本方案四文件，其余 1,876 个 index 条目不变，九份原有删除和原始 patch 保持，不提交/推送。本项产物已清理；后续不据此次成功直接开放生产工作区或默认切换，P0 待办不变。

宿主剪贴板项已按 revision 25 确认最小范围，修正两处代码阻断后获 revision 30 复审通过。一次前置流程遇到未支持格式 49406，在 GetClipboardData 内容读取和实例启动之前结束；不是通过或候选失败结论。编译检查的两个产物经用户手动删除且只读确认不存在；新运行目录由既有身份清理机制确认移除，当前无本项遗留进程/目录。具体来源摘要、上下文/完整性判据及审批拒绝历史见第十五节。当时等待用户选择准备新的可丢弃纯文本或保留阻塞，未自动修改或重试；生产接入、默认切换和 P0 边界不变。最终独立只读收口复核 revision 35 / turn `01a19313-0e68-70b3-a693-63b672310f0b` 通过，无新增阻断；确认可按“验证代码准备完成并已审查、真实完整性验收前置阻塞”保存成果，不必为暂存等待用户回复。审核未运行测试、助手、剪贴板查询或实例。已精确暂存方案、生命周期、clipboard 驱动、host/guest C# 助手和 clipboard 测试六文件；index 总条目由 1,880 增至 1,884，其余 1,878 条的完整 stage 记录摘要前后均为 `4013C5325FCB2FA28FAD56526E2ED4763D448F4A768181C6E29C13741F51CF7F`。目标文件与 index 一致，差异检查通过；九份原有未暂存删除和 `super-pi-clipboard-fix.patch` 保持，不提交或推送。

用户准备文本后的单次恢复流程仍以前置拒绝结束：格式 49161 不在已审支持集合，未读取内容、形成快照、启动实例或执行来宾操作。用户回复已落实为一次新任务，不再处于等待用户准备状态；按已审条件停止，不循环要求复制、搜索或扩展格式。三个本项进程退出和专属目录清理均确认，代码未变，只补本方案记录。生产真实工作区、默认切换和 P0 待办保持；独立只读收口复核 revision 38 / turn `01a1931b-1fad-7a22-b1f4-4aacce6dbcff` 通过，无阻断，允许仅精确暂存本方案文档；审核未运行测试、助手、剪贴板查询或实例。本轮仅精确暂存该文档，工作副本与 index 一致，差异检查通过；总条目仍为 1,884，其他 1,883 条 stage 记录摘要前后均为 `AF368A3FB6CE507397EE5F4C91C4CD81D16F2BD3032163CF059AD66A8041C78D`。九份原有未暂存删除及原始 patch 保持，不提交或推送。

格式 49161 的新只读核查已完成：一次名称查询确认本机注册名为 DataObject，官方注册格式 HGLOBAL 存储契约为最小兼容提供依据。独立审核 revision 44 / turn `01a1931e-bb68-7e52-81de-ec8214c6e895` 通过兼容设计及文档预审，明确保持全格式/全存储字节/元数据比较；须动态名称匹配、C# 与 JS 同步严格类型校验、完整有界摘要及正确判定 GlobalUnlock 结果，不能忽略未知或推断块外对象语义。具体官方来源、一次本机只读观察、必要检查和实施边界见第十五节新记录。当时授权仅核查/记录，未改代码、读取内容、运行快照或启动实例，不要求用户再次复制；真实完整性验收仍阻塞，生产接入、默认切换、权限退役及 P0 待办保持。本轮仅精确暂存本方案文档，工作副本与 index 一致，差异检查通过；总条目保持 1,884，其他 1,883 条 stage 记录摘要前后均为 `AF368A3FB6CE507397EE5F4C91C4CD81D16F2BD3032163CF059AD66A8041C78D`。九份原有未暂存删除和原始 patch 保留，不提交或推送；本项无新增项目临时产物或待退出实例。

DataObject 兼容实现已获 revision 51 先行代码审查，并完成一次三项定向验证（3/3 通过、native 42 个断言）。只有自有内存 fixture 执行，原宿主剪贴板入口和实例均未运行；本项编译/检查进程已退出，UUID 目录已清理。未知格式整体拒绝、完整摘要、非空标准文本和既有隔离判据保持；生产工作区、默认切换、权限退役与 P0 边界不变。最终独立只读复核 revision 54 / turn `01a19354-fba2-7f40-8795-728d3ee6d414` 通过，无新增阻断，允许仅精确暂存 host、driver、定向测试、native fixture 和本方案五文件。实现层阻断已消除，恢复单次实测的现场前提见第十五节；该实现子项当时没有恢复授权，也不需要再次复制。审核仅检查来源、差异、记录与摘要，未重复测试、助手或 VM；其他 index 摘要以主推进实际核对为准。本次已精确暂存上述五文件，index 总条目由 1,884 增至 1,885，目标工作副本与 index 一致，差异检查通过；其他 1,880 条 stage 记录摘要前后均为 `6B8C0AA1DFDABDFAE8496FE1E23A9B9EBBC80542BF00A26A5359CBEEFC80DEC4`。九份原有未暂存删除及原始 patch 保持，不提交或推送；本项临时产物已清理，无新增常驻进程或实例。

用户随后明确授权的一次 host-v2 恢复流程已执行到前置检查并停止：format-count-bound 表示格式数量不满足 1–5 项判据，回执没有具体数量，不猜测是空列表、超限或某种未知格式。首份基线、DataObject 内容读取、CLI/实例/来宾操作均未发生；三个本项进程已结束、专属目录已清理。旧实现层审核通过事实保留，真实完整性验收继续前置阻塞，不自动重试、不反复复制、不放宽阈值；生产接入、默认切换和 P0 边界保持。最终独立只读收口复核 revision 55 / turn `01a19361-79f9-7e80-ad66-1a8b2d09596a` 通过，无其他文档审查阻断，允许仅精确暂存本方案；审核未运行测试、编译、助手、剪贴板查询或实例。本轮已仅精确暂存该文档，工作副本与 index 一致，差异检查通过；总条目保持 1,885，其他 1,884 条 stage 记录摘要前后均为 `830012FF7BD680B70D4EC0E3C644460BCD149DA71B785771D6170B884CD3C791`。九份原有未暂存删除及原始 patch 保留，不提交或推送；本项运行产物已清理，无待退出实例或本项进程。

只读格式清单诊断已按先审后运行完成：两项纯检查通过后，仅一次查询完整取得 7 项格式及注册名称，新增明确缺口为 EnterpriseDataProtectionId（49356）和 Ole Private Data（49171）尚未支持。顺序名单、一次时点/归属标记、源码与制品摘要、进程退出和目录清理证据见第十五节；不能回填前次失败数量，诊断完成不等于内容完整性或隔离通过。原五项准入、内容读取实现和旧测试均未改，不追加查询/搜索/实测或反复复制；生产真实工作区、默认切换、权限退役及 P0 待办保持。最终独立只读复核 revision 60 / turn `01a19395-6450-71e0-81ba-a349820bb892` 通过，无新增阻断，确认记录与回执一致，允许仅精确暂存元数据 C# 程序、诊断入口、纯检查及本方案四文件；审核没有重复检查、编译、查询或实测，没有代为暂存。本轮已精确暂存上述四文件，index 总条目由 1,885 增至 1,888，目标工作副本与 index 一致，差异/空白检查通过；其他 1,884 条 stage 记录摘要前后均为 `830012FF7BD680B70D4EC0E3C644460BCD149DA71B785771D6170B884CD3C791`。九份原有未暂存删除及 `super-pi-clipboard-fix.patch` 保持，不提交或推送；本项产物已清理，无待退出进程或实例。

用户新授权的注册 HGLOBAL 统一支持已完成，设计/代码/记录分别经 revision 62/65/68 审查通过；三项受影响检查通过，native 54 断言及自有内存释放确认，代码项五文件先精确暂存并保持非目标 1,883 条摘要。随后唯一一次交互实验 task f9b3b243-bba8-4423-9601-a6f84169cb2b / instance e7035af2-e495-48fd-89db-344eed2557c3 通过：实际七项（HTML/Chromium 注册类及四标准格式）、42,030 字节，五阶段全存储摘要与名称/顺序/长度、owner/sequence/宿主上下文一致；一轮来宾清空/写入/回读成功，实例、连接、窗口、exec 和全部助手退出，运行目录按身份清理。此为限定 Win32 存储完整性通过，不是上轮 DataObject 等三种注册名称的现场实读或任意 OLE 语义/整体隔离通过。具体时点、窗口归属、源码/制品摘要和计数见第十五节；不重复实验。下一最小项是有明确对照的禁网验收方案预审，文件边界、执行中取消及 RW output 容量/结果证据保护继续按计划推进，生产真实工作区、默认切换、权限退役及 P0 边界保持。结果分类复核 revision 69 / turn `01a193d4-fb33-7de1-83f2-1c9d1d774354` 及最终记录复核 revision 72 / turn `01a193d6-22af-78a2-935c-d8ef360039dd` 通过；唯一非阻断措辞已将“上轮纯文本元数据清单”更正为“上轮只读元数据清单”，不从元数据查询推断内容类型。审核未重复测试、查询或实测，允许仅精确暂存本次方案记录。

本次实验结束后仅补录并精确暂存方案文档；本小项四个代码/检查文件与方案共五文件均与 index 一致，差异/空白检查通过，index 总条目保持 1,888，非目标 1,883 条完整 stage 摘要仍为 `49F8BE023D3B7A3D624D375C11413DE62336FF6D232AB5DC85486F8D4C30330C`。原九份未暂存删除和 `super-pi-clipboard-fix.patch` 保持，不提交或推送。定向检查及实测产物已按各自记录身份清理，无本项待退出进程或实例。

带阳性对照的禁网验证已完成方案/代码审查及四项新定向检查，先精确暂存六文件后仅执行一次现场流程。task `8e79c77b-6aae-4349-82e2-96574cea3caf` 只完成一次固定域名解析，第一个宿主 health-before 的接口元数据阶段即因 `InvalidOperationException` 停止；TCP 尝试为 0、实例为 0，结果为前置证据不足而非禁网通过/失败。编译、DNS、health 三个助手均退出，运行根和检查目录均清理并确认不存在；具体摘要、计数、分类及时间见第十五节。流程停止后没有复测剪贴板、追加网卡查询或重跑网络流程。恢复前需要针对明确失败阶段审查有界元数据诊断，先获得具体失败分支依据，不能猜测未知类型、提高上限、忽略接口或以网络重试代替诊断；本轮不追加该诊断执行。文件边界、完整执行中取消、RW output 容量与结果保护仍未验收，生产真实工作区接入、默认切换、权限退役继续关闭，P0 桌面回放继续待办。

最终结果与文档只读复核通过，最后澄清确认回执为 revision 89 / turn `01a193f2-3c1d-7b42-ae0b-0f42c0c84a7f`，无新增记录审查阻断。审核只读取文档增量并依据实际回执判断，没有重复查询、检查或实验，也没有代为暂存。下一最小范围是先审独立元数据诊断入口，再仅一次走相同接口收集/校验路径，报告受控阶段/原因码及已经取得的必要数量、失败索引、类型/状态值；系统 API 异常记录类型及可用错误码。维持原有界限，失败即停；入口须与 DNS、TCP、健康探针及实例路径隔离，明确原因并审查修正后才能讨论恢复条件。本轮不执行该下一项，也不自动恢复网络序列。

结果复核后仅精确暂存本方案记录；本项六文件均与 index 一致，差异/空白检查通过，总条目为 1,892。原六文件集合之外的 1,886 条 stage 摘要仍为 `B9F88CBD4F70AD23E1823D8D6A4427D2180F23D800ADB235AE5A3B82BA14FBC9`；此次单文档暂存之外的全部 1,891 条摘要前后均为 `EE0ED5EE63FF46E86B53D94A3E806E63C0F308DC186EE5FF6465BA866612571F`，五个代码/检查文件保持已审版本。九份原有未暂存删除及 `super-pi-clipboard-fix.patch` 保留，不提交或推送。本项检查及现场流程产物已按记录身份清理，无本项待退出进程或实例。

用户继续授权后，独立接口元数据诊断已完成代码预审、两项检查（native 27 断言）及唯一一次查询。task `90e8448d-5b70-4124-8188-0151e0b5e4f0` 取得总数 6，在索引 0 的类型 53 拒绝处即停，未读字段为 null；不是接口数量超限，未 DNS/TCP/VM。官方 SDK/IANA 对 53 有明确类型定义，修正方向是精确识别并继续完整检查该接口，仍按非 loopback 的状态判据处理；其他未知值不放行。详细来源、摘要、时间和清理见第十五节。独立结果/文档复核 revision 101 通过；诊断六文件已精确暂存，index 1,896，集合外 1,890 条 stage 摘要保持 `C9429A59109933481E9EA928A5475E62384A0C744BEF39FB2AF6FF9D86025336`。原删除/patch 保留，本项进程及产物均清理，不提交/推送。先审精确兼容补丁与反例，再讨论恢复条件，不因诊断完成自动重跑网络流程；生产接入/默认切换/权限退役继续关闭，P0 待办不变。

随后仅类型 53 的 C#/JS 同步兼容及反例已完成，代码预审 revision 106 通过，两个受影响用例通过、native 30 断言，检查进程/产物清理。保留完整接口和全部既有状态/数量/网络分类判据；生产热路径未改，无新增常驻任务。按单项边界精确暂存四份代码/检查及方案，其他 1,891 条 stage 基线为 `AD4F9F85683D7AC73D430A5F3257088F5DF05C05B1B1C04316E6960E0829554D`。恢复原一次对照流程须先核对已审来源、固定工具与独占归属，并经条件复核；不追加一次元数据查询来预跑，不将纯检查通过记为现场隔离通过。

恢复条件 revision 111 确认后，唯一一次 run `10436052-a2c2-4198-a466-78d8b8e3b777` 完成原五阶段：三个宿主健康和 Enable 来宾均取得完整预期响应；Disable 来宾仅 loopback、一次 TCP 返回 10051、未连接或传输。两个串行实例、14 CLI 和5助手全部实际退出，owner 清理并确认不存在。结论为固定 IPv4 TCP 禁网限定通过；宿主各阶段自身前后稳定，跨阶段 6→7→7 的事实保留，不外推整体设备/协议隔离或新增设备归属。最终分类与记录复核 revision 113 / turn `01a19411-7fbb-7c41-bbe7-2379ec1d2d0a` 通过，仅精确暂存方案文档；实现与检查维持已审版本，总 index 1,896，原五文件集合之外 1,891 条摘要仍为 `AD4F9F85683D7AC73D430A5F3257088F5DF05C05B1B1C04316E6960E0829554D`。无本项待退出进程/实例/产物，不提交推送，原删除及 patch 保留。按用户持续推进授权进入单实例固定等待负载主动取消的先审准备，文件边界、后代树、独立超时及输出硬容量等缺口保持；生产工作区/默认切换/权限退役关闭，P0 待办不变。

固定单进程主动取消已完成先审代码、三项定向检查和唯一一次实测。task `2d450b13-baa1-432f-aa59-b623cb774b19` / instance `0fa4710e-aea8-4ac0-a0de-da6eb8f8d689` 在 ready 后约 893 ms 计划取消，执行仍活动，含清理全程 1,731.2528 ms；stop 成功，最终实例为空，exec 物理 close、全部 pending 清空、产物移除。exec 的非零 `0x80370107` 只记物理结束事实，stderr 有损解码未被当成可准确还原的文本。最终复核 revision 126 / turn `01a1941c-bfb5-7da2-bfa0-ecd0b8836d80` 通过；五文件精确暂存，index 1,899，集合外 1,894 条 stage 摘要保持 `632C876F9CF4564BA10BB387A7BC01F5AE4102EFDA59B7BB6A280376AC9861CB`。原删除/patch 保留，不提交推送，无本项遗留。下一最小范围为专属可丢弃 RO input / RW output 与未映射私有、邻接、合成 .git/.sp 哨兵对照，宿主先证明哨兵存在、退出后核对未变，只尝试固定有限路径，先审后测；任意路径/链接、可写工程根内部排除策略、RW 硬容量、独立超时和后代树仍待验收，生产接入/默认切换/权限退役关闭，P0 待办保持。

专属可丢弃文件边界单次 task `cf5a41ce-3839-4414-8db5-599cecae71a6` 已取得限定通过：input 正读成功、申请追加权限的打开被原生错误 5 拒绝，output 正写与回读匹配，六种固定未映射路径均打开失败/错误 3；退出后五个宿主哨兵身份、长度、摘要未变。guest/exec 正常结束，stop 成功、末 list 空，编译及 7 CLI 均实际 close，owner 按身份清理。三项检查与现场证据、摘要及计数见第十五节；不扩大为真实工程内受保护目录排除、任意路径/链接、容量或恶意结果保护。代码五文件已精确暂存，index 1,902，集合外 1,897 条摘要保持 `A3816251CB2F5D52E4841A698E7D9FD92C11F584E213F1FE057B1C4D7476980A`；最终结果/文档复核 revision 142 / turn `01a1942a-8240-77e1-a61e-04cd8407169e` 通过；已将交接措辞精确到申请追加权限的打开，结果记录仅精确暂存方案。无本项遗留、未重复旧矩阵。下一最小候选为固定等待负载的独立执行时限触发，先审范围/代码；生产工作区、默认切换、权限退役继续关闭，P0 桌面回放继续待办。

固定单进程独立执行超时已完成一次实测：task `a13c69bf-c933-45c2-b365-38433fd86dd5` / instance `412e47cc-fcae-4bb5-aa81-9d21978cac60`，ready 904.3937 ms，实际 timeout 10,030.1813 ms，含清理全程 10,912.5175 ms；正常流程没有主动 abort，外部取消 false。stop 成功、末 list 空、exec 物理 close、pending 全清、owner 移除；八个调用均完成，非零 exec 仅作物理结束事实。两个定向检查和具体摘要/回执见第十五节，固定后代树仍待下一独立范围，实际工程保护、输出硬容量及结果通道边界仍未通过。代码四文件已精确暂存，index 1,904，其他 1,900 条摘要保持 `82CA77E4A81BACD2C8465ED0A34A73958C674D69322D2D1CA709B6B7B8FE7EBA`；最终结果/文档复核 revision 150 / turn `01a19431-739f-7710-b617-39e0f796987d` 通过，本次结果记录仅精确暂存方案。生产工作区、默认切换、权限退役关闭，P0 桌面回放继续待办；无本项遗留或重复实测。

固定后代树唯一实测 task `80cf80cb-d165-40e2-a7ae-93e0635f9d48` / instance `75b162b8-46b7-4cf5-8576-ff98c3315816` 已取得限定通过：parent 1820→child 1960→grandchild 2060 的实际启动边、创建时间、固定路径及 System/session 0 相互匹配，汇总活性成立；完整 ready 1,763.8303 ms 后计划取消，包含清理总时长 2,616.2291 ms。所属 VM 停止、末 list 空、exec 物理 close、pending 全清、产物移除；无逐后代正常退出或独立取消通知的宣称。三项新检查、实际源码/制品摘要及全部调用回执见第十五节。四文件已精确暂存，index 1,907，其他 1,903 条摘要保持 `7840F9506B30608E1A6D0AD0A1DD5924BC823D8A8C290D083D64806AE46FBFF6`；最终结果/记录复核 revision 158 / turn `01a1943a-d632-7933-8f23-2f162c32f204` 通过；结果与架构阻断说明复核后仅精确暂存方案。无本项遗留或重试，原九份删除和 patch 保留，不提交/推送。剩余工作须解决 RW 硬容量、监督/结果权限及真实工程适配，不以固定矩阵重复实测代替；下一最小项正在核对明确依据。生产工作区、默认切换、权限退役继续关闭，P0 桌面回放继续待办。

本轮在明确的架构门槛处停止：审核 revision 158 未发现还必须补跑且已有依据的同类固定夹具项。当前 RW 映射没有硬存储容量约束，任意任务与监督/结果通道的权限未分离，工程视图和带来源版本的变更回接协议未确定；现有文件策略/提交模块不能替代映射内部边界。下一项先只读选型与契约预审，要求官方机制依据、各主体及通道关系、系统改动清单、区分性反例和清理责任，之后才讨论新的实现/最小实验。本轮不新增磁盘/挂载/功能或实例，不用重复测试替代这些条件。生产工作区、默认切换、权限退役继续关闭，P0 桌面回放保留待办。

最终文档只读复核 revision 162 / turn `01a1943f-02c7-7321-99f4-7309dafb7154` 通过，无新增记录阻断；审核确认当前仅方案增量、原九份删除和原 patch，没有新增代码差异。本次仅追加该审核/暂存回执后精确暂存方案，index 共 1,907 条；树小项四文件之外 1,903 条完整 stage 摘要保持 `7840F9506B30608E1A6D0AD0A1DD5924BC823D8A8C290D083D64806AE46FBFF6`，四文件工作副本与 index 一致，差异/空白检查通过。保留用户原删除及 patch，不提交、不推送；无须为记录收口补跑检查或固定夹具。本轮在上述架构门槛处停止。

本轮只读架构选型已形成独立《Windows Sandbox 存储与执行契约预审》及第十五节索引，范围/关键机制分别经 revision 165/166 确认。固定 VHD 只提供局部容量候选，Sandbox 系统盘及平台开销总界限缺证据；NTFS 按所有者计费不构成简单 Task SID 限额方案。HMAC 认证信封有官方原语，但共同密钥建立、Task 与监督者对象权限、真实映射/代操作边界未闭合；Job 空也不能代表全部活动静止。工程快照/候选回接可定义，仍依赖前两门槛，最小版本明确拒绝删除/移动。契约列明系统改动、数据流、权限矩阵、关键反例、验证前置及按身份清理责任；本轮没有安装、挂载、启用功能、账户改动、编译、探针、实例或测试，没有运行产物。下一步需补足文档列出的机制证据与契约，再交审核决定最小实现/验证，不能从当前预审直接启动实验。最终复核 revision 169 / turn `01a195d2-0418-7f90-be1d-b45016287a86` 通过；revision 167 的两项意见已修正，明确预检拒绝与提交期部分结果，以及宿主 owner 持有非永久附加管理句柄至读取、解除附加确认完成的顺序。仅两文档精确暂存，index 共 1,908 条，范围外 1,906 条 stage 摘要保持 `AC5CAE6C3CD4EC3283CF3A9683CE0EBED8AE7A4D1FADB03F413F6A5C5D5E0559`；文档差异、空白、8 个本地链接及范围核对通过。原九份删除和 patch 保留，不提交、不推送；生产关闭及 P0 待办保持。本轮在明确架构阻断处停止，无需重复实测或扩搜。


用户已明确批准首版范围收敛及离线实施顺序：平台存储总硬上限不再承诺，剩余耗尽风险明确接受；全来宾不可信，不再认证其监督结果、具体来源/完整性。专属共享硬容量、宿主各项预算、外层限制和真实工程保护仍保留，旧G0/G1/G2没有通过。离线候选模块与新检查文件完成，revision 177 代码复核后唯一一次11组检查全通过，细节及源码摘要见第十五节和契约第0节。候选检查不代表任务成功、授权或提交；只由合成夹具调用，真实owner/目录适配与共享卷硬容量仍待独立审查。临时根和故障注入句柄均按身份清理，无VM、挂载或生产动作；最终结果/文档复核 revision 178 / turn `01a19603-b9ce-7b31-9254-dabf7855f2a9` 通过，四文件已精确暂存，工作副本与index一致，差异/空白和契约10个本地链接检查通过；index共1,910条，范围外1,906条完整stage摘要保持 `AC5CAE6C3CD4EC3283CF3A9683CE0EBED8AE7A4D1FADB03F413F6A5C5D5E0559`。无需重跑检查；原九份删除、patch、生产关闭和P0待办保持，不提交、不推送。

任务专属固定VHD生命周期实现已完成代码复审与限定检查：单一持续持句柄助手、128MiB固定盘、从句柄到镜像/设备/分区/卷的身份链、唯一GUID/exchange候选路径，无普通目录/盘符回退，shareAdmission保持false。宿主实时读取/释放门槛与候选字节租用分离，close-unknown、助手/日志/身份异常保留责任并传递撤销取消。revision194放行8组后首轮7组通过，第8组PS语法失败；revision196语法修正后仅第8组发现替身注入变量别名问题，revision199修正复核后第8组及20项分支通过，最终872.181ms。没有重跑前7组或旧矩阵，累计4个临时根已按身份清理，编译/替身进程全部结束，实际磁盘/管理助手/VM为0。源码摘要、完整失败与修正回执见《Windows Sandbox 固定共享卷实现方案》第7节；最终结果/记录复核 revision201 / turn `01a19634-18a1-7ca0-b0ec-8e9a901003c8` 通过；本项8文件已精确暂存，index共1916条，范围外1908条完整stage摘要保持 `0172CE3FDD77B10EF3152676B09649CBF3860C9A687F5084B8F5C428BA26D702`，工作副本与index的Git差异为空，两份独立文档18个本地链接检查通过。下一项须先审具体现场入口及本机权限/存储条件，再验证原生GUID、固定客户端兼容与失效语义、直接写入容量拒绝；当前不把这些未实测门槛记作通过，也不重开已批准三项产品决定。生产接入、默认切换、权限退役关闭，P0桌面回放待办；原删除与patch保留，不提交推送。
当前原生单盘入口阶段已取得五组/七项替身通过（894.0717ms），经revision218复核、九文件精确暂存及摘要核对后唯一实测失败：task=72ec5342-2730-4160-8055-74d45a43416f，管理助手PID23336产生stderr，未取得prepared/probe，入口自然退出1。revision221确认失败在VHD创建前，原错误正文缺失，具体根因未知；released=false、passed=false保持。后续精确进程已退出，两文件和空根由用户在自动审批拒绝后手动删除，主任务只读核实不存在，不当作正常release通过。revision221/222仅允许诊断最小项：1024字节原始stderr、退出码/信号、清理pending/监听器后最终快照及reportedUtc时间语义，代码先审后仅两组纯内存替身；revision226两项意见在运行前修正，revision228复审后唯一两组纯内存检查通过，53.2702ms，0失败/取消/跳过，无新临时产物。本轮未再运行现场入口、管理助手、编译或存储API，也未重复旧矩阵；原错误正文不可追溯，启动根因仍未知，下一次具体诊断/恢复范围须先交审核。原生GUID/正常释放仍未证明，WSB路径兼容、硬容量、异常失效和真实候选接线继续等待；详细失败与清理证据见固定共享卷实现方案第8节。index共1919条，范围外1910条stage摘要136339B1DE1F33B5A7B8936BAB10BA5F1AFF8F25814D8A6441115A9AF429DC64，原九份删除/patch、三项产品决定、生产关闭与P0待办保持，不提交推送。
当前新增阶段仅获取管理助手启动失败证据：revision236 / turn 01a196e4-ec49-7ee1-8f04-1ce169c66fbd确认同一真实helper的StartupDiagnostic分支，保留原参数/程序集/编码/只读构造顺序，命令循环前终止，不发送stdin，不调用Storage/权限调整/VHD/WSB。最多一次固定csc编译原C#及一次固定PS5诊断；先审代码，再四组内存检查和一组单独记录的PS5 parse-only AST，结果复核后才执行一次诊断。原始stderr1KiB、回执2KiB、记录及整体输出8KiB；超时/取消/日志失败不kill或自动重试，清理只按本项根/精确叶子身份及证据交付后执行。详细账本/范围及后续唯一诊断结果见固定共享卷实现方案第9节和契约0.7；生产关闭、P0及原Git边界保持。

启动诊断代码已按revision239/242修正输出error和取消监听寿命问题，revision246复审后新增五组检查一次通过：四组内存、一组PS5 parse-only（PID31976/exit0），报告358.1055ms，0失败/取消/跳过；无编译、真实助手或临时产物，旧矩阵未重跑。四源码摘要与边界计数记录于固定共享卷方案9.1。revision248放行并精确暂存七文件后，紧邻核对摘要和owner不存在，唯一startup-only取得本次PS5的Get-FileHash命令解析失败：task=7b03cdef-4aa7-4429-88da-d2e08ee2bc19，编译PID30056/exit0、助手PID33408/exit1，step=assembly-check、completed=arguments、CommandNotFoundException、HRESULT=-2146233087；尚未加载DLL或构造NativeDisk，零存储命令和VM。stdout498/stderr413字节完整未截断，物理退出及证据交付后按身份清理两文件和空根，artifactsRemoved=true，固定根只读确认不存在，startupSucceeded=false不改写。revision249确认只定位本次命令解析失败，不能推定模块路径等环境原因或回填旧stderr。本轮停止，不修复/不第二次诊断；下一项可先静态审查保持完整摘要、大小和关闭判据的最小SHA-256替换。原始流及归属见方案9.2；index1922、范围外1915条stage摘要B1759DF7EC47D7F4A4752223EC4B8BB686F8FFDC2D9552E25F3144DDED836B37保持，原九份删除/patch与生产关闭、P0待办保持。

### 宿主运行时纠正：仅PowerShell 7（2026-11-01）

用户明确立即改回本机唯一D:\PowerShell\7\pwsh.exe，不需要PS5回退。固定PS5是主任务自行选型错误，现撤回继续替换Get-FileHash算法的建议；PS5历史失败和清理证据保留，不推断PS7失败。版本7.6.9、exe摘要2A6769A3330DC1084D0154BFDE7D164AB750CA7F700F313F9D417C1BE78B2233已只读核对。三个宿主入口/三个测试启动点已统一固定路径及共用SettingsFile，配置DisableImplicitWinCompat=true、摘要守卫，脚本要求7/Core/x64；不修改全局设置，不回退5。revision254范围确认后先审源码，再仅新增2组最小兼容检查（源码边界＋一次编译/一个PS7进程，含Storage原生导入和无兼容会话），不构造NativeDisk、不旧矩阵/实际startup/完整存储。详见固定共享卷方案10及契约0.8；生产关闭与P0、原Git边界保持。

首次两组检查在revision256代码复审后取得1通过/1失败：源码边界通过，PS7夹具正文前SecurityError，编译退出0、检查退出1、总529.7691ms，两个文件和临时根清理。首版专用配置遗漏宿主原有策略，revision259/260允许两次只读内联核对：默认固定PS7的有效/LocalMachine策略RemoteSigned；旧专用配置查询在Security.types.ps1xml授权检查失败，未取得有效策略值，不记成Restricted。当前修正完整保留原RemoteSigned与模块denylist，仅增加禁止隐式兼容，固定原配置及专用配置摘要，基线变化即停，不改全局或增加执行策略参数。原失败和缺失的PID/原始stderr如实保留，修正诊断改为断言前记录原始有界字节；代码复审后仅恢复新增两组一次，不执行实际助手/存储入口。详细范围、预算与后续结果见固定共享卷方案10.1。

revision262配置修正复审后一次新增检查，源码组通过，兼容组在Marshal.SizeOf的类型重载选择失败（编译PID31500/exit0、PS7 PID30320/exit1，stderr428字节完整保留），产物清理。revision263复审两行显式选择SizeOf(Type)修正后，仅恢复原失败组一次并通过：编译PID31992/exit0、固定PS7 PID20540/exit0，报告2006.8012ms；实际7.6.9/Core/x64、RemoteSigned、Get-FileHash和DLL加载、56/8/24 ABI、两份AST、Storage2.0.0.0原生导入及7命令参数均确认，兼容会话和代理0。两个新增检查分别取得通过，前两次失败保留，已通过源码组和旧矩阵未再运行；累计3次编译/3个兼容进程，各两个文件和临时根均清理。未构造NativeDisk/调用磁盘命令/启动真实助手或VM，不改全局配置；后续实际startup-only先审具体条件，本次不自动恢复完整存储。最终源码摘要和逐次证据见固定共享卷方案10.2–10.3；生产关闭和P0待办保持。

最终代码/结果/记录只读复核revision268 / turn `01a19712-c565-76d2-9669-76940993c061` 通过，以固定PS7适配及最小兼容完成收口，不追加检查或下一诊断。十三份源码摘要、两独立文档30个本地链接及差异格式核对通过；本项13份代码/配置/检查加3份方案共16文件精确暂存，index从1922增至1925，范围外1909条stage记录JSON数组UTF-8 SHA-256保持`E399071F02C52F88EBEF182C77F040FAC641984BDFEC12A03DA11E48B2243F53`，本项工作副本与index一致。原九份未暂存删除和未跟踪patch保留，不提交推送；本项运行进程及产物均收尾，生产关闭和P0桌面回放待办保持。


### 按顺序推进：固定PS7实际助手启动（2026-11-01）

用户新授权按顺序执行、审查、核对。revision271范围/代码复核后，未改源码、未重跑检查，紧邻核对摘要和独占根，仅一次startup-only通过：task=8de4ea6a-4a57-43f5-8f8d-9bdf9ae7d25c，编译PID26152/exit0、实际PS7助手PID30492/exit0；ok=true、step=complete、completed=native-constructor，stdout164/stderr0无截断，startupSucceeded=true。两个文件按身份清理、根不存在确认；无权限调整、Storage/VHD/VM或stdin调用。完整归属/原始回执见固定共享卷方案第11节和契约0.9。先复核记录并精确暂存三文档，再单独审原生单盘生命周期；不将启动通过记为存储/共享/生产通过，生产门槛及P0待办保持。

结果/文档最终复核revision276 / turn `01a19725-7d2b-7c01-a1fe-1f425117b732` 通过；本项仅三文档精确暂存，index1925条，范围外1922条stage JSON数组UTF-8摘要保持`1AD3ABD599F1C9A6B47E67138D33160433EC823ED1930290991A1696A3B77CFB`，工作副本与index一致，31个本地链接及差异格式核对通过。原九份删除和patch保留，不提交推送。下一原生单盘入口暂不执行：先修复证据输出确认前删根、以及一次性/过早移除取消监听这两项P2，完成最小代码/替身审查后再复核实际条件。已通过startup不重跑，生产与P0边界保持。


原生单盘恢复前，revision276指出证据交付前清理记录、一次性/过早移除取消监听两项P2。当前仅修手动入口收尾：主证据≤7680B交付确认后才清理、尾行≤512B；失败保留记录，已删根不因尾行失败重建。最多三调用、一次pending输出，稳定幂等信号/error监听保持到实际close和写回调全部完成，迟到close仅补记、不重清理。新增四组纯内存及一个原受影响用例先审后测，C#/PS存储/容量算法不变、无旧矩阵或现场重跑。详细见固定共享卷方案12、契约0.10；通过复核后再讨论一次真实单盘条件。

revision280完成代码复审后，新增四组和原受影响一组仅运行一次，5通过/0失败取消跳过，106.6841ms；无编译/PS助手/存储/VM或临时产物。两个pending输出时序的迟到close均持久化，三调用/重复取消、输出四故障与记录保留通过，最终监听/缓冲/引用释放。具体源码摘要、计数及7文件暂存边界见固定共享卷方案12.1；先复核/精确暂存，再审一次原生单盘条件，生产与P0边界保持。

最终结果/记录复核revision282 / turn `01a19733-ec5c-7bf1-8203-a167f41d329d` 通过，本项7文件精确暂存，index1926条，范围外1919条stage JSON数组UTF-8摘要保持`C67D0D511BA560F4F065AFE65A60A38047DF72030660C50BAB111214EF8FE99F`；工作副本与index一致，33个本地链接及差异格式核对通过，原九份删除/patch保留。审核确认紧邻核对源码、工具/两配置和独占根不存在后，可以唯一一次运行固定PS7原生单盘入口；范围只含既有只读前置、一次编译/单助手、128MiB本任务盘及prepare→verify→32字节probe→release→exit。未知或失败保留责任，不自动重试/kill，不WSB、共享、灌写或真实工程。该放行不是现场通过证据，实际结果另记。


### 原生单盘当前阻断（2026-11-01）

revision282结果/现场条件复核后，精确暂存7文件并核对源码/工具/配置/独占根，仅一次原生单盘调用：task=eb60c4fd-8ebc-4b10-bd74-93e061f58641，前置PID33352/编译PID21544均exit0；管理助手PID15524在prepare的120秒期限后未确认退出，最后正式回执creating，prepared/probe=null、released/passed=false，内部unsafe触发cancelled/revoked。主证据及尾行已交付，retained=true、artifactsRemoved=false，外层会话38438未结束。只读归属核对发现task.vhd逻辑134218240字节，volume-helper.next.json为created/imageCreated=true，imageId与该文件身份一致；因此不能记成未创建或Create API本身挂起，具体记录提交/交付原因尚未知。保留本次根内5叶和助手，不重试/kill/删盘/扩大时限。下一项仅先审记录与句柄/附加状态的最小只读诊断；本轮在此阻断，WSB共享、真实工程/默认/权限退役及P0未推进。完整时间、元数据和待提交回执见固定共享卷方案13。

最终记录复核revision285 / turn `01a1973d-a590-73a3-b3a4-fc3bf6ecb6a7` 通过，按其一项时序意见明确区分120秒逻辑截止和随后created观察，未推定创建发生在截止前。本次仅三文档精确暂存，index1926条，范围外1923条stage JSON数组UTF-8摘要保持`1564EB8818F7CE0C08A865186D3C23B3D755A71764B9540757C5F40D64F74386`，工作副本与index一致，33个本地链接及差异格式核对通过。代码/检查保持已审已测版本，原九份删除及patch保留，不提交推送。本轮停止后续诊断/磁盘查询/重试/清理，助手、会话和5个归属文件保持未决，不能宣称本项产物清理完成；下一项不得越过该owner，生产/P0边界保持。

### 记录替换原因与最小修正（2026-11-01）

按用户“查明原因，继续”，revision286/290/293先审诊断与修正：固定PS7原Write-State第二次File.Replace($null)明确抛出空路径ArgumentException（HRESULT=-2147024809），正式creating/next=created，仅1次stdout；同重载真正null对照成功。最小改为NullString.Value后，同一单组一次通过，两份stdout与正式created一致、next消失。修正前1fail保留为机制证据；两轮小型诊断进程退出、独占根和3/2小叶已清理，未加载C#/Storage、未操作VHD/VM或跑旧矩阵。旧助手异常仍未直接捕获、函数没有热更新，第13节旧owner及五叶继续保留。下一步仅已审指定镜像一次只读附加状态查询，再独立审恢复；不越过旧责任重跑入口。详细原始字节数、摘要、性能/预算及六文件暂存边界见固定共享卷方案14、契约0.12。生产真实工作区/默认/权限退役关闭，P0待办。
### 旧任务外部恢复与精确清理完成（2026-11-01）

revision293/295的一次只读查询确认旧镜像在观察时点未附加；revision298/302另审一次性恢复，绑定准确helper15524句柄仅终止一次，实际exit125，parent24964自然exit1，原会话38438退出1；原owner补齐helperClosed/pending=false/buffersReleased和三物理调用关闭，恢复器自身句柄均关闭，前后镜像未附加。revision304/308再审精确清理，单次独占只读打开从句柄核对镜像身份/长度并确认关闭，正文读取0；删除前交付完整最终归属证据，逐路径清除原五叶/空根及本轮两临时源，退出0、artifactsRemoved=true。历史passed/released保持false，不把外部恢复记作正常release通过。详细时间/身份/摘要见固定共享卷方案15，当前没有旧owner遗留；下一步待复核修正后的唯一原生单盘条件，不重跑旧矩阵。生产真实工作区、默认及权限退役关闭，P0待办。
### 修正后原生单盘正常生命周期通过（2026-11-01）

revision310条件复核并完成记录暂存/紧邻前置核对后，task8da73fd7-3423-4079-9dde-98b02481e7a5唯一一次原生流程startedUtc=14:04:53.055Z、reportedUtc=14:05:08.154Z；随后清理尾行通过，session40114实际exit0；前置32772/编译33512/manager30160均exit0/closed。128MiB专属卷prepare/verify通过，32B probe匹配且opened2/closed2；sequence5 released、detached/managementClosed/helperClosed=true、pending=false/buffersReleased=true；尾行passed/artifactsRemoved=true，根不存在，无未决责任。主证据passed=false为清理前既定时点，不替代最终尾行。该限定正常生命周期通过，vmCalls0/shareAdmissionfalse，尚未证明WSB卷GUID共享或直接写满硬容量。下一项先审共享准入、实时VM/CLI状态及安全宿主读取适配，详细见固定卷方案16/契约0.14。生产工作区接入、默认及权限退役关闭，P0待办。

### 实验共享准入与实时收尾绑定离线完成（2026-11-01）

revision329代码复审后，新增11组纯内存检查一次通过；指定旧无钩子用例首次筛选漏字未命中，修正精确名称后实际1组通过，不将空筛选记作通过、不重跑新检查。共享配置只有一个所属卷GUID exchange；私有一次性ticket绑定具体VM/卷/配置，最终同步守卫覆盖撤销、释放、清理和runtime销毁时序；实时list与全部exec/connect/control实际退出共同约束盘释放，未知保留。原shareAdmission=false，新增实验许可不等同WSB兼容证明；没有编译/助手/VHD/WSB或临时产物。详见固定卷方案17/契约0.15，复核后精确暂存8文件。下一项先完成固定32B安全读取，再审统一owner的真实GUID小文件共享入口；直接硬容量/异常失效及真实工程未验收，生产/默认/权限退役关闭，P0待办。

### 固定32B安全读取离线完成（2026-11-02）

revision335代码复审后，新五组检查一次通过（792.466ms），其中一次编译/一次固定PS7 AST夹具24分支；两个进程exit0，唯一22016B DLL及专属根按身份清理，未构造NativeDisk或运行Storage/VHD/WSB。读取器固定所属GUID exchange/guest-control.bin，从两个持有句柄核对身份与路径，单次32B读取；原操作异常优先保留、两个关闭错误与未知句柄独立记录。实时VM/CLI收尾才准入，读取期间不释放盘，未知保留责任；普通marker失败可在明确关闭后释放。完整证据、局限和9文件暂存边界见固定卷方案18/契约0.16。下一项审统一外层owner、总记录预算、固定写入及GUID小文件往返入口；真实共享/硬容量/异常失效与工程接纳未验收，生产/默认/权限退役关闭，P0待办。

### 共享会话组合核心离线完成（2026-11-02）

revision341/347先审统一owner及代码，新八组纯内存检查首次7pass/1fail；失败为记录回调拒绝后not-started摘要更新遗漏，没有实际派发。最小修正经revision348/349复审，仅原失败组恢复一次1pass，其余七组不重跑，历史失败保留。最终派发重验私有卷/VM许可，输出callback未结束和未知VM保留责任，正常关闭后按固定身份逐叶清理、逐次记录删除数；99预留/4未决、8KiB journal及有界证据保持。完整正常替身7CLI/6manager命令/8物理对象/2次输出、最后未决0及绑定引用释放；编码压力结果按限定样本解释，不宣称覆盖所有可达完整报告。详细源码摘要/预算/局限及7文件精确暂存范围见固定卷方案19/契约0.17，无真实进程、磁盘、WSB或临时产物。下一项先审真实adapter及一次GUID小文件共享条件，生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 单GUID共享适配入口离线完成（2026-11-02）

revision352范围和359/362代码复审后，固定PS7预检/编译/manager至真实runtime的组合入口已实现，新四组定向检查一次全部通过（63.9713ms），无真实helper/存储/WSB或文件写。所有宿主创建在预留持久化后重验源码集合与工具；可选收据区分初始不存在、读取中消失和JSON null，关闭未知保留精确fd且不清理。16文件集合c8b77da13b6b8f3771a63d3e42fb8bc789e4286870d369681c9a2b1a5ac4a228的完整清单、预算压力样本及5文件精确暂存范围见固定卷方案20/契约0.18。下一项只审同一代码下单卷/单实例/32B往返的实际条件；尚未证明GUID映射或硬容量，生产真实工作区/默认/权限退役关闭，P0桌面回放待办。

### 单GUID共享与32B往返实际通过（2026-11-02）

revision368现场条件复核及代码暂存后，唯一task84afcab6-d9e4-4012-ae7d-ea93c40aaebc已实际完成128MiB专属卷/单GUID实例/32B写入与宿主匹配读取；实例f4a1a1f0-92c8-4e07-880b-170f8f131457关闭、最后list为空、全部10调用实际关闭，卷正常解除附加与关闭manager，业务句柄两开两关。主证据时间16:29:48.354Z不是最终退出时间；随后清理尾行passed/artifactsRemoved=true，四私有叶及空根已删除，原会话87555实际exit0，根不存在独立核对。详细身份、SHA与限定结论见固定卷方案21/契约0.19。固定客户端接受本项GUID共享的疑问已得到现场证据；共享直接硬容量、异常失效及真实工程接纳仍待后续。下一项先审有界容量探针，不重复本轮/旧矩阵，生产真实工作区/默认切换/权限退役保持关闭，P0桌面回放待办。

### 容量写入核心独立离线通过（2026-11-02）

revision372范围及377代码复审后，独立容量算法的新单组一次通过（435.2256ms），一次编译/一次固定PS7纯Fake检查16分支，实际存储调用0，两个进程exit0，9728B DLL及独占根已精确清理。固定1MiB复用块、最多144次/144MiB及20秒循环期限，直接112/39与路径/权限/短写/上限分别判定，Write/Flush/Close错误独立保留、缓冲清零。该核心无文件/PInvoke/运行入口；结果槽交付契约已审，但真实探针、卷内安装和宿主核对/容量专用预算仍待接线，未做容量实测。详见固定卷方案22/契约0.20；复核后精确暂存6文件，不重复旧项，生产/默认/权限退役关闭，P0桌面回放待办。

### 固定容量结果槽与来宾封装离线完成（2026-11-02）

revision383代码复审后，两组首次1pass/1fail；夹具局部变量CS0136仅改名，经revision385复核后精确第一组一次恢复通过，保留首次失败、不重跑第二组/旧核心。25个纯替身分支、512B跨语言报告/拒绝断言及有限退出状态完成，Native.Calls=0，两个恢复子进程exit0，19456B DLL和独占根清理。退出码0只作为槽交付的必要条件，推导状态是经平台承载的来宾报告，不能冒充平台观测或容量验收；未知错误不补零，数据和槽三步错误独立保存，关闭最多一次。完整证据与8文件精确暂存范围见固定卷方案23/契约0.21。下一宿主卷内安装、槽预写、实际文件分配和私有哨兵读回及容量专用预算另项审查，尚无容量实测；生产真实工作区/默认/权限退役关闭，P0桌面回放待办。

### 宿主容量安装与读回组件离线完成（2026-11-02）

revision390复审后，新单组一次通过，30纯分支，编译/固定PS7均exit0，50176B DLL与根已精确清理。可选native partial支持固定probe卷内安装、512B槽预写刷新及32B宿主私有哨兵，再按持有句柄核对slot/填充文件身份、EOF/Allocation与哨兵；9槽业务责任、峰值3，未知关闭保留且不重试。小槽Allocation判据冲突已修，填充大文件的严格分配规则未降低。详细证据与8文件暂存范围见固定卷方案24/契约0.22。尚无helper/owner实际接线或容量实测，当前源码变化须固定新集合；下一项只审容量回执、控制接线、3+1+95预算和完整收尾，不重复已通过矩阵。生产真实工程/默认/权限退役保持关闭，P0桌面回放待办。

### 容量回执与helper/owner准入离线完成（2026-11-02）

revision394先审后，新owner六组/helper单组一次7pass，总986.1368ms；helper仅编译native base并固定PS7 AST替身14分支，两进程exit0，22016B DLL及根精确清理。安装仅同任务无绑定VM，读回仅所属VM和全部CLI实际关闭后，pending租约/身份/九槽关闭责任保留；普通已关闭失败可释放。固定回执与guest事实分别验证，未宣告真实容量通过。完整证据与10文件精确暂存见固定卷方案25/契约0.23。下一项审外层3+1+95预算、固定容量编排、实际adapter及源码/清理清单，旧矩阵不跑；生产真实工程/默认/权限退役关闭，P0桌面回放待办。

### 容量外层与固定源码集合离线完成（2026-11-02）

revision400复审后，新增六组及精确受影响旧manifest一组一次7pass、137.4233ms，无真实helper/编译/存储/WSB或临时产物。容量专用3helper+1manager+95CLI/99总预留保持；修正第96次factory前拒绝未撤回临时记录的问题，真实Lifecycle组合记录/快照/factory均95。完整替身7CLI/7manager命令/11物理对象、7精确叶清理，journal7490B/主6223B/尾175B限定样本均未提高预算。当前24源码集合bd2b96fd01acdff28c73cea9d9c4ec5e741dc4701e49dea99f0c591599be7866及9文件暂存边界、一次128MiB单VM容量现场条件详见固定卷方案26/契约0.24。现场尚未执行，不将离线结果算作硬容量通过；待复核/暂存后继续唯一有界实测，异常失效和真实候选适配后续处理。生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 唯一容量现场取得原始事实，最终记录检查失败（2026-11-02）

唯一task15f06cbc-9d54-4186-b556-1021d963a382在114MiB成功写后第115次返回原始112（空间不足），宿主EOF/Allocation一致、原槽/私有哨兵匹配、9开9关；VM、7CLI及manager均实际关闭，卷正常解除附加。原入口最终记录检查失败，host30244及七小叶63187B仍保留，passed=false。获审一次只读诊断明确：原日志7730B，加入清理清单的pretty副本8536B，而实际compact含换行仅6680B；是最终检查对象错误，未证明输出7680B超限。完整槽/摘要/归属与失败保留见固定卷方案27/契约0.25。下一只审最小格式检查修正、离线真实形态回归及原owner精确恢复，不再次写盘；生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

### 最终记录检查修正与容量任务外部收尾完成（2026-11-02）

限定容量事实已获revision415复核认可，原现场入口最终记录失败保持。最小修正只去掉未持久化最终对象的pretty限制，实际日志/输出/尾行8192/7680/512B不变；revision421先审后新单组一次1pass，总62.2563ms、journalPeak7917/main6680/footer175，七叶/引用/监听释放，未再实测容量。独立审查后原host30244由同一持有对象核对身份并唯一终止，实际exit-1/句柄关闭，原会话20189exit1；随后revision425条件下七个登记叶和空根精确清理，工具exit0、artifactsRemovedtrue，独立确认根不存在。完整事实与六文件精确暂存范围见固定卷方案28/契约0.26。原失败不被改写为正常自动收尾通过；下一先审异常GUID失效及真实候选接线，生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 真实卷候选读取契约与纯数据核心离线通过（2026-11-02）

revision432/435确定同一管理助手、两阶段捕获及宿主私有载体，五叶32KiB/错误叶另8KiB，原候选/控制/输出预算不变。纯数据核心复用原manifest/path规则，旧盘符根与I/O代码未改；预审发现Buffer共享池问题，已修为独立分配并补完整backing隔离和BOM拒绝。revision440复审后原九组一次9pass、58.8226ms；最大正常request2159B/batch receipt2153B/payload16384B，内部撤销清零/上下文释放，不擦除调用方既有副本。无原生/Storage/WSB或临时产物，未接NativeDisk或真实owner；candidate-data-checked不代表运行时准入。完整契约、拟定业务句柄模型和六文件暂存范围见固定卷方案29/契约0.27。下一原生捕获及真实租约继续先审，不重复旧矩阵；生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 固定manifest原生捕获组件离线通过（2026-11-02）

revision441范围新增可选捕获partial与纯替身：固定GUID清单、宿主CREATE_NEW载体、4096B单scratch、3业务句柄峰值2；操作与关闭错误独立，未知责任保留、缓冲清零。revision445代码预审后只编译一次并用固定PS7调用纯替身，1pass/内部50项、总675.4656ms；两个进程exit0，49664B DLL与空根按登记身份清理，无卷/实例或旧矩阵。尚未接helper/真实租约或运行入口；既有元数据句柄另计，未知关闭精确责任先于真实接线补齐。详细结果与六文件范围见固定卷方案30/契约0.28。生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 临时句柄责任与未知关闭诊断离线通过（2026-11-02）

revision448后manifest项精确暂存，继续修正八处临时句柄责任：helper先持有单槽owner再构造NativeDisk，操作/关闭分离，未知后禁止新获取。预审发现报告期间新unknown漏诊断及准入假阳性，两项均修正；revision454复审后唯一新检查1pass、核心24项/9准入/3诊断/5收尾及5旧依赖parse通过，总958.7304ms、诊断最大422B，未执行真实helper主体/NativeDisk/Storage/WSB或旧矩阵。两个进程exit0、70656B唯一DLL与空根按身份清理；13文件范围和局限见固定卷方案31/契约0.29。下一批量捕获与真实租约接线继续先审，生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 批量候选捕获与批准请求解析离线通过（2026-11-02）

revision456后补同一NativeDisk批量捕获，request绑定已完成manifest和本机task，路径规范与宿主一致；保持16项/单4KiB/总16KiB。revision460预审后唯一新入口1pass、74纯项及真实JS请求生产者到C#解析兼容样例通过，总695.8956ms；业务98开/峰值7、累计分配18543B并清零，失败无部分候选、未知责任保留。两进程exit0、82944B唯一DLL/空根按身份清理，无原生操作或旧矩阵。未接helper/owner lease或实际读取；七文件范围与局限见固定卷方案32/契约0.30。下一固定命令/回执与真实租约继续先审，生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

候选读取固定命令/回执历史预审：revision462确认默认关CandidateCapture、两阶段一次性读取、独立回执流和共享单次终止诊断的最小离线适配。当时先准备源码和29组纯检查，后续revision467预审及唯一运行结果见下一段；产品4096B回执/1024B错误输出/16命令/32消息预算不变。范围和资源责任见《Windows Sandbox 固定共享卷实现方案》§33；没有实际候选读取、真实owner租约或生产准入。P0桌面回放仍待办。

候选helper读取/回执离线项已完成唯一执行：revision467代码预审后，2026-11-01T20:43:33.5400632Z，1pass/0fail（29组、16次guard），PS实际0/1/16回执交现有JS核心通过；成功最大2102B、错误2281B、诊断478B。编译/PS7均exit0，原生适配调用0，无helper正文或实例；登记65536B DLL和空根已精确清理。完整证据及限制见固定共享卷方案§33.4。待13文件结果复核后精确暂存，后续只接真实owner租约/私有载体；生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

候选owner租约下一项：按revision472/474/475确认范围，准备真实TaskVolumeOwner连续读取租约及固定接口计数替身。阶段admit一次、validate可重复；操作结果与物理不再使用缓冲分开结算，撤销不提前改写借出request。两固定命令仅补白名单，真实私有载体I/O与helper profile仍未接入。详见固定共享卷方案§34，先源码预审后唯一离线检查；生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

候选真实owner租约离线项完成：revision483代码复核后，2026-11-01T21:07:57.919Z仅新入口11pass/0fail，总69.5718ms，固定Node运行器实际exit0/stderr0。实际owner/LiveSandboxRuntime/SandboxLifecycle/VolumeProtocol接计数替身，正常5开5关/峰值2，撤销缓冲期限、晚到结果、原始拒绝值、未知责任及最终发布检查通过；无本项临时存储/实例或新文件产物。完整限制与记录见固定共享卷方案§34.4。待五文件结果复核后精确暂存；实际私有载体I/O/helper profile/候选VM仍待后续，生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。
候选私有载体适配准备：revision488确认固定未共享宿主根可用Node fs，真实来宾路径仍原生检查。新增固定五叶读写和13组纯替身，原始回执保留、同fd身份/长度、CREATE_NEW及独立close未知责任；尚未运行。Node/native同登记文件兼容、helper profile与实际候选入口仍待后续，属性证明边界见固定共享卷方案§35/契约0.33。生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

候选私有载体适配离线完成：revision496先审后唯一13组通过，总69.5676ms、运行器exit0/stderr0。实际owner/core配计数fs，正常5开5关峰1/64API；原始回执、字节上限、独立错误和未知fd责任通过。无本项文件产物/实例或旧矩阵；执行前一次摘要抄录被守卫阻止，核实原获审值后才启动唯一检查。结果及五文件待复核暂存见固定共享卷方案§35.4，下一同登记文件Node/native兼容继续先审。生产真实工程/默认切换/权限退役关闭，P0待办。

下一最小项为同一登记文件Node/native身份兼容：revision498已审范围，准备三源码和一次单文件检查，保持Node原fd并核对原生serial/index及实际元数据，先审源码再执行。具体资源与未知保留边界见固定共享卷方案§36/契约0.34；无VHD/VM或生产准入，P0待办。

Node/native单文件身份兼容完成：revision504代码预审后唯一新检查1pass，总510.7936ms；原Node句柄保持期间原生身份/长度/路径完全匹配，前后元数据稳定且两边各一次关闭。编译/PS7均exit0，5632B DLL和32B文件及专属根已精确清理。固定本机身份转换前置疑问解除，完整私有I/O/helper profile/候选VM仍未验收，证据及六文件待复核暂存见固定共享卷方案§36.1。生产真实工程/默认切换/权限退役关闭，P0待办。

候选链组合接线准备：revision509/511/512批准显式CandidateCapture启动、固定cmd合成目标、同一外层owner与PrivateChannel、完整源码/资源/报告预算。正常卷释放后才核对独立候选字节；失败原始事实保留，关闭未知不释放盘。新增七组纯组合检查尚未运行，后续先源码预审，再唯一纯检查及单卷单VM条件复核；不再单独重复身份/五叶I/O。详见固定共享卷方案§37/契约0.35，生产真实工程/默认/权限退役关闭，异常GUID及P0桌面回放待办。

组合执行前又查明确定性格式冲突：echo产生的清单尾换行会被既有canonical校验拒绝，当前版本执行准入已撤回。按revision524先准备同一固定body的三场景CMD兼容前置，核对无换行字节及失败退出；不改PS5、不放宽清单判据、未启动组合/VM。范围、预算和精确清理责任见固定共享卷方案§37.5；通过后再回到组合项，生产接入/默认/权限退役关闭，P0待办。

规范清单写入前置已通过：revision526代码预审后唯一三场景CMD检查，正常0、两个确定失败各1；payload23B/manifest220B精确匹配且canonical parser通过，未放宽判据。五次fd已知关闭，四文件与七目录精确清理，完整协议3805B；无VM/旧矩阵。组合fixture同步无换行正常及CRLF拒绝，下一先复核结果和组合最终源码，再执行唯一七组；详见固定共享卷方案§37.6。生产/默认/权限退役关闭，异常GUID/P0待办。

候选组合七组已通过：revision531最终源码预审后首次执行7pass/0fail，112.7481ms；实际owner/core/私有适配器与内存替身闭合正常、失败保留、未知关闭、末次权限、清理及完整报告预算，无新增现场或临时产物。五报告样例最大journal8144/main6540/footer239，限制8192/7680/512保持；替身句柄计数不替代现场。十文件结果待复核精确暂存，随后只审单卷单VM一次合成候选条件，详见固定共享卷方案§37.7。生产真实工程/默认/权限退役关闭，异常GUID与P0桌面回放待办。

唯一候选现场已通过：revision535精确暂存十文件后，revision537审准单128MiB卷/单VM/一次固定合成候选。2026-11-01T22:33:49.839Z启动，host25916实际exit0，task eeda94ae-3214-4f70-b380-0fdd7b053281；220B规范清单和23B正文由真实native/五叶私有链捕获，卷及manager释放后独立候选仍匹配，随后清除候选。VM/7CLI/10进程对象全部关闭；native实际manifest3/3/2、batch5/5/4，私有5开5关峰1/64API。主报告6021B/尾行176B，八叶71327B精确清理，根独立确认不存在，无自动重试/旧矩阵。细节见固定共享卷方案§38/契约0.36。正常合成链不替代异常GUID失效、项目PowerShell/Node环境、工程保护与回接；生产真实工程/默认/退役关闭，P0待办。

异常阶段最小增强已按revision544准备：VM登记后、候选exec前一次verify，跨await复核原身份及任务状态；当前控制失效→撤销/取消/保留链不变，不增加持续监测、回退或自动恢复。新8命令与历史7命令现场分开；拟仅四组受影响定向检查，先代码预审，详见固定共享卷方案§39/契约0.37。尚不启动新VM或主动脱卷，生产真实工程/默认/退役关闭，P0待办。

登记后核对定向检查已通过：revision548先审后按名称唯一四组4pass/0fail，88.3673ms；正常8命令、三类verify异常、九种跨await变更及原末次派发守卫通过，预算保持，无文件/VM产物。未执行其余五组或旧矩阵；失效例为unsafe/迟到回复替身，不能冒充真实manager退出或脱卷。五文件待结果复核暂存，下一现场仍需区分登记后verify兼容、控制失效及平台路径失效并审定触发/收尾，详见固定共享卷方案§39.1。生产真实工程/默认/退役关闭，P0待办。

故障现场前置收窄：revision550结果复核后五文件已暂存；revision553/555确认精确原进程终止机制有依据，尚需专用故障收尾资格。已准备六原对象/证据版本/完整原文交付/五叶身份绑定的纯模型与十组定向检查，未运行、未接真实删除或终止。普通失败保留和原故障事实不改，模型释放自身引用不冒充实际owner释放；详见固定共享卷方案§40/契约0.38。新的故障现场仍被真实诊断/收尾接线所阻断，生产真实工程/默认/退役关闭，P0待办。

故障收尾纯模型已通过：revision557先审后唯一十组10pass/0fail，63.9071ms；正常14次观察/五叶模拟/8442B副本全清，原owner保留不变；4096B完整诊断封装5639B、4097B拒绝。无新现场或临时产物，五文件待复核精确暂存；下一先补只读原生诊断的固定实现与证据来源，详见固定共享卷方案§40.5。真实终止和清理执行尚未接通，生产真实工程/默认/退役关闭，P0待办。


故障收尾纯项已由revision558复核并精确暂存index1984。继续准备独立只读原生诊断：固定GET_INFO/RWDepth0、同句柄身份/附加状态/旧GUID及四槽关闭责任，失败不生成成功回执；新增111分支纯替身与编译入口尚未运行，先审源码，详见固定共享卷方案§41/契约0.39。它尚未接真正故障或释放动作；生产真实工程/默认/退役关闭，P0待办。

原生诊断纯项已通过：revision565最终先审后仅一轮编译/PS7夹具111场景，真实原生接口调用0；四槽/64B缓冲与600B成功schema定向验证通过。两子进程exit0，唯一28KiB DLL与原根精确清理且确认不存在，无WSB/VHD。六文件结果待复核暂存，下一最小故障触发/宿主观察/诊断包装仍需审定，详见固定共享卷方案§41.4。生产真实工程/默认/退役关闭，P0待办。


只读诊断六文件已由revision570复核并精确暂存index1987。下一单次原child故障能力及十二组纯组合源码已准备：专用工厂固定原进程/协议，verify结算后绑定、先消耗/记录attempt再末次守卫，请求与close分开、dispose不终止。尚未运行或触发真实故障，先审；详见固定共享卷方案§42/契约0.40。诊断包装/真实观察/精确清理仍是后续接线，生产真实工程/默认/退役关闭，P0待办。

单次manager-loss纯项证据已补齐：首次11组通过/1组计数预期失败，经revision581复核仅将error→close按原协议两次unsafe通知修正，以完整名称只补跑失败组通过（51.4699ms），其余十一组不重复。工厂默认关闭、一次原child请求/真实close分离、日志在途/异步未决/重入/撤销及释放检查通过；无业务进程/VM或文件产物。五文件待结果复核精确暂存；下一PS7诊断包装/真实观察/五叶收尾仍须先审，详见固定共享卷方案§42.5。生产真实工程/默认/退役关闭，P0待办。

单次故障能力五文件已由revision590复核并精确暂存index1988。继续准备成功诊断原文的最小准入链：原调用实际close、完整ASCII与字节计数、原成功schema全过后精确重建最多4096B；超时保留、不kill/不重试，字节只转移一次或本地清零。新增七组内存检查尚未运行，先审，详见固定共享卷方案§43/契约0.41。此项不含真正诊断启动/PS7包装/回执落盘/删除，后续仍按依赖接线；生产真实工程/默认/退役关闭，P0待办。

成功诊断原文准入七组已通过：revision594先审后首次7pass/0fail，55.5847ms，原文/摘要/封装回转、一次字节转移或本地清零、异常拒绝、wait1/kill0、迟到close不恢复与引用释放均通过。无真实进程业务/PS7/文件产物，六文件待复核精确暂存，详见固定共享卷方案§43.4；下一继续固定PS7包装与Unknown保留，随后接原调用来源/角色和回执文件责任。生产真实工程/默认/退役关闭，P0待办。

成功通道六文件已由revision595复核并精确暂存index1990。继续准备固定PS7诊断包装，重点防止Unknown因报告或输出异常退出；保存原操作/关闭/调用/包装/输出异常，原owner先持有再Run一次。两原函数由AST限定提取，拟一次PS7的12个流程和MemoryStream编码场景，先审源码，不加载入口/DLL或调用native，无产物/旧矩阵重跑。真实宿主观察/诊断角色、回执文件owner与五叶释放依次后续，详见固定共享卷方案§44/契约0.42；生产真实工程/默认/退役关闭，P0待办。

固定PS7包装纯检查已通过：运行前预审修正合成编码总量102→105B，revision598放行后仅一次PS7的12场景全部通过（565.2195ms）；原owner/异常区分/Unknown不退出、原编码逐字节及105B全清通过。PS7实际exit0/stdout270B/stderr0，无入口/DLL/native/文件/VM产物或旧矩阵重跑。六文件待结果复核精确暂存；下一宿主观察/角色及回执I/O仍需接线，详见固定共享卷方案§44.3。生产真实工程/默认/退役关闭，P0待办。

固定PS7包装六文件已由revision600复核并精确暂存index1993。下一按审核先准备宿主回执文件owner：同上下文一次Buffer接管、排他叶和同fd身份、有界短写/fsync/一次close；Unknown保留，原IO与原错误独立，固定同步完整封装不暴露通用字节借用。六组替身检查源码已准备，先审后验，无真实文件操作/旧矩阵。详见固定共享卷方案§45/契约0.43；后续真实诊断角色、宿主观察、五叶释放仍待接线，生产真实工程/默认/退役关闭，P0待办。

诊断回执文件owner已完成唯一六组纯检查：revision602先审后6pass/0fail、57.1184ms，正常12fs/峰值fd1、三段短写/fd0、Unknown保留、falsy错误/身份及跨上下文/重入边界、已知关闭后的同字节清零与引用释放通过。无真实文件/PS7/native/VM或产物，旧矩阵未重跑；五文件待结果复核精确暂存，详见固定共享卷方案§45.4。下一继续真实诊断角色和原宿主观察，再接五叶清理/外层释放，生产真实工程/默认/退役关闭，P0待办。

新工作/审核已接管index1996后的故障组合阶段：故障专用角色/原对象观察、独立停止、回执完整fingerprint、输出后原字节交接、五叶清理及外层释放草稿已备。八组内存检查未运行，先审源码；故障验收与任务成功区分，普通volume.release/热路径不变。仅八文件，旧矩阵不重跑，现场另核，详见固定方案§46/契约0.44。生产真实工程/默认/退役关闭、P0待办；一次额度重置已消耗，不再自行重置。

故障组合唯一八组已通过：新审核revision20先审后8pass/0fail、118.9506ms，observer33216/runner31124实际exit0、stderr0。artifact142fs，原文600B/外层清零600B，契约副本8400B全清，日志6153B及输出975/4925/196B在预算内；停止、读回指纹、Unknown、输出/逐叶失败保留和成功引用释放通过。纯内存替身，无实际文件/PS7/native/VM/产物，不重跑旧矩阵。八文件待结果复核精确暂存；真实现场随后另核，生产/P0边界不变，详见固定方案§46.4/契约0.44。

故障组合§46随后已由revision22/24复核并精确暂存index1999，新工作（四）接管。当前准备唯一单盘单VM管理进程故障现场预审：固定28源码bundle、原manager一次请求及原close、一次只读诊断、完整原文/报告/footer与五叶收尾。外层固定捕获/完整hash和原父子对象观察，无强制timeout/kill/retry；失败与Unknown保留，须另审恢复，不能冒称现场通过。完整具体启动、观察器、等待及接受判据见固定方案§47/契约0.45。只追加三记录，未运行/暂存；生产真实工程/默认/旧权限退役关闭，P0待办，一次额度授权已用完。

唯一真实管理进程故障现场已通过：revision7预审后2026-11-02T01:31:44.234Z启动，observer33476/owner30852均实际exit0。原manager4316一次SIGTERM并关闭、VM及6CLI/10记录全闭；诊断11048的603B完整原文确认VHD未加载和旧GUID不存在，三实际句柄各一次关闭。三段完整输出6120B/stderr0、五叶及原根清除且独立ENOENT确认；taskPassed=false及unsafe/cancelled/taskRejected保留，故障验收单列通过。没有重跑/外部恢复或本项遗留；具体身份、完整原文、摘要及未直接观测内部计数的限制见固定方案§47.5/契约0.45。三记录待结果复核精确暂存，下一范围另核；生产真实工程/默认/旧权限退役仍关闭，P0待办，额度一次授权已耗尽。

§47完成及移交后，当前进入宿主选择性输入的最小离线项：审核（五）revision7确认五文件/八组范围，独立expose与写回许可，固定原root/task/epoch/snapshot/revision/身份/hash及输入/元数据预算，关闭Unknown保留原责任。源码和内存检查草稿已备，尚未运行/暂存，详见固定方案§48及契约0.46。已确认FileService write未提供显式snapshot接口，会选latest；后续原revision桥接另行解决，本项不修改/调用生产提交，不将任意候选字节转为content即宣称无损。真实来源安全打开、快照发布、独立cwd/固定工具/离线依赖和执行/提交仍需依序接入；生产/default/旧权限退役关闭，P0待办，额度授权已耗尽。

宿主选择性输入离线项首次八组通过：审核（五）revision11先审后唯一运行8pass/0fail、85.6532ms，实际执行工具exit0。正常9B/上限16KiB私有字节全清，引用与正常token归零；Unknown原reader/token责任保留且不重试，纯模型actualOSHandles0。无业务fs/VM/临时产物/真实提交，旧矩阵未重跑；五文件待结果复核与精确stage。FileService显式原revision写入缺口及真实Windows输入适配仍待后续，详见固定方案§48.5/契约0.46；生产/default/旧权限退役关闭，P0待办。

§48已完成复核/精确暂存，工作（六）现按审核核定的六文件准备原FileRevisions成员租约：固定原owner/对象/generation及task/root/snapshot，WeakRef避免额外钉住已退役源字节，失效与宿主回调前后检查、Unknown责任分离。拟一个合成根/5B叶、最多64次兼容签发和八组检查，尚未执行，先源码审；兼容capture不冒充完整原生read/SessionFiles或Windows安全打开。旧输入校验仅导出复用，生产代码未改；完整边界见固定方案§49/契约0.47。source-root真实reader及显式原revision写入、发布/执行/提交仍按依赖后续，生产/default/旧权限退役关闭、P0待办。

原FileRevisions成员租约首次八组通过：审核（六）定稿后唯一8pass/0fail、1350.9141ms，实际exit0。一个合成根/5B叶完成41次兼容签发/205逻辑回执字节并按身份清理、独立ENOENT；正常/失活5B私有输入全清，Unknown内存责任保留，四轮受控GC三个原目标live0，native worker差值0。空/纯add拒绝、双错保存和关联变化已验证；没有完整原生read/SessionFiles/Windows安全打开或真实工程提交结论。三记录追加、六文件待复核精确暂存，详见固定方案§49.3/契约0.47；生产/default/旧权限退役关闭，P0待办。

§49及交接已完成复核/精确暂存，现按审核（七）核定六文件准备真实SessionFiles原回执来源守卫。低频pin只从现存service借原owner，弱引用固定runtime/context/boundary与双generation、signal，异常/重入/生命周期变化单调失效；既有生产热路径不改。单5B合成叶最多32次安装read兼容签发、八组及四轮GC尚未运行，先源码审，细节见固定方案§50/契约0.48。生命周期守卫不提供读取授权，受控runtime和兼容capture不证明完整原生read或Windows安全打开；真实reader、显式原snapshot写回、发布/执行/提交仍后续，生产/default/旧权限退役关闭、P0待办。

现有SessionFiles原回执来源守卫首次八组通过：审核（七）先修正末次runtime回调更换signal的检查顺序，再唯一8pass/0fail、4550.8736ms、actual exit0。单5B根叶26次安装read兼容签发/130逻辑字节并按身份清理，测试ENOENT及审核独立PathNotFound；正常/失活私有5B全清，四轮GC七原目标live0、worker差值0。来源为真实SessionFiles/boundary加受控runtime/basic read，不称当前读取许可、完整native read或Windows安全打开；Unknown未实际注入/恢复。三记录追加待复核、六文件待精确暂存，详见固定方案§50.3/契约0.48；真实来源reader/显式原snapshot写回/发布与执行提交仍后续，生产/default/旧权限退役关闭、P0待办。

§50及最终交接已闭合，工作/审核（八）现冻结§51-BASE-1六文件：Windows x64本地NTFS原生逐组件打开与同步reader基础，固定GUID锚点/原身份、单basename相对父handle、全部reparse/别名/硬链接拒绝、原mtime/ctime/hash及有界句柄关闭。当前不接input.capture/SessionFiles/lease，签发0；后置读取失败清本次buffer区，Unknown保留原handle/ops/各异常，已返回外部块归调用方。唯一八组拟单合成根/5B叶/真实junction-symlink-hardlink及共享冲突、模型故障/GC，源码待审、尚未运行或暂存，详见固定方案§51及契约0.49。原会话/当前读取授权组合与input外层全资源关闭、显式原snapshot写回、发布/独立cwd/固定工具/离线依赖及真实执行提交仍后续；生产/default/旧权限退役关闭、P0待办，额度授权耗尽。

Windows来源BASE-1首次唯一八组通过：审核（八）复审后8pass/0fail、224.3505ms、actual exit0，原输出与七精确清理路径已独立复核。11真实reader、4次ReadFile/10B、87句柄各一次关闭/峰9；真实祖先与内部junction、symlink/hardlink及共享冲突拒绝。caller14B全清、native scratch24904B及bootstrap2264B全释放，失活时hash完成仍后置拒绝；模型Unknown/pending原责任保留，四轮GC正常三目标live0、worker差值0。无真实资源/会话/恢复责任遗留、无重跑；签发0且尚不接input.capture/SessionFiles/lease/当前读取许可，不称生产快照或完整集成。三记录待复核、六文件待精确stage，详见固定方案§51.4/契约0.49；后续外层关闭/授权组合、原snapshot写回及发布执行门槛保持，生产/default/旧权限退役关闭、P0待办。

§51及最终交接完整闭合后，工作/审核（九）冻结五文件输入捕获组合：同一冻结输入、专用真实source/原lease、每次native业务前后的独立同步宿主authorize，活动同path用原token真实stat，外层全close及末次guard后才交付。失败私有bytes全清、partial/祖先Unknown保留原责任，copy前后继续检查；当前许可为受控宿主接缝，不能声称生产授权完整接入。初审A–C补齐真实owner事前登记/失败不漏收尾、settle释放原错独立保存与模型、在途短读/吞重入及authorize回调forget后的post-lease反例。单根/5B叶、最多8reader40B/10兼容签发50B及八组/四轮GC修订源码待复审，尚未运行或暂存，不重跑旧矩阵，详见固定方案§52/契约0.50。原snapshot写回、发布/独立cwd/固定工具/离线依赖与真实工程执行提交仍后续；生产/default/旧权限退役关闭、P0待办，§0取消承诺不恢复、额度授权耗尽。

原会话租约与Windows输入捕获组合首次唯一八组通过：审核（九）A–C修订复审后8pass/0fail、406.5233ms、actual exit0；完整原输出及两精确路径已独立复核。五真实reader读取25B，58句柄各一次关闭/峰8，scratch11320+2264B释放；八兼容签发/40逻辑B，wrapper0。正常copy5B全清，read后/全close后/复制后许可失活均拒绝并清相应私有/新副本；请求区清零与私有buffer重叠不重复计量。模型四HANDLE责任和一个ops释放Unknown保留、不重试，在途短读/吞重入与callback forget的post-lease拒绝通过；四轮GC八原目标live0、worker差值0。两节点按原身份清理，无实际资源/会话/恢复责任遗留，不重跑旧矩阵。三记录待复核、五文件待精确stage，详见固定方案§52.4/契约0.50；受控authorize不是生产权限完整接入，原snapshot写回、发布及真实执行门槛仍后续，生产/default/旧权限退役关闭、P0待办。

§52与最终交接已完整闭合，工作/审核（十）冻结八文件推进真实读取许可准备：在原SessionFiles和compatibility boundary上新增低频接口，首次await前固定canonical及原receipt，复用真实权限scope/workspace异步检查，返回弱引用原policy/ctx/signal的失效检查；与runtime执行边界分开，不getService或补新基线。preparation独占source/lease，permission只弱借；等待中撤销后仍等原调用结算、清迟到policy，不复活。当前不接§52 capture/copy或FS续验。拟单5B根叶、≤12签发60逻辑B、prepare≤96/assessTarget≤256、0native/capture、八组和四轮GC九目标，源码待审尚未运行/暂存，详见固定方案§53/契约0.51。原snapshot写回/latest缺口、grant/native绑定、关闭后续验、发布/独立cwd/固定工具/离线依赖及真实执行提交仍后续；生产/default/权限退役关闭、P0待办，§0取消承诺不恢复、额度授权耗尽。

§53源码预审A–C修订待复审：固定独立pin时ctx/signal、增加真实权限观察等待中的失活证据，并在core/外层末次原receipt回调后以纯policy/owner身份检查收口；不移动原receipt后置检查来代替。当前仍未运行或暂存，不改变§52、写回及生产边界。

真实读取许可准备首次唯一八组通过：审核（十）A–C同版复审后8pass/0fail、10800.4821ms、actual exit0，完整原输出3314B/JSON2330B及两精确清理路径已独立复核；9兼容签发45逻辑B、prepare36/assessTarget83、33登记preparation最终live/pending/host0、fixture1open/close，无实际遗留。pin时独立ctx/signal、观察等待中失活与迟到policy释放、最终纯policy/owner核验均通过；四轮GC九目标live0、stale拒绝清引用。三结果记录待复核/八文件待精确stage，源码未重跑或改变，详见固定方案§53.4/契约0.51。当前只完成许可准备，不称FS续验、capture/copy、原snapshot写回或生产接入，后续执行前置及§0/P0边界保持。

§53与最终交接完整闭合后，工作/审核（十一）最终冻结六文件推进原workspace grant固定及真实异步续验：首次await前固定真实原对象/槽/字段/全部路径，safe整数才转bigint；真实assessTarget/lstat/realpath后同原policy与映射复核，最后ctx回调后纯身份收口，失败恢复不复活。单grant，无alias/full-access缺grant或跨grant；静态观察不强持退役controller，pending撤销仍结算原I/O。只是grant/FS观察基础，不接source/receipt/native/capture-copy，不把冻结数据或同步check当权限。拟两空目录、≤64准备续验/256assessment、0内容及native、八组/四轮GC五目标和原id清work后真实ENOENT续验，完整源码预审前不运行。详见固定§54/契约0.52；下一阶段先授权祖先与原source/native绑定，再关闭后消费。原snapshot写回/latest、发布/隔离cwd/固定工具/离线依赖及真实工程执行提交仍后续，生产/default/权限退役关闭，P0待办，§0取消承诺不恢复、额度耗尽。

§54源码首审A–B已修订待复审：补Controller最后await交付前的原lease检查与独立迟到结果反例，保留内部观察等待证据；两目录原身份和有界原错随记录保存，失败仍以原异常交接。预算/范围不变，尚未测试/暂存，原grant与source/native绑定仍后续。

原workspace grant固定及真实异步续验首次唯一八组通过：审核（十一）A–B同版复审后8pass/0fail、678.9659ms/actual exit0，完整原输出3637B及11JSON2588B、原两目录路径已独立复核。42请求/33真实assessment，26登记lease最终live/pending/hosts0；0内容/receipt/native/capture、worker差值0。内部await六支与完成后迟到两支分别拒绝，原对象/字段恢复不复活、末次ctx/吞重入/falsy通过；四轮GC五目标live0。两空目录原身份记录并精确清理，无实际遗留；work清理后的真实renew ENOENT未补基线。仅三记录结果追加待复核/六文件待stage；仍不含source/receipt/native祖先或capture-copy，后续先绑定再消费及显式原snapshot写回，生产/default/权限退役、P0/§0/额度边界保持，详见固定54.4/契约0.52。

§54及最终交接已完整闭合，工作/审核（十二）冻结八文件实现原SessionFiles grant/source/receipt与实际原生授权祖先HANDLE绑定基础。新wrapper独占source、沿原compat boundary取得grant，每个新async层均借原receipt检查且末次回调后pure owner+grant；grant身份只绑定reader已登记slot，不新持HANDLE。外read后置失败清本次slice再cleanup，Unknown保留原责任不重试。拟单三节点5B/三真实reader15B/八组/四轮GC十一目标，完整源码预审后唯一测试，尚未运行。详见固定§55/契约0.53；不接§52capture-copy、发布、原snapshot写回或生产/default/权限退役，§0/P0/额度边界保持。

2026-11-02用户纠正换窗约定：用户没有要求每阶段完成就新建/归档工作与审核窗口；原意仅为上下文已经很大，例如连续几十轮输入后，才考虑换窗。此前逐阶段换窗的交接说法为助手误传，立即废止。当前工作/审核（十二）继续使用，阶段完成不触发新建/归档。仅纠正当前交接和此项记录，不改变既有验证事实；本次文档更正把当前交接文件作为第九个精确scope，源码/测试不变，仍待同版预审后运行。

§55源码预审A–C修订待复审：测试末报告先交全部实际资源责任再做成功断言；补bridge已完成而外层await未交付的三支，以及全关成功后末次guard拒绝的普通释放两支。仍八组及原资源预算，源码实现不改、未运行。连同用户换窗纠正，精确九scope；继续当前工作/审核窗口，不按阶段新建归档。

§55首次唯一验证未通过：实际临时root/work的inode超过安全整数，原number授权在读取前拒绝；八业务组1通过/7失败，加after预期三reader而实际0的失败，框架1pass8fail/actual1。完整原输出15667B/7JSON2314B及三路径按原id清理经独立复核，无实际遗留。7prepare/0assessment、真实/模型reader与内容0、8签发40B、fixture1open/close；bootstrap1call/2264B分配未单列释放，未取得目标绑定/迟到失效/模型/GC证据，不改写为通过。源码获审版本保持，不换目录/新stat修复/重跑；下一独立前提为原grant签发时精确身份保留，详见固定55.5/契约0.53。继续现有工作/审核窗口，生产/default/权限退役仍关闭。

§55失败记录已复核、全部保持未暂存；§56仅补原grant签发时的精确身份前提，原同次bigint观察与原对象通过私有WeakMap关联，legacy数字/JSON保持，既存恢复只比较、克隆不继承、unsafe无来源仍拒绝。Controller固定原来源含undefined、lease弱pin及纯尾核，binding不授内容权。新六组/两空目录/分项预算与GC待源码预审后唯一运行，本项不接native/capture，不把后续结果回填成§55通过。当前原窗口继续、并集12scope不暂存，生产/default/权限退役及§0/P0边界保持，详见固定§56/契约0.54。

§56精确签发前提已取得限定验证并独立复核：首次唯一6组全通过/exit0，完整原输出3400B/11JSON2648B。实际两目录均unsafe legacy inode，原bigint精确签发、无来源克隆拒绝、既有primary不补发、撤销和四轮GC六目标live0成立；两原身份目录已清理，独立PS7确认不存在。签发请求9/成功8、比较3、prepare9/renew2/assessment9、末登记live/pending/hosts0，0内容/receipt/native/capture。原§55失败及尚缺原生读取组合证据仍单独保留；本项不代表整合通过。四记录追加后对同一十二路径再审并精确暂存，实际闭环以暂存后独立核验为准；原删除/patch不动、不commit/push。详见固定56.4–56.5/契约0.54，继续现有窗口，生产/default/权限退役与§0/P0边界不变。

§56最终十二路径已精确暂存并获独立复核，index2019；用户要求继续完成剩余任务。当前§57针对新精确签发补此前未到达的读取组合证据：新增五组/单三节点5B，真实目录绑定、迟到撤销与post-read清零、Unknown及十二目标组合GC，五scope（新test+四记录），既有实现保持。真实/模型/receipt与scratch分列预算，完整方案见固定§57/契约0.55，源码待审尚未运行。原§55失败不回填，不重跑旧测试；此项之后仍接capture/copy发布、显式原snapshot写回及真实执行/最终验收。当前工作/审核窗口继续，不按阶段换窗，不commit/push/PR。

§57新精确签发读取组合首次唯一五组通过并独立复核：5/0、actual0，原输出14227B/20JSON13552B，3真实reader底层15B/交付10B/外层拒绝清5B；29句柄全关、峰9、native1826+bootstrap1、scratch9056分配与释放一致。模型11/28B，四Unknown仅模型；含sidecar十二目标GC live0，三登记路径已清理并独立确认。旧§55首次失败保留；五文件结果记录与精确暂存待复核，完整证据见固定57.3/契约0.55。当前继续全close后的capture/copy与安全发布，再补原snapshot写回、真实执行和最终验收，不以§57完成代替全部剩余任务。

§57暂存格式修正记录：首次精确git add五路径已执行，但后续cached差异检查发现新test第496行EOF多余空行，原命令chunk533254实际exit1，不记成暂存复核通过、不reset/unstage。仅删除测试末尾一个LF（0x0A），从38669B变38668B，当前SHA256 6547A7E94069F93DECF9143589C745E74D93C0887785EC286E0670A1543A10E4；在内存回拼该LF后严格恢复已运行原SHA C98F678BD88C9C3D04EACCC5FF5B4E7FE5384677C900E2DA723250F3B2A47F06（chunk18a035）。执行内容未改，不重跑；§57原运行5/0及原字节输出证据保持。四记录只追加此事实，修订摘要复核后精确更新本五路径暂存，再做完整同版/范围外/余留原改动检查；当前不预称该修正已完成暂存复核。

## §58 同原授权的输入捕获、复制和元数据发布（源码预审，尚未执行）

§57五路径格式修正已完成最终独立暂存核验（工作chunk99568a、审核chunkd14f4b均exit0），index2020，范围外2015摘要保持。继续当前工作/审核（十二），不按阶段创建或归档窗口；全部剩余任务仍包括原snapshot写回、真实隔离执行/候选消费/宿主应用、P0实机与最终切换验收。

本项仅八路径：session-input-workspace-permission.ts、windows-sandbox-workspace-source-reader.mjs、新windows-sandbox-workspace-input-capture.mjs、新windows-sandbox-workspace-input-capture.test.mjs和本四记录。基线index2020，本范围外2014条目SHA256 5375FEF0BCA9D80DCAB12A6406F2D4AFE15466DAE71C84EA9F70629D34D60FDE。不更改原九删除或super-pi-clipboard-fix.patch，不commit/push/PR；旧§55失败不回填，不重跑§55–57或旧容量场景。

桥接层新增同一个InputWorkspaceGrantLease固定prototype renew；没有重新prepare、重签grant或receipt。每层await回来重新验证原source/receipt/binding，最后为无回调owner+grant纯核验。reader的seal只在全部原生资源已关闭后保留原guard，禁止再次read/initialize；原settle仍释放guard。seal/cleanup complete本身不等于capture成功。

新owner独占reader和OfflineInputSnapshotOwner：new→preparing→capturing（同步借用）→renewing→captured；capture只在全关和原授权续验后返回。copyFile每个暴露条目最多一次，先同原续验，再分配copy，返回前做完整source/receipt/binding及最终纯核验；拒绝时清新copy和私有原buffer，已成功交给调用方的历史副本由调用方负责。publishMetadata最多一次，同样续验和最终核验，返回构造时冻结的原canonical数据；元数据不是授权。最多16条/每文件4KiB/总16KiB/metadata32KiB，故成功阶段最多初次1+copy16+metadata1次续验。grant续验重观察原授权目录与当前许可范围，不宣称捕获后所有文件仍未变化；宿主写回须另核原snapshot磁盘基线。

撤销在异步等待中立即清理未被借用的私有buffer，并使原reader失效；同步读取/回调仍持有buffer时只标记、由原栈返回后清理。pending直到原调用落定才归零。任何Unknown保留原reader/operations/slot/error/attempt责任，不因active=0推定complete，不重试dispose/close。CaptureIO的活跃同路径检查使用原token stat；底层失败先全关时，仅在固定原reader诊断明确complete、native complete/active0/unresolved空且原token精确匹配时确认该token已关闭，不再native close，不掩盖最初错误（含undefined/null/0）。

唯一拟运行新test六组，完整源码独立预审后才运行固定Node26.13.0 --expose-gc --test --test-concurrency=1该文件。一个sp-workspace-capture-* root/work/source.txt三节点固定5B，记录原身份逐节点清理；真实reader恰3，真实读取总15B：exact/ancestor两次正常capture与真实post-read撤销一次；业务每reader open≤256/peak≤82/native calls≤8192/read calls≤4096，合计open≤768/calls≤24576；bootstrap仅volume一次。scratch为bootstrap+3reader各2264B，预计9056分配=释放；私有capture每次5B，两个成功调用方副本各5B，第三次实际读取外层拒绝清5B并确认已关token一次。

模型reader≤20（源码18）、模型读取≤128B（分支固定请求、每read最多2B）。六异步gate：capture/assessment撤销、copy/assessment撤销、metadata/assessment重入、capture/bridge完成后owner变更、copy/source完成后原grant变更、metadata/bridge完成后原receipt失效；每例新model capture最多5B。三同步分支为read撤销、read抛undefined、leaf close后撤销；三Unknown为pending open、leaf close抛0、所有句柄关闭但dispose抛0，保留原责任不重试。两post-copy原receipt回调改变owner/grant，实际新copy各5B清零；一次成功copy后重复copy拒绝且历史副本保持；两个模型验证seal与原settle释放语义；captured wrapper仍存活时四轮GC检查十二原目标含签发sidecar，随后消费拒绝并清私有buffer。

host/grant原签发/receipt各≤12、prepare≤40、assessment≤256，JSON报告≤48KiB，逻辑receipt每次5B；test没有worker、外部进程、VHD、WSB或生产切换。报告先记真实分支部分结果/缺计数/原始错误和责任，再做成功断言；Node隐式metadata I/O、全部OS句柄和V8分配不声称完整计量。属于低频验收/授权生命周期扩展，未改provider/render/event等热路径、不引入pool、不作零分配或热路径性能提升声明。当前仅源码静态检查，尚未import/编译/测试/暂存，最终证据以首次唯一实际执行及独立原输出/资源核验为准。

§58源码预审修订（未运行）：审核cursor77指出两处测试前置错误，现已修正。第六组两个standalone reader各通过原token分段读取完整5B、核对alpha并close，再验证seal/settle；两个测试buffer共10B在finally清零。第四组close失败只注入openKind=read，明确记录且断言读取5B、原read close恰一次、原handle和Offline owner保留token同槽、重复dispose不再调用close。分项模型读取：六await gate30B，三个同步分支2+2+5=9B，三个Unknown0+5+5=10B，post-copy三例15B，standalone两例10B，GC捕获5B，总79B/18模型；保持≤128B/≤20上限。真实3reader/15B、9056scratch和其余预算不变。实现三文件未改，仅新test及四记录追加；仍未import/编译/执行/暂存，修订摘要复核后再唯一运行。

### §58首次唯一验证结果（独立原输出与资源复核通过）

获审test SHA60FD22AAA972DD5105632C20DE73157E922A7132E483A687D2B557DB40C95490，三实现摘要未变。紧邻preflight chunk6e27e3/exec-52ec91cf-076f-41c6-b948-4ffa759e21a4通过后，首次唯一执行固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-workspace-input-capture.test.mjs。原commandExecution exec-e65969b5-a80f-4236-a4a9-1b97a33f5e45/chunkec6f15，actual exit0/completed/1074ms、工具wall1.0747453s、框架981.7238ms，6pass/0fail，无cancel/skip/todo/工具session。原输出42204UTF8B，22JSON含LF41430B（≤48KiB），stderr无独立字节计量；时间不作优化证据。

审核cursor89已从原始执行记录独立确认命令事件与原工具输出逐字一致；现场检查chunk1320fc实际exit0，以下三登记路径均PathNotFound/ObjectNotFound，原身份清理证据一致，无本项实际资源遗留。八获审文件/七冻结依赖/六旧暂存对象均未变，原九删除/patch保持。

唯一root C:/Users/Administrator/AppData/Local/Temp/sp-workspace-capture-Elcpz7及work/source.txt，dev均3637606815，原ino依次3659174697855695、4503599627988166、3659174697856242；三节点逐原id/类型/父链/canonical校验清理，各Node ENOENT。fixture显式open/closeAttempt/closed各1，记录节点3，无保留fixture handle。host/原grant/receipt签发各8、逻辑receipt40B、wrapper重签0；prepare21/assessment88、登记21，最终live/pending/hosts0。

真实reader3：底层15B/3次read，source成功交付10B，真实read先返回5B再外层拒绝清5B；实际open/closeAttempt/closed均37（13+13+11），peak9、active0、unresolved[]。业务nativecalls5762（2246+2246+1270）加bootstrap1；bootstrap和三reader各scratch2264B分配=释放，总9056/9056、retained0。真实capture私有分配15B清15B，两个成功副本各5B，两个metadata与copy均在native全关后续验同原grant，各3renew/原grant observations4，无重开原生reader。真实post-read拒绝确认原已关token恰1，无duplicate close；其原错误workspace source inactive由外层保留。actualUnknown0，worker启动/调用差值和pending均0，missingCounters/errors均空。

模型18、实际读取79B（30+9+10+15+10+5）。六原await/完成后gate及重入均拒绝并归零pending；同步借用在原栈返回后清理；三Unknown分别pending未决slot、原read close抛0、全部handles0但dispose抛0，保留原slot/token/error/attempt责任，重复dispose不加close。两个post-copy回调真实分配新copy各5B后拒绝并清零；历史成功caller副本不被后续拒绝清掉。standalone两个原token读完后验证seal保留guard和旧settle释放guard，独立测试buffer10B分配清10B。所有capture私有分配90B清90B；copy分配25B=交付15B+拒绝清10B，成功15B由测试finally清零；这些层次可能清理同一底层借用，不把重叠清理相加成独立实际内存。captured wrapper保持存活，四轮GC十二原目标（含sidecar）live0，之后消费拒绝并释放私有bytes。

证据仅覆盖本项capture/copy/metadata和模型生命周期。模型Unknown不是实际OS遗留；Node隐式metadata I/O、全部OS句柄、V8分配不声称完整计量；immutable元数据不是授权；授权目录续验不承诺捕获后所有文件仍未变。§55旧失败/§56–57原结果不改写。后续原snapshot宿主写回、真实隔离执行/候选消费/应用变更、P0实机及最终切换仍未完成；生产/default/旧权限退役保持关闭，不恢复§0取消承诺或旧额度场景。

本次八路径待精确暂存及暂存后独立复核；预计index2022，本范围外2014条目及原SHA5375FEF0BCA9D80DCAB12A6406F2D4AFE15466DAE71C84EA9F70629D34D60FDE保持。原九删除/patch不改，不commit/push/PR，不按阶段新建或归档窗口。

## §59 原生写入显式原snapshot与兼容隔离（源码预审，尚未运行）

§58已最终闭合：工作精确八路径暂存exec-21493b7c-23aa-4d4f-9175-0203e8379134/chunk6f47f4 exit0；审核cursor97/独立chunk4306e0 exit0，八工作SHA/blob/六旧→新/两新cached检查一致，index2022/外2014原摘要保持，仅余原九D+patch。六组唯一6/0及§55旧失败均保持，不重跑。

采用审核cursor95/97同意的native-only 11scope：core/files/file-parameters.ts、file-batch-protocol.ts、file-service.ts、file-invocation.ts、file-batch.ts、session-files.ts，新tests/windows-sandbox-explicit-write-snapshot.test.mjs及本四记录。基线index2022，本范围外2012条目SHA256 71F52AA79FB24708AF3E51614E0CA3DDEB2C93E24D68675C8DEAB6162375ADE2。旧extension两入口不改，§58其他源/test不改，不commit/push/PR，不按阶段新建/归档对话。

WriteParameters原样保留，另加NativeWriteParameters，由原schema属性派生并增加符合SNAPSHOT_ID_PATTERN的optional snapshot，仅FileService验证与SessionFiles.install(write)选用。copyBatchInput默认不接纳write snapshot（包括原先拒绝的own snapshot:undefined字段）；仅core FileBatch固定传内部true启用，不把该开关放入用户input。显式snapshot只允许overwrite，create拒绝。FileService mode=create+snapshot在路径观察前拒绝，缺失目标的显式snapshot在creation判定后拒绝，绝不把修改退成新建；现有input.snapshot ?? latest选择保持，显式原版本不重新取latest。缺省snapshot原行为保持。

单write请求摘要在原content字段后，仅当snapshot !== undefined时追加固定snapshot;标签及结构化长度+值；批量通过已有递归绑定同字段。缺省snapshot的旧摘要保持，例如write/source.txt/next无purpose的旧SHA256 80b5943cd8c85e39d1f9476c908dcdcb09e7a5a814c8cc41401d7ae760392df7。这样prepare/permission/consume同原输入校验能够发现快照替换或移除；不能把摘要当作独立授权。

调用链已只读审查：原生SessionFiles prepareInvocation→FileBatch/FileService prepare→mutationRequestHash，Controller原path approval→consumePermissionPathApproval→同invocation consume；旧extension reexport WriteParameters及默认copyBatchInput仍拒绝新字段，旧write body不会静默忽略已公开的新字段。另核对hash在完成/意图记录和/changes有界恢复中的使用，缺省旧hash保持。改动限schema初始化、有限调用的准备/授权消费、每次请求的摘要；不改provider/message_update、progress delta分发、render/layout、terminal或Evidence Ledger lookup，不引入pool，不作热路径优化/零分配声明。实际installed permission消费、host writeback及Sandbox执行仍是后续整合，不能由本项preflight证据替代。

唯一拟运行新test一个有界组合：纯旧/native schema对比，五种非法snapshot及extra field/create拒绝；旧默认batch拒绝显式与own undefined，原生batch保留冻结原snapshot；single/batch hash更换snapshot不同、single移除不同、旧缺省hash不变。实际一个sp-explicit-snapshot-* root/source.txt共两节点，exclusive初写alpha5B，然后同原file identity的r+改写beta4B，仅fixture初始化/外部变化模拟共9B；两次真实issueSnapshotForRead签发原receipt合计9B。显式old在newest仍live时拒绝且不调用latest；原old失效后再次拒绝；显式newest准备成功、legacy缺省调用latest恰1；缺失目标snapshot/create+snapshot拒绝、缺省create只准备不执行。最后batch先准备missing.txt create，再因old snapshot拒绝，已有item全release且items0；检查source仍beta和missing仍ENOENT。

预算：一次Node26.13.0 --test --test-concurrency=1该新文件，direct prepare恰7/上限12，FileBatch.prepare一次含另2次service prepare，whole-batch执行入口0、宿主应用请求0；fixture显式open/closeAttempt/close预期各2、write9B，final读4B并finally清零；receipt签发2（守卫上限3），成功direct plan3分别release，service.dispose后revisions0。只登记两节点，创建成功即先登记路径再取得原id，按原身份/类型/父链/canonical逐节点清理；任何close未知不重试，不猜测清理路径。不启动worker/WSB/VHD/helper或做容量/旧矩阵验证；native worker启动/调用差值与pending预期0。报告先列实际部分结果/原责任和错误，再作最终断言；Node内部stat/read/文件提交预检的临时buffer不声称完整OS句柄或分配计量，也不外推实际写入完成。

当前仅11scope源码/记录草稿和静态差异检查，尚未import/编译/运行/暂存。完整源码、冻结摘要及本预算独立复审后才唯一验证。之后继续候选bytes严格UTF8往返、原snapshot+原会话的安装后权限/全批预检/逐项提交回执、真实隔离输入/工具清单/执行/P0及最终切换；全部剩余任务仍未完。

### §59 首次源码复审纠正：有界历史恢复（未运行）

审核cursor101发现changes.ts旧恢复字段白名单拒绝新write snapshot，使合法新请求的/changes回执无法关联。按同次明确范围调整，将core/files/changes.ts加入原11scope成为12scope；其原65807B/SHA256 61D05CD2BC8EEEF13DBE6176B2CFCAD4F1BAC5FFA90DE555E4BC48E56263D2B5/blob299cd9ad4eba14458549ea6e975caa4d7e68184b。紧邻扩围基线chunk25d0fb exit0：index2022，范围外2011条目SHA256 BF5638A36FE505671A76F724FC5AF4496B41FD5511222FB36C9BC163F2F98BF4；changes.ts改前工作区等于原index。其余原基线保持，原11scope说明保留为首次提案记录。

修正仅允许单项/批量write恢复字段snapshot；有值时按现有字符串预算消费至多27UTF8B并检验原SNAPSHOT_ID_REGEX，批量仅overwrite，create+snapshot拒绝。沿用原总4MiB恢复预算、每次mutation1MiB预算、有限512条分支、原requestHash/顺序/target/terminal检查，未调用observe/verify或扩大可重放权限。完整调用链复查：唯一生产collectChanges调用位于显式/changes命令，入口要求idle UI→recentMutationEntries→有界恢复→collectStructuredMutationReceipts/uniqueBatchPreparation/boundBatchIntents→现有hash关联→记录→用户另选View/Verify/Draft；它不在provider进度、渲染或Evidence Ledger lookup循环中。新字段常量仅模块初始化，校验沿用已有局部预算，无新增per-entry数组/closure/pool，不作性能改进声明。

原新test中增加11次纯内存恢复模型，每次4条历史（总44），每分支JSON最多4096UTF8B/总45056B；单项及batch各验证：合法同snapshot关联、改snapshot拒绝、移除拒绝、旧缺省仍关联、非法latest即使hash一致也拒绝；另一次batch create+snapshot即使hash一致仍拒绝。预期4次关联/7次拒绝，关联核对requestEntryId、原input同一对象、postimage，无关联时三者均undefined且明确unavailable。模型只传入虚构历史，不签发真实变更回执/授权、不触发磁盘观察或应用。原两节点/9B fixture、prepare/receipt/worker预算均不变；仍只首次唯一执行这个新test文件，不重跑任何旧矩阵。

当前12scope尚未import/编译/运行/暂存；需修正源码及冻结摘要复审后才运行。此修正不改写§58或§55失败事实，也不代表宿主实际写回已完成。

### §59 首次唯一验证结果（预检及恢复，不是宿主应用）

源码获审cursor106/独立chunk1a7b8e exit0后，紧邻preflight chunk68a620 exit0核对冻结12scope、10既有依赖、固定Node/PS7/Koffi三二进制及原index2022/outside2011。唯一执行Node26.13.0 --test --test-concurrency=1 tests/windows-sandbox-explicit-write-snapshot.test.mjs，原commandExecution exec-dec89e11-b2e8-4e0b-943e-eafa64b141f5/chunk1c5381：actualexit0/completed379ms、工具wall0.3798943s、框架308.7745ms；1pass/0fail，无cancel/skip/todo/工具session。test冻结SHA A98372F9004603176FD77548B2EB002E33E555EF59762172DAFD3827BEC952D0/blobbf7e306e3b5a2cfe56d50639bbd5855d040e90c1保持。原完整输出1588UTF8B，4JSON含LF1381B；stderr无独立字节计量，时间不作性能证据。

纯内存历史恢复实际11调用44条/15619B，4绑定7拒绝，filesystemOperations0；这不是11次实际宿主写入。真实fixture唯一root C:/Users/Administrator/AppData/Local/Temp/sp-explicit-snapshot-BJ7B8Q及其source.txt，dev均3637606815、原ino分别5348024558118302和1688849860880060；显式open/closeAttempt/closed各2，fixture初写/外部变化模拟总9B；两节点按原身份/类型/父链/canonical逐个清理后Node ENOENT，retainedFixtureHandle false，safe/succeededtrue，errors[]。两份原read receipt合计9B、direct prepare实测7，batch内部另2次prepare由冻结源码调用链确认（非额外实测计数）、latest恰1、成功direct plan3均释放、service.dispose后revisions0。原source最终beta、missing.txt未创建；批量准备中后项旧snapshot拒绝并释放前项，executionMethodsRequested0、finalTargetsVerifiedtrue。worker启动/调用差值及pending均0。

证据覆盖新旧schema隔离、原snapshot绑定及缺省兼容、create/缺失目标拒绝、单项/批量历史恢复和未执行预检释放；不替代installed permission消费、真实write commit、新增文件或Sandbox运行。模型回执不当作真实变更事实；未计量Node隐式OS I/O/临时buffer全量，也不声称全局V8零残留。不重跑、不改写§55或§56–58旧结果。

审核cursor112独立复核原日志/原工具输出一致，并以chunk4f1ff5 exit0确认两登记路径均PS7 PathNotFound/ObjectNotFound、12冻结文件/11原index不变；chunk6a7619确认10既有依赖/3二进制摘要保持。无本项实际遗留，原九删除/patch保持。

本项12scope待精确stage及暂存后独立复核，预计index2023、范围外2011及SHA256 BF5638A36FE505671A76F724FC5AF4496B41FD5511222FB36C9BC163F2F98BF4保持。仅新test增加一索引条目，原九删除/patch不动；不commit/push/PR，不按阶段开新对话。后续继续严格UTF8候选请求、同原会话/权限实际写回、真实隔离输入与工具执行、P0和最终切换，生产/default/旧权限退役仍不宣称完成。

## §60 候选字节到原生写入请求（源码预审，尚未运行）

§59已完成首次唯一1/0及独立复核：精确12scope stage exec-0b46cfa2-9870-45d0-a9b2-6701c136361a/chunk229ad1 exit0；审核cursor116/独立chunk8970d8 exit0核对12SHA/blob、11旧→新、新test cached及工作/index一致。index2023/outside2011原摘要保持，原9D+patch不动，无重跑/commit/push/PR/新窗口。

按cursor114/116认可的6scope：新scripts/acceptance/windows-sandbox-candidate-write-batch.mjs、新tests/windows-sandbox-candidate-write-batch.test.mjs及本四记录。落盘前chunk9b671c exit0确认两新路径不存在，四doc仍为§59最终index；index2023、本scope外2019条目SHA256 9AA37CD1FCD7136714CD677D295D639A9A8E5886C360D14BE31ACDBD888CC1A2。依赖原CapturedCandidateOwner SHA7DF38019A8E4885264EB27FAFBBD18D468C8D6F691993393A9FBFADEE488CCA4、candidates.mjs SHA7025A6B392C34549910B4BB15D2026A11DB02D9FF025DE0DB97B739327AB57CE、regex.ts SHA709E48987D8CA1B7E5F5846B6EAAC8BDCB21240DE4E513AFF9C7B63B4206B722，不修改§59及更早源码/test。

CapturedWriteBatch.prepare只接受固定CapturedCandidateOwner原型getter/copyBytes可以访问私有brand的实例；这只是数据来源类型及存活校验，不是授权或真实guest来源证明。模块WeakSet记录每个原owner一次转换attempt，不强保留key；同转换器一次prepare。先检查全部记录与预算：1–16项、每项≤4096B、总≤16384B，add原revision须null，modify须精确27字符且原SNAPSHOT_ID_REGEX通过。之后逐项恰一次原copyBytes，核对长度与SHA；fatal UTF8/ignoreBOM true解码并用独立Buffer精确往返比较，保留BOM/CRLF/NUL/Unicode。任何失败拒绝整批、释放已转换字符串引用；每项copy/roundtrip自有buffer在finally清零，计数区分两种分配。

生成operation=write，add为mode=create且不含snapshot，modify为mode=overwrite且保留原snapshot。operations和每item冻结；顶层operations公开字段不可写/不可配置，顶层对象仍可扩展以附加PREPARATION/权限符号，也可能附加其他属性（不声称只允许某个符号）。take前用固定原getter再验原owner存活，take成功或失败均释放转换器保留的owner/binding/input等；dispose同样释放。成功移交的数据由调用方持有，之后原owner撤销不偷偷擦除已交付字符串。字符串无法原地清零，仅释放本层引用。空候选不给出可执行空batch。无磁盘I/O、权限授予、native invocation、WSB/VM或提交入口。

完整调用链只读检查：原捕获owner acceptManifest/acceptBatch有限校验→固定getter/once copy→本同步转换器UTF8/hash/once take→未来宿主私有组合继续原SessionFiles prepareInvocation→实际installed Controller.authorizeToolCall→原invocation.consume→原installed file_batch.execute。当前未接入后四段，不以模型回执冒充实际写回；原CapturedCandidateOwner仍只负责捕获数据契约。新增代码限显式一次候选消费，未接入provider/message_update、工具进度、事件分发、render/layout、terminal或Evidence Ledger lookup；无pool/性能优化声明。

拟唯一新test六组：精确保留空文本/BOM/中文/CRLF/NUL/emoji和modify原snapshot，冻结公开字段/允许运行时symbol；四种非法UTF8（非法首字节、截断、多余编码、代理项）置第二项，验证首项已转但整批不可取并清理；两种非法原snapshot及空候选在复制前拒绝；伪实例/原型伪造/Proxy拒绝，替换公开getter/copy不劫持原方法；prepare前/后撤销均拒绝take并释放；保持转换器活着，对原capture做四轮GC确认WeakSet不强保留。合法及失败原owner都拒绝再次转换。

预算一次固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-candidate-write-batch.test.mjs。纯模型owner12（守卫≤16）、converter20（≤24）、prepare尝试25（≤32）、candidate payload合计75B（≤512）；模型fixture自有buffer总分配守卫65536B、全部finally清零，最多一个fixture存活。预期converter原copy14次/66B、roundtrip58B、合计清124B/retainedBytes0；20个终态diagnostics均无candidate/input/binding引用。四轮GC一个原capture目标，converter仍存活，预期live0。原capture内部manifest/request/payload有各自清理，不将其与本层重叠计数混作全局内存；全部V8字符串/OS句柄不声称完整计量。报告只计数和状态，预期≤8KiB，不输出候选正文。无filesystem/guest/nativeFile execution、无实际临时文件或进程，无旧额度/故障矩阵重跑。

当前仅6scope源码/test/文档草稿，尚未import/编译/运行/暂存；完整源码与冻结摘要独立审核后才唯一验证。随后继续实际同会话宿主写回、隔离输入/cwd/工具与guest执行、P0实机和最终切换；本转换数据不替代原授权/原snapshot/全批预检/逐项commit事实，生产/default/旧权限退役仍未完成。

### §60 首次唯一模型验证结果

源码获审cursor119/独立chunk9acb5d exit0后，紧邻preflight chunk68245d exit0核对6冻结scope、21既有依赖（含本项3个直接依赖）、固定Node/PS7/Koffi三二进制及index2023/outside2019原摘要。唯一固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-candidate-write-batch.test.mjs，原commandExecution exec-94f654a7-3c25-4edf-a631-fa7a9cc13a5d/chunk1805d3：actualexit0/completed189ms、工具wall0.1900271s、框架97.1786ms；6pass/0fail，无cancel/skip/todo/工具session。原输出1032UTF8B、两JSON含LF367B，stderr无独立字节计量；耗时不作性能结论。源码SHA2F419AC72E38D5F55833871687261508C8ADBEAF99775A53C2D8FD0E7FEFE421、test SHA CD6670F3B5F127C1362AAA6B4AF83D19D1F4CEC945832714077E3A2425619D47保持，不重跑。

实际owner12/converter20/prepare尝试25、payload75B；converter复制14次/66B，roundtrip58B，清零合计124B且retainedBytes0。fixture自有buffer分配19004B/清零19004B、activeFixtures0；20终态diagnostics的candidate/input/binding引用释放断言通过。converter保持存活，四轮GC/一个原capture目标liveTargets0。无filesystem/guest/nativeFile执行；没有实际临时文件/VM/helper需要查删。不同层计数不合并成全局内存，字符串仅释放本层引用，不声称其已清零或全部V8内存归零。

审核cursor122独立确认原command记录与原工具输出完全一致、字节计数一致；chunk6ecde3 exit0核对6冻结文件/4原index、两新文件未暂存，index2023/outside2019原SHA保持；chunk561778确认21依赖/3binary未变，原9D+patch保持。该证据仅模型数据转换/生命周期，不证明真实guest来源、宿主权限消费或实际write提交；§55及后续旧结果不改写。

本6scope待精确暂存及暂存后独立复核；预期index2025（仅两新文件新增）、范围外2019及SHA256 9AA37CD1FCD7136714CD677D295D639A9A8E5886C360D14BE31ACDBD888CC1A2不变。四旧→新blob和两新完整cached差异均需检查，原9D/patch不动，不commit/push/PR/新建窗口。下一步实际写回需记录原创建/提交对象身份，以便按原身份收尾；拟优先复用现有NestedToolDispatch到原installed file_batch的真实权限/调用链，不为新功能旁路授权。完整隔离输入/guest运行/P0/最终切换仍继续，生产/default/旧权限退役不提前宣称完成。

## §61 原回执身份事实与真实宿主写回接线（源码预审，尚未运行）

§60已最终闭合：精确6scope stage exec-2441f8cc-17b9-4f55-ba66-7dd912de8d2d/chunk432cae exit0，审核cursor126/独立chunk45ea66 exit0核对6SHA/blob、四旧→新/两新cached及工作/index一致。index2025/outside2019原§60摘要保持，仅原9D+patch；6/0旧结果不重跑，不commit/push/PR/新开窗口。

按cursor126认可的8scope草稿范围：core/files/file-commit.ts、file-creation.ts；新scripts/acceptance/windows-sandbox-apply-captured-writes.mjs、新tests/windows-sandbox-captured-host-write.test.mjs及本四记录。落盘前chunkdc5ed7 exit0确认六现有路径等于index、两新路径不存在。index2025、本scope外2019条目SHA256 2EC41744482EB1633E70156201A3D612FA7D16F028BEF37EA0370405EC61F18F。commit旧16800B/SHA C43D4FEF4E38D92DC8A166A9AE5762F169B8B1B7A47D7010872143CBEFDD60C1/blob39908176f82c0d703765fa9b938914adbf5af9be；creation旧8398B/SHA261F87262C6C1F4AA0399AB880F5C685B83463C29A7755607A0E163C5B3D9E94/blobae39da57cf313e51999576ee438635fa0620ff81。四doc以§60最终index为基线，§59–60等其他源/test不改。

两个生产模块各加一个私有WeakMap和只读查询，无外部setter、无新序列化回执字段。commit的值仅从原temporary/publishedObject生成冻结{最终target path,device,inode}，记录点在原cleanup之后、原return/原FileCommitError之前；仅publishedObject已由原流程确认时关联。staged_replace身份来自原创建handle，protected_in_place来自原已固定target。已确认committed但postcheck/close失败的原FileCommitError.receipt可保留该历史关联；unknown/not_committed不凭后看路径生成已发布证明。该事实不保证当前路径仍相同，也不是权限或清理许可。

creation只在原exclusive open的handle.stat取得device/inode，成功完成原close后与原CreationResult关联；不以之后的lstat补成创建归属。原失败仍序列化Error.message再由FileService解析，没有原CreationResult，因此本稿不声称失败创建身份可以经旁表到达最终结果。实际验证若发生该失败，必须保留计划路径/原错误/未证明身份和收尾责任，不能猜删或靠新stat填补。旁表值没有handle/owner/授权对象引用；copy/JSON导入/原型派生/Proxy不是原key，不能取得关联。

完整结果链已读：原commit/creation→FileService.receipt保留commit或creation对象→BatchExecution.items.receipt→formatBatchResult.details.items→Agent createToolResultMessage.details原引用。新增身份关联仅在有限文件提交完成边界；未改progress/event delivery、provider delta、render/layout、terminal、large output、Evidence Ledger lookup或Agent热路径，不引入pool或性能改善声明。新增桥接只做一次§60转换、核对host给出的五个task binding字段、一次原executionContext.callTool(file_batch)，无直接文件I/O/自动retry/fallback。executionContext由可信宿主提供，桥接自身不证明调用方权限；不接受伪造callback回执作为真实链证据。失败原child仍标记parent失败，未用allowFailure压掉失败。

拟新test一个真实宿主集成：真实Agent生成两个独立接受性parent invocation，每个调用read及file_batch，共4个nested call。仅该新fixture parent声明orchestration，既有powershell/工具标记和Agent代码保持。真实createExtensionRuntime/SessionFiles先建立，再加载原resource-lifecycle-guard，其原getSessionFiles发现owner并安装实际SessionPermissionController；使用SessionManager.inMemory，原read definition、SessionFiles.install、原wrapToolDefinition、原ExtensionRunner.emitToolCall及finalAuthorization消费。before hook核对被选wrapper与原definition，观察原审批对象/hash和原pending invocation；after hook仅读取实际返回原receipt，不伪造审批或提交。

源码别名明确映射file-invocation/file-host/file-batch-protocol/file-commit/file-creation/input-workspace-grant-lease/session-input-read-permission到相同原src URL，并断言permission-contract.mutationRequestHash及两个旁表查询函数与直接source import为同一函数。原permission扩展index含TS参数属性；固定Node --help只读检查chunk845a2a exit0未列transform-types选项，未因此试跑目标。新test注册load hook仅对该唯一原index URL用既有TypeScript5.9.3转ES2022/ESNext，保留URL和模块实例；source≤128KiB、输出≤256KiB、恰1次，hook在import后解除，无编译落盘。其他目标模块普通导入，没有Jiti另起模块缓存。该编译只在获审唯一test启动时执行。

真实fixture一个sp-captured-host-* root、source.txt及计划new.txt三最终路径。先原exclusive handle写alpha5B，第一parent真实read得到原snapshot后用同原identity的r+写beta4B（fixture共9B/2open/2closeAttempt/2close）；第一份纯模型capture含add new.txt和modify oldsnapshot，经真实调用链整批准备拒绝，parent isError、没有实际receipt/审批、new仍ENOENT/source仍beta。第二parent是独立新请求，真实重新read取得新snapshot、另一个模型capture和新task/snapshot ID，再通过真实原权限和文件工具完成add new.txt=5B、modify source.txt=6B。只在此新请求使用新snapshot，不替换第一请求原基线或自动重放。

两份capture各11B候选，模型wrapper buffer累计守卫16384B、finally清零并释放capture；它们不是guest来源证据。预期2原生成功receipt/1原审批、六条原file-mutation-progress-v2均绑定成功batch hash，pending/inFlight/revisions归零。实际commit可能按原能力选择staged_replace或protected_in_place，测试不强迫策略；替换会产生原core负责的私有临时对象及发布身份，三最终路径数不冒充全部OS创建对象数。通过原返回对象旁表保存两个最终对象的原身份，与initial source身份分别记录；复制/JSON/派生/Proxy查询均应undefined。外层四轮GC检查两个原receipt key释放，旁表metadata可继续作为普通历史数据而不保留key。

原native worker本项最多启动1次，calls≤128、publicationAttempts≤1；记录原stats activeHandles/activeDescriptors和pending，必须为0才按原Worker owner释放。正常stats只一次；若在此前失败，仅在尚未尝试stats、pending0且worker未failed时允许一次诊断stats，不重试已失败stats或写入。stats未知/句柄未闭/pending不为0时保留worker责任，不通过terminate掩盖unknown。runtime依次等待Agent idle、原session_shutdown、原boundary/provider owners释放，再invalidate并释放内存session/Agent引用；未使用Chrome或截图，其原cleanup集合为空，不广扫/猜杀资源。

只有所有实际操作和关闭证据完整时才按登记root/最终原对象identity、父路径/canonical/type逆序unlink两file和非递归rmdir root，各自确认ENOENT。任何意外错误/partial/unknown/关闭未决均safe=false，先报告原错误、计划/已发身份及资源状态，不执行猜测清理。fixture统计不包含Node隐式全部OS I/O；native stats也不等于全部Node句柄/分配，字符串与V8堆不声称全量清零。

拟唯一固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-captured-host-write.test.mjs；预期一个组合测试，无live provider、guest/WSB/VHD/helper、额度/旧矩阵重跑，输出上限16KiB。当前8scope仅草稿，尚未import/编译/运行/暂存；完整源码/预算独立审核后才允许首次真实写入。后续仍继续真实隔离输入/cwd/工具执行与实际candidate来源、P0实机及最终切换，本项不提前宣称整体验收或默认启用完成。

§61首次运行前审核修正：cursor130确认仅有两项证据阻断，未发现其他阻断项，尚未运行。新test在原before hook捕获file_batch原prepare异常，复制有限值后原样throw；第一parent结束后断言恰一个异常、parentToolCallId=captured-stale、target=source.txt、snapshot等于该parent刚取得的原read snapshot，并精确核对原子调用ID:1及[SNAPSHOT_EDIT_STALE] Source changed or is unavailable. No change.与Preflight failed; no batch item executed.，排除任意schema/导入/权限错误冒充旧快照拒绝。第二parent另获不同snapshot且不增加该准备异常。原after hook在任何session清理前独立JSON复制每item的reason/stateChanged/requiresVerification，以及receipt.status/category/cause/stateChanged/requiresVerification/fileCreated/retryable/createdDirectories/creation/commit全部原历史字段（含retainedTemporary、cleanupReason），没有receipt也保存item事实。该有限值记录累计UTF8≤8192B，不保留原receipt key、authority、handle或callback；未知/失败仍禁止清理，原两个成功key的4轮GC要求不变。8scope与一次真实运行预算不扩展，需修正后源码/预算重新审核。

§61首次唯一运行结果：失败，尚未取得真实宿主写回通过证据。修正源码获cursor136首次单次放行后，紧邻预检chunkb4008a exit0核对8scope、25依赖、Node/PS7/Koffi三个二进制、6原index blob及index2025/outside2019 SHA256 2EC41744482EB1633E70156201A3D612FA7D16F028BEF37EA0370405EC61F18F。实际仅执行固定Node --expose-gc --test --test-concurrency=1 tests/windows-sandbox-captured-host-write.test.mjs一次，未重跑。

原commandExecution exec-d75a6be1-17df-483c-8ee9-9504b77ca839（工作turn01a19b54-2ed5-7c11-af84-8d6790dfac01）/chunkb90adb，status=failed、exit1、命令duration1238ms、工具wall1.2391611s；审核原执行记录1.2389681s与工具舍入层次分列。0pass/1fail，cancelled/skipped/todo均0，framework1158.5334ms。原完整输出1490UTF8B，无JSON计数回执。原ERR_MODULE_NOT_FOUND指出packages/chrome-devtools/src/browser-manager.ts导入不存在的runtime.js。

原resource-lifecycle-guard/index.ts导入@super-pi/chrome-devtools/browser-manager；其package exports直接指向src/browser-manager.ts，该源第18行写./runtime.js，实际源为runtime.ts，当前精确alias hook未覆盖此依赖。已进入顶层动态模块加载，并允许过唯一index转译hook；不得记为未import/编译。失败早于test注册及exercise()，因此按源可达性，本测试未创建fixture root/source/new、Agent/SessionFiles/capture，未启动native worker/VM/helper；没有本测试登记资源需清理。写回、stats、清理和GC均未执行，这些不是运行计数为0或清理通过回执。

审核cursor142独立确认原命令与工具输出一致：chunk75641a exit0核对固定目标只执行1次，chunk1e3ad7 exit0核对8scope和索引边界，chunkf7a688 exit0核对8+25+3冻结哈希，原9D与patch保持；chunkf783c9 exit0确认新增加载依赖三hash。browser-manager.ts SHA42F97138AD9F5ED92F98FFD812CCDB53B850BFA0FAA75EA26CCE3094B48686BE；runtime.ts SHA939218E9728550659529B572A6275ED3BB1E3B4B5284023A7B34D65202D56038；其package.json SHA561A3851FE08329EC35D6E90BD1C5882B1B6BA756A7D52F81961E8BE950A6881。

本项保留生产源码/桥接/原test冻结值，仅四doc追加失败事实；精确暂存仍须记录复核，保存本项变更与失败证据不将失败改为通过。下一范围获准草稿为独立新test加四doc，限定原browser-manager parentURL与./runtime.js映射到原runtime.ts URL，核原state/解析次数，提交完整导入关系、三新增依赖和新唯一预算后再审；当前不放行新运行。真实隔离输入与执行、候选实际来源/写回、P0桌面及最终切换继续待完成。

## §62 原源码依赖精确解析后的真实宿主写回验证（草稿，尚未运行）

§61按原失败保存：唯一exec-d75a6be1-17df-483c-8ee9-9504b77ca839/chunkb90adb exit1，0pass/1fail，1490UTF8B；原test与生产/桥接源码不改、不重跑、不回填通过。8scope精确stage exec-5c1116cd-37cb-4e0d-8edb-e3af30f4bf80/chunk1236b4 exit0，index2027/outside2019仍§61原摘要；cursor147/独立chunkdffc79 exit0确认8SHA/blob/worktree=index、6旧→新增量/两新cached checks与原9D+patch保持。加载失败发生在动态模块图，测试主体未注册；无业务写回/资源清理/GC计数，不说加载未发生。

本项仅新增tests/windows-sandbox-captured-host-source-resolution.test.mjs及四doc追加。落盘前chunk931468 exit0：四旧doc与index一致、新目标不存在，index2027/本scope外2023 SHA256 0501219B1AB5110D6C7905022D5753396DBCA010FA0B3B275837D2DA49F7C844。新test保留§61同一有限业务用例与全部清理/失败记录/GC断言，独立文件入口仅增加已确诊依赖解析与无Chrome启动断言，不改生产路径、不新增行为替代实现。

实际加载关系：测试静态导入原src Agent、SessionFiles、SessionManager、EventBus、ExtensionRuntime/loader、ExtensionRunner、wrapToolDefinition、read definition、file-invocation、file-commit、file-creation、native-file-client及原候选转换/桥接；注册同一精确hook后动态导入原resource-lifecycle-guard/index.ts。该原index加载原Controller、core/shell分析、powershell生命周期、changes、background-shell及包出口browser-manager。Controller的原权限/状态、mutation兼容模块依赖保持原路径；file-invocation/file-host/file-batch-protocol/file-commit/file-creation/input-workspace-grant-lease/session-input-read-permission七个internal导出仍指向与静态import相同src URL，原hash与两个旁表函数同一对象断言不变。其他既有包出口沿当前环境，包括coding-agent公开shell接口和background tasks的dist，不声称全部dist重建或全源码加载。

确诊缺口只在browser-manager原URL的./runtime.js：新resolve分支必须同时匹配context.parentURL与specifier，返回原runtime.ts URL，并断言命中恰1次。原runtime仅有builtin ChildProcess type import，运行时为常量/env派生/AbortController，无导入时文件/进程I/O；原browser-manager其余运行时依赖均builtin。原browser-manager普通constructor可直接去TS类型；原index的TS参数属性仍唯一经既有TypeScript转ES2022/ESNext，同原URL、最多1次/128KiB源/256KiB输出、无编译落盘，hook finally解除。不广泛猜测.js→.ts、不模拟shutdown、不改包出口或Chrome状态。原runtime.state在加载后及业务结束都断言managedBrowser与launchPromise为undefined。

新增冻结依赖：browser-manager.ts SHA42F97138AD9F5ED92F98FFD812CCDB53B850BFA0FAA75EA26CCE3094B48686BE；runtime.ts SHA939218E9728550659529B572A6275ED3BB1E3B4B5284023A7B34D65202D56038；chrome-devtools/package.json SHA561A3851FE08329EC35D6E90BD1C5882B1B6BA756A7D52F81961E8BE950A6881。原§61四代码/test及25依赖保持；Node/PS7/Koffi仍固定。未修改生产热路径，无pool或性能改善声明。

拟唯一固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-captured-host-source-resolution.test.mjs，仅1组合。业务仍2独立parent/4nested/2模型capture各11B；原read snapshot→同identity fixture修改→精确旧snapshot整批准备拒绝，再独立新read/新snapshot经真实权限完成2项。fixture最多3最终路径、2open/2close、9B初始/外部修改；模型buffers≤16384B且finally清零；独立历史事实JSON累计≤8192B，原commit/creation两个WeakRef四GC应释放。原worker最多1启动、≤128calls、≤1stats、≤1publicationAttempt，只有确认原句柄/descriptor/pending归零才释放worker；未知仍保留责任，所有文件只按原创建/发布identity与父路径确认后精确逆序清理。完整输出≤16KiB，无guest/VM/VHD/helper/live provider、旧矩阵、依赖安装或工程执行。首次运行须完整源码/预算独立放行，当前仅草稿。

§62首次唯一结果仍为失败。cursor152放行后，紧邻预检chunk6e66dd exit0核对5scope、32依赖、3固定二进制、4旧index及index2027/outside2023 SHA256 0501219B1AB5110D6C7905022D5753396DBCA010FA0B3B275837D2DA49F7C844。唯一exec-20a778f0-9efc-49a8-82bd-71f8db161a2a/chunk49de74 statusfailed/exit1、duration1026ms、工具wall1.0269577s、审核原记录1.0265788s，framework929.4988ms；0pass/1fail，cancelled/skipped/todo0。完整原输出4088UTF8B，两JSON含LF2580B。原test不编辑、不重跑。

本次原模块精确解析1次、index转译1次，源14948B/输出16137B，七源码alias实际被使用；Chrome原state无managedBrowser/launchPromise。实际创建root C:/Users/Administrator/AppData/Local/Temp/sp-captured-host-EDhfNe（dev3637606815/ino20829148277204705）及source.txt（同dev/ino7036874418382861），独占fixture handle打开/关闭尝试/关闭成功各1，写alpha5B，无保留handle。new.txt仅计划路径、无已发identity。parentCalls1、nested before-hook计数0、batch/approval/receipt/capture/readSnapshots均0，模型分配/清零0。原owner/boundary/provider owners报告已关闭；worker启动/调用差值0、loadedfalse/pending0，stats未尝试、无worker保留。原测试safe=false/succeeded=false、两实际对象未清，失败断言为准备异常条数0!==1；没有执行外层GC。

nested before-hook为0不等于callTool未被调用。原child/parent错误正文没有保存，不能将其回填为已观测的“read not found”。只读源码机制：runHostToolDispatch在agent-loop.ts构造selectedContext时将tools缩为唯一parent；createNestedToolDispatch沿用该turn表，原read查找因此在before hook前拒绝。这解释当前计数，是源码推断而非遗失的原错误文本。采用complex-debugging-protocol建立两次失败/正负对照：§61加载缺口已由本次计数证实修正；§62入口选择假设被原host-only边界推翻。生产单次host隔离语义不应为测试扩大，后续改用原agent.prompt与固定无网络FixtureStream保留正常工具表，并先保存child/parent有界原始结果。

审核cursor156确认唯一原命令/输出一致及字节计数；chunk6979e2 exit0核5+32+3冻结值/index，原9D+patch保持。其后单独放行原登记对象精确清理脚本，不是测试重跑。固定Node哈希预核后，清理exec-23308225-9537-4779-9bc5-add989f4f7c5/chunkc2552c exit0，工具wall0.2553412s、审核原执行0.2552991s，原输出821UTF8B。逐一核原root/source bigint identity、普通类型/规范父路径/source单链接与5B大小，计划new为ENOENT；用1个原身份read handle验证精确alpha5B，1open/1closeAttempt/1close成功，5B buffer清零。重新核原identity后仅unlink source和非递归rmdir root，各自ENOENT；errors=[]/retainedReadHandle=false。该清理的1读/5B与原测试1创建写/5B分列，不改写原测试未清理事实。

审核cursor159确认清理原命令及输出、821B和原脚本一致；独立chunk828abf exit0分别检查原root/source/new三个登记路径得到PathNotFound/ItemNotFoundException，当前均不存在。本项登记fixture收尾已完成，但原业务验证依旧0/1。只有四doc追加本结果，原test、生产/桥接和§61失败保持；5scope暂存仍待记录复核。最终还需精确处理手动验收入口被scripts/test.mjs普通*.test.mjs递归发现的问题，保留源码hash与失败历史，不隐藏回归或重跑旧矩阵；本范围不改测试发现规则。真实宿主写回、隔离输入/执行/候选、P0与最终切换仍未通过。

## §63 使用原Agent正常编排入口验证真实宿主写回（草稿，尚未运行）

§62原唯一0pass/1fail不改写，原test不改不重跑；登记root/source已通过独立单次身份清理及cursor159三路径不存在复核。本阶段不再检查旧已清路径。§62精确5scope stage exec-fde24e8e-1004-4cad-bbea-1d25da1afb5c/chunkb0db31 exit0，index2028/outside2023保持原0501219B1AB5110D6C7905022D5753396DBCA010FA0B3B275837D2DA49F7C844；cursor163/独立chunk4912f0 exit0确认五工作SHA/blob及index一致、4旧→新/1新cached空白、原9D+patch保持。

本范围仅新增tests/windows-sandbox-captured-agent-orchestration.test.mjs及四doc。落盘前chunk662a17 exit0确认四doc等于index、新目标不存在；index2028/本scope外2024 SHA256 F5327BA7D149830DADAC0ADC5ADCE5BAD3CD602DB406D7EA9413951215B3FD69。§61–62原code/test和全部生产文件保持；普通suite发现手动验收的路由问题继续单独待处理，不通过本项省略它。

根因对照来自原tests/nested-tool-dispatch.test.ts和tests/operation-host-dispatch.test.ts的静态源码，不执行这些旧测试。前者使用agent.prompt+FixtureStream进入完整正常Agent编排，后者验证单次host dispatch隔离。新test据此只替换接受性入口：保留原Agent、SessionFiles、原安装read/mutation定义、wrapper、Runner、原权限扩展与最终authorization；由固定本地FixtureStream提供一次parent toolUse和一次stop，每个phase调用一次agent.prompt，总2prompt/4响应。fixture model/provider为明确本地测试标识，streamFn不调用任何网络/provider API、认证回调、额度/重置；这只是模型意图的确定性输入，不是假原生权限/文件回执。原生产host-only集合不扩大，原正常编排热路径不改。

完整调用关系为原Agent.prompt→runPromptMessages/createContextSnapshot→runAgentLoop→streamAssistantResponse（固定fixture stream）→executeToolCalls/prepareToolCall/原before hook→原parent execute→原createNestedToolDispatch使用完整turn tools→read/file_batch实时查找、schema验证、原Runner准备/权限及最终消费→原installed execute与真实FileService。保留§62原精确Chrome源解析和唯一index转译，同一hash/旁表函数身份检查不变；其余既有包出口保持原环境，未全dist重建。

每个child的callTool返回后先保存有界toolCallId/toolName/isError/executionStatus/content/observationFailure独立值，再断言或继续，包含read及file_batch各两次。每个prompt完成后，从Agent原history选择该唯一parent toolResult，连同phase、实际stream响应数和errorMessage先保存独立值再断言结果数1及响应数2；没有parent也先记录空结果和原errorMessage。原准备异常与item/commit/creation历史事实保存不变，整个valueCopy计费累计仍≤8192UTF8B，parent嵌套复制也计费，不声称全堆精确分配。这样失败不会再仅留下外层0!==1而丢掉已返回的原拒绝正文；异常尚未产生结果时保留外层原Error。

其他业务/资源预算沿用有限组合：2独立parent/4nested、两次真实read、第一原snapshot随同identity外部修改后明确旧快照整批准备拒绝，第二原read/new snapshot经实际权限提交2项；两份纯模型capture各11B，不当guest来源。3最终fixture路径，初始/外部修改9B，2open/2close；模型buffers≤16384B清零；native worker最多1启动/≤128calls/≤1stats/≤1publicationAttempt，未知不terminate掩盖。原successful creation/commit key两个WeakRef四轮GC，原owner/runtime收尾、原身份逆序清理与failure retention保持。输出≤16KiB，四个child与两个parent的原结果摘要也在此预算内，无VM/VHD/helper/guest、旧矩阵或真实工程执行。

依赖冻结补入原Agent/agent-loop/nested-tool-dispatch、tool-definition-wrapper、ExtensionRunner、read及两个只读控制测试，共8路径；加原§62test及32依赖共41，Node/PS7/Koffi仍固定。拟唯一固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-captured-agent-orchestration.test.mjs，1组合。当前仅草稿，完整源码/依赖/预算独立放行后才首次运行；不提前宣称真实写回通过、默认切换或权限退役完成。

§63首次唯一运行及资源收尾通过，1pass/0fail。cursor168放行后，紧邻预检chunk79bef4 exit0核5scope、41依赖、3固定二进制、4旧index，index2028/outside2024 SHA256 F5327BA7D149830DADAC0ADC5ADCE5BAD3CD602DB406D7EA9413951215B3FD69保持。唯一exec-74f37f88-491b-4dc4-be41-a7519e9aacce/chunke06ad0 completed/exit0、duration1053ms、工具wall1.0537343s、审核原记录1.0536155s；组合123.6662ms、framework975.3174ms。cancelled/skipped/todo0，完整原输出7293UTF8B、三JSON含LF7047B，独立值事实计费4021B，均在预算内。未重跑§61/62或旧矩阵。

实际2prompt/4本地固定响应、2parent/4nested、2批准备、1实际原批准和2实际原receipt。第一原read取得snap_Ia8IOkpwMxGMwwr1FEc5Jg后，同identity fixture从alpha5B改beta4B；原captured-stale:nested:2第二项精确[SNAPSHOT_EDIT_STALE]拒绝整批，child executionStatus=not_executed，parent失败，无该批实际receipt，目标new仍ENOENT。第二独立原read为snap_zlTd43PxwP-sV6SuRfjEoA，新请求成功新增new.txt=5B与修改source.txt=6B，最终精确内容及原六条file-mutation-progress-v2关联断言通过。实际原权限对象/hash、原pending及最终native消费经过原链；不是模拟回执或放宽host-only入口。

实际root C:/Users/Administrator/AppData/Local/Temp/sp-captured-host-A5DlSt，dev3637606815、inode14636698789571532；source初末inode13229323906018267、新建new原inode3096224744434693。修改实际选择protected_in_place，原兼容原因是unprotected Windows DACL下替换可能改变继承语义；原source identity保持、commit=committed/fileSynced=true/directorySynced=false，publicationAttempts0。本次不覆盖staged_replace或目录持久性，不为新建receipt添加不存在的sync承诺。原sidecar从两个实际原receipt取冻结身份，copy/JSON/派生/Proxy无关联；两个原key四轮GC后liveTargets0。

fixture打开/closeAttempt/关闭各2，初始与外部修改写入共9B，无保留fixture handle。两份候选各11B仍是纯模型CapturedCandidateOwner，不是guest输出；模型承载buffer累计3360B分配=清零、capturesLive0。原native worker启动1次、调用7次；唯一stats给activeHandles0/activeDescriptors0/publicationAttempts0/fileBytesRead4/metadataBytesRead0/hashBytes744/hashUpdates36，平台win32/x64。该计数不包含Node隐式全部OS I/O或全堆分配。原owner释放后workerLoadedfalse/pending0/workerRetainedfalse，native owner/boundary/provider owners均关闭。Chrome精确解析1、转译1（源14948B/输出16137B），无managedBrowser/launchPromise。

三登记节点按各原创建/发布identity、规范父路径/type复核后逆序精确清理，各Node ENOENT，safe=true/succeeded=true/errors=[]。审核cursor172确认原命令与工具输出一致、仅1运行、7293B/7047B/4021B独立重算一致；chunk39726c exit0对原root/source/new逐一获得PathNotFound/ItemNotFoundException，当前不存在。chunk331f21 exit0核5+41+3冻结、原index/outside摘要及9D+patch不变。没有本项资源或恢复责任遗留。

结论仅为正常Agent编排下的真实宿主原权限/文件写回与本次兼容原地策略，以及两原receipt key释放。guestExecutions0、input/candidate尚非实际隔离任务来源；真实输入发布、固定工具/离线依赖、隔离cwd/执行/候选→此宿主链接线、P0桌面、最终切换/权限退役和手动验收路由仍待办。§61/62原失败与独立清理事实保持，不回填。本次仅四doc追加结果；五scope精确暂存须记录复核后执行。

## §64 手动验收与普通测试路由隔离（源码预审，尚未运行）

§63 暂存已独立闭合：原 exec-4065d168-10cd-4dba-9c87-3a21c8b42fa7/fe6330 exit0；cursor175、独立 b35ffd exit0 确认5scope工作区=index、索引2029项、范围外2024项及原F5327BA7D149830DADAC0ADC5ADCE5BAD3CD602DB406D7EA9413951215B3FD69摘要不变。原9D与补丁保持，未新增聊天。

本项仅 scripts/test.mjs、新 tests/windows-sandbox-manual-routing.test.mjs 与四doc，共6scope。修改前8bae49/78cb0d确认5既有文件等于index、新目标不存在；index2029、scope外2024 SHA256 0B0D7DB3A810AD684038ECC1FC15176EF0C6D66C350A0AADC923697BC7D83DCB。原16个单次验收文件全部保持原路径、原内容与失败历史。路由精确列举这16个相对路径为manual；discover仍返回全部，普通all/unit/hot/contract均不执行manual，且不新增批量manual执行开关。未知新Windows Sandbox文件及嵌套同basename不会被宽泛排除。普通候选write-batch离线模型继续自动回归，新增其--expose-gc启动参数；原5个GC入口不变。仅提取原argv构建为testFileArguments，执行/并发/日志/清理链不改。这是测试基础设施冷路径，无生产热路径或对象池改动。

拟唯一验证为固定PS7 -NoProfile环境下固定 D:/Nodes/26.13.0/node.exe --test tests/windows-sandbox-manual-routing.test.mjs，30s界限。新验证只import runner、读取16既有文件各≤65536B累计≤1MiB核原SHA、获取all/unit/hot/contract和直接manual共5份list:true清单、比较全量保留与三常规分类分区、核6个GC argv。无旧test import/执行、无子进程/VM/worker/原生I/O绑定/fixture创建/清理；测试框架自身与目录/文件只读不冒称零OS I/O。输出≤16KiB，JSON摘要≤1024B。不跑原矩阵、旧失败或全npm test。16路径精确集合见runner源码；尚待独立分类/源码/预算复核，不把源码预审写成结果。

真实输入发布/固定离线工具/隔离执行与真实候选接宿主写回、P0桌面及最终生产切换仍需继续完成。

### §64 唯一只读验证结果

分类/源码/预算经cursor182独立放行，独立124b66 exit0确认16个手动入口、原45个普通回归与六文件冻结；16文件合计406700B。执行前317688 exit0核6scope+16保留文件+固定Node/PS7两binary、5旧index blob及范围外摘要。随后唯一原命令 exec-15bbabee-1306-4fbf-b43f-d23a79ec8c4a/chunk6d65b7 完成exit0、duration129ms、工具wall0.1294362s；1pass/0fail，cancelled/skipped/todo0，test13.5319ms、框架58.6498ms，完整输出347UTF8B。

实际只读原文件406700B，5次list:true；发现395个文件，16手动入口内容SHA不变，普通清单379项，其中Sandbox46项（原45加新路由测试），manualSelected0；6个GC argv符合预期。数字379/46是清单数量，不是这些项目已运行或通过。本次只执行新路由测试；没有import或执行旧验收、旧失败或容量/链接矩阵。新测试体没有spawn、fixture创建、VM、受测native worker或清理操作；Node测试框架自身进程、目录扫描和文件读取不纳入“没有业务子进程/原生读取”的陈述，也没有宣称零OS I/O或零分配。保留失败历史并隔离自动重放，同时维持普通回归发现。

审核cursor185确认唯一原命令与完整347B输出一致，独立重算JSON135B/含LF136B；07f222 exit0核运行后六文件冻结、原16文件SHA、index2029/outside2024及0B0D7DB3A810AD684038ECC1FC15176EF0C6D66C350A0AADC923697BC7D83DCB摘要不变，四doc原前缀保持、增量空白通过，原9D与补丁保持。审核确认本项无测试自建资源遗留，允许四doc追加该结果。仅此结果现已追加；源码两文件保持运行冻结版本。下一步按6scope精确暂存复核，随后继续真实输入/固定工具/隔离执行接线。

## §65 原输入 → 固定离线工具 → 实际隔离执行 → 原宿主写回（源码预审，尚未运行）

§64精确暂存已闭合：原exec-01d93681-f9f2-4e33-b957-ff567c669e21/24f8fc exit0，cursor188独立592b1c确认6scope工作区=index，索引2030、范围外2024及0B0D7DB3A810AD684038ECC1FC15176EF0C6D66C350A0AADC923697BC7D83DCB摘要不变。继续在原工作/审核聊天推进，不按阶段新建聊天；此前P0桌面回放仍属用户明确延期事项。

本项14scope：既有windows-sandbox-workspace-input-capture.mjs、windows-sandbox-volume.mjs、windows-sandbox-volume-helper.ps1、windows-sandbox-volume-session.mjs；新增windows-sandbox-input-install.cs、windows-sandbox-offline-worker.cs、windows-sandbox-input-publication.mjs、windows-sandbox-input-execution-session.mjs、windows-sandbox-input-host-fixture.mjs、windows-sandbox-input-execution-acceptance.mjs（均在scripts/acceptance），加本四doc。修改前0ccffb确认8既有文件等于index、6新路径不存在；index2030，scope外2022 SHA256 1DEDB7B070E866051B4E7115578FC3D17D641A0A3C4DFB4A8AC32FD03482D3FD。原9D与super-pi-clipboard-fix.patch保持。旧§55/61/62失败、§56–64入口/结果不改不重放。

唯一新场景由正常Agent的1prompt/2固定本地响应，经原wrapper/ExtensionRunner/resource-lifecycle-guard与SessionFiles：原nested read获得source.txt=alpha的原snapshot；原WindowsWorkspaceInputCapture读取5B并关闭原生句柄，单次发布元数据/复制后保留原授权。CapturedInputPublication在安装、实际映射派发、实际exec三个边界依次续期同一原授权（总renew6），每次实际派发同步复核原对象绑定。元数据/安装receipt只是数据；不接受JSON/布尔替代原权限，不重开源文件刷新baseline。

输入安装走原TaskVolumeOwner/VolumeProtocol/PS7管理器，不旁路原VHD/VM责任。新增NativeDisk partial一次读取宿主私有input-source.bin≤4096B和固定offline-worker.exe≤65536B，核原carrier身份、摘要、原卷/exchange，独占创建workspace/tools与两文件。七原生槽接管valid HANDLE早于inspect，正常opened=closed=7/peak4；close一次、失败单独留原异常/句柄，不重试。两内容buffer分配=清零；托管receipt writer独立责任不混入七原生槽。JS publication自己的carrier写/receipt读共2fd，每次关闭恰一次，复制与receipt缓冲清零。关闭状态不明保留原负责人，阻止后续派发和卷释放。

固定工具只使用系统.NET离线框架，不安装/下载依赖；唯一guest cwd C:/SuperPiVolume/workspace，exe固定tools/offline-worker.exe及两个UUID参数。只读本次alpha输入，产出修改source.txt=alpha-guest CRLF（13B）、新增new.txt=derived:alpha CRLF（15B）和两项guest manifest。原VM先停止并确认CLI/实例消失，再经原candidate owner/channel获取实际候选；guest报告不授权宿主写入。原卷确认释放、source/publication释放后，原applyCapturedWrites将这两个实际候选转换为一次nested file_batch，沿原权限批准/原执行边界写回fixture source/new。原commit/creation receipt sidecar确认目标身份；fixture三登记节点仅按原身份与规范父路径逆序清理，不递归扫描。宿主frame在任何fixture/native创建前由task保留，证据序列化/输出失败仍有原负责人。

预算：固定Node26.13.0/PS7/CSC/WSB CLI/Koffi/TypeScript摘要；源码manifest75项、当前只读计量1285967B、最大83610B，运行每文件≤262144B/累计≤2097152B并在物理派发前核同bundle。一个固定128MiB VHD，一个VM，一次guest exec；3 helper（只读preflight、native DLL编译、离线exe编译），1manager；原lifecycle CLI≤95/全部进程记录≤99/未决≤4，manager协议命令≤16。helper各15s，原VM普通call15s/start120s/exec30s/settle120s/exit30s；未决责任保留，不因外部超时杀猜测进程。native DLL≤131072B；输入5B、实际候选28B，candidate原协议/载体预算沿用。正常私有产物精确11项，journal≤16384B、最终证据≤15360B/footer≤512B、宿主详细证据≤12288B；源码哈希/固定binary哈希属于只读验证I/O，不称零OS I/O。宿主native worker启动1次/调用≤128，唯一stats须activeHandles0/activeDescriptors0，原owner/boundary/provider关闭；源capture/publication/candidate及两原receipt key共5目标，4轮受控GC须live0。

唯一拟执行命令：固定PS7 -NoProfile下 D:/Nodes/26.13.0/node.exe --expose-gc scripts/acceptance/windows-sandbox-input-execution-acceptance.mjs --run-input-once --source-bundle <独立复核后的75项bundle SHA256>。只在独立源码/预算放行后执行一次；失败保留原入口/输出/资源责任，不改后重跑。此入口不在普通tests发现中，不重跑旧矩阵、容量/链接场景或全npm test。本项是显式冷验收，生产Agent事件/渲染/终端/结果热链未改，不引入对象池。即使通过，也仅覆盖上述5B fixture及固定.NET工具；不代表通用离线工具集、正式默认切换或旧权限退役已经完成。

### §65 执行前失败路径修正（仍未运行）

独立预审cursor195指出两项阻断，工作端同时确认capture原错误丢失：CloseInput现将原生close返回false和直接抛异常都永久标记CloseUnknown，保留原异常/原槽且不重试；宿主fixture有任何登记节点尚未确认删除时，保留含原节点/身份及资源的同一responsibility，不能只因进程/句柄已关闭而丢失责任；capture拒绝时重新抛出原错误，释放已知关闭的owner前记录operation/cleanup及下层input/reader独立错误事实（包括undefined/null/0），publication自身operation/close事实分开。正常通过条件另明确原source native scratch分配=释放、retainedScratch0及bindings释放。没有新增失败实测或旧矩阵重跑。

三源码修正后，静态只读c1f8d3确认75项累计1288165B、最大83610B，bundle为40cffb14ac9e5b25f0ba9da773a659e6cb50d3a942518e8ad9aa1bd80ef5a682；其余运行/资源/输出预算不变。原14文件af11be冻结已撤回执行准入，以此次重冻/独立差异复审为准。尚无编译、fixture、VM或原生安装执行，也未暂存。

### §65 唯一实际运行失败及精确恢复

修正后的14scope及75源码bundle 40cffb14ac9e5b25f0ba9da773a659e6cb50d3a942518e8ad9aa1bd80ef5a682经cursor200、独立67bc4e exit0复审放行；执行前4b2707 exit0核101个去重SHA（含16旧入口/6固定程序）、原8个index blob及范围外摘要。原命令exec-6e0d8555-5b60-455f-a91f-1741c205a333（工作turn01a19c65-3da4-7011-8c05-a2d3e9c50e53）只执行一次，入口及全部运行冻结源码保持；没有改后重跑。task e1a79451-4744-4ff9-a47a-1130e7e4efb2，snapshot fcee9c88-efd3-4940-a0ad-f7e17ffd624d，VM 55159622-033f-4d00-be7e-0a7e68241293，host Node6000。原输出完整11345UTF8B、truncated=false，四JSON含LF分别414/2541/8182/208B，与原分段tool输出逐字一致。

实际完成原read snapshot=snap_wMaptUpQwFfMRPxX72TjwQ、原source capture5B（source native12开12关/closeAttempts12、active0，1content open/1read/5B，scratch2264B释放）；原capture总renew6/publicationRenew3，元数据发布及副本各1，原5B和复制5B均清理。安装原native7开7关/peak4、5+6144=6149B分配=清零；原carrier及卷内workspace/tools/source/tool身份回执齐全。JS publication2fd/2closeAttempts/2closed、883B分配=清零，disposed=true/retainedCapture=false/retainedFd=false。preflight和两次编译均exit0；原DLL69120B SHA5c7438d963138266baf815d1610eeb4af95dbf12db9b7526c15a8e57ddd5b65b，离线exe6144B SHAb6a3b7f3e78c570c0f5c75f566c6eea53fee5e07e8b68e97b66c9b18c94501d6。

一次真实guest exec返回平台接口ExitCode0；264B规范清单和28B payload经原候选链捕获：new.txt add15B SHA81a8095dfa53d1399e09bbe4c2969fa88282d495ccabd410fa5769027a8a61da，source.txt modify13B SHA1ac211b6d92be3d8a939ede7e10fd75ffd56cd740ce5ca7757fd21899152efc7。native manifest3开3关/peak2、batch8开8关/peak4；私有通道5开5关/peak1、64API、1474B转移（本地cleared0，不混作本地清零）；候选最终payload/request/context释放断言通过。原7CLI与3helper+1manager共11子进程对象均物理关闭、pending[]；VMclosed、最后原list为空，manager15456exit0/transport buffer释放，原卷released/detached/managementClosed、closeUnknown=false。此为实际输入/安装/guest/候选和业务资源关闭的限定观察，不认证guest来源或授权报告。

失败发生在host apply前的新增验收断言“Original source/permission settlement”。静态核查455bf1/18f0d4确认：reader.permission实际为SessionInputWorkspacePermission.diagnostics，内部计数位于permission.grant.grants；本项误写permission.grants===0，读到undefined必然失败，publicationSummary也因此省略该字段。工作端和独立源码预审均漏检了此层级，不能将其改写为权限泄漏或平台失败。宿主仅1prompt/2本地固定响应、1parent/1nested read，file_batch尝试/批准/原receipt/native worker启动及调用均0；没有宿主写回。fixture打开/closeAttempt/关闭各1、写入5B；owner/boundary/provider已关闭，无managedBrowser/launchPromise。恢复前五目标GC没有执行，外层task及fixture责任对象仍被保留，不能称所有引用清空。

恢复前失败状态保持passed=false、sequencePassed=false、retained=true。原私有root D:/RMProjects/Pi/.artifacts/windows-sandbox-acceptance-owner（dev3938676073/ino1970324838180597）保留11叶89772B；host root C:/Users/Administrator/AppData/Local/Temp/sp-input-execution-qP9GEP（dev3637606815/ino22517998137468260）保留source.txt5B（ino20829148277204325、原alpha摘要），new.txt明确未创建。只读4de996核全体原身份/大小/SHA/普通单链接/规范路径，无VHD或额外叶；持有外层timer的原Node6000未自然退出。

恢复按cursor204独立审准的A→B→C各一次执行。A原exec-6a7cb2cd-63c1-4b65-abd5-46b7600e48b0/b52a5f exit0，持有同一Process句柄，核Node6000程序/完整cmd/parent16776/UTC创建2026-11-02T13:43:08.2370682Z、无直接子进程，并重新核两root/12叶及原业务关闭报告后，仅Kill(false)原Node；确认其实际ExitCode=-1。B原tool session62179/a7bc2e结束，工具退出码1、无新增输出；原exec最终failed/exit1/duration841477ms包含等待独立恢复时间，不是执行性能或自然退出。C原exec-a0b3728c-c124-4aaa-8dd9-eb878f9cdc94/51e3bf exit0，逐叶重核原身份/SHA/规范父路径后unlink，两个原根确认空且原身份匹配才非递归rmdir，14目标逐一ENOENT，passed=true/error=null；没有杀父PS/manager/VM、递归清理或新WSB/磁盘试验。A内容读取101189B、C190966B，合计292155B（不含元数据查询）。

恢复成功与原验收失败分开记录；本次实际入口仍失败，宿主写回和五目标GC没有通过结论。原源码冻结继续保留；后续修正诊断层级须独立新入口、源码/预算预审及新验证，不重复原§65入口、旧容量/链接/故障矩阵。P0桌面仍按用户延期，生产真实工程/默认切换/旧权限退役未完成。

独立恢复复核cursor207闭合：8e1bb3 exit0对两个原根均确认PathNotFound/ItemNotFoundException；446031 exit0核101个SHA、14文件冻结/八原index blob、index2030/outside2022及1DEDB7B070E866051B4E7115578FC3D17D641A0A3C4DFB4A8AC32FD03482D3FD摘要不变，原9D和patch保持。原调用时间确认A→B→C，没有提前删除。两处资源现已无本项遗留；这是外部精确恢复闭合，不把原自动收尾或GC改记通过。四doc现仅追加记录，14scope待精确暂存复核。


## §66 原权限诊断分层纠错与实际写回接线（源码预审，尚未运行）

§65的14项精确暂存已闭合：原exec-92f6305e-734f-4fd5-a1da-c85b036df671/e564b3 exit0，cursor210独立b40b1d exit0确认14项工作区=index、101哈希与增量空白检查、index2036/outside2022及1DEDB7B070E866051B4E7115578FC3D17D641A0A3C4DFB4A8AC32FD03482D3FD不变。§65仍为原验收失败、定向恢复闭合；不将宿主写回或GC追记通过。继续使用原工作/审核聊天。

本项仅新增scripts/acceptance/windows-sandbox-input-writeback-session.mjs、windows-sandbox-input-writeback-acceptance.mjs与四doc，共6scope。修改前2a2463 exit0核新2路径不存在、原14项冻结及index；index2036，范围外2032项，SHA256 9CA15475BE0501561BFD38E35C88ED4C986C3D4895BD86371D872835F38B9E70。原§65十份源码及75文件bundle 40cffb14ac9e5b25f0ba9da773a659e6cb50d3a942518e8ad9aa1bd80ef5a682保持，原9D及补丁不动。旧入口不重跑。

纠错依据是实际类的getter与release链：SessionInputWorkspacePermission保留grant诊断，grants属于内部InputWorkspaceGrantLease，不能读取外层permission.grants。新session在原publication.prepare后、attachManager前，检查两层实际诊断的整数/布尔/状态字段及原授权就绪状态，并记录preparedPermission；诊断不授权任何操作，物理安装/派发/exec仍由原对象续期与同步identity检查决定。提前保存使用入口已创建的原journal回调，不调用尚未attach的task.save。最终source reader、外层会话权限、内层grant和原生scratch分开断言：外层disposed/renewals6/grantDisposals1、弱引用与metadata/path计数0及prepare/verifier/grant/binding引用消失；内层disposed/grants0、路径与字符串/弱引用0、observer/verifier/issuance释放、policyDisposals1且policy不再持有。摘要明确嵌套grant，各缺字段显式null，结构检查拒绝缺失字段。

新session复用§65原task/helper/guest执行/candidate释放函数；原错误producer与错误诊断函数保持但新链不调用。新entry复用旧源码清单常量，旧entry主调用有自身import.meta.url路径保护，导入不会重放旧验收。77文件源束为原75加新2，协议super-pi-input-writeback-sources-v1，静态累计1316307B、最大83610B；SHA256 4c40dee19cbdcd262fe561bf20fe9192b4962a58f05cbadb8f4038455e0331af。每源≤262144B/累计≤2097152B，真实派发前继续复核同束和固定binary。

唯一拟运行固定Node26.13.0 --expose-gc scripts/acceptance/windows-sandbox-input-writeback-acceptance.mjs --run-input-writeback-once --source-bundle 4c40dee19cbdcd262fe561bf20fe9192b4962a58f05cbadb8f4038455e0331af，仅独立源码/预算放行后执行一次。正常Agent原read/权限/source capture5B→原卷一次安装固定.NET离线exe→一个VM一次guest exec→原候选28B→原host file_batch一次实际2写→原receipt身份清理。仍为3 helper（只读preflight与两编译）/1manager/1个128MiB VHD/1VM/CLI≤95/总记录≤99/未决≤4/manager命令≤16，原时间界限不变；不下载或安装依赖。预期native输入7开7关、publication2开2关；宿主native worker1启动/调用≤128，stats无活动handle/descriptor。正常private11文件、host3登记节点按原identity非递归清理，5个原对象目标4轮GC须live0；所有保留责任/关闭未知路径沿原实现保留，不把外部恢复冒充自动成功。

journal≤16384B、最终证据≤15360B/footer≤512B、host明细≤12288B、组合stdout≤32768B；新增诊断摘要约1.5KiB，最终实际字节数需原输出复核，不以估算替代证据。此为显式冷验收，无生产热路径改动，无旧测试/容量/链接矩阵重放，无额外失败模型或普通npm test。源码检查及哈希读取不声称零I/O。即使通过也仅覆盖本次固定5B输入与.NET工具链，通用工程输入/正式执行入口/默认切换/旧权限退役仍待办；P0桌面仍按用户明确延期。


### §66 唯一实际写回验证结果

源码/预算经cursor222独立放行，4ae9b5与9e9f67 exit0核六文件冻结、103去重哈希、四doc各4029B追加及旧75源束不变；日志预算估算不是实测。执行前1d71a2 exit0再次核103哈希、四旧doc blob、index2036/outside2032及9CA15475BE0501561BFD38E35C88ED4C986C3D4895BD86371D872835F38B9E70摘要。原exec-9432ce96-bc8c-4e16-9a57-b44c2466c087仅运行一次冻结新入口，固定PS7 -NoProfile/Node26.13.0，源束4c40dee19cbdcd262fe561bf20fe9192b4962a58f05cbadb8f4038455e0331af；自然完成exit0/duration19323ms。此为本次耗时，不作优化证明。原chunk2c4002与2f847e完整串接15478UTF8B，5JSON含LF为414/4915/9883/173/93B，均在预算内。

task fc253a45-a95d-416b-9e36-3230dff3ceeb，snapshot faa47e5a-8842-4d01-8b14-8ae9ee051988，VM 8d7d06cc-102e-40ba-a8f9-7568032efe4a，host Node17184。原nested read snapshot=snap_Mfd5HeFQmXFxDLuzQmcsrQ；原source5B、native12开12关/closeAttempts12/active0、一次content open/read5B、scratch2264B释放。capture renew6/pubRenew3，原5B与复制5B释放。准备时外层ready/renewals3/weak6/path2，内层ready/observations4/grants1/weak4；最终外层disposed/renewals6/grantDisposals1/weak与metadata/path0、retained标志全false；内层disposed/observations7/grants及path/pathChars/grantChars/weak0、originalIssuance/observer/verifierfalse、policyDisposals1。分层诊断和原生scratch断言均通过。

输入安装native7开7关/peak4、6149B分配=清零、无保留handle/错误；publication2开2关/closeAttempts2、883B分配=清零。本次DLL69120B SHA8d7681b8902f26a244830815d3358b14fb61853939608ccf45412532abc6decb，离线exe6144B SHAf16e1c102ce9eabef80a4e6280d1b8b357e14597b989751e1e198f0de59bb49d，编译均exit0。一个guest exec返回平台接口ExitCode0；264B清单/28B真实候选：新增new.txt15B SHA81a8095dfa53d1399e09bbe4c2969fa88282d495ccabd410fa5769027a8a61da，修改source.txt13B SHA1ac211b6d92be3d8a939ede7e10fd75ffd56cd740ce5ca7757fd21899152efc7。native manifest3开3关/peak2、batch8开8关/peak4；私有通道5开5关/peak1、64API、1474B转移（本地cleared0），原candidate最终payload/request/context释放。

原VM确认关闭后捕获候选，卷释放/source授权释放后才原host apply。正常Agent1prompt/2本地固定响应/1parent/2nested，file_batch1次、approval1次、原receipt2份，2succeeded/0failed/0notStarted。new.txt实际创建15B；source.txt采用protected_in_place，保留原identity、outcome committed/fileSyncedtrue，directorySyncedfalse，目录持久化未确认。原宿主native worker启动1次、调用7次，唯一stats activeHandles0/activeDescriptors0、fileBytesRead5/hashBytes745/hashUpdates36；这不是全部隐式OS I/O/全堆分配计数。owner/boundary/provider均关闭、workerLoadedfalse/pending0，无browser实例/launchPromise。

host fixture root C:/Users/Administrator/AppData/Local/Temp/sp-input-execution-nvKv4d（dev3637606815/ino18295873486808856），原source inode21110623253915418、新file inode2251799814303001；三登记节点各按原identity/规范父路径清理并ENOENT，safe/succeededtrue/errors[]。fixture原开/closeAttempt/关各1、初始化写5B。宿主明细4915B，原receipt事实2557B，原bootstrap scratch2264B释放。

7CLI+3helper+1manager共11物理子进程关闭、pending[]；VMclosed/最后list空，manager26208exit0/transport buffersReleasedtrue。卷released/detached/managementClosed、closeUnknownfalse；不对历史PhysicalDrive编号另作操作。固定private root dev3938676073/ino2814749768312506，11文件精确清理；清理前清单中lifecycle.json观察值12817B，并非所有journal写入峰值。主报告9883B是清理前证据，仍含passedfalse/removedFiles0等当时字段；随后独立cleanup footer passedtrue/artifactsRemovedtrue/removedFiles11/retainedfalse，最后4轮GC targets5/live0/passedtrue，原执行自然退出0。清理和引用释放各有后续事实，不能仅凭主报告sequencePassedtrue推断。

e77a5c exit0复算上述UTF8长度，并对两个原根确认ItemNotFound；868536 exit0核运行后103哈希、四旧blob及index/outside均未变。read_thread大turn查询上限导致高输出请求被拒、低额度查询截断，不是本次实际stdout截断；原工具两chunk完整输出和原exec元数据分别保留。独立复核cursor225确认原exec完整输出与两段工具输出逐字一致，按原写入格式重建journal12817B匹配。独立953ea9/a8ed79/7c1ccf均exit0核103哈希、六文件冻结/四旧doc blob、index2036/outside2032及原摘要不变；两登记根均PathNotFound/ItemNotFoundException，原9D及patch保持。本项自动清理及五目标GC限定通过，允许四doc补本结果；源码不改。

结论限定为固定5B原输入/固定.NET工具/一个实际WSB任务的真实候选，经原正常Agent授权/版本/文件链完成两处宿主写回并自动清理与GC通过。没有推广为通用工程/任意命令、正式默认profile或旧权限退役完成。§65原失败和外部恢复保持，旧入口未重放。P0桌面继续按用户延期；生产入口接线与剩余权限迁移继续推进。


## §67 有界任务意图与原父调用绑定（源码预审，2026-11-03，尚未运行）

§66六项精确暂存已独立闭合：原exec-85bc816e-82e3-4a4b-a75f-b7a5955f4437/3ae596 exit0，49c0a1增量空白通过；cursor233、独立cee730 exit0核六项工作区/index、103哈希、四旧→新及两新增空白、index2038/outside2032与9CA15475BE0501561BFD38E35C88ED4C986C3D4895BD86371D872835F38B9E70摘要。§66仅固定真实两写/自动清理/五目标GC通过；§65原失败不改写。不按阶段新建聊天。

本项7scope：新增packages/coding-agent/src/core/sandbox/task-request.ts、task-binding.ts，tests/windows-sandbox-task-binding.test.mjs，加四doc。修改前575d2a exit0核三新路径不存在、§66六项冻结与index；index2038、范围外2034项，SHA256 21B015040260BD606CA3D05CD6F64D84A652DB419EA5B483A591AF0DB951C36F。§65/66原75/77源束与源码、16旧单次入口及原9D/patch保持；不修改旧entry/volume/helper/worker，不执行或重放它们。

本项解决生产接线的前置语义，不开放生产执行。普通BashOperations.exec缺少选择性输入/输出声明和原父调度上下文；自定义后端的显式cwd仍被原shell包装层拒绝。现有shell不能仅替换operations后直接nested file_batch，PowerShell也不改成嵌套orchestration。入口方向选现有CodeMode原父调用中的宿主协调器：在其原ToolDefinition.execute第六参数存活期间借用原execution，以同一父调度器先后走真正的命令子调用与file_batch兄弟调用。此协调器和工具参数传输仍须后续实际接线/审核；本项未注册新工具、未改变CodeMode API或Agent调度，不能声称生产入口已覆盖。原输入permission、实际命令授权、候选捕获、文件授权/版本检查和VM责任各沿原owner，不另建permission表或任务表。

request只复制并校验意图：固定version1/windows-powershell-foreground-v1、原文command、相对cwd、timeoutMs、inputs(path/snapshot)和writes(path/add|modify/snapshot)。拒绝未知host授权字段/访问器/稀疏或额外属性数组、非法编码/路径及冲突；修改项必须精确引用已选择输入的原snapshot，新增项snapshot=null且不与输入冲突。联合路径≤16、单源/候选≤4096B、源/候选总计各≤16384B、路径ASCII/120字符/4层等沿现有首版限制。命令UTF8≤8192B、元数据≤32768B、执行≤30000ms；stdout/stderr各32768B为后续执行profile预算，本项没有输出读取或进度链。冻结副本和WeakSet品牌只表示验证过的意图，不授予权限；序列化后须重新校验，不能携带原上下文。

明确的首版guest命令环境为C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe，命令传输UTF16LE→Base64，cwd映射C:/SuperPiVolume/workspace下的相对目录；只固定SystemRoot/WINDIR=C:/Windows与TEMP/TMP=C:/SuperPiVolume/temp，不转发宿主环境变量。本项只是声明，后续安装器须建立这些目录并以固定argv/无shell拼接执行，再取得新卷内实际证据。宿主仍只用固定PS7；宿主程序哈希、旧probe成功不能替代新环境验证。暂不开放Node、PowerShell7整套guest工具链、后台任务、任意依赖、删除/移动或超预算工程。

binding必须由可信宿主调用点传入原SessionFiles/ctx/父execution/execute signal及原parentToolCallId；构造函数、ID和callback形状都不证明来源。普通嵌套shell没有这样的父dispatcher，仍不支持。通过SessionFiles原prototype pinReadRevisions取得专属原source，核原receipt对象、精确canonicalPath和大小预算，不制造/刷新read证据；原source的current是实例arrow，捕获该原函数，不能误取prototype.current。弱借用当前powershell/file_batch工具及execute、父callTool/findTool、ctx/owner/signal和≤16receipt key，检查原会话/边界/信号与当前工具替换。可序列化请求不包含这些对象。

单次run同步接管借用再await可信协调器，禁止重入/重用。assertInputsCurrent在输入捕获/派发前检查原receipt身份；assertSessionCurrent负责会话/父调用状态，成功写回可消费旧revision，完成时不错误地再次要求原receipt仍在表内。权限和安全打开仍由原capture负责，真正nested调度仍是最终授权与父关闭拒绝点；本类不认证任意宿主回调、不对恶意同进程代码隔离、不把工具表检查当OS准入。dispose在pending时立即使检查失效但保留该借用/source责任直到原work settled；不冒充已停止VM或任意回调活动。完成/失败后source disposal恰一次，强request/原source/实例check闭包、receipt/tool弱表、其余弱引用及cwd/parent元数据释放；外部自行保留的借用副本仍由调用方负责。

新增测试仅针对本次契约：12个请求拒绝形状，原parent不匹配/意图JSON冒用/未知snapshot拒绝，9个绑定生命周期场景（正常、原falsy异常、方法/工具替换、父关闭、会话改变、pending取消/释放、模拟receipt消费与陈旧拒绝）；这些不是旧VM/容量/链接矩阵。使用真实SessionFiles/SessionFileRevisionSource/SessionExecutionBoundary/NestedToolDispatch类，但runtime/registry/read实现受控，child调用始终0；不宣称原permission-controller、真实宿主写回或guest执行已验证。一个身份登记Temp根与notes.txt10B，fixture1fd一次关闭、一次安装read、无native worker启动/请求、无业务子进程；原issuer内部OS I/O未全计数。两个节点按原identity/规范路径非递归清理，未知关闭/身份保留原fixture责任；原业务错误和清理错误分开保留。四轮GC检查request/binding/owner/ctx/dispatcher五目标live0。测试在普通无--expose-gc运行下明确gc=null，只断言确定性释放；本次唯一获审运行必须带--expose-gc，结果须确认五目标回收，不以gc=null记GC通过。

静态58b3d2核80项（原77加新3）累计1349664B/最大83610B、证据源束0e39b7fb287764986b002ef6d87f5dfb0160580b22dde23af1457564775ae888，作为外部冻结清单，不冒充测试内或VM派发前自动核束。拟唯一命令固定PS7 -NoProfile下D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-task-binding.test.mjs。执行前复核7scope+80源+16旧入口+6固定程序共106去重SHA及四旧blob/index；仅独立源码/预算批准后运行一次。30s预期上界，stdout≤16384B、JSON摘要≤2048B；无构建、下载、VM、编译器或旧tests重放。失败保留原入口与证据，不改后重跑。

已复读完整热路径合同。新增模块只处于调用准备/借用生命周期冷路径，尚无生产消费者；未改输出、进度、事件、渲染、终端或Ledger链，没有对象池，不扩跑既有分配基准。后续实际shell/CodeMode接入必须重新审完整生产调用链并补对应热路径检查。当前先送源码/预算预审，尚无测试通过、资源创建或暂存结论。P0桌面继续延期，通用工程/生产后端/默认切换/旧权限退役仍未完成。


### §67 执行前更正：零输入与测试收尾（2026-11-03，仍未执行）

初稿fe79d2与源束0e39b7fb287764986b002ef6d87f5dfb0160580b22dde23af1457564775ae888已在任何测试前主动撤回执行冻结。自查发现inputs=[]仍pinReadRevisions会依赖既有FileService，可能给首次无输入命令带回“先read”门槛；独立cursor234另指出pending断言失败可跳过gate结算、runCases串行finally可跳过后续清理并覆盖原错误。本段更正上文相应语义与数字，原预审历史保留，不是失败入口重跑。

binding新增第七参数为可信调用点的原ExtensionRuntime，弱借原runtime/assertActive/executionBoundary及独立ctx.signal，记录原generation与session ID；核runtime.nativeFiles同一原owner、owner未closed、原runtime有效、boundary当前、ctx/cwd/session与原execute/ctx双信号。仅非空输入pin原专属source/原receipt；零输入不pin、不创建FileService、不制造revision。run借用原runtime供后续协调器使用。完成后新增弱引用及session/generation元数据同时清除；非空sourceDisposals=1、零输入=0。无host回调来源认证或新授权能力，最终nested工具授权与父关闭拒绝仍在原dispatcher。源码当前无生产消费者。

测试在第一次read前验证零输入成功且owner计数保持pending/inFlight/revisions=0，结束前再验证原boundary转换使零输入旧binding失效。生命周期9→11，成功构造11、实际work回调5、拒绝24、请求形状拒绝12；原一次10B安装read、fixture1fd、两个节点清理与5目标GC不变。pending结果在断言前立即挂原promise观察者，独立finally一定释放该gate并等待同一结果，分别保留断言与结算错误；不重新发起工作。runCases保存原失败标志和值，清理每个已登记对象分别收集错误，继续其余收尾后聚合；原throw0/undefined不会被真值判断丢掉。外层原fixture身份检查与未知责任保留规则不变；没有重试未知关闭。检查仍只代表受控契约，不证明真实权限或guest执行。

修订静态4f8f32核原77源不变；80项累计1355795B、最大83610B，修订源束1cde2aea2e9ad843e52d0c33563778e0fcd9bd8b8bbacc678b1c5b0dd45d0c04。request7867B、binding14507B、test17114B。7scope、index2038/outside2034与21B015040260BD606CA3D05CD6F64D84A652DB419EA5B483A591AF0DB951C36F预算不变；仍只拟同一新增测试一次，固定Node带--expose-gc、30s预期、总输出≤16384B/JSON≤2048B，无编译器/VM/业务子进程或旧矩阵。本轮无测试、资源创建、构建或暂存；重新冻结送独立源码/预算预审。


### §67 唯一验证结果（2026-11-03）

修订ff7381通过独立cursor244源码/预算预审后，仅运行新增tests/windows-sandbox-task-binding.test.mjs一次。冻结入口、原77源和16旧入口未改后重跑。执行前5c869a exit0核106去重SHA、四旧docblob、index2038/outside2034及原摘要；外部源束为1cde2aea2e9ad843e52d0c33563778e0fcd9bd8b8bbacc678b1c5b0dd45d0c04。

原执行exec-3509de84-1300-4022-96b1-17724d097b85（工作turn01a19cd2-1606-7e80-b07a-d354b048e236）actual completed/exit0/app duration13024ms（独立原记录13024.214ms）；固定D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-task-binding.test.mjs，固定PS7 -NoProfile，cwd D:/RMProjects/Pi。初始8ea87a无输出/session12098，最终原2e3bee exit0。完整输出1127UTF8B，三JSON含LF为89/260/596B，摘要595B不含LF；测试1pass/0fail/0cancelled/0skipped，case26.0407ms、整体12958.5196ms。满足30s预期/16KiB输出/2KiB摘要预算；30s不是硬超时，时间不是优化证据，stderr未另行独立计量。

实际11个成功构造binding/11生命周期场景、5次work回调、24次预期拒绝（其中12个请求形状）；首次read前零输入成功且owner无revision，边界转换后零输入原binding拒绝。一次安装read10B，真实SessionFiles/source/boundary/dispatcher类但runtime/工具/read实现受控；childInvocations0，native workerStarts/calls差值0且pending0。原输入source释放state disposed/checks21/weakReferences0/retainedVerifier false/retainedMetadata0；各binding强request/source/check、receipt/tool/owner/runtime/boundary/context/signal弱引用和元数据按断言清零。pending场景原gate与promise已结算；原throw0保留，模拟forget只消费receipt，不是宿主文件写回。

原fixture根C:/Users/Administrator/AppData/Local/Temp/sp-task-binding-ju3CaZ，dev3637606815/ino4785074604152907；notes.txt dev3637606815/ino18014398509554156。fixture显式open/close1/1，两个节点按原身份/规范路径非递归清理后ENOENT；外部b15016 exit0两者PathNotFound。GC4轮、request/binding/owner/ctx/dispatcher5目标live0；不外推外部保留副本或全部OS隐式I/O。没有VM、业务子进程、编译、真实权限决策或guest执行；permissionOrGuestExecutionVerified/implicitOsIoInstrumented均false。后查027b4f exit0，106哈希/四旧docblob/index/outside不变。

外部输出字节统计曾因functions isolate无TextEncoder而报ReferenceError，仅该统计步骤失败；改用Unicode码点UTF8计数，未改变或重放目标。独立cursor247已对原exec与原poll逐字复算通过；5ae6c5只读确认两节点PathNotFound，5f46f9/f7190c核七文件、106SHA、四旧前缀、80源束及index/outside。原前后检查中的bundle字段是固定文本，源束复算结论来自独立核验，不冒充脚本内自动复算。该统计步骤错误不属于目标失败或重跑。

§67只闭合有界意图/原会话绑定，不宣称通用安装、命令执行或生产入口已接通。下一项按cursor244范围建立新有界任务publication/安装协议：有输入借原capture，零输入不造read；共享owner/helper/runtime可正式泛化，形成新源束并保存旧到新关系及§65历史内容/失败证据；新runner仅首版guest Windows PowerShell，独立核命令/cwd/环境/输出/超时及进程树结算。不能把任意包冒充原CapturedInputPublication，也不把旧offline-worker的65536B当新程序的已批准预算。该链验收后再接CodeMode原父协调器；默认切换、旧权限退役、通用工具链和P0桌面仍未完成/延期。此处尚未暂存。

### §68 通用任务执行链：源码与单次验收预算（2026-11-03，尚未执行）

§67已由独立cursor253完成暂存核验，7scope/index2041/outside2034保持其历史结论。本项不再按阶段创建或归档聊天；P0桌面继续延期。当前生产后端仍未接入，以下实现与验收不能冒充日常CodeMode、默认切换或旧权限退役已完成。

本项18scope：新增task-package.ts及task-publication/install/worker/result/session/acceptance六脚本，改原volume/helper/session/candidate-manifest与input-host-fixture五共享文件，新增历史ZIP/JSON两项，追加本四记录。基线2bc7fb为index2041/outside18scope2032、摘要5CA76AF8046A6B76E6AC725D9DD10C8070D2B9301CD324D6A0C534CCB5551D84。原9删除及untracked patch不动，无commit/push/PR或旧入口重跑。

先于共享源码变更，5debbd建立docs/evidence/windows-sandbox-through-67.sources.zip：1063118B/SHA d581769d1780d68e6e81c7bf3dc04d197566f2c4605441e15d0e1a368761c13c；配套JSON57855B/SHA4198f22376033da80b72c5e393ec7e5f8a9a1b30f1faaaefed098ebef4aec693。91 ZIP项中90原始项逐字复核：80原源码、4旧记录、§65/66/67各stdout与原exec元数据六项；内部清单另占一项，保留75/77/80历史源束。独立cursor256核档案及§66/67原stdout；它不是完整运行依赖镜像，也不宣称包含全部旧手动测试。最初过长shell命令在OS206创建进程前失败、没有写入；改为结构化文件后短命令成功，不是目标重跑。0e9cea核原五共享SHA与档案后才开始修改共享文件。

任务包只承载意图与原capture交付内容：SPTASK01、16B头、元数据≤32768B、输入总≤16384B，包≤49168B。原命令UTF16LE→Base64，任务/快照UUID、相对cwd、≤30000ms、≤16联合路径、逐输入长度与SHA、显式add/modify；不传宿主路径、原revision标识或授权对象。TaskPackageBuilder一次精确Buffer及一次命令scratch，按序复制原capture返回副本后立即清除；一次finish转移，放弃/失败清除。非空借原capture，零输入publication禁止制造capture，均须原SandboxTaskBorrow存活。原capture三次renew保持install/dispatch/execute检查。

原七native input槽各仅一次，两个载体只安装到tools/task-package.bin和tools/task-runner.exe，workspace保持输入命名空间；新旧Install入口共享同一attempt latch。安装receipt核两原载体身份/digest、五目标身份、7opened/7closed/peak4、无unknown和包/runner缓冲清零。原input-install.cs保存未改；本项新增partial不复用关闭后的slot。

新guest runner严格读完所有包字节，核路径、ASCII、Base64/UTF16、长度/溢出、输入hash、联合路径/修改关联；建立所选workspace输入、cwd与temp。原命令写tools/task-command.bin，argv只含固定小bootstrap；固定Windows PowerShell、固定四环境项，无宿主环境复制。bootstrap先等stdin固定gate，原Process加入不继承的KILL_ON_JOB_CLOSE Job后才放行。正常root退出也TerminateJobObject并核ActiveProcesses=0；超时同样结算root/两pump，unknown/未结算不能发布成功wrapper。request10s，结算截止request+8s，结果上限request+10s；宿主WSB exec预算20s。宿主取消拒绝结果/写回，实际VM关闭另行确认，不把VM关闭补写成guest进程树证据。

stdout/stderr各32KiB prefix及4KiB scratch独立pump，满后继续读取计数，无逐块字符串、对象、闭包、promise或对象池；两流原字节写SPRES001固定128B头+payload，总≤65664B。严格flags、reserved0、UUID、total/seen/retained/truncation/elapsed；结果本身是guest claim。新结果捕获复用原ManifestCapture算法但独立三slot/attempt/计数，固定两种内部profile，旧manifest仍4096B；结果18顶层native operations、3open/3close/peak2、独立buffer清零，unknown传播原NativeDisk。宿主确认原VM实际closed/absent/callsClosed后才读receipt及carrier两个独立fd，核原身份与SHA、再次核原borrow，并在解码后清除carrier/借用视图。UTF8替换解码明确允许截断末尾不完整字符，不宣称原bytes必为有效UTF8。

完整审计链为guest两BaseStream.Read→固定pump prefix→一次结果组装/文件发布→原native manifest读取/host私有载体→TaskResultReader两文件同步读取→一次settled UTF8解码→旧候选capture→原Agent/file_batch。既有WSB/manager逐chunk回调未改。本项尚无生产消费者；热路径验收用新增入口内source invariants和同一编译runner --contract-check：131073B内存流、34 reads、保留32768B、明确分配/清除36864B、两个buffer经独立NoInlining调用边界后GC live0，nativeCalls0；另零输入包及9 malformed package拒绝。JS新契约测包转移/放弃清除、零输入以及15拒绝（含一次重用拒绝），不跑旧VM/容量/链接/故障矩阵。仅源码约束不外推CLR全部隐式分配。

新链借原父execute上下文/SessionFiles/runtime，用§67 binding包住原capture到VM/结果/候选释放前的协调。原fixture增加实际powershell工具定义用于当前工具身份核验，没有调用它，不能声称真实生产命令授权。真正read与file_batch仍走原Agent/permission-controller，两次真实写回、原revision消费；生产CodeMode兄弟命令调用/最终授权需后续另接。成功预期stdout为stdout:alpha 中文+CRLF、stderr为stderr:fixture+CRLF，source修改alpha-guest+CRLF、new新增derived:alpha+CRLF；fixture5B源、2真实receipt、1native worker与5B一次capture沿旧有界断言。

静态524fb5按实际新入口清单顺序核88文件、1492798B、最大83610B，新源束585971bb2f168f325022e72a604d975fafa6322807e5d6be64507bdbd0d4144b。88=旧80+新7代码+原powershell.ts；不是完整transitive依赖镜像。先前9880da只是外部清单排序草稿，排序与入口不同，在任何运行前修正，不作为执行冻结。新入口每次physical dispatch复核自身88源束及对应固定程序；runner合同执行前核原编译产物。6固定程序、16旧手动测试保持原SHA。

拟唯一命令：固定PS7 -NoProfile、cwd D:/RMProjects/Pi，D:/Nodes/26.13.0/node.exe --expose-gc scripts/acceptance/windows-sandbox-task-acceptance.mjs --run-generic-task-once --source-bundle 585971bb2f168f325022e72a604d975fafa6322807e5d6be64507bdbd0d4144b。源码/预算独立批准且执行前116去重SHA/9旧indexblob/index/outside复核才运行一次；没有先行target import/compile/parse/test/VM。失败保持原入口与原始证据，不改后重跑。

预算：一个固定private root、一个按原identity管理的固定128MiB VHD/单VM、一个Temp host fixture根与两文件。4 helper（preflight、两csc编译、一次runner纯合同）各15s；DLL≤131072B、runner≤65536B是新拟上限，尚非实测大小。host物理记录≤99=helper4+manager1+CLI94，pending≤4；CLI按旧call/start/settle/exit15/120/120/30s边界，exec本次20s；manager commands≤16/messages≤32。新journal24576B、合并evidence23040B、footer512B、fixture原evidence12288B、总stdout≤40960B；普通私有文件13项，明确task profile固定白名单按原identity非递归清理；失败保留原owner及精确身份。成功预期capture/binding/publication/resultReader/checked及2原receipt共7弱目标、四轮GC live0。上述均为待验证预算，不是已观察结果。

执行批准尚未取得，新增入口保持未运行。

### §68 执行前修正：有界预览与新文件空白检查（尚未执行）

独立cursor268完成整链审阅；原073518与585971bb2f168f325022e72a604d975fafa6322807e5d6be64507bdbd0d4144b未获执行批准，现于任何目标运行前撤回。其余包/安装/Job/结果/原VM关闭/写回责任链未发现新增阻断；d41e5a/c8148c已独立核18scope、116去重哈希、88源及7552B四记录原前缀。两处集中修正如下，不属于失败入口重跑。

原task-session对完整32KiB输出转字符串再交boundedText，确实违反大结果处理的整链分配约束。现新增taskOutputPreview：只解码min(raw.length,64)字节，再把这份小文本交既有boundedText，JSON预览≤192B；两流各报告decoded/omitted字节和固定上限。原始字节数、seen/truncation及SHA仍直接从原buffer/view取值；前缀截断UTF8采用明确替换解码。helper内部完整JSON序列化的输入现在至多64个解码字符、控制字符最坏386B，而不是完整32KiB正文；没有完整输出字符串副本。

同一新增入口纯契约补三份满额32768B情形，复用一个32768B buffer：ASCII、全控制字符JSON展开、UTF8字符横跨第64字节；预期总source98304B、实际decode192B、每份omitted32704B、预览JSON≤192B，finally清除该buffer。源码不变量明确检查带0/end参数的限量解码、64/192常量及生产调用处无完整stdout/stderr.toString。C#原pump合同、VM数、helper数及七弱目标预算不变。原15拒绝字段改名refusals，避免误把一次包重用拒绝全计为result拒绝。

新task-acceptance末尾多余空行已移除。此前普通git diff --check不覆盖untracked新文件，不能声称已检查全部新源码；4a77ad现在逐个对七新源码运行git diff --no-index --check，以退出码及无诊断双重确认通过。此为静态空白检查，无目标导入/编译/执行。

修订88源仍最大83610B，累计1495795B，源束15cbd72dacc313125f96c9443108b3a0641fa04beaf8bdece17390820a5c1a3e。唯一拟命令的--source-bundle同步替换为该值；源码其他86项、历史ZIP/JSON、9旧indexblob和原范围外索引保持不变。尚未运行、未暂存，下一步仅复核这两文件/相关契约及新束增量，不重新审已完成整链，不扩大旧矩阵。

### §68 唯一实跑失败、原始证据与定向恢复

独立cursor273完成修订增量复核并批准唯一实跑；e709d8预核116哈希/九原index blob/index2041/outside2032通过。原执行exec-da163c9a-d25b-4f43-8831-877b1ce1d7cd（initial9a8adb、session68005）使用冻结88源束15cbd72dacc313125f96c9443108b3a0641fa04beaf8bdece17390820a5c1a3e。原stdout来自8e5773与2a6815，14379UTF8B、四行正文411/2529/11233/202B加四LF，SHA cda809c2c8ada0566d64eb7de539953f334a1de25763250fd4df55589ed1a68b。原任务a2a90255-985c-4e8a-9796-c2b83c594b5f、snapshot649bb91e-5b6a-41f3-a696-90f7756dc64e。report起止2026-11-02T18:03:53.386Z至18:04:38.710Z，45.324s到失败报告；原执行最终failed/exit1/duration891726ms包含失败保留与审核恢复等待，不能当作命令耗时。

实测preflight、两次编译与纯合同helper各exit0；DLL73728B/runner23040B。零输入/包转移/弃用清零及15拒绝断言通过；三预览情形source98304B、decode192B、最大JSON191B、fullOutputStrings0。生产pump纯内存合同读取131073B/34次，保留32768B，分配与清零各36864B、liveBuffers0/nativeCalls0，包拒绝9。上述是实际有限合同结果，未外推为全局内存计量或七目标GC通过。

实际5B输入捕获与安装成功：source12开12关、1次read/5B、scratch2264B释放；capture renew6/publication renew3，原5B与副本5B清理。publication2开2关、2202B分配清理相等；native install7开7关/peak4，24302B分配清理相等。guest wrapper0，但内部命令结果exit125、timedOutfalse、elapsed1503ms、flags995、stdout/stderr均0B。宿主收到严格校验的128B结果；native result3开3关/peak2/18operations/128B清理，JS reader2开2关/908B全部清理。宿主报Actual command result differs并拒绝候选写回：batchAttempts0、realReceipts0，仅原nested read成功。原fixture source仍为alpha5B，new.txt未创建。binding/source/publication/resultReader终态均释放已登记引用；七弱目标四轮GC分支未到达。源码支持优先调查bootstrap启动握手拒绝；编码或读取原因尚未实证，不记为已修复。

原VM97e91120-e670-4c49-b206-49cf0b535e98已closed，最后平台list为空；7CLI+4helper+1manager共12记录物理子进程均closed，pending[]；volume released/detached/managementClosed，closeUnknownfalse。失败策略保留外层Node33248及现场，不是自动收尾成功。私有root dev3938676073/ino9570149209367107有8叶115976B；fixture根dev3637606815/ino3096224743863722，source ino1407374883599787为5B。9fa125只读9开9关、115981B，核原身份/规范路径/普通单链接/大小/SHA和new.txt ENOENT。

失败证据保存为.artifacts/windows-sandbox-task-68-failure-a2a90255.json，4424950B、identity3938676073:1407374884759492、SHA f0041826cfe766cdaaa360a253aa9d33a950f0ff130808c93c26481abccf73d8。包含9现场叶、88冻结源码、四份追加前记录共101个原始字节条目及原stdout/身份清单。cd18cf逐条回读核验，101开101关、源内容读取3283087B；独立cursor277/fa7870再次确认档案及原输出一致、0cac5d核116冻结值。该档案独立保留，不在清理集合，不是新的可运行入口或完整依赖镜像。

恢复按cursor277批准的A→B→C执行。首次A/4d89ae在第一StartTime守卫停止，无kill/资源检查/删除；65d02c确认Process时间2026-11-02T18:03:52.8678132Z与CIM微秒时间18:03:52.8678130Z差2ticks。cursor278批准分别精确比较两值，不使用容差。A/f7b450 exit0持有同一原Process句柄，核原Node路径/完整命令/parent23584/创建时间/无直接子进程和档案/两根九叶/原关闭报告，读取115981B，仅Kill(false)原Node，实际ExitCode=-1，删文件0。B/9faf8d取得原session68005最终exit1，无新增输出。C/f6287c exit0先重核全部九叶，再逐叶重核原身份/SHA/规范父路径/单链接后unlink，两个原根核身份且空后非递归rmdir，11节点逐一ENOENT。C两次内容核验合计231962B，档案保持。未杀父PowerShell、未操作旧磁盘编号、未重复VM/目标入口。370d58核原116SHA、九旧indexblob及index2041/outside2032/SHA5CA76AF8046A6B76E6AC725D9DD10C8070D2B9301CD324D6A0C534CCB5551D84不变。

本项结论为原验收失败、定向恢复完成；未取得通用命令成功/两项宿主写回/七目标GC的通过结论。§68冻结源码与失败入口不修改、不重跑；原9D与补丁保持，无commit/push。后续首先以最小独立诊断确认启动握手机制，再处理新的修正验证；其后仍有生产CodeMode/session原授权接线、执行profile/配置迁移及旧权限退役、真实工程整体验收。P0桌面图片回放继续按用户延期，继续原工作/审核聊天。

### 用户要求停止：进度汇总（2026-11-03 03:25 JST）

用户最新明确指令：“立即记录进度并汇总，停止剩余任务”。本记录取代前文所有自动继续指示。剩余实现、诊断、测试、验收和后续审查均停止；仅完成此次进度记录。没有新建聊天。审核聊天已于cursor283完成既有暂存确认并处于idle，没有待运行验收。

已完成范围：P1原生装配/任务生命周期、P2原生文件正确性与会话装配、P5工具目录/提示词组合、P6约定的Provider/压缩契约已有实现和限定审查验证；P4.1/P4.2提前处理项及P7.1–P7.7各自范围已有完成记录。P7整体未完成。此前§66固定任务的输入捕获→沙盒执行→两项真实宿主文件写回链路已通过；§67请求/调用绑定的限定验证已通过，不能等同于通用生产命令接入。

本轮实际新增工作：实现通用任务包、来宾PowerShell runner、结果传输与有界输出预览；完成纯合同检查与一次真实沙盒验收。实机验收失败：子命令exit125、stdout/stderr为空，宿主正确拒绝写回；启动握手具体根因未验证、未修复。随后完成原失败证据保全、原Node精确终止、九临时文件/两个原目录清理和独立恢复核对。没有完成后续四块中的任何一块。45.324s到失败报告；原执行891.726s含人工恢复等待，不能把用户等待时间说成测试一直在执行。重复的实现/修正/复核和过细拆分消耗了时间，不能以局部检查通过替代交付进度。

停止时尚未完成：
1. 通用PowerShell任务启动握手问题修复，以及命令输出、两项写回和引用释放的成功实测。
2. 生产CodeMode、正常会话及原工具授权链的接入。
3. 执行profile/配置迁移、默认切换及依赖新边界的旧权限入口退役。
4. 代表性真实工程的整体验收与最终交付。
P0真实Windows桌面图片回放仍按用户之前要求延期，未恢复执行。

保存状态：§68冻结18文件已由442b2a一次精确暂存，cursor283独立确认，index2050/outside2032及原摘要不变；验收仍记失败。此前原九项未暂存删除与super-pi-clipboard-fix.patch保持。此次停止记录仅追加到四份现有文档，未再暂存、未commit/push，也不触发新的审查循环。完整失败档案保留在D:/RMProjects/Pi/.artifacts/windows-sandbox-task-68-failure-a2a90255.json；原沙盒、卷、记录辅助进程和专用临时目录均已收尾。后续仅在用户明确恢复后继续，不自动重跑§68或其他旧验收入口。

## §69 恢复实施：通用握手修复与生产接线（2026-11-03，进行中）

用户已明确恢复执行，并补充要求完成剩余全部任务、按性能文档检查全部代码。此前停止指示不再有效；历史失败结论和原始证据继续保留，不将旧失败回填为成功。此前延期的 P0 桌面回放纳入最终收尾。

握手机制已实证：Framework Process 的 StandardInput 在创建时使用 Console.InputEncoding；带 BOM 的 UTF-8 在 SUPERPI_GO 前插入前导字节。原 Console.In 的代码页解码使精确匹配失败并 exit125。第一次尝试固定 Console.InputEncoding 仅在有控制台本地成功，真实 System 来宾 wrapper125，已保留新失败档案 .artifacts/windows-sandbox-task-recovery-failure-86a46e00.json；其12个辅助进程/VM/VHD已关闭，精确终止本次保留 Node3372，按原身份清理7叶与2根。最终修复由子进程使用显式 UTF-8/BOM 检测 StreamReader 读取 stdin，不修改控制台编码；Job 分配先于握手放行，精确字符串校验保持。新增回归覆盖 UTF-8 有/无 BOM、936 代码页、无控制台，4场景通过。

新入口 windows-sandbox-task-recovery-acceptance.mjs 的修复源束 0e175d82314c5f9b134ce8e1f10dfe6c77edc425b9535ceee228fd5cf22d27b7 实机通过。task433edc0d-1128-4e89-8a03-774a114e87a6，命令exit0，stdout21B（含中文）、stderr16B；原授权下真实写回2项、1批/1次批准；12个物理进程全部closed，13文件自动清理，7弱目标/4轮GC/live0。证据为 .artifacts/windows-sandbox-task-recovery-bom-20261103.stdout.jsonl。原§68档案SHA256仍为f0041826cfe766cdaaa360a253aa9d33a950f0ff130808c93c26481abccf73d8。

生产接线已开始：共享任务链从固定夹具中提取，新增会话SessionSandbox、CodeMode兄弟powershell/file_batch协调及打包运行时。三组定向检查通过：命令拒绝不启动、写回拒绝不提交、正常兄弟调用和释放。首次正式构建后的AgentSession→CodeMode→实际WSB零输入命令通过，中文输出匹配，task目录无遗留；记录 .artifacts/windows-sandbox-session-20261103.stdout.jsonl，验收工程根 .artifacts/sandbox-session-uTmNbv 暂留作为现场证据。类型检查与离线构建通过。

当前仍未完成：生产输入/候选写回与失败/取消实测、执行配置迁移和默认切换、旧权限退役、代表性工程/P0桌面验收、完整性能检查。默认行为尚未切换；不能交付为全部完成。既有源码不变量首次检查发现6处此前已有property delete；CodeMode回归初跑与构建并发导致8个dist依赖缺失，不计为有效回归，构建后重跑正在进行。后续记录真实修复和结果，不以局部通过代替整体交付。未暂存本轮改动，未commit/push，原九删除与补丁保持。


## 70. 最终完成记录（2026-11-03）

**本轮 Windows/Node 交付范围完成，原四项剩余工作及恢复后的 P0 桌面回放均已闭合。** 当前状态以本节为准；早期“未完成/停止/待验收”保留为当时事实，不能覆盖本次证据，也不能将历史失败回填为通过。未运行 Linux/NVX/Bun 或任意第三方组合，不扩大既定平台范围。

| 原剩余任务 | 最终结果与证据 |
| --- | --- |
| 通用命令执行 | GateBootstrap 在 headless/System 来宾读取 BOM stdin 的根因已修复；显式 UTF-8 StreamReader，Job-before-gate 与精确握手仍保留。四项 gate 回归通过。通用任务支持真实 PowerShell、snapshot 输入、stdout/stderr、显式输出与取消/超时；失败不会发布候选。 |
| 正常产品流程接入 | AgentSession → CodeMode → 原 powershell 授权 → 实际 WSB → 原 file_batch 已贯通。最终工程脚本读取 JSON、计算 42、输出中文并写回两项，全部成功；10 个物理进程 closed，pending=0、task root removed，候选和结果字节释放。 |
| 配置与旧权限迁移 | 全局 executionEnvironment / executionPermissions、CLI 会话覆盖、JSON schema、Windows 新配置默认 sandbox 已完成；现有配置不猜测扩大权限。新 profile 仅安装原生权限 owner，旧 guard 不再重复注册；未适配 sandbox 的宿主入口明确禁用。旧会话权限不导入新 profile，仍有消费者的兼容路径按明确条件保留，见配置文档。 |
| 最终整体验收 | 离线构建、类型、源码门禁、全量回归及 20 个性能基准完成。实际工程成功、命令 exit23、超时与取消均有真实 WSB 证据；失败三类不写回宿主。 |
| P0 桌面图片 | 终端重启后工具恢复；真实 Alt+V/Ctrl+V、系统截图、Aseprite 图片复制、Explorer 中文文件名图片及普通 '-' 文本回放通过。辅助视觉 2 次：vision 每次 1 图、文字主模型每次 0 图；损坏图片保留失败原因，Enter 阻止发送，删除失败附件后可退出。 |

最终代表工程：`.artifacts/windows-sandbox-project-final-20261103.jsonl`，任务 `cc7540a2-e5d0-4287-a1d8-161ae12f8454`，根 `.artifacts/sandbox-session-eOxRnU` 作为可检查的工程证据保留。成功/失败/超时/取消原记录分别见 project-final、windows-sandbox-failure-20261103、windows-sandbox-timeout-session-20261103、windows-sandbox-cancel-session-20261103 的日志。没有重新运行冻结的历史失败入口。

回归：完整 suite 385 个单元 / 5165 项；初次最终运行有 3 个失败，分别是实际打包 peer 夹具缺失、源清单重复项、LSP Windows URI 夹具异常分配，均已诊断修正；随后对应 34 项全部通过。合并最终结果 5069 通过、96 个明确平台/可选场景跳过、0 未解决失败。`npm run check`、`npm run build:offline`、最终 `test:hot` 14 文件 / 81 项、diff whitespace 检查通过。保留失败和修复后日志，不将结果描述为一次全绿运行。

性能按完整生产调用链审查；20 场景最终全部通过。17 MiB 输出 / 272 chunks 仅固定保留 32768 B；200000 工作区 + 200000 普通 epoch 检查；热路径 Promise/controller=0，9 WeakRefs / 4 GC / live=0。Main/Alt 各 20000 帧，完整帧复制=0、最终字符串=1/帧、队列高水位=1、释放后引用=0。原生文件、任务、Provider/压缩、CodeMode、MCP、Evidence Ledger 与大结果各有独立数据；详见 [性能完成检查](performance/native-sandbox-closeout-2026-11-03.md)。

桌面证据：`.artifacts/windows-image-desktop-acceptance.json` 与 `windows-image-desktop-evidence.zip`。离线 fixture 使用真实 UI/剪贴板及生产序列化，网络禁止，未声称真实模型识图。经典 conhost 滚动区会保留部分中间状态行，当前附件状态和最终 wire 均核实；此展示限制不隐藏。两个验收终端、图片预览、专用 Explorer 与本次 Notepad 标签已关闭；用户其他 Notepad 标签保留。三个专用临时根按记录的路径、inode、内容 hash 归档后逐叶清理。

[执行环境与配置说明](execution-environments.md)明确支持范围：Windows、单会话串行、命令最多 30 秒、单文件 4096 B / 总 16384 B / 16 路径、有界离线任务。固定工具链缺失时拒绝运行，无宿主降级；不把本次小工程验收泛化为大型联网构建。兼容保留用于旧配置/历史数据/旧宿主，删除条件是完成显式迁移并退出相关支持范围；不会通过删除用户历史满足“退役”字样。

本轮没有 commit、push、PR 或再次暂存；已有暂存内容、9 份用户文档删除与 `super-pi-clipboard-fix.patch` 保留。运行时任务资源已收尾，`.artifacts` 下仅保留有意保存的验证记录与工程证据。统一源码/档案指纹见 `.artifacts/native-sandbox-closeout-manifest.json`。

## §71 三档会话权限完成记录（2026-11-03）

用户在 §70 后明确修订交互要求：只保留 `superpi` 日常启动，在 `/permissions` 内切换“只读（沙箱）”“沙箱读写（默认）”“全部读写（宿主机）”；前两档都在 Windows Sandbox，只有第三档离开隔离。此追加需求现已完成；§68 的失败及 §70 旧有界任务验收仍作为历史事实保留。

已完成：三档菜单与 `/permission` 别名；同一会话 ID/对话内撤销、等待旧任务并替换后端；新建/恢复/分叉不继承宿主授权；默认配置及旧权限迁移；read/ls/find/grep 和变更工具在来宾执行；PowerShell 工作区自动捕获与受校验写回；`/reload` 重建已关闭 owner；显式拒绝不因写回 revision ID 变化而丢失；失败原生回执不能被报告为成功。

真实验证：小工程成功生成 `answer=42 中文` 并写回；只读直接文件工具与命令写入均被拒绝；命令失败、超时、运行中切换都无宿主写回；会话历史保留，宿主授权不继承。另验证真实 VM 后 reload、新 VM 读取以及宿主模式写工作区外文件。Pi 仓库本身捕获 4864 个源文件，同一 VM 读取 README 并运行 Node；`.codegraph` 本地索引属于排除的生成元数据。相关运行的 VM、辅助 owner 和私有工作区均确认收尾，无剩余验收任务。

构建保持 1.0.0，PATH 中 `superpi` 命中已修复的本地入口。已有终端中的旧进程需退出后重新运行一次 `superpi` 加载构建；此后用菜单切换，无需不同启动命令。`--offline` 仅禁用启动网络，不决定权限，也不表示本地模型。

性能按完整调用链复核，无新对象池；固定输出缓冲/热路径计数、Pi 仓库分配采样与 GC、线性搜索计数和生命周期释放均有证据。定向覆盖并集 103 项：99 通过、4 个平台跳过，首次 4 失败已修复复验；未重复全量 CI。当前支持边界和测试细节见[会话权限与沙箱](execution-environments.md)、[性能追加检查](performance/native-sandbox-closeout-2026-11-03.md)。源码和验证记录见 `.artifacts/permission-modes-closeout.json`。

## §72 性能与稳定性再次复核（2026-11-03）

按用户追加要求完成全量 JS/TS 静态清单及关键生产调用链复核，专门检查闭包、临时对象、正则、过度防御和回退。修复十类问题，包含普通沙箱失败后可在清理确认后继续、整组候选预验证、UTF-8 无损边界、可重试清理、文件增长容量、授权历史增量扫描、压缩/重试 Esc 导航及 ANSI 二次方扫描。真实 VM 失败后同一会话恢复并成功写回已验证；最新本地构建仍为 1.0.0。

本轮审查完成不代表每条路径均无问题：密集控制字符输出分配及 tui-kit 菜单临时数组保留为性能后续项。扩展回归 318 通过、21 平台跳过；最终变更定向 38 通过，类型检查和构建通过。详见[完整审查与证据](performance/code-review-2026-11-03.md)。VM/快照已关闭；自动审批拒绝删除的一处三层空夹具目录明确保留。无提交、推送或重新暂存。

文档状态：§70 原范围及本节追加需求均完成。完成结论限于已记录的 Windows、有界工作区与受支持工具；不宣称任意联网或大型工程构建可在沙箱运行。已有暂存内容和用户改动保留；本轮无 commit、push、PR、重新暂存或历史验收覆盖。
