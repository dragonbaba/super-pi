# PF05 增量统计验证

日期：2026-11-05。基线 `8cc7ffcf6656848cc1d14c42ce7cfc3302d33c37`。[PR #223](https://github.com/dragonbaba/super-pi/pull/223) 已合并为 `3d2ea7088d3f0b956f68eb818ded165515dbb3ba`；审查 head `8e5af249ac58da9d3904d8499c942a491625b073` 无发现，CI `41970416768` 六项全部通过。审查/合并树均为 `742d4e5177c2b411ac5ee873cd58904b40e3a750`。完整原始样本、失败、源码/构建摘要及复现驱动见 [PF05 证据](../evidence/performance-pf05-incremental-stats-2026-11-05.json)。遵循[总方案](../super-pi-performance-followup-plan.md)、[PF00 门禁](pf00-baseline-validation.md)及[分配契约](hot-path-allocation-contract.md)。

## 复现、语义和调用链

基线通过实际 InteractiveMode/ Footer 方法复现三项失败：普通追加后页脚仍复制全部历史；可选提示每轮 getEntries/scan 创建随后丢弃的完整 Map；重复同一完成响应在持久化前后产生重复估计。提示默认关闭，不将此可选成本写成每个用户都会承担。

生产链为 provider 终态 → AgentSession message_end（持久化前）→ InteractiveMode 可选估计 → SessionManager 持久化追加，以及 UI 帧 → Footer getSessionScan → usage/name/CH 显示。SessionManager 提供只读、同步的 append cursor/visitor：位置对应物理文件项，跳过所有 header；显式记录历史 generation。加载器原本允许重复 header 和 id，不能把 entryCount+1 当作物理位置。公开 getEntries 仍返回隔离数组，未暴露内部数组或改变文件格式。

可选 CacheOverlapCursor 在第一次启用或 context generation 改变时以活动 getBranch 重建前态；普通追加只读取游标后的项。preview 不预先提交当前消息，只保留一个弱身份来抑制重复完成；已经持久化的当前响应不会与自己比较。分支、reset、compaction/branch_summary、reload/new session 的行为与完整活动分支扫描逐步对照。失败 append 回滚不推进游标；失败重载可能留有部分旧索引，history generation 失效，状态不一致时估计返回未知。

Footer 的语义仍为**全部会话**累计用量和最后一个 session name/assistant CH，不跟随活动分支丢弃历史费用。每次 append 增量累加；branch 导航不重算相同全会话统计；换 manager/重新加载时重建。最新空名称、toolResult/summary/compaction usage、相同 count/id 的重载和重复 id/header 均保留。`/session` 的完整汇总、usage breakdown 及 explicit transcript rebuild 保留所需全量扫描；活动 transcript 的估计使用活动 branch，不能借用另一分支最后追加的响应。

本项没有把整段 Footer render 宣称为 O(1)：既有 getContextUsage 仍有独立 branch 读取。也没有把长度上限改成实际相同内容、缓存资格、账号或费用证明。

## 生命周期和分配边界

普通 tail visitor 是稳定原型方法，无新闭包、Promise、controller、iterator-result、数组或包装对象。Footer 的 totals/state 对象仅在 owner/reload 失效时创建；每个 enabled completion 可创建一个 weak identity、一个长度估计和所需 persisted previous scalar 记录。没有对象池、历史消息 Map 或无界 memoization。

提示关闭路径保留原有直接返回；实际 UI 设置变更、runtime settings reload、session invalidation 与 stop 清除 cursor。直接程序化修改 SettingsManager 且不触发 UI/rebind 通知时，已有 bounded cursor 可保留至再次启用/rebind/stop；它只持有 mode 本已拥有的当前 manager、前轮标量和弱响应身份，不额外保留历史副本或响应正文。完整扫描函数继续作为重建入口和正确性 oracle。

1k/10k/50k 初始历史下，新增 3 项后提示和页脚各访问 3 项，历史复制和 branch rebuild 都为 0；disabled 无 cursor/扫描。AST 检查约束 visitor 无热路径分配，Footer state 构造必须受 owner/generation guard 保护，notice 全分支读取必须在 rebuild guard 内。

## 性能测量与失败记录

首次五组对照的 disabled 微路径 +13.56% 超过 5% 门禁；无条件清理改成条件清理后仍 +13.49%，均保留为未通过尝试。最终把清理放回实际设置/rebind/stop 边界，并将 enabled 工作放入原型 helper，关闭路径保持原来的 getter 和直接返回。原小对象夹具还在预热后替换 getter 函数，与真实构造对象不同，因此补充真实 InteractiveMode/SettingsManager 对照。V8 inlining trace 证实两侧都内联，排除“完全没有内联”的未经证实解释。

真实对象的 100 万调用短批次中，部分正式窗口出现两次约 2.5–2.8 ns/次的尖峰，随后从约 1.64 ns/次变为约 1.37 ns/次；增加预热后，基线也出现同类过渡。优化器 trace 显示 Maglev/TurboFan/OSR 切换，但原生 stdout 与 JS stderr 混排，不能仅凭标记声称准确的编译先后。仅延长预热未稳定测量，保留为未通过窗口。双方改用每批 1 亿调用、10 预热/30 正式批次，避免约 1.4 ms 的短批次被固定编译/调度开销主导；生产源码未再改动。纳秒级绝对耗时不作为产品提速承诺。

最终表格按 PF00 的**最大相对中位数偏差**计算基线波动带。早期控制台错误使用了最大值减最小值除以中位数，证据保留原始样本并按正确公式重新计算；没有采用较宽的旧数值放宽门槛。名为 `accepted-*` 的早期日志是历史标签，其中有失败样本，不能据名称视作已验收。

性能夹具固定每侧五个进程、10 预热/30 正式批次，独立三进程 allocation sampling（4096 字节间隔，含已回收分配）；所有早期样本保留。GC 在预热前，逐预热批次让出事件循环。notice 测固定历史上的不同 pre-persistence preview，另以确定性计数证明真实 append tail；footer 测实际追加+usage refresh，每批 10 次，正式阶段历史从初始+100 到初始+400。负对照含 disabled、steady footer usage、普通 append。结果是各进程批次平均操作 p95 的中位数，不是单次调用、网络或原生终端延迟。

| 场景 | 基线 → 候选 p95（ms/操作） | 基线 → 候选采样字节/操作 |
| --- | --- | --- |
| notice，1k 历史 | 0.03031 → 0.0000753 | 182397 → 64.6 |
| notice，10k 历史 | 0.43654 → 0.000137 | 2113692 → 109.0 |
| notice，50k 历史 | 3.13789 → 0.000180 | 9681333 → 154.7 |
| append + footer usage，1k 历史 | 0.01623 → 0.00124 | 29599.9 → 946.3 |
| append + footer usage，10k 历史 | 0.12321 → 0.00192 | 358864.3 → 907.0 |
| append + footer usage，50k 历史 | 0.70203 → 0.00137 | 1217313.5 → 861.5 |

计时各对照均明显改善，部分 footer 基线/候选或极短 notice 候选的跨进程带仍超过 10%，因此表格是观测值，不宣称稳定绝对延迟。验收依赖规模无关的访问计数及三个独立分配窗口的共同改善。基线主要分配来自 scan/Map.set/filter；候选 notice 为一个 WeakRef 和长度估计，footer 的主要采样来自夹具真实 append 的 UUID/entry。采样范围包含断言和 inspector 固定开销，不能把小样本近零值解释为精确零字节。普通 append 的 p95 +1.59%、采样分配 +0.30%，均在 5% 内；没有把更新统计的成本转嫁到 append。

真实 UI 的 1 亿调用长批次仍未稳定：default-off 基线带 44.54%、候选带 54.74%，不能用中位数 −0.18% 或较宽门槛宣称通过。该孤立纳秒路径计时保留 V；其 getter/立即返回结构和无扫描/无 cursor 的确定性检查通过。补充实际构造 mode 的 `message_end` 消费者对照（每次创建正常 assistant 组件并执行真实完成 handler；20 预热/30 正式批次，每批 2 万次，五组交替进程）：基线/候选 p95 中位数 0.00048558/0.00047735 ms，变化 −1.69%；基线带 9.22%、候选带 5.25%。一组配对 +9.97%，其余为 −4.61%、−1.49%、−6.86%、+2.50%，没有两组超过预定门槛的回退。该测量包含组件完成和状态清理，renderer 未启动、没有持久化或原生帧输出；不将它替换为端到端请求延迟，也不掩盖孤立微基准的未稳定结果。PF08 保留该计时限制，并复核组合场景。

## 正确性、生命周期与交付

基线最小复现的三项失败、第一轮六项旧 source/copy 计数不匹配、失败 reload 比较到旧索引的实际缺陷均保存在证据中。旧计数改为更严格的实际尾部访问/零复制断言；reload 缺陷通过一致性状态及 generation 失效修复，没有降低语义断言。最终 48 项定向测试、typecheck、append/event-chain/frame-queue 门禁通过；完整测试 runner 的 448 个单元均退出 0。本地 `npm run build:offline` 构建 12/12 包，7384 ms，并发峰值 2。

三个独立生命周期进程各执行六轮跨事件循环 GC：clear/manager replacement/new session 后旧响应引用为 0，最终 clear 后旧 manager 为 0；Footer dispose 后新增 scan 引用为 0；实际构造 InteractiveMode 的 stop 清除 cursor 及其 manager/latest 槽。当前 manager 在 cursor 活跃期间有意保留，Footer 原本的 session owner 也不会因为清除派生统计而消失；不将这两项正常 ownership 误记为泄漏。

任务根 `.task-tmp/pf05-stats-359ee56d86`，仅 PowerShell 7；子进程环境和 PID/退出状态由任务 runner 记录。合并后已同步 main，删除远端/本地 `codex/perf-pf05-incremental-stats`；核验 141 个直接子进程 settled 和 480 个资源身份/链接边界后清理任务根（339 个直接子项，cleanup PID 15148）。共享 `.task-tmp` 与 dist 保留，详见[收尾回执](https://github.com/dragonbaba/super-pi/pull/223#issuecomment-6650147919)。
