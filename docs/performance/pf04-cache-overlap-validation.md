# PF04-A 缓存统计口径验证

日期：2026-11-05。基线 `f1b4963d42489c6e1a59a742425f13aa5aa7b56a`，分支 `codex/perf-pf04-cache-attribution`。状态：最终本地验收通过，准备独立 PR；当前 head reviewer 无未处理发现且六分片 CI 全通过后才允许合并。遵循[总方案](../super-pi-performance-followup-plan.md)、[PF00 门禁](pf00-baseline-validation.md)和 [Hot-path allocation contract](hot-path-allocation-contract.md)。PF04 拆为两个顺序 PR：A 修正统计/界面断言；B 核对有效派发与响应身份、retry/reconnect/账号和历史边界。B 结束后才进入 PF05 增量统计。复现代码、所有正式样本、失败和进程退出记录见 [PF04-A 证据](../evidence/performance-pf04-cache-overlap-2026-11-05.json)。

## 复现与语义

旧实现把前后轮长度当作相同内容，把未知 cache-read 价格替换为 0，40,000 token 的合成例子由此报告 `$0.04`“重新计费”；切换到未报告缓存的新 provider 或使用 error 响应也会产生相同结果。时间差超过通用 5 分钟阈值时，提示还暗示缓存失效原因。上述反例先在未修改基线复现。

现只输出 `uncachedOverlapUpperBound`：`min(前轮归一化 prompt tokens, 本轮 input + cacheWrite)`。缓存读可能属于新增内容，因此不能先对两个长度取较小值再扣除所有缓存读。上限不能证明实际重复内容、可缓存性、账号范围、retention、失效原因或可避免费用。金额和 TTL 推断删除；阈值 1024 是显示门槛，非跨 provider 的断点承诺。

前轮必须来自同一 provider/model/API 段；失败/取消、未知零用量、非法非有限或负 token、compaction/branch_summary 会重置比较。当前轮或同一连续段有过 cacheRead/cacheWrite 才显示估计；未报告缓存不被称为确定未命中。完整历史仍按已有追加顺序扫描，活动分支和请求身份的精细关联继续 PF04-B/PF05，不能用此上限证明分支间内容复用。

设置仍兼容 `showCacheMissNotices`，默认关闭；界面名称变为 **Cache overlap estimates**。启用后，至少 20,000 token 的上限显示为 “up to …; repeated content and cache cause unknown”。`/session` 将上限放在 token 区，移除 “Cache Re-billed” 金额；provider 报告的总用量/现有费用未改动。页脚 CH% 仍是最近一轮报告的 cacheRead/归一化 prompt tokens；累计比例按 token 加权。两个各占一次请求的 100%/0% 样本，长度 10k/90k，累计是 10%，不是 50%。

## 生产调用链与所有权

核对 provider API usage：OpenAI Chat 从 inclusive prompt 扣除 cacheRead/cacheWrite；Google 从 promptTokenCount 扣除 cachedContentTokenCount；Anthropic 的 input/cacheRead/cacheWrite 为分桶字段。Responses 及相关协议回归沿用现有入口，未改 provider 协议或价格。

核对 Agent 事件 → AgentSession `_handleAgentEvent`/`_emit` → InteractiveMode message_end → 可选 notice → `getEntries`/scan → Text/Spacer → retained transcript/render/terminal；message_end 在 SessionManager 持久化前通知 UI。恢复路径 `renderSessionEntries/renderSessionItems` 通过同一响应对象查估计，`/session` 使用同一扫描语义，footer 使用独立现有版本缓存。

本次不新增 provider-delta/event/frame 闭包、正则、Promise、AbortController、池或缓存。scan 仍有每次一个 Map/totals/返回对象、每条有效消息一个 previous 记录及可选 estimate；删除 modelKey 拼接和价格计算，保留原有 O(n) 扫描和 getEntries 引用复制，PF05 处理这些成本。Map 仅在调用者重建时持有消息，返回后不存入全局/实例；默认关闭提示时不扫描，恢复路径也不再创建空 Map。通知的 Text/Spacer 与字符串仍由 transcript 持有至 clear/dispose，不声称完整调用链零分配。

## 验收记录

同机 Node 26.13.0，每侧每规模五个进程；每进程 10 个预热批次、30 个正式批次，每批累计访问约一百万条记录（1k/10k/50k 各为 1000/100/20 次扫描）。表中是每个进程的**批次平均扫描耗时 p95**再取中位数，不是单次完成事件或 TUI 端到端 p95。每轮均有 20k input + 20k cacheRead，旧/新两侧都会产生估计。

| 历史条目 | 基线 ms | 候选 ms | 变化 | 基线/候选进程间 p95 带 |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 0.17204 | 0.02256 | -86.9% | 4.43% / 6.74% |
| 10,000 | 1.82217 | 0.37029 | -79.7% | 9.51% / 4.21% |
| 50,000 | 10.03066 | 2.54968 | -74.6% | 5.21% / 11.74% |

所有配对窗口降低，但 50k 候选绝对耗时稳定性尚未证明，不能把 2.55 ms 当作延迟保证。此次是删除错误计算带来的扫描微基准变化，不代替 PF05 的规模无关目标。三进程/侧、4096-byte HeapProfiler 采样独立于计时（含已回收对象），50k 扫描分配中位数 **18,879,928 → 8,481,541 bytes/scan（-55.1%）**。源码计数仍为每次一个 transient Map；100 条夹具两侧均有 399 次 entry.message 读取，证明未隐藏扫描。36 个测量进程各检查 1000-entry array、一个 message 和返回 Map，108 个注册 WeakRef 在跨事件循环受控 GC 后均为 0；这不代表任意 transcript owner 都无泄漏。

新增核心 AST 断言：无 arrow/function expression/regex，只有一个 Map 构造位置与四个对象字面量位置。原生产 UI 审计记录关闭提示时移除空 Map，ownership Map 位置 **9→8**、rebuild caller **3→2**，精确下调断言而非放宽上限。普通 message/tool update 生产事件桥基准各 100k 更新，Promise/闭包/包装对象计数为 0；其 UI leaf 是 stub，不能当作完整 TUI 吞吐。队列基准 20k prebuilt frames，Promise/AbortController/wrapper/full-size copies 为 0，flush 后 active/pending 帧和字节为 0；受控 GC heap delta +252,608 bytes 如实保留，未宣称 heap 零增长。

130 项定向协议/前缀/页脚/统计测试通过；补入恢复入口后，核心/UI 结构审计 30 项通过。`npm run check` 通过，`npm run build:offline` 完成 12/12 包（7,422 ms，峰值并行 2）；最终 `npm test -- --keep-going` **443/443 单元退出 0**。构建后仅同步测试断言和文档，生产源码摘要保存在证据中。

保留三项失败：最初 UI 夹具误向 getter-only settingsManager 赋值；随后误预期 `90.0k` 而实际格式为 `90k`；首次完整运行 442/443 通过，旧 Map 位置断言失败。前两项只修夹具，第三项核对删除位置后更新精确计数，定向及完整套件重跑通过，未删断言或放宽超时。

任务根为 `.task-tmp/pf04-cache-6d02767093`，归档前 48 个直接子进程全部 settled，随后归档进程也退出。子测试由现有 runner 在任务根下建立自己的临时目录、拥有子进程句柄并等待 close；证据记录直接 PID 和环境/退出回执，不声称每个后代 PID 均已单独插桩。合并后再按最新资源清单验证边界和身份清理，回执写入 PR，后续阶段更新此状态。

未进行在线 provider 请求，真实命中率/费用改善保持外部待验证；有效派发与相应响应的关联继续 PF04-B，未将当前 latest manifest 错当作每条历史消息的因果证据。
