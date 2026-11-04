# H05 — Anthropic 非 strict 工具根定义

状态：[PR #204](https://github.com/dragonbaba/super-pi/pull/204) 已合并，分支 `codex/h05-anthropic-schema-definitions` 两端已删除。基线为 H04 merge `796bfe62b92ea73f4e5d8a7e2d62a26448853be3`。任务根 `D:\RMProjects\Pi\.task-tmp\h05-89535dc97a48`，Node v26.13.0；子进程启动前设置并验证 TMP/TEMP/TMPDIR，资源和进程登记 resources.json。

## 根因、边界与调用链

已阅读完整 hot-path allocation contract。工具声明由 AgentSession/SDK context.tools 进入 Anthropic buildParams，经过 capability authority、历史转换与工具放置，再由 convertTools → strict 决策 → SDK JSON 编码/fetch → SSE parser → done/error/abort。非 strict 的 getJsonSchemaToolParameters 直接返回原 schema；convertTools 只重建 type/properties/required，丢失根级 $defs/definitions，嵌套对象或数组的 $ref 保留下来却失去目标。

固定上游 [anthropic-messages.ts](https://github.com/earendil-works/pi/blob/676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d/packages/ai/src/api/anthropic-messages.ts) 保留这两个根字段；本地将用已有 request-owned schema 对象上的直接赋值，避免额外条件 spread 包装对象。未知根字段不扩散，strict 成功/require 失败以及 prefer 的既有能力决策不变；不新增服务端失败重试或 strict 降级。

完整链的既有成本：splitDeferredTools 每次请求按工具名去重、扫描工具加载历史，创建 Map/Set/数组；convertTools 每次调用创建一个 map 回调与返回数组、每工具 legacy schema/声明及选项 spread 对象。strict resolve 先 structuredClone 并校验，成功后 getJsonSchemaToolParameters 再 clone/严格化；这些既有重复处理不纳入本修复。普通非 strict 路径复用调用方 schema 子树，不主动修改输入；payload hook 的既有可变边界不扩大。

预算链 buildParams → clampMaxTokensToContext → estimateContextTokens → estimateToolsTokens → safeJsonStringify 会序列化完整输入工具，已经包含根定义；inline 路径还对初始出站声明 JSON.stringify 计量。基线 profile 中 safeJsonStringify 是普通路径主要分配，inline 主要为 structuredClone、snapshot JSON parse/stringify。这些原有成本一并报告，计数 hook 也覆盖 safeJsonStringify，不把复制成本藏在预算 helper 里。

原生 inline 模式额外执行 snapshotText 的 JSON 编码、历史 checkpoint 比较、changeBlocks 的 Map 和工具比较，再 structuredClone 定义后 convertTools。无跨请求 schema WeakMap/cache；当前 checkpoint 的声明快照按协议保留在最终 assistant 消息中以供后续重放，不是请求临时对象。请求参数和转换出的定义归本次请求所有，完成/错误/取消后应释放；最终 stream 和输入存活的生命周期检查必须区分这两类引用。cache_control 是发送给服务端的缓存标记，不能当成本地 schema 缓存。

## 验收设计

实际 SDK fetch 截获出站 body，覆盖 $defs/definitions/both、嵌套对象/数组引用、普通/prefer、无定义、strict 成功、require 不支持、inline 初始/变更与 deferred。深冻结输入并验证无突变。网络只使用合成 SSE fixture；错误/取消保留原语义。

固定大 schema fixture 将串行执行冻结基线/候选：AST hook 统计转换调用/工具遍历、对象/数组/回调和深拷贝/序列化次数；关闭 hook 后做 HeapProfiler 采样。加入根定义必然增加必要请求字节，不能把修复前遗漏字段的较小请求宣称为有效优化。保存实际尺寸、主要分配栈和源码哈希。生命周期保留输入、消费后的 stream/AbortSignal，检查请求参数/转换 schema 引用在 success/error/abort 之后释放；inline 协议 checkpoint 保留单独说明。无新池、正则、闭包或深拷贝。

## 冻结失败基线

生产文件 anthropic-messages.ts SHA-256 `056408e64e41373b7b4cb3a15be6c04d554ba7321cf666e1582a725a4f865152`。10 项真实 SDK contract 中 2 项通过、8 项失败：六个根定义/strict-prefer 组合及 inline/deferred 请求丢失根定义；无定义/strict-success 和 require 拒绝为通过的对照。输入冻结检查通过。inline 的变更阶段在初始请求断言失败后尚未运行，候选必须完成整个两次请求序列。

## 最小实现与性能验收

候选仅扩展已有 schema 的类型声明，并在已有 legacyInputSchema 上有定义时赋值 $defs/definitions。没有新对象/闭包/正则/clone/扫描，未知根字段继续不转发，strict 的成功/拒绝分支保持原行为。必要 strict 校验仍在原入口；未增加重复验证、状态、缓存或兜底。生产文件 SHA-256 `40dcf5747d5f94ce233da616ecfa985b1ec3fe58a536486f066ea0370488474a`；完整文件 AST arrow/function-expression 20→20、function declarations 29→29、regex/new Promise 0→0、async 3→3，string literal 293→294（新增一个仅类型声明的 `"object"` 字面量）。

冻结基准 `scripts/bench/anthropic-schema-definitions.ts` SHA-256 `8dc38f84e0ab72ca8c63f2c41196119f3200484193d8cc9b8e5002c72e640fd4`。同 Node、同 16 工具/512 定义/352,503 code units 输入，基线候选串行。计数 hook 只在 counts 阶段覆盖声明、inline/deferred 与工具预算 helper，profile/lifecycle 加载原源码；SDK/SSE/V8 隐式分配不算作源代码字面量计数。

| 每请求结构 | 普通路径，基线 = 候选 | inline 路径，基线 = 候选 |
| --- | ---: | ---: |
| convertTools 调用 / 工具访问 | 2 / 16 | 1 / 16 |
| 对象字面量 / 数组 | 100 / 22 | 117 / 26 |
| 既有请求级闭包 / 深拷贝 | 5 / 0 | 7 / 1 |
| JSON 序列化（所选应用层） | 1 | 3 |
| Map / Set | 2 / 3 | 4 / 1 |

| 每请求结果 | 基线 | 候选 |
| --- | ---: | ---: |
| 普通 SDK body code units | 33,833（缺定义） | 353,353 |
| inline SDK body code units | 34,028（缺定义） | 353,548 |
| 普通采样 bytes/request | 544,088.5 | 882,377 |
| inline 采样 bytes/request | 2,165,757 | 2,835,463 |

HeapProfiler samplingInterval=4096，包含 minor/major 已回收对象，每路径 3 warmup + 16 测量。新增必要字节主要在 SDK FallbackEncoder，inline 另有原预算 JSON.stringify；原 structuredClone 和 snapshot/budget 序列化仍在主要栈中。不是性能优化声明，不把不完整请求的较小分配作为可保留的性能优势；没有额外深拷贝或重复遍历。采样含 fixture Response、SDK/profiler 噪声，不代表 CPU 或精确堆大小。

生命周期六条 success/failure/abort × 普通/inline 链保持 16 个输入工具、6 个消费后 stream 和 AbortSignal 存活。基线与候选 18 个请求参数/tools/schema-root WeakRef 全部释放，abort listeners=0，取消 ready/reject 引用清空；一个成功 inline 结果按协议保留 checkpoint（独立 snapshot，非出站转换对象）。GC 后约 16.48M bytes，只作为释放背景，不推断小幅变化。没有修改生产清理；生命周期 hook 额外触发的 inline declarationSignature 只存在于该验收，counts/profile 不启用该 hook。

10 项新 contract 全通过，包括完整 inline 两次请求；相关 capability/inline/thinking/source/stream 共 **58 通过**，新增 allocation regression **1 通过**。CI gate 运行实际 SDK 计数子进程，校验 TMP/TEMP/TMPDIR 与 os.tmpdir，按 PID/退出结果登记并清理独立仓库 fixture。类型检查与离线构建通过；首次测试类型检查发现 fixture 的动态索引缺少声明，已补明确类型，未改变运行时断言。完整计数、主要采样栈、生命周期、源文件/fixture 哈希和命令见 [正式证据](../evidence/pi-history-h05-schema-allocation.json)。

## 合并与资源回执

最终 head `4a4a147b1304cb55d5fe479b8b5b4fa5fe2a0d53` [首次 reviewer](https://github.com/dragonbaba/super-pi/pull/204#issuecomment-6623856959) 无建议、review threads 为空，[CI 41782907179](https://github.com/dragonbaba/super-pi/actions/runs/41782907179) 六分片通过。2026-11-04 06:09:18 UTC 按该 head 锁定合并，merge `b900f2e82dc1904811ac868cbf8af74caa9d63d9`；main 已同步，远端/本地精确旧分支已删除。

34 个登记日志已删除。107 缓存文件和 2 目录的删除被自动审批在执行前拒绝，原文 `blocked by policy`；不重试/更换机制，缓存、manifest、runner、PR body 留在上述精确任务根，登记子进程均已退出。[清理受阻回执](https://github.com/dragonbaba/super-pi/pull/204#issuecomment-6623867359)。
