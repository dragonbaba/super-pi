# PF03 复杂 Markdown 增长验证

日期：2026-11-05。基线 `b4cabe0ec7cabef0acd0f615def7ab734ac8459f`，分支 `codex/perf-pf03-markdown`。状态：最终本地验收完成，准备独立 PR；仍须当前 head reviewer 无未处理发现及六分片 CI 全通过。对应[总方案](../super-pi-performance-followup-plan.md)和 [PF00 验收门禁](pf00-baseline-validation.md)。原始样本、两版候选、协议、源码/构建摘要、失败夹具、进程退出和复现脚本见 [PF03 证据](../evidence/performance-pf03-markdown-2026-11-05.json)。

## 根因与最小改动

先分别采样真实 dark 主题的 64 KiB 增长表格和 TypeScript 代码块。表格中，`visibleWidth()` 及字素宽度处理是主要 CPU/分配来源；边框使包含普通 ASCII 单元格的整行进入 Unicode 分割。代码块主要成本在完整语法高亮，与表格不同。原始诊断同时启用 CPU/HeapProfiler，只用于定位，不作为正式延迟数据。

本次仅让既有宽度快路径识别 U+2500–U+257F 框线字符：与当前完整字素算法一致，每个占一列。遇到组合标记、Prepend、CJK、emoji、未知控制序列等仍整体回退，不能跨 ANSI 边界错误拆分字素。`terminalAsciiWidth` 改名为 `terminalSimpleWidth`，下游 UI 审计同步追踪新名字。没有新缓存、容量扩大、闭包、正则、对象池或帧字符串副本。

没有改动 Markdown 解析、token 签名、表格列宽决策和代码高亮。表格列宽、引用定义仍能影响前文，完整回退保留；主题高亮接口接收完整代码文本，本轮不引入尚未证明安全的跨行高亮状态缓存。代码块与普通纯文本作为负对照，不将表格收益推广至所有 Markdown。最终候选把框线判断放在原有 ASCII/tab/ANSI 分支之后，保留普通样式文本原有的判断顺序。

## 生产链与所有权

核对链路：Agent latest delivery/snapshot → AgentSession 同步事件 → `InteractiveMode.handleEvent(message_update)` → `AssistantMessageComponent.updateContent()` 的保留槽位和 transformer → `Markdown.setText/render()` → Marked/inline/table/highlight → `wrapTextWithAnsi/visibleWidth` → RetainedItem/viewport → Main/Alt frame → TerminalFrameQueue → ProcessTerminal 的 callback/drain 完成、flush/abort/dispose。

- 本次快路径每次调用新增闭包、Promise、AbortController、包装对象、数组和正则均为零；复用原有 512-key 完整输入/Unicode 核心共享 FIFO。遇到不支持字符时仍保留原 Unicode 算法，不能将候选表格的零分割推广至混合 Unicode。
- Markdown 仍持有当前文本、当前输出及有界增量缓存；256 KiB source、8192 tokens、4 MiB rendered characters 的既有边界不变。`setText` 替换当前输出，`invalidate`/卸载释放增量引用，组件释放后不再拥有 source。全局宽度缓存按原上限保留最近键，不宣称组件卸载会清空全局缓存。
- 既有 Marked token/inline 数组、token JSON 签名、当前组件行数组和最终输出仍分配；transformer 的生命周期回调与每次调用 context 也未改变。不能只凭宽度函数 AST 的零分配构造，把完整 Markdown 更新写成零分配。
- 帧链的活动/待写上限、最终帧物化与复制、异常和最终卸载引用释放由既有源不变量及生产 benchmark 验证；本次不更改调度、背压或终端语义。

## 预先固定的测量

候选修改前选定：120 列、真实 dark 主题、约 64 KiB 起始且持续增长的表格，p95 改善至少 20% 并超过基线批次带；表格、代码、多行/单行、纯文本及容量边界分别对照。每侧五个独立进程、100 次预热、30 个正式样本，每样本为五次连续 `setText/render` 的平均耗时；表格 source 从 65565 增长到 72915 字符。报告的是五次更新批次均值的 p95，不是原生按键延迟或单帧 p95。基线通过 loader 在同一依赖图中替换原 `utils.ts`，其余源码相同。

以下为最终候选结果。第一版候选和所有短窗口/慢样本单独保留；不将诊断 profiler 同时启用时的耗时混入正式计时。

| 指标 | 基线 → 最终候选 | 解释 |
| --- | --- | --- |
| 五进程 p95 中位数 | 33.00930 → 11.26952 ms | 约下降 65.9%，基线跨进程 p95 带约 2.43%，候选约 3.96% |
| HeapProfiler 分配/更新 | 29,277,515.41 → 16,321,351.84 bytes | 三个独立进程中位数，4096-byte 采样并包括已回收对象；约下降 44.3% |
| 150 更新的字素分割 | 445988 次 / 20515448 字符 → 0 / 0 | 此表格 ASCII 内容与框线的确定性计数 |
| 同窗口重解析字符 / 重建表格行 | 10389675 / 222075 → 相同 | 解析/行重建未减少；inline 调用两侧均为 1777501 |
| 增量缓存最终 source / token / 行数 | 72915 / 1 / 3113 → 相同 | 缓存边界没有扩大 |

最终满速计时窗口的观测峰值堆中位数为 128.73 → 178.23 MB，受控 GC 后为 26.580 → 26.611 MB。固定 60 ms 更新节奏、五轮同样输入的观测峰值中位数为 57.28 → 61.77 MB（约 +7.9%），受控 GC 后为 16.185 → 16.136 MB；18 个登记数组引用在两侧均归零。第一版也曾观察到满速峰值上升，固定节奏后两侧接近。这支持分配/GC 节奏影响瞬时堆的解释，但没有证明真实最大堆下降或长期零泄漏。峰值是在更新/批次边界取样的最大观测值，不能冒充渲染内部每一时刻的真实峰值。

堆数值包含 benchmark 自身输入、主题和模块。满速夹具预先保留 150 个输入快照，固定节奏夹具只保留基底及当前输入，不能横跨这两种夹具比较绝对堆量。释放结论限于登记的组件输出/token/增量数组；共享宽度 FIFO 仍按既有生命周期保留最近键。

第一版负对照补测：两组 16/64/256 KiB/超容量 × table/code/code-single/plain 共 64 个进程，没有连续两组超过 `max(5%, 基线带)` 的回退。16 KiB 纯文本初始 p95 带为 44.67%，50 更新批次的预热复核仍有波动；改为 10000 更新预热、30 × 1000 更新的双方一致窗口后，基线带约 6.45%，p95 中位数 0.05447 → 0.05729 ms，64 KiB 基本持平。GC 记录显示该差异不能全部归因于 GC，因此没有直接接受第一版，而是移除普通 ANSI 分支之前的框线比较并重新测量。16 KiB 代码的补测保留全部尾部慢点，不能将小窗口不稳定性写成高亮加速。

最终再次运行完整 64 进程矩阵：表格四种规模均改善，基线 p95 带 0.26%–3.60%；代码、多行/单行和超容量纯文本均没有连续两组超门限回退。16 KiB 代码的短窗口基线带为 12.00%，只保留为不稳定诊断，不声明该场景绝对时延稳定或高亮提速。

短纯文本必须单独说明：最终 16 KiB 的原始短窗口两组分别出现 +47.08%/+20.47%，不能将其删除后宣布全部窗口通过。最终候选修改前的 `revision-protocol.json` 已固定使用长窗口验收普通纯文本；五进程的 16/64 KiB p95 中位数分别为 0.056562 → 0.056515 ms（−0.08%）和 0.160995 → 0.162578 ms（+0.98%），基线带 5.87%/3.07%，均在原门限内。补充结构计数两侧均为 14112 次 `visibleWidth`、0 次改动辅助分支；将两侧都用相同 loader 并改为实际生产的无计数器配置，短窗口中位差约 +7.57%，低于其 9.93% 基线带；预热和测量都开启计数器时方向相反且基线带为 17.49%。这些证据说明短瞬态窗口不足以作稳定归因；未观测到确定的 JIT/deoptimization 根因，不将该假设写成事实。短瞬态稳定性仍不作保证，不用它宣称提速；正式稳态门限没有放宽。

## 生产链复核

将同一 64 KiB 增长表格输入既有真实叶组件 benchmark：实际 AgentSession emit、InteractiveMode handler、AssistantMessageComponent、Markdown、viewport 和 frame queue 均参与，100 个计时更新的采样分配为 30.30 → 17.49 MB/更新。该 profiler 窗口只有一个 100 更新计时批次，不据此另报独立 p95 收益。组件 slot/Markdown/Spacer/Text 新建计数均为零；随后 100 个原始观察事件合并为 1 次交付，实际 snapshot/session bridge/handler 路径均参与。夹具没有构造完整 runtime，也不是原生终端。

5 千条历史的 paced plain/thinking 检测分别交付 300 次；普通文本的完成历史项重绘为 0，built-in listener Promise 为 0，调度 callback identity 为 1，最终待调度任务为 0。2 万帧 queue 检测的帧 Promise/AbortController/wrapper/full copy 均为 0，flush 后 active/pending 帧和字节均为 0。下游 UI 的 32 轮、512 个组件测试中，登记组件、发现、source、registration 和 Box 缓存 WeakRef 全为 0，停止后 attached/pending 全为 0；堆斜率约 +1243 bytes/cycle、末八轮约 +163 bytes/cycle，保留这些短期正值，不声称零泄漏。源审计的数组/字符串构造站点数保持原值，宽度链没有新增构造站点。

## 正确性与验收边界

121 项首轮定向测试通过：16/64/256 KiB、超容量表格/多行及单行代码；增长列宽、引用定义变化、部分/闭合围栏、嵌套列表、LaTeX、CJK/emoji/组合字符、ANSI、重复空格、thinking 样式、transform、宽度/主题和非追加替换；每个输入增量与完整 renderer 逐次比较。所有 128 个框线字符及邻接 Unicode/ANSI 边界另与完整字素 oracle 对照，1200 个不同样式框线行零 Segmenter 调用。首轮新增计数测试曾将固定列数误写多一列，修正夹具期望后通过，生产实现不因该失败调整。

两版候选均已通过 typecheck、离线构建、442 个全套执行单元、生产事件链/帧队列及下游 UI 检测。最终离线构建为 12/12 包、7329 ms、并发峰值 2；全部本地进程已退出，只有两个已解释并修正的夹具断言失败。纯文本稳态夹具首版错误地把缩短后的首个重建算成普通追加，实际 6371 次增量而非 6500；现已将检查点恢复移到计时区外，逐批断言每个计时更新都增量执行，失败日志保留。

正式证据先保存，任务根 `D:\RMProjects\Pi\.task-tmp\pf03-markdown-f9562c5aba` 保留至 PR 审查/六 CI/合并完成后精确清理。首次推送单独 `@codex review`，后续每次新增推送重新触发；合并前核对当前 head/base、审查和所有检查，合并后核对树一致性、同步 main、删除两端旧分支。原生终端持续输入、缩放、选择和慢写体验继续 PF08；本项不代表整轮性能验收完成。
