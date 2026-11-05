# PF04-B 有效请求与响应归因验证

日期：2026-11-05。基线 `8668da9def5a41fa701cce159b718462580ba9ec`，分支 `codex/perf-pf04-dispatch`。本地验收通过，准备独立 PR；当前 head reviewer 与六分片 CI 完成后才能合并。沿用[总方案](../super-pi-performance-followup-plan.md)、[PF00 门禁](pf00-baseline-validation.md)和[分配契约](hot-path-allocation-contract.md)。[原始证据](../evidence/performance-pf04-request-attribution-2026-11-05.json)包含复现、正式样本、分配站点、生命周期、失败记录及复现驱动。

## 已复现问题和选择

在未修改生产源码的基线上，通过真实 `createAgentSession` 装配及离线 transport 复现三项断言失败：旧请求延迟的 effective-dispatch 覆盖新请求结果；同一次请求重复报告相同派发时抹去与前一请求的漂移；辅助 summarization 替换主响应诊断。不能再用一个不断覆盖的 latest manifest 代表任意响应。

每个主请求增加一个具有原型方法的生命周期对象，由 recorder 保存一个活动槽。它捕获 owner、递增请求序号、context/credential generation，重复派发始终与前一成功完成主请求比较。终态观察在 EventStream 的 timing 最终化之后、结果 Promise resolve 和终态事件交付之前同步执行，因此绑定的是实际返回的响应身份，包括不可变 provider 响应的既有 envelope 副本及同步完成流。

`session.getPrefixObservation(message)` 只查询当前 live owner 最近一个完成响应的弱身份，返回摘要和 comparisonState。复制、恢复的历史、没有派发观察、错误、取消、替代、scope 改变或 dispose 都返回未知；不会凭 requestSequence、时间或长度猜测身份。普通追加不改变 context generation；branch/reset、compaction、branch_summary、new session、成功重载和可能部分修改状态的失败重载使旧 scope 失效。失败持久化回滚不推进 generation。新 owner 开始后释放旧 owner 不会清除新请求。

辅助 summarization 保留原有预算派发通知及调用方观察器，只隔离主请求前缀记录。配置 intent 与 provider 实际观察仍分离；没有新增跨请求正文缓存或持久化关联数据。现有公开 recorder 的手动 `record`/`recordIntent` 入口保留兼容，调用方不得把手动构造的摘要当作生产身份凭据。

## 调用链、分配与释放

审计 SDK manifestInput → request observation → ModelRuntime lazy stream → provider transformed payload/transport → effective callback → EventStream 终态 → Agent processEvents → EventDelivery critical lane → AgentSession message_end。critical lane 保留终态响应身份；latest coalesced observer 的 clone/freeze 语义没有改动。Codex SSE 和 WebSocket 在成功派发 commitment 后、终态前交付观察，自动回退的现有承诺仍适用。真实 Codex SSE 离线夹具通过 SDK 核对 inclusive input 15、cacheRead 10 的归一化响应与对应 manifest；其余 provider/retention/transform 回归使用现有测试。

新增成本限定在请求/完成边界：一个 request owner、可选 abort listener options、成功响应一个 WeakRef 与一份冻结标量/摘要记录。SDK 原有的派发及 header transform 闭包、manifestInput 的工具/资源数组和 hash 处理仍存在，PF06 再处理已证实的重复计算。EventStream 增加两个固定字段；settledResult 与现有 result Promise 共享响应引用，不复制正文。delta 路径不执行观察器、不新增闭包、Promise、controller、包装对象或正则。只有外部终态观察器实际返回 Promise 时使用稳定 rejection handler，这属于明确的低频 hook 边界。

recorder 最多保留当前 intent/effective manifest、前一完成请求比较摘要以及一个完成记录；开始下一请求清除上次响应身份。completion、error、abort、supersede、dispose 清除新 request owner 的 input/session/signal/recorder 引用并移除 abort listener。三进程、每个五种结局、每步六次跨事件循环 GC：释放后 input/session/message WeakRef 与 listener 均为 0；控制组在活动请求和活流 result Promise 存活时能看到引用，证明探针确实有 owner。旧 SDK 回调若被第三方保留仍拥有其原有闭包作用域，本记录不将其宣称为已全部释放。

## 性能门禁

Windows、Node 26.13.0，同机五进程/侧交替运行；每场景 10 批预热、30 批正式样本。基线 loader 以原始模块 URL 加载五份基线源码，保留相对依赖解析；摘要记录在证据中。表中为**批次平均每操作耗时的 p95，再取进程中位数**，不是网络/TUI 端到端延迟。

| 场景与批量 | 基线 ms/操作 | 候选 ms/操作 | 变化 | 基线/候选 p95 带 |
| --- | ---: | ---: | ---: | ---: |
| 流入队/取出，无终态观察，1m delta | 0.000011400 | 0.000011471 | +0.62% | 9.84% / 8.15% |
| 同上，候选挂起一个终态观察器，1m delta | 0.000011502 | 0.000011205 | -2.59% | 4.45% / 9.27% |
| in-memory 普通追加，10k append | 0.00111942 | 0.00112555 | +0.55% | 4.20% / 5.43% |
| SDK 完整离线请求观测，200 request | 0.0831540 | 0.0840985 | +1.14% | 3.18% / 5.12% |

独立三进程/侧 HeapProfiler、4096-byte 采样、包含已回收对象：append 中位数 1005.33→1009.21 bytes/操作（+0.39%）；请求 40617.02→41524.69（+2.23%，约 +908 bytes/请求）。流批次采样接近采样底噪，不用极小分母的百分比宣称优化。没有触发 `max(5%, 基线 p95 带)` 的非目标回退门禁。本项交付归因正确性，不宣称吞吐优化。

AST 门禁覆盖 request owner 无 arrow/function expression/Promise/controller/regex，终态通知只能位于 complete 分支，外部 async tail 必须有实际 Promise guard，recorder 只有一个 WeakRef 构造点且无响应集合。既有 session-append smoke 在 0/1k/10k 历史上每 16 次追加为 0 history reads、16 stringify/write、0 active fd；失败/clear 引用释放通过。生产事件桥及 terminal queue 分配门禁另存原始输出；UI leaf 为 stub，队列输入为预建帧，不能当作完整 UI 性能。

## 验证、限制与交付

22 项针对请求边界、真实 Codex SSE、终态观察、生产装配与 AST 的最终定向测试通过；此前 58 项前缀/provider/缓存键矩阵通过。`npm run check` 通过；`npm run build:offline` 12/12 包成功，7759 ms、峰值并行 2。完整互斥测试分区全部通过：unit 399、hot 21、contract 26，共 446 个执行单元退出 0；三个分区覆盖同一全量 discovery，没有重复以增加通过计数。队列 20k 帧的 Promise/controller/wrapper/full-size copy 均为 0，flush 后 active/pending 为 0，受控 GC heap delta +259384 bytes 如实保留。

失败完整保留：三项基线复现；第一版用了 Node strip 模式不支持的构造器参数属性，改为显式字段；旧生产装配夹具跨已 dispose session 共用 recorder 的比较断言失效，改为明确比较两份已捕获的生产摘要，同时断言 live owner 不跨 session；一次测试变量被 TypeScript assert 收窄为 never，改用真实 result 返回值核对 timing。没有削弱生产断言、扩大超时或删除失败证据。

任务根 `.task-tmp/pf04-dispatch-a46e89d3cb`。直接子进程环境在启动前隔离 TMP/TEMP/TMPDIR、HOME/config/session，子进程内验证 tmpdir；原有 test runner 继续拥有并等待后代进程。记录直接 PID 和退出回执，不声称逐个后代 PID 插桩。归档后才按精确清单校验路径、链接边界及身份清理；完成状态由 PR 回执与后续阶段更新。

这是离线请求身份和本地边界验收，未访问真实账号或测量云端命中率/费用。观察次数不是物理 HTTP 重试次数；credential generation 不能识别自定义 auth header 或 OAuth 刷新背后的账号变化；configured retention 不代替服务端策略。无法识别的历史响应、服务端 cache cause、真实账号隔离和云端费用保持未知。PF04-A 的长度上限、CH% 和累计 token 比例未改成因果结论；PF05 再处理历史扫描成本。
