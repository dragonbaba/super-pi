# PF06 同次前缀构建去重验证

日期：2026-11-05。基线 `3d2ea7088d3f0b956f68eb818ded165515dbb3ba`；分支 `codex/perf-pf06-prefix-dedup`。实现与本地验收完成，进入独立 PR 的审查/六 CI 门禁，尚未合并。原始计数、采样、失败、源码/构建摘要与复现驱动见 [PF06 证据](../evidence/performance-pf06-prefix-dedup-2026-11-05.json)。遵循[总方案](../super-pi-performance-followup-plan.md)、[PF00 比较协议](pf00-baseline-validation.md)与[热路径分配契约](hot-path-allocation-contract.md)。

## 证据与最小改动

同一次 intent manifest 构建将完全相同的 contextEntries canonical 摘要算了两遍，分别用于 effectivePrefixHash 的输入和返回 manifest 字段；prompt/context 已经完成换行规范化，hashText 又重复规范化。含两项 context 的基线诊断得到 4 次 canonical 内容访问、6 次 EOL 规范化；effective 构建为 2 次访问、5 次规范化。基线回归测试按一次遍历要求失败（4 ≠ 2）。1 MiB intent 初始采样约 11.21 MB/构建，主要站点为 replace 和 updateCanonicalHash。

实现只复用本次构建的 persistentContextHash，并让已经规范化的 prompt/context 直接进入 hashNormalizedText。cache key 和动态指令仍通过原有 hashText 规范化。EOL 正则提升为模块私有常量，同步 String.replace 使用全局表达式的既有重置语义；没有新增动态正则、闭包、Promise、controller 或池。文本规则仍仅规范化 CRLF/CR，未对正文新增 NFC 或 trim；工具名/逻辑路径仍按既有规则处理。

没有跨请求或跨 effective dispatch 的摘要缓存：工具 schema、context 允许原地修改，现有对象身份不是可靠版本。每次实际派发仍重新读取其当前输入，不用 intent 代替有效请求。此决策避免添加额外 owner、逐出策略及长寿命正文；跨请求复用假设在本阶段排除。

## 完整调用链和保留边界

资源/工具/扩展状态 → SDK manifestInput 数组 → PrefixRequestObservation intent → buildPrefixManifest 的规范化/摘要/metadata → provider 有效派发回调 → 新 effective manifest/差异比较 → result/error/abort/supersede/dispose 释放。既有 SDK 资源/工具 map、manifest 的 toolOrder/contextEntries/requestTransforms、Map/Set、规范序列化字符串、比较器闭包与诊断数组仍属于整链成本。本项减少重复摘要和规范化，不宣称整链零分配；有效派发和结果 observer 的生命周期沿用 PF04-B。

源码审计仍见 buildPrefixManifest 内 5 个既有 arrow 站点、17 个对象字面量站点和 4 个数组字面量站点（含互斥分支，不是每次分配计数）；canonicalizeLogicalPath 仍有既有 normalize 闭包，显式序列化仍有 mapper。它们在请求诊断构建/比较中执行，不进入 provider delta/frame 处理；本项没有新增这些站点或把它们伪记成零。新 helper/normalize 源码不含 arrow/function expression、Promise/controller、临时数组/对象或每次调用的 regex literal，AST 测试约束这些边界。

新增复用仅为一个当前调用内的 digest 字符串，本来就由返回 manifest 持有。临时规范化文本、contextEntries 和 schema 在本次构建返回或异常后不增加任何 owner；WeakMap metadata 仍只保存标识、哈希和计数。无全局正文 memoization，无额外完整 provider payload 序列化。受控 GC 将分别验证 input、schema、context entry/array、session 和完成响应的释放。

## 测量结果

每侧五个独立进程交替执行，10 预热/30 正式批次，GC 在预热前且预热批次间让出事件循环；allocation 为另三个独立进程、4096 字节采样间隔并包含已回收对象。大小表示合成持久 context 总量，system prompt 同样约为该大小；八份 context 使用相同合成正文，不把结果当真实用户的命中率。下表为各进程批次平均操作 p95 的中位数，而非单次真实请求 p95。

| 构建场景 | 基线 → 候选 p95（ms/构建） | 变化 | 基线 → 候选采样字节/构建 |
| --- | --- | --- | --- |
| 无 context 的 intent 对照 | 0.0285674 → 0.0282040 | −1.27% | 26619.6 → 25730.9 |
| 128 KiB intent | 0.741585 → 0.527827 | −28.82% | 1458709 → 1197125（−17.93%） |
| 1 MiB intent | 6.228145 → 4.541600 | −27.08% | 11223063 → 9261974（−17.47%） |
| 128 KiB effective 长窗口对照 | 0.427282 → 0.402698 | −5.75% | 940045.6 → 938310.5 |
| 1 MiB effective 对照 | 3.586295 → 3.508865 | −2.16% | 7310753 → 7320801（+0.14%） |

128 KiB/1 MiB intent 的基线带分别 4.19%/2.08%，候选带 1.28%/2.61%，五组都有超噪声改善。初始 128 KiB effective 基线带 13.63%，保留为不稳定窗口；双方仅把该对照扩为每批 500 次、仍为 10 预热/30 正式批次，五组基线/候选带收敛为 2.71%/1.91%，每组变化 −4.97% 至 −6.23%。其他非目标对照没有两组超过原门槛的回退；没有用早期宽波动带放宽验收。全部采样 manifest 摘要与基线一致。

通过 19 组逐字节基线对照：EOL、Unicode、逻辑路径、sibling 顺序、语义工具/precedence/transform 顺序、同一对象 schema/context 变更、cache key/dynamic/compaction、effective 重复观察及 transport fallback；accessor 拒绝且不执行 getter。三个独立生命周期进程、每种结束六轮跨事件循环 GC，在 complete/error/abort/supersede/dispose 后 input、schema、context entry/array、session 的旧引用和 abort listener 均为 0。live stream 的结果 Promise 原本持有完成响应；释放 stream 后该响应弱引用也为 0，不把原有正常所有权误记为泄漏。

## 验证进度与交付

41 项定向测试通过，包含既有 manifest/determinism/生产 assembly/diagnostics/request attribution，以及新增单遍计数、原地修改和 source invariant。第一次类型检查发现新增诊断测试的可选编码与 this 注解问题；修正后通过，失败日志保留。prefix/effective-dispatch smoke、生产 event-chain/frame-queue 门禁通过。本地 `npm run build:offline` 构建 12/12 包，7496 ms，并发峰值 2。全量 449 个测试单元均退出 0。

任务根 `.task-tmp/pf06-prefix-0f9b0452a1`，子进程 TMP/TEMP/TMPDIR 与 HOME/config 隔离。review/六 CI 与合并清理回执待当前 PR 验收。PF05 孤立纳秒计时 V 继续保留到 PF08，未改写为通过。
