# Super Pi 性能优化与进一步验证方案

日期：2026-11-05，Asia/Tokyo。任务前缀 **PF**。

状态：**用户已授权 PF00 起依次执行；PF00、PF01 已交付，PF02-A 版本目标及功能回归完成、待审查/CI，PF02-B、PF03–PF08 尚未开始生产实施。** 本方案将当前性能审计转为可核对、可排除、可分批交付的任务。先复核测量和行为边界，再实施有证据支持的优化；阶段状态以对应源码、验收证据和 PR 记录推进。PF00 的实际检测与目标见[基线复核记录](performance/pf00-baseline-validation.md)，PF01 见[布局宽度测量记录](performance/pf01-layout-width-validation.md)，PF02-A 见[版本入口验证](performance/pf02-version-entry-validation.md)；其关闭绝对计时稳定性 V 已明确转入 PF07，未宣称整轮验收完成。

沿用 [历史修复方案](upstream-pi-history-followup-plan.md) 的代码、资源管理和 PR 约束，并完整服从 [Hot-path allocation contract](performance/hot-path-allocation-contract.md)。实施时若用户已有授权，不重复申请相同步骤的许可。首次推送后等待 reviewer；同一 PR 每次后续新增推送，必须单独评论 `@codex review`，等待当前 head 的审查闭环。

## 1. 基线与证据边界

| 项目 | 当前事实 |
| --- | --- |
| 生产基线 | main，`fc790a0bd608298b9acdb2860eddd12ac596628a`；每项实施前重新核对实际 main 和工作区 |
| 审计材料 | [2026-11-05 性能审计](evidence/performance-audit-2026-11-05.json)，含测量、夹具、复现代码和限制 |
| 本机环境 | Windows x64、i7-14700KF、Node 26.13.0、PowerShell 7；当前 CI 为 Node 26.13.x |
| 已有验证 | 上次审计的 81 项定向测试通过；不是本次规划重新运行，也不等于完整 CI |
| 当前交付范围 | PF00 纳入此前新方案、文档导航及原始审计 JSON，并交付本轮独立基线与检测入口；不改写原审计 |
| 外部验收缺口 | 未测原生终端完整体验、运行中沙箱的完整关闭时间、真实 provider 缓存命中率 |

| 路径 | 审计观察 | 能支持的判断 |
| --- | --- | --- |
| CLI 到可输入 | 简化配置、管道终端：regular 中位数约 639 ms，fullscreen 603 ms | 该隔离路径仍有启动成本；不能替代默认捆绑资源和原生终端 |
| 空闲退出 | regular 约 80 ms，fullscreen 90 ms | 空闲关闭暂无高优先级延迟证据；不涵盖活动工具/VM |
| `--version` | 无诊断预加载，中位数约 484 ms | 简单命令也承担了较重入口加载成本 |
| 常规 TUI 帧 | 5 千→5 万条，regular p95 约 0.028→0.029 ms；fullscreen 0.041→0.042 ms | 固定宽度夹具的普通帧随历史规模基本稳定；不含真实终端耗时 |
| 宽度变化 | 真实消息组件：5 千条中位数约 77 ms，5 万条约 765 ms | 当前同步全历史测量具有可复现成本；初次布局也需单独计量 |
| 64 KiB Markdown 追加 | 安全纯文本约 0.047 ms，代码块 1.94 ms，表格 11.95 ms，均为中位数 | 复杂单块仍有重解析/重排成本；使用无高亮 identity theme |
| 前缀确定性 | 128 KiB、1 MiB 上下文，各 100 种资源顺序，哈希漂移为 0 | 这些资源排序扰动未破坏确定性；不能推出真实缓存命中率 |
| 前缀构建成本 | 每个样本含 100 次构建，折算平均单次约 0.93 / 4.90 ms | 只能按平均构建成本理解，不能写成请求延迟 p95 |
| 未命中历史扫描 | 5 万条合成 assistant 记录，单次扫描中位数约 10.6 ms | `detectCacheMiss` 的成本，不含 `getEntries()` 复制；提示默认关闭 |

证据使用四种状态：**R** 为本基线运行观察，必须注明生产函数/夹具/隔离 CLI/原生终端/真实 provider；**S** 为源码确认；**V** 为尚待验证；**E** 为已有能力或经验证无须改动。不能把 S/V 写成已复现的产品缺陷，也不能把 E 重新实现一遍。新一轮基线变化后，旧测量保留为历史记录。

## 2. 任务顺序与推进门禁

默认顺序：**PF00 → PF01 → PF02 → PF03 → PF04 → PF05 → PF06 → PF07 → PF08**。PF00 建立足以比较的测量条件；后续每项开始前再补齐本项具体证据。待验证假设被排除时记录理由继续下一项，不为完成编号而强行改代码。

| ID | 内容 | 初始证据与状态 | 交付边界 |
| --- | --- | --- | --- |
| PF00 | 复核基线、探针与检测矩阵 | R/S；已交付，[PR #215](https://github.com/dragonbaba/super-pi/pull/215) | 固定源码/构建、补测量边界、审查各项假设和验收条件 |
| PF01 | 长会话首次布局与缩放 | R/S；已交付，[PR #216](https://github.com/dragonbaba/super-pi/pull/216) | 50k 合成生产组件夹具缩放 p95 −60.3%；保持精确高度，同步 O(n) 和原生终端验收边界不变 |
| PF02 | 启动入口与模块加载 | A：版本目标/功能回归完成，待审查；B：待设计验证 | 独立版本查询 p95 −88.3%；默认交互启动另测收益、另建 PR，关闭绝对计时 V 继续 PF07 |
| PF03 | 增长中的复杂 Markdown | R/S；待设计验证 | 分别评估表格/代码块；保留既有纯文本与 token 复用能力 |
| PF04 | 缓存命中观测与归因 | S/V；待核对 | 实际 usage、有效前缀和 retention 的关联；不承诺云端命中率提升 |
| PF05 | 缓存统计的历史扫描 | R/S；待设计验证 | 单轮统计增量维护；保留全量重建所需的正确扫描 |
| PF06 | 前缀摘要的重复计算 | R/S；待设计验证 | 优先同请求去重，再评估具备可靠失效条件的跨请求缓存 |
| PF07 | 活动任务退出与生命周期 | 空闲 R、活动路径 V；待测量 | 分阶段检测、定位实际慢点；成立问题独立修复 |
| PF08 | 集成复核、文档与退役 | 待前置任务 | 组合场景、最终离线构建、交付/遗留清单和已证实冗余项退役 |

每项状态使用：`待复核 → 设计就绪 → 实施中 → 待审查 → 待合并 → 已交付`；允许 `已排除` 或 `外部验收待完成`，必须写明依据与具体剩余条件。

进入生产实施前必须具备：根因或明确成本来源、最小可复现输入、生产调用链、正确性对照、资源 owner、容量/失效/释放规则、适用测试、基线与候选比较方法。把同一项拆成 A/B 子项时，先补各自边界；独立根因使用独立 PR。

## 3. 代码与性能硬约束

### 3.1 实现范围

- 优先修改已有函数和 owner，不新增通用任务框架、全局无界缓存、第二套关闭状态机或无消费者的抽象。
- 外部输入在所属边界校验一次；保留必要的授权/版本核对，不在内部热链反复 schema parse、规范化、序列化或文件身份检查。
- 不修改调用方消息/schema，不泄漏 mutable scratch；保留类型、稳定对象形状和错误含义，不能用 catch 后返回空结果掩盖失败。
- 不回退工具准入、项目可信度、认证隔离、Sandbox 工作区/网络策略、宿主 PATH 工具发现、会话持久化和取消语义。
- 不为微基准删除功能、延迟必要通知、改变工具顺序、降低输出保真度或跳过最终输出。异步分批只对已明确允许延迟的工作采用。
- 不批量格式化、不无关升级依赖；任何退役先证明无消费者和有等效入口。

### 3.2 热路径数值与所有权

修改 provider delta、进度、事件交付、交互更新、布局/渲染、终端帧、大结果或高频索引时，审计完整生产调用链直到成功、失败、取消、clear/dispose。把分配移到 helper 不构成豁免。大历史和前缀计算虽可能每请求一次，也须按实际规模核对扫描、复制和保留成本。

| 项目 | 必须满足 |
| --- | --- |
| 高频闭包 | 常规 frame/delta/progress 内 inline arrow/function、Promise executor、inline then/catch/finally、逐事件 timer 回调、循环 bind 均为 0；稳定回调随 owner 创建一次 |
| 高频异步分配 | 每 frame/provider-delta/tool-progress 的 Promise、AbortController、signal/options wrapper、Promise tail/数组均为 0；保留契约规定的生命周期边界 |
| 临时容器 | 不逐更新创建 Map/Set、spread、Object.assign 或包装对象；必要数组/scratch 记录容量、owner、所有退出点与超大 backing store 丢弃条件 |
| 正则与字符串 | 不在每字符/delta/frame 中重复创建 RegExp、动态拼接正则或构造完整文本副本；复用有明确语义的模式，注意全局正则状态；计量规范化、JSON、哈希、split/join 和 ANSI 处理的字符扫描/物化次数 |
| 完整终端帧 | active write ≤ 1，pending latest ≤ 1，queue high-water ≤ 2；每帧完整物化 ≤ 1，应用层完整副本 = 0；每 busy cycle shared deferred ≤ 1 |
| 背压与代次 | 保留 callback + drain 完成条件；逻辑取消不提前释放物理 writer；迟到回调不得完成新代次；内容和光标原子提交 |
| 事件链 | 常规 Agent latest observer → AgentSession → 内置 InteractiveMode 保持同步交付；不逐事件增加 async/rejection observer；保留实际交付时必要的隔离快照 |
| 缓存 | owner、键含义、版本来源、容量/字节上限、失效与释放均明确；不能仅凭对象引用假定可变 schema/扩展输出不变 |
| 生命周期 | 成功、throw、abort、clear、dispose、重复调用后核对大字符串/容器/监听器/timer/waiter/子进程释放；不能只看状态标志或进程退出 |

低频闭包例外必须点名启动、停止、fatal cleanup、显式命令、切换或生命周期 deadline 的实际函数，不给整文件/整类豁免。稳定回调也必须在 owner 退出时解除引用。

默认不引入对象池。例外必须先有主要分配栈证据，并满足契约全部所有权、容量、重入、异常、取消、双重释放与字段清空条件：采样分配下降至少 20%，CPU p95 回退不超过 5%，最终堆增长不超过 10%。不池化消息、事件、工具结果、provider payload、Promise、字符串或跨异步边界对象。

### 3.3 每个热路径 PR 必交三类证据

1. **确定性结构计数**：测量/渲染项目数、扫描字符数、parse/hash 次数、缓存命中/失效、每更新分配、队列与引用高水位。
2. **分配证据**：allocation profile 或精确计数，附采样方法、主要栈、输入规模和单位成本；结构计数与时间/profile 分开采集。
3. **生命周期证据**：受控 GC 加确定性引用/owner 观察，保持必要长寿命 owner 存活，验证正常、错误、取消和销毁；单次 heap delta 不作为泄漏或无泄漏结论。

已有必要协议对象、隔离快照和新分配分别记账，不把“没有新增分配”写成整链零分配。遵循 [完整契约](performance/hot-path-allocation-contract.md) 的 AST/source-invariant 和生产 allocation 门禁。

## 4. 进一步校验与检测方法

### 4.1 复核测量可信度

- 固定基线 commit、候选 commit/source hash、Node、依赖锁文件、OS/终端、fixture hash、参数和环境。执行 `npm run build:offline` 后记录构建输入/产物对应关系；包版本号和 `--version` 不能证明 dist 属于当前源码。
- 现有审计的子进程冷启动属于模块/进程冷启动，不能称为 OS 磁盘冷启动。模块导入、runtime 创建、资源加载、TUI init、首帧、首次输入被处理分别标记，避免把窗口标题出现当作可交互完成。
- 对启动探针分别运行有/无 instrumentation 对照，检查预加载改变导入顺序或测量开销的影响；正常运行时关闭探针，无逐 delta 日志。
- 同机串行比较基线/候选，采用交替顺序以暴露热身和机器漂移，不与构建、全量测试或其他基准争抢资源。至少 5 个独立进程；CLI/生命周期每侧至少 30 个有效观测，微基准复用既有足够长的采样窗口。
- 明确 p50/p95 是原始事件、批次均值还是整段任务；分别记录冷启动和稳态，报告样本数、分布、CV/离群值及失败样本。不用删除慢样本或加大循环掩盖回归。
- PF00 先固定每项改善目标、计时噪声带和复测规则，再改生产代码。普通优化必须有超出噪声的重复收益，且无可重复的非目标路径回退；对象池仍受 §3 的硬数值门禁。CI 主要卡确定性计数，不给共享 runner 强套本机微秒阈值。
- 拆开即时响应、全部工作完成、CPU、分配和长期保留；把工作移到后台只能证明响应改善，必须同时报告总工作量、取消和积压情况。

### 4.2 分层检测矩阵

| 层级 | 检测内容 | 通过条件/限制 |
| --- | --- | --- |
| 源码与 AST | 完整调用链、分配、重复计算、owner 和失效点 | 源码不变量通过；新增 helper 进入审计范围 |
| 生产函数/组件 | 原实现或完整渲染作为行为对照，固定输入/随机种子 | 输出、状态及错误语义一致；需要变化的行为先写清差异 |
| 隔离 CLI | 正式 `scripts/superpi.mjs`，简化/默认捆绑资源，regular/fullscreen，空/长会话 | 从真实入口构建并执行；隔离 HOME/agentDir；默认资源不能被全禁用后宣称通过 |
| 原生终端 | Windows ConPTY/Windows Terminal；Linux PTY 对应交互 | 输入延迟、连续缩放、光标、粘贴、选择、alternate screen/raw mode 恢复；无条件时保持该验收待完成 |
| Sandbox | 已支持宿主上的实际 VM、活动命令取消、关闭 | 网络 enabled/disabled 配置显式且隔离；工具路径和读写边界不退化，按实例身份回收 |
| Provider 离线协议 | 实际 adapter 组装/usage 归一化/effective dispatch，网络边界 fixture | 稳定与故意变化的前缀均能正确识别；不替代云端命中率 |
| Provider 在线 | 明确测试账户/模型/retention/预算的非敏感测试会话 | 仅使用已授权条件；记录实际 usage、请求成功/失败和采样限制，不存凭据/私密内容 |

离线构建不等于离线推理。网络可用不等于已具备付费 provider 探测预算。在线条件未具备时继续独立的本地验证，将云端结论保留待验证，不能以本地哈希稳定宣称命中率提升。

### 4.3 对方案本身的反例检查

每项设计就绪前必须回答：当前成本是否来自生产而非探针/夹具；已有能力是否已覆盖；优化是否只是换位置/延迟执行；缓存能否因同引用内容变化失效；功能对照是否涵盖错误和取消；指标是否遗漏历史规模、宽度、配置或 provider 差异；是否可能牺牲隔离、输出正确性或物理资源所有权。

建立至少一个稳定负对照和一个应失效/应回退的反例。被反例否定的方案先修正设计；没有可测收益或不能保持语义时，记录 E/排除理由，不扩大范围寻找其他指标“过关”。

## 5. 各任务实施与验收

### PF00 基线复核与设计校验

- 核对上一轮审计 JSON 的单位、夹具修正、探针加载顺序和子进程口径；前缀 100 次/样本与普通单次计时分开。保持现有审计原始记录，不覆盖成候选结果。
- 复用现有 benchmark、测试 runner 和隔离能力；只为缺失的生产场景增加最小探针，不新增通用性能平台。将 JSON 中必要的审计脚本按任务临时根重建后复核，收敛确实长期需要的入口。
- 固化 §4 的比较协议，给 PF01–PF07 建立逐项验收记录：调用链、观察级别、反例、目标、非目标回归和待补环境；目标不能从结果反推。
- 交付基线/设计记录与可复现命令；未完成的原生终端、默认资源、在线 provider 或 VM 验收逐项列出。没有足够证据的具体实现保持待设计验证。

### PF01 长会话布局与宽度变化

- **链路**：窗口 resize → TUI 调度 → `RetainedContainer.prepareViewportIndex()` → 消息组件/Markdown 测量 → viewport/layout → terminal frame queue → write/flush。
- **补测**：1 千、5 千、5 万条，短文本与真实长块；底部、中段、顶部，连续不同宽度与往返宽度；首次恢复、流式输出同时 resize、overlay/选择/搜索定位、宽字符/组合字符、Kitty 图像回退。普通滚动和固定宽度帧为负对照。
- **候选方向**：先定位全历史测量、宽度缓存和高度索引成本，再评估可见区域优先、受限分批或已完成内容复用。当前总高度/滚动定位依赖精确测量，不能未经证明直接换成估计高度，也不预先选定新树结构或后台调度器。
- **验收**：首个正确可见帧与输入处理延迟改善；报告全部测量完成时间、总 CPU、每次 resize 测量项目数和每分批工作上限；滚动锚点、总高度、选择命中与基线一致。快速 resize 只能保留有界当前任务/最新意图，旧代次不得提交，清空/退出后无测量任务或历史引用。
- **现有入口**：`tests/tui-retained-transcript.test.ts`、`tests/tui-retained-golden.test.ts`、`tests/tui-retained-source-invariants.test.ts`、`tests/tui-frame-hot-paths.test.ts`；`bench:tui-transcript`、`bench:tui-frame-allocations`、`bench:tui-retained-lifecycle`，复杂叶子补 `bench:tui-assistant-leaf-allocations`。

### PF02 启动入口和加载成本

- **链路**：`scripts/superpi.mjs` → CLI args/bundled resources → `cli.ts`/`main.ts` 静态模块 → settings/trust/runtime/resource loader → 所选模式 init → 首次输入。
- **补测**：`--version`、普通/扩展帮助、包/auth 命令解析、print/RPC/interactive；无/有捆绑资源、缺少 dist、配置缺失/损坏、项目已信任/未信任、空/长会话、扩展启动 hook/失败/启动中 quit。测试不得打印真实凭据或触发真实登录刷新。
- **候选方向**：简单命令轻量入口、按模式动态导入、避免已证实重复初始化。Provider API 的 lazy import 已存在，不重复增加一层；`--help` 可能依赖扩展参数，不能为了快而遗漏扩展帮助。重复 refresh 先测来源/收益和注册语义，再决定是否改。
- **验收**：无关模块不加载的确定性证据 + 端到端时间/分配；默认捆绑资源行为和首次使用成本单独报告，不能把启动成本完整转移到第一条输入后忽略。保留 CLI 参数优先级、错误码、资源检查、信任与 hook 顺序，启动失败/取消清理通过。
- **拆分**：简单命令与默认交互启动若属于不同根因，按 PF02-A/B 独立 PR；前者收益不能代替后者验收。
- **验证前置 PF02-V**：[仓库内临时目录的测试隔离与释放](performance/pf02-task-temp-validation.md)。PF02-B 全套检测发现旧夹具会继承父目录依赖/Git watcher，另有固定宽度截断误报；先独立修复测试、审查合并，再恢复启动优化，不弱化断言或修改临时目录约定。
- **现有入口**：`tests/alpha-cli.test.ts`、`tests/alpha-startup-faults.test.ts`、`tests/alpha-startup-quit.test.ts`；`bench:model-runtime`、`bench:model-runtime:warm`、`alpha:g2-capture`。capture 与正式 launcher 的路径/加载差异须先核对，不能直接套用。

### PF03 复杂 Markdown 的增量成本

- **链路**：实际 assistant 更新 → `AssistantMessageComponent` 保留槽位/transform → `Markdown.setText/render` → lexer/inline/block/table/highlight/wrap → viewport/terminal。
- **补测**：16/64/256 KiB 和超容量输入；多行/单行代码、未闭合/闭合/部分围栏、增长表格与列宽变化、列表、链接/引用定义、数学内容、CJK/emoji/ANSI、重复空格、thinking 样式、扩展 transform、宽度/主题变更和非追加替换。
- **候选方向**：在既有 token/纯文本缓存上定位仍重复的解析、块尾和表格宽度工作；表格和代码块分别证明后再优化。不得简单假定此前所有 Markdown 块都永久稳定，引用定义和列宽可能影响前文。
- **验收**：每个输入增量与完整 renderer 的结果逐次一致；边界必须正确回退。记录扫描/重解析字符数、重建 token/行、高亮调用、分配和缓存高水位；普通纯文本仍为负对照。保留现有 256 KiB source、8192 tokens、4 MiB rendered characters 等边界，改变容量须独立证明，不能通过放大缓存掩盖成本。
- **生命周期**：slot 替换、流式结束、invalidate、clear、dispose、异常时释放大 source/token/行引用，多实例不串状态。
- **现有入口**：`tests/tui-markdown-incremental-wrap.test.ts`、`tests/alpha-markdown-ownership.test.ts`、`tests/tui-final-unmount-cache-owners.test.ts`；`bench:tui-markdown-incremental-wrap`、`bench:tui-assistant-leaf-allocations`、`bench:tui-paced-assistant-leaf`。现有小 code/table fixture 不代替本项长块测试。

### PF04 缓存观测和归因正确性

- **链路**：provider usage 归一化 + provider effective-dispatch → SDK manifest/recorder → session 完成事件 → cache stats/footer/notice。
- **补测**：同前缀多轮、工具 schema/顺序/激活变化、项目上下文和动态指令、分支/压缩/恢复、模型/传输/账号边界、retry/reconnect、扩展请求变换；`none/short/long`、不支持/未报告 cache、零 token、cacheRead-only 和 cacheWrite 模式分别覆盖。
- **候选方向**：复用已有 CH% 与漂移诊断，关联实际有效请求和相应响应 usage；异步重试或重连不得把上一请求诊断配给下一条消息。不把单一 5 分钟空闲阈值作为跨 provider 的失效证明；缺少 retention/服务端原因时明确未知。
- **指标口径**：归一化 prompt tokens 后计算单轮和 token 加权命中比例；不能把 API 原始 inclusive input 与 cacheRead 重复相加，不能将请求数比例混作 token 比例。`min(前轮长度, 本轮长度)` 只是重复 token 的估计上界，前缀内容变化时不能直接称为本可命中的确定浪费。价格未知时不制造节省金额。
- **在线补验**：在已明确的测试身份、模型、预算、retention 和非敏感固定内容下做稳定对照/单因素变化，记录真实 usage、样本数、失败与服务端不确定性；实际缓存策略在实施日核对官方说明，不将本地硬编码阈值当服务承诺。
- **验收**：离线协议和 UI 归因正确性可独立交付；没有在线结果时，云端命中率/费用改善保持待验证。日志只保留必要散列、标识和标量，不保存提示词、auth、完整 payload 或用户会话。
- **现有入口**：`tests/prefix-production-assembly.test.ts`、`tests/prefix-production-diagnostics.test.ts`、`tests/cache-key.test.ts` 及实际涉及的 provider-contract；`bench:effective-dispatch`、`bench:cache-markers`。各 provider 用量差异按源码选择相关回归，不生造统一协议。

### PF05 增量缓存统计

- **链路**：message_end（持久化前）→ `maybeShowCacheMissNotice()` → `getEntries()` → `detectCacheMiss()/scan()`；同时核对 session 汇总、footer 和 transcript rebuild 的消费者。
- **补测**：提示开/关，1 千/1 万/5 万记录，普通/零用量消息、工具穿插、模型切换、压缩、分支摘要、分叉/切换/恢复、重复事件和失败请求；包含“同长度但不同内容”的归因反例。
- **候选方向**：单轮路径只维护所需前态或复用现有 session 版本状态；以 session/branch/history generation 为失效依据。恢复/分支切换可一次重建，正常 append 不复制扫描全部历史。`collectCacheMisses()` 的完整重建用途保留，公开 `getEntries()` 的隔离语义不变。
- **验收**：与已校正语义的参考扫描逐步对照，避免重复计数/遗漏重置；正常完成事件处理与历史长度无关，不构建随后丢弃的全量 Map。记录访问条目数、复制引用数、分配、重建次数和退出引用；提示关闭不新增无消费者的统计负担。
- **门禁**：补最小公开行为回归和定向 allocation/增长规模测试，复用 `tests/alpha-cli.test.ts` 相关重建路径、事件链/缓存消费者测试；不复制实现来充当正确性 oracle。

### PF06 前缀计算去重与稳定性

- **链路**：资源/工具/扩展当前状态 → SDK manifestInput → intent manifest → provider 实际变换/有效派发 → effective manifest/差异比较 → owner 释放。
- **先做**：同次构建/同请求内稳定摘要去重。只有证明资源与工具的版本来源可靠后，才设计跨请求复用；对象引用相同、路径相同都不保证内容相同。
- **补测**：资源顺序扰动、NFC/换行/路径规范化、同 precedence 与不同 precedence、语义工具顺序、原地 schema 修改、扩展 reload/动态变换、工作区/模型/缓存键/retention 改变、压缩/恢复/失败重试和多 session。
- **验收**：有意义的请求顺序和内容保持不变；不通过全局排序改变工具/指令优先级来“稳定哈希”。缓存命中与强制失效均有反例，失效后的诊断与未缓存实现一致；provider effective-dispatch 仍观察实际发送内容，不能用 intent 代替。诊断异常仍不得阻断正常请求。
- **性能/生命周期**：记录 normalize/hash 次数和字节、工具 schema 重处理次数、临时分配及保留大小；缓存不得额外保留整套上下文正文，明确容量/逐出与 session/reload/dispose 释放。
- **现有入口**：`tests/prefix-manifest.test.ts`、`tests/prefix-determinism.test.ts`、`tests/prefix-production-assembly.test.ts`、`tests/prefix-production-diagnostics.test.ts`；`bench:prefix`、`bench:effective-dispatch`。

### PF07 关闭阶段与活动资源

- **链路**：用户 quit/EOF/信号/扩展 shutdown → before-shutdown hook → input drain → TUI stop/flush/terminal restore → runtime/session/provider/MCP/tool/Sandbox dispose → 进程退出。
- **补测**：空闲、流式请求、工具/后台命令、compaction、MCP、活动 VM、背压/慢 stdout、断开输出、慢/失败扩展、启动中退出及重叠/重复关闭；regular/fullscreen 和 print/RPC 的既有收尾语义分别保留。
- **计时**：按 hook、输入 drain、逻辑 UI、物理写入、runtime、子进程/VM 分段；同时测实际 raw/alternate screen 恢复和最终输出，不把 `drainInput(1000)` 误写为固定 1 秒延迟。
- **前置未决证据**：PF02-A 的 Windows bundled/fullscreen 空闲关闭，五个 30 事件窗口仍有 10.151% 基线 p95 带；分段探针观察到原有 50 ms 输入等待及 runtime dispose 的波动。配对窗口未出现 >5% 回退，但绝对计时稳定性未通过，原始样本与探针见 [PF02-A 记录](performance/pf02-version-entry-validation.md)，本项须继续核验，不能改写为已稳定。
- **验收**：取消只发起一次，重复关闭共享完成点，最终帧/退出码正确，无 stale callback、写后释放、重复 hook、遗留自有进程/VM。区分无法取消的 OS 写入最小物理 ownership 和可释放逻辑引用。
- **决策边界**：先证明慢点再改；不能删除必要清理、提前 process.exit、强杀不属于任务的进程或默默增加扩展 hook timeout。确需改变可取消/等待语义时单独写兼容性决策，不混入普通提速。
- **现有入口**：`tests/alpha-shutdown-deferred.test.ts`、`tests/alpha-startup-quit.test.ts`、`tests/alpha-cli.test.ts`、`tests/rpc-shutdown.test.ts`、`tests/mcp-refresh-shutdown.test.ts`、`tests/tui-terminal-state.test.ts`、`tests/tui-frame-queue.test.ts`；`bench:tui-frame-queue`、`bench:tui-input-lifecycle`、`bench:tui-interactive-reference-allocations`，实际 VM 验收按 [测试说明](testing.md) 的现行 opt-in 入口执行。

### PF08 集成、退役与交付

- 对最终累计版本运行默认资源启动、长会话流式输出+连续缩放、复杂 Markdown+工具进度+背压、分支/压缩后的缓存诊断、活动工具/VM 退出等组合场景；只选能覆盖交互风险的组合，不机械做无关笛卡尔积。
- 复核稳定帧、纯文本追加、默认未开启提示、输出保真、权限与网络模式等负对照。运行生产构建和完整要求检查，报告最终 source/dist 对应关系。
- 退役候选只限已被替代且无消费者的探针/脚本、重复统计路径或过时的当前使用说明。搜索 package scripts、CI、文档与调用者，证明等效入口后再删除；历史失败证据保留并标注适用 commit，不将历史记录改写为成功。没有证明的候选保留。
- 同步必要的中英文 README、性能文档、测试/构建说明和任务记录；不因本方案重复创建 npm/cmd/ps1 启动入口，不把尚未验证的收益写进产品说明。
- 汇总每项交付/排除/外部待验证、PR/CI/merge、最终构建、分支和资源回执。外部环境缺口不得用本地测试替代，也不能在存在必需未完成项时宣称整轮验收完成。

## 6. 验证命令与交付流程

下列是当前仓库已有入口；具体参数在各任务开始时按脚本再次核对。先设置子进程隔离环境，再执行。Windows 必须显式使用 PowerShell 7，禁止退回 Windows PowerShell 5.1；通过宿主 PATH 发现工具与依赖目录，不逐工具硬编码一组固定路径。

```powershell
npm run check
npm run build:offline
npm test
```

PowerShell 执行策略需要时可用 `npm.cmd`，它与在线 npm 包是否发布无关；不为此更改永久执行策略。`build:offline` 使用本地已安装依赖和仓库模型数据，不替代依赖安装。

每个生产 PR：最小失败/成本回归 → 实现与定向验证 → 相关 AST/source invariants、allocation 和生命周期 → 上述 check/build/test → 最终 diff 和证据核对。全套已覆盖后不重复机械运行 hot/contract 子集，除非新改动、失败或未决风险需要。性能基准串行且与测试分离。文档-only 变更只做链接/命令/内容一致性和 `git diff --check`，不启动无关构建。

### 6.1 PR 和 reviewer 约束

1. 每个独立根因/验收目标从最新 main 建新分支和新 PR，建议 `codex/perf-pfNN-<topic>`。不复用已合并 PR，不夹带无关改动，不重置/丢弃用户已有文件。
2. 完成先行设计、回归、性能证据、自审和资源处理后再提交推送；PR 说明问题、最终行为、取舍、完整链成本、验证和实际限制。
3. **首次推送创建 PR 后等待 reviewer。** 沿用既有主动审查约定，单独评论准确文本 `@codex review` 触发首次审查，并记录 URL/head；评论发送或 reviewer 收到请求都不算审查完成。
4. **同一 PR 每次后续新增推送必须再次单独评论 `@codex review`。** 包括 reviewer 修正、文档补证、解决冲突或同步 main 引入的新 head；旧 head 的结论不能覆盖新提交。
5. 核对当前 head 的正式 reviews、行内线程和 comments。有效建议逐条解决并验证；无评论/暂未回复不等于无建议。已采纳建议必须对应最终代码，不以手动 resolve 代替修复。
6. 当前 head 已完成审查且无未处理有效发现，所有必需 CI 成功，才允许按已有授权和远端规则合并。当前为 **Linux 2 分片 + Windows 4 分片**，共六个检查；typecheck 在 Linux shard 1，所有分片均构建并运行各自测试。失败、取消、排队或过期结果不算通过；实施时 CI 若新增必需项，同样必须通过。
7. 合并前重新核对 PR head/base、审查和 CI 的 SHA，并以预期 head 约束合并，防止审查后发生竞态变更；有新 head 就重新进入审查/验证。
8. 合并后确认 merge commit 已进入 main，按 PR 精确身份删除对应远端旧分支；同步本地主分支，确认任务提交已包含于合并结果且无 worktree 占用，再删除对应本地旧分支。squash 合并不能只靠祖先关系判断；不按名字模糊批量清理。
9. 更新正式记录，回到 main，再开始下一项。等待 reviewer 时释放无用进程/采样资源，不使用不断新增无关提交替代等待，也不重复询问已获授权的相同步骤。

### 6.2 任务资源

使用 `<repository>/.task-tmp/<task-id>-<unique-id>/`，按需创建 `resources.json`、日志、fixture、profile；禁止将任务临时数据放入 `.git`。创建即登记绝对路径、文件身份、PID+启动时间/用途、退出状态和共享父目录归属。只在子进程环境设置 `TMP/TEMP/TMPDIR`，启动后核对 `os.tmpdir()`；隔离 HOME/配置/会话，不改用户系统环境和真实配置。

先保存可复现的去敏证据到任务记录或 `docs/evidence/`，再等待子进程/VM退出、释放句柄。删除前验证目标仍位于任务根、父目录/reparse/link 边界和资源身份；仅清理本任务登记资源，最后删任务根。共享 `.task-tmp` 只有本任务创建且为空才可删除。清理被阻止时保留清单，报告精确路径和原因，不切换机制绕过、不宣称完成。

## 7. 验收记录与本次方案核对

每项正式记录至少包含：ID/状态/前置项、基线/候选/构建哈希、R/S/V/E 与环境、反例/生产链、最小实现、必要校验/错误传播、owner/容量/失效/释放、确定性计数/分配/生命周期、计时口径与噪声、功能/性能回归、外部验收缺口、PR/审查评论/最终 head/六分片 CI/merge SHA、两端分支和资源回执。

本次规划已核对当前 `package.json`、CI 六分片配置、审计 JSON、性能契约、历史 PR 流程，以及列出的现有测试/基准入口。方案明确纠正四种容易混淆的口径：管道终端不等于原生终端；平均前缀构建成本不等于请求 p95；本地前缀稳定不等于云端命中；空闲退出不等于活动工具/VM退出。具体性能目标与设计仍须 PF00/各项前置验证固定，文档建立不将这些项自动标为已通过。

规划阶段文档检查：当时 9 个任务细则、5 个本地链接目标、20 个去重测试文件路径、15 个 npm 基准/诊断脚本名均已核对存在；新文档无尾随空白且代码围栏成对，导航 diff 通过 `git diff --check`。这是规划时的文档可执行性检查，不是重新运行性能测试；当时未修改生产代码、构建产物、CI 或真实配置，也未创建任务临时目录。后续执行的构建、测量与临时资源以 PF00 及各项执行回执为准。
